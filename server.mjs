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
          liveConfig = await loadConfig(root, 'live', { allowKeyless: true });
          try {
            const resolved = resolveActiveConfig(liveConfig, 'live');
            routingPreview = resolved.routing;
          } catch {
            const activeModels = liveConfig.models.filter(m => isModelAvailable(m, 'live'));
            routingPreview = {
              totalModels: liveConfig.models.length,
              activeModels: activeModels.map(m => m.id),
              inactiveModels: liveConfig.models.filter(m => !activeModels.includes(m.id)).map(m => m.id),
              seatDistribution: {},
              remappedSeats: [],
              remappedRoles: {},
              isAdaptive: false
            };
          }
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
        const payload = await body(req);
        let testModel = null;
        if (payload.modelConfig && typeof payload.modelConfig === 'object') {
          testModel = structuredClone(payload.modelConfig);
          if (typeof payload.apiKey === 'string' && payload.apiKey.trim() && !payload.apiKey.includes('•••')) {
            testModel.apiKey = payload.apiKey.trim();
          }
        } else if (payload.modelId) {
          let liveConfig;
          try { liveConfig = await loadConfig(root, 'live', { allowKeyless: true }); } catch (e) { return json(400, { error: e.message }); }
          const model = liveConfig.models.find(m => m.id === payload.modelId);
          if (!model) return json(404, { error: `未找到模型配置: ${payload.modelId}` });
          testModel = structuredClone(model);
          if (typeof payload.apiKey === 'string' && payload.apiKey.trim() && !payload.apiKey.includes('•••')) {
            testModel.apiKey = payload.apiKey.trim();
          }
        } else {
          return json(400, { error: '缺少 modelId 或 modelConfig' });
        }

        testModel.protocol = testModel.protocol || 'chat';
        testModel.structuredOutput = testModel.structuredOutput || 'json_object';
        testModel.tokenParameter = testModel.tokenParameter || 'max_tokens';
        if (testModel.supportsTemperature === undefined) testModel.supportsTemperature = true;
        if (testModel.supportsReasoning === undefined) testModel.supportsReasoning = true;
        if (testModel.supportsSeed === undefined) testModel.supportsSeed = false;

        const key = getModelApiKey(testModel);
        let isLocal = false;
        try {
          const u = new URL(testModel.baseUrl);
          isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        } catch {}

        if (!key && testModel.apiKeyEnv !== null && !isLocal && !testModel.isKeyless) {
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
      if (route === '/api/models/discover' && req.method === 'POST') {
        const { baseUrl, apiKey, protocol, modelId } = await body(req);
        if (!baseUrl || typeof baseUrl !== 'string') return json(400, { error: '请提供有效的 baseUrl' });
        try {
          const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
          let effectiveKey = (typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•••') && apiKey !== '__EXISTING__')
            ? apiKey.trim()
            : null;

          if (!effectiveKey && modelId) {
            try {
              const liveCfg = await loadConfig(root, 'live');
              const exist = (liveCfg.models || []).find(m => m.id === modelId);
              if (exist) effectiveKey = getModelApiKey(exist);
            } catch {}
          }

          let isLocal = false;
          try {
            const u = new URL(baseUrl);
            isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0' || u.hostname === '::1';
          } catch {}

          if (!isLocal && !effectiveKey) {
            return json(200, {
              ok: false,
              needsKey: true,
              error: '探测云端服务商模型必须提供 API Key 凭据。请在下方填入 API Key 后重试。'
            });
          }

          if (protocol === 'gemini') {
            const endpoint = `${cleanUrl}/models${effectiveKey ? `?key=${encodeURIComponent(effectiveKey)}` : ''}`;
            const res = await fetch(endpoint, {
              headers: effectiveKey ? { 'x-goog-api-key': effectiveKey } : {},
              signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) {
              const text = await res.text();
              if (res.status === 400 || res.status === 401 || res.status === 403) {
                return json(200, { ok: false, isAuthError: true, error: `Gemini API Key 认证未通过 (HTTP ${res.status})，请核对 Key 是否正确` });
              }
              return json(200, { ok: false, error: `Gemini HTTP ${res.status}: ${text.slice(0, 300)}` });
            }
            const data = await res.json();
            const models = (data.models || []).map(m => {
              const name = m.name?.replace(/^models\//, '') || m.name;
              return { id: name, name: m.displayName || name };
            });
            return json(200, { ok: true, models });
          }

          const headers = { 'Content-Type': 'application/json' };
          if (effectiveKey) {
            if (cleanUrl.includes('anthropic.com')) {
              headers['x-api-key'] = effectiveKey;
              headers['anthropic-version'] = '2023-06-01';
            } else {
              headers['Authorization'] = `Bearer ${effectiveKey}`;
            }
          }

          let targetEndpoint = `${cleanUrl}/models`;
          let res = await fetch(targetEndpoint, {
            headers,
            signal: AbortSignal.timeout(10000)
          });
          if (!res.ok && res.status === 404 && !cleanUrl.endsWith('/v1')) {
            targetEndpoint = `${cleanUrl}/v1/models`;
            res = await fetch(targetEndpoint, {
              headers,
              signal: AbortSignal.timeout(10000)
            });
          }
          if (!res.ok) {
            const text = await res.text();
            if (res.status === 401 || res.status === 403) {
              return json(200, {
                ok: false,
                isAuthError: true,
                error: `API Key 认证未通过 (HTTP ${res.status})：密钥无效或无权访问模型列表，请核对下方 API Key`
              });
            }
            if (res.status === 404) {
              return json(200, {
                ok: false,
                isNotFound: true,
                error: `该服务端点未开放 /models 模型探测接口 (HTTP 404)。请直接使用下方推荐选型或手动输入模型标识。`
              });
            }
            return json(200, { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` });
          }
          const data = await res.json();
          const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
          const models = list.map(m => ({
            id: m.id || m.name,
            name: m.name || m.id
          })).filter(m => m.id);
          return json(200, { ok: true, models });
        } catch (err) {
          const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
          return json(200, {
            ok: false,
            error: isTimeout ? '连接服务端点超时，请检查 Base URL 是否正确或网络是否畅通' : err.message
          });
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
