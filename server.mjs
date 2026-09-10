import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Store, summary } from './src/store.mjs';
import { createRun, executeRun, EXPERIMENTS } from './src/engine.mjs';
import { loadConfig, saveConfig, getModelApiKey, isModelAvailable, resolveActiveConfig } from './src/config.mjs';
import { chatCompletion } from './src/provider.mjs';
import { operators } from './src/operators.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ dataDir = path.join(root, 'data/runs'), mockDelayMs = Number(process.env.MOCK_DELAY_MS ?? 1200) } = {}) {
  const store = new Store(dataDir); await store.init(); await store.recover();
  const streamEvents = new EventEmitter(); streamEvents.setMaxListeners(64);
  let active = null;
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
        let liveConfig = null, liveError = null, routingPreview = null;
        try {
          liveConfig = await loadConfig(root, 'live');
          const resolved = resolveActiveConfig(liveConfig, 'live');
          routingPreview = resolved.routing;
        } catch (e) {
          liveError = e.message;
        }
        const sanitizeConfig = cfg => {
          if (!cfg) return null;
          const cloned = structuredClone(cfg);
          cloned.models = cloned.models.map(m => {
            const rawKey = getModelApiKey(m);
            const hasKey = rawKey !== null;
            let maskedKey = '';
            if (rawKey) {
              maskedKey = rawKey.length > 8 ? `${rawKey.slice(0, 4)}••••${rawKey.slice(-4)}` : '••••••••';
            }
            const keySource = m.apiKey ? 'config' : (m.apiKeyEnv && process.env[m.apiKeyEnv] ? 'env' : 'none');
            const { apiKey, ...rest } = m;
            return { ...rest, hasKey, maskedKey, keySource };
          });
          return cloned;
        };
        return json(200, {
          mockConfig: await loadConfig(root),
          liveConfig: sanitizeConfig(liveConfig),
          rawConfigPresent: !!liveConfig,
          liveError,
          routingPreview,
          experiments: EXPERIMENTS,
          operators
        });
      }
      if (route === '/api/config' && req.method === 'POST') {
        const input = await body(req);
        try {
          await saveConfig(root, input);
          return json(200, { ok: true, message: '配置与 API Key 已成功持久化保存并即时生效' });
        } catch (e) {
          return json(400, { error: e.message });
        }
      }
      if (route === '/api/models/test' && req.method === 'POST') {
        const { modelId, apiKey } = await body(req);
        let liveConfig;
        try { liveConfig = await loadConfig(root, 'live'); } catch (e) { return json(400, { error: e.message }); }
        const model = liveConfig.models.find(m => m.id === modelId);
        if (!model) return json(404, { error: `未找到模型配置: ${modelId}` });
        const testModel = structuredClone(model);
        if (typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•••')) {
          testModel.apiKey = apiKey.trim();
        }
        const key = getModelApiKey(testModel);
        if (!key && testModel.apiKeyEnv !== null) {
          return json(200, { ok: false, error: '未检测到 API Key，请先输入 Key 后测试' });
        }
        const start = Date.now();
        try {
          const result = await chatCompletion(testModel, {
            phase: 'direct',
            messages: [{ role: 'user', content: '严格返回 JSON: {"text":"ok"}' }],
            generation: { max_output_tokens: 64, temperature: 0.1, reasoning_effort: 'low' },
            seed: 1
          }, { timeoutMs: 15000 });
          return json(200, { ok: true, latencyMs: Date.now() - start, model: testModel.model, response: result.text });
        } catch (err) {
          return json(200, { ok: false, latencyMs: Date.now() - start, model: testModel.model, error: err.message });
        }
      }
      if (route === '/api/runs' && req.method === 'GET') return json(200, { runs: await store.list(), activeId: active?.run.id ?? null });
      if (route === '/api/runs' && req.method === 'POST') {
        if (active) return json(409, { error: '已有会议运行中，请等待完成或停止当前会议' });
        // Reserve before the first await so simultaneous requests cannot launch two runs.
        active = { run: { id: null }, controller: new AbortController(), promise: null };
        try {
          const input = await body(req);
          const mode = input.mode || 'live';
          const config = await loadConfig(root, mode);
          const run = createRun({ ...input, mode }, config), controller = active.controller;
          active.run = run; await store.save(run);
          active.promise = executeRun(run, { store, signal: controller.signal, mockDelayMs, onEvent: data => streamEvents.emit(run.id, data) }).catch(async e => { run.status = 'failed'; run.error = `存储或执行失败：${e.message}`; run.completed_at = new Date().toISOString(); await store.save(run).catch(() => {}); }).finally(() => { active = null; });
          return json(202, summary(run));
        } catch (e) { active = null; throw e; }
      }
      const match = route.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)(?:\/(export|answer|cancel|stream))?$/);
      if (match) {
        const [, id, action] = match;
        if (action === 'cancel' && req.method === 'POST') { if (active?.run.id !== id) return json(409, { error: '此会议未在运行' }); active.controller.abort(); return json(202, { status: 'stopping' }); }
        if (action === 'stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': keepalive\n\n');
          const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ } };
          streamEvents.on(id, send);
          req.on('close', () => streamEvents.off(id, send));
          return;
        }
        if (req.method !== 'GET') return json(405, { error: '方法不支持' });
        const run = await store.get(id);
        if (action === 'answer') { if (!run.final) return json(409, { error: '尚未生成答案' }); res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.md"` }); return res.end(run.final.text); }
        if (action === 'export') { res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`); return json(200, run); }
        // Full prompts are downloadable; polling only returns metadata and response text.
        return json(200, { ...run, calls: run.calls.map(({ request, ...c }) => ({ ...c, request_characters: JSON.stringify(request).length })) });
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[route]) {
        const [file, type] = files[route]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(root, 'public', file)));
      }
      json(404, { error: '未找到资源' });
    } catch (e) { json(e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
  });
  server.on('close', () => active?.controller.abort());
  return { server, store, stop: async () => { active?.controller.abort(); await active?.promise; } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(path.join(root, '.env')); } catch {}
  }
  const { server, stop } = await createApp();
  const port = Number(process.env.PORT ?? 4317);
  server.listen(port, '127.0.0.1', () => console.log(`Aha: http://127.0.0.1:${port}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请更改 .env 的 PORT` : e.message); process.exitCode = 1; });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await stop(); server.close(); });
}
