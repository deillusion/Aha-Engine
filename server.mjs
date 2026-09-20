import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { RunService, RunConflictError } from './src/application/run_service.mjs';
import { ConfigService } from './src/application/config_service.mjs';
import { AgentService, AgentTurnConflictError } from './src/agent/agent_service.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const defaultRunDataDir = path.join(root, '.varina/data/runs');
const defaultSessionDataDir = path.join(root, '.varina/data/sessions');

async function ensureDataMigration(rootPath) {
  const legacyDataDir = path.join(rootPath, 'data');
  const targetDataDir = path.join(rootPath, '.varina', 'data');
  if (existsSync(legacyDataDir) && !existsSync(targetDataDir)) {
    try {
      await mkdir(path.dirname(targetDataDir), { recursive: true });
      await rename(legacyDataDir, targetDataDir);
    } catch {
      try {
        await cp(legacyDataDir, targetDataDir, { recursive: true });
        await rm(legacyDataDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function createApp({
  dataDir = defaultRunDataDir,
  sessionDataDir = dataDir === defaultRunDataDir ? defaultSessionDataDir : path.join(dataDir, 'agent-sessions'),
  workspaceRoot = process.env.VARINA_WORKSPACE_ROOT || process.env.AHA_WORKSPACE_ROOT || os.homedir(),
  mockDelayMs = Number(process.env.MOCK_DELAY_MS ?? 1200)
} = {}) {
  await ensureDataMigration(root);
  const runService = new RunService({ root, dataDir, mockDelayMs });
  await runService.init();
  const agentService = new AgentService({ root, dataDir: sessionDataDir, workspaceRoot });
  await agentService.init();
  const configService = new ConfigService({ root });
  const store = runService.store;
  async function body(req) { const chunks = []; let size = 0; for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 512000) throw new Error('请求体过大'); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      // Loopback-only host and same-origin mutations prevent cross-site paid run creation.
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return json(403, { error: '仅允许本地访问' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, { error: '不允许跨站请求' });
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 application/json' });
      const url = new URL(req.url, `http://${host}`), route = url.pathname;
      if (route === '/api/config' && req.method === 'GET') {
        return json(200, await configService.overview());
      }
      if (route === '/api/config' && req.method === 'POST') {
        const input = await body(req);
        try {
          await configService.save(input);
          return json(200, { ok: true, message: '配置与 API Key 已成功持久化保存并即时生效' });
        } catch (e) {
          return json(400, { error: e.message });
        }
      }
      if (route === '/api/models/test' && req.method === 'POST') {
        try {
          return json(200, await configService.testModel(await body(req)));
        } catch (e) {
          return json(e.code === 'MODEL_NOT_FOUND' ? 404 : 400, { error: e.message });
        }
      }
      if (route === '/api/models/discover' && req.method === 'POST') {
        try {
          return json(200, await configService.discoverModels(await body(req)));
        } catch (e) {
          return json(400, { error: e.message });
        }
      }
      if (route === '/api/agent/sessions' && req.method === 'GET') {
        const reqMode = url.searchParams.get('mode');
        const allSessions = await agentService.list();
        const liveCount = allSessions.filter(s => s.mode !== 'mock').length;
        const mockCount = allSessions.filter(s => s.mode === 'mock').length;
        const sessions = (reqMode && reqMode !== 'all') ? allSessions.filter(s => s.mode === reqMode) : allSessions;
        return json(200, {
          sessions,
          total: allSessions.length,
          counts: { live: liveCount, mock: mockCount }
        });
      }
      if (route === '/api/agent/sessions/clear-mock' && req.method === 'POST') {
        return json(200, await agentService.clearMock());
      }
      if (route === '/api/agent/directories' && req.method === 'GET') {
        try { return json(200, await agentService.browseDirectories(url.searchParams.get('path'))); }
        catch (e) { return json(e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
      }
      if (route === '/api/agent/sessions' && req.method === 'POST') {
        try {
          const session = await agentService.create(await body(req));
          return json(201, agentService.summary(session));
        } catch (e) {
          return json(400, { error: e.message });
        }
      }
      const agentMatch = route.match(/^\/api\/agent\/sessions\/(session-[a-zA-Z0-9-]+)(?:\/(messages|cancel|stream))?$/);
      if (agentMatch) {
        const [, sessionId, action] = agentMatch;
        if (!action && req.method === 'GET') return json(200, await agentService.get(sessionId));
        if (!action && req.method === 'DELETE') return json(200, await agentService.delete(sessionId));
        if (action === 'messages' && req.method === 'POST') {
          try {
            const input = await body(req);
            if (typeof input.message !== 'string' || !input.message.trim()) return json(400, { error: 'message 不能为空' });
            await agentService.startTurn(sessionId, input.message, { enable_varina: input.enable_varina ?? input.enable_aha, enable_aha: input.enable_varina ?? input.enable_aha, max_tool_iterations: input.max_tool_iterations });
            return json(202, { session_id: sessionId, status: 'running' });
          } catch (e) {
            if (e instanceof AgentTurnConflictError) return json(409, { error: e.message });
            if (e.code === 'ENOENT') return json(404, { error: '会话不存在' });
            throw e;
          }
        }
        if (action === 'cancel' && req.method === 'POST') {
          try { return json(202, agentService.cancel(sessionId)); }
          catch (e) { if (e instanceof AgentTurnConflictError) return json(409, { error: e.message }); throw e; }
        }
        if (action === 'stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': keepalive\n\n');
          const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          const unsubscribe = agentService.subscribe(sessionId, send);
          req.on('close', unsubscribe);
          return;
        }
        return json(405, { error: '方法不支持' });
      }
      if (route === '/api/runs' && req.method === 'GET') {
        const reqMode = url.searchParams.get('mode');
        const allRuns = await runService.list();
        const liveCount = allRuns.filter(r => r.mode !== 'mock').length;
        const mockCount = allRuns.filter(r => r.mode === 'mock').length;
        const runs = (reqMode && reqMode !== 'all') ? allRuns.filter(r => r.mode === reqMode) : allRuns;
        return json(200, {
          runs,
          total: allRuns.length,
          counts: { live: liveCount, mock: mockCount },
          activeId: runService.activeRunId
        });
      }
      if (route === '/api/runs' && req.method === 'POST') {
        try {
          const input = await body(req);
          const { run } = await runService.startRun(input);
          return json(202, runService.summarize(run));
        } catch (e) {
          if (e instanceof RunConflictError) return json(409, { error: e.message });
          throw e;
        }
      }
      const match = route.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)(?:\/(export|answer|cancel|stream))?$/);
      if (match) {
        const [, id, action] = match;
        if (action === 'cancel' && req.method === 'POST') {
          try { return json(202, runService.cancel(id)); }
          catch (e) { if (e instanceof RunConflictError) return json(409, { error: e.message }); throw e; }
        }
        if (action === 'stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': keepalive\n\n');
          const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          const unsubscribe = runService.subscribe(id, send);
          req.on('close', unsubscribe);
          return;
        }
        if (req.method !== 'GET') return json(405, { error: '方法不支持' });
        const run = await runService.get(id);
        if (action === 'answer') { if (!run.final) return json(409, { error: '尚未生成答案' }); res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.md"` }); return res.end(run.final.text); }
        if (action === 'export') { res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`); return json(200, run); }
        // Full prompts are downloadable; polling only returns metadata and response text.
        return json(200, { ...run, calls: run.calls.map(({ request, ...c }) => ({ ...c, request_characters: JSON.stringify(request).length })) });
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/markdown.js': ['markdown.js', 'text/javascript'] };
      if (req.method === 'GET' && files[route]) {
        const [file, type] = files[route]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(root, 'public', file)));
      }
      json(404, { error: '未找到资源' });
    } catch (e) { json(e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
  });
  server.on('close', () => { void runService.stop(); void agentService.stop(); });
  return {
    server, store, runService, agentService,
    stop: async () => { await Promise.all([runService.stop(), agentService.stop()]); }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(path.join(root, '.env')); } catch {}
  }
  const { server, stop } = await createApp();
  const port = Number(process.env.PORT ?? 27333);
  server.listen(port, '127.0.0.1', () => console.log(`Varina: http://127.0.0.1:${port}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请更改 .env 的 PORT` : e.message); process.exitCode = 1; });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await stop(); server.close(); });
}
