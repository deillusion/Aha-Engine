import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { loadConfig, saveConfig, getModelApiKey, resolveActiveConfig } from './src/config.mjs';
import { Store, summary } from './src/store.mjs';
import { createRun, executeRun, EXPERIMENTS } from './src/engine.mjs';
import { chatCompletion } from './src/provider.mjs';
import { operators } from './src/operators.mjs';
import { domainCatalog } from './src/domain_operators.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(root, '.env')); } catch {}
}

const MCP_PATH = path.resolve(root, 'mcp.mjs');

export async function createMcpApp({ dataDir = path.join(root, 'data/runs') } = {}) {
  const store = new Store(dataDir);
  await store.init();
  await store.recover();

  const streamEvents = new EventEmitter();
  streamEvents.setMaxListeners(64);
  let active = null;

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 512000) throw new Error('请求体过大');
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify(value));
    };

    try {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return json(403, { error: '仅允许本地访问' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, { error: '不允许跨站请求' });

      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;

      // API: Config
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
          mockConfig: await loadConfig(root, 'mock'),
          liveConfig: sanitizeConfig(liveConfig),
          rawConfigPresent: !!liveConfig,
          liveError,
          routingPreview,
          experiments: EXPERIMENTS,
          operators,
          domainCatalog,
          mcpPath: MCP_PATH
        });
      }

      if (route === '/api/config' && req.method === 'POST') {
        const newConfig = await body(req);
        try {
          await saveConfig(root, newConfig);
          return json(200, { ok: true, message: 'MCP 席位与模型 API Key 配置已保存并实时生效' });
        } catch (e) {
          return json(400, { error: e.message });
        }
      }

      // API: Model connectivity test
      if (route === '/api/models/test' && req.method === 'POST') {
        const { modelId, apiKey } = await body(req);
        let liveConfig;
        try { liveConfig = await loadConfig(root, 'live', { allowKeyless: true }); } catch (e) { return json(400, { error: e.message }); }
        const model = liveConfig.models.find(m => m.id === modelId);
        if (!model) return json(404, { error: `未找到模型配置: ${modelId}` });
        const testModel = structuredClone(model);
        if (typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•••')) {
          testModel.apiKey = apiKey.trim();
        }
        const key = getModelApiKey(testModel);
        if (!key && testModel.apiKeyEnv !== null) {
          return json(200, { ok: false, error: '未检测到 API Key，请先填入 Key' });
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

      // API: Runs list & run detail
      if (route === '/api/runs' && req.method === 'GET') {
        return json(200, { runs: await store.list(), activeId: active?.run?.id ?? null });
      }

      // API: Simulate / Trigger MCP run
      if (route === '/api/simulate' && req.method === 'POST') {
        if (active) return json(409, { error: '已有设计会议运行中，请等待完成' });
        active = { run: { id: null }, controller: new AbortController(), promise: null };
        try {
          const input = await body(req);
          const config = await loadConfig(root, input.mode || 'mock');
          const run = createRun({
            problem: input.problem,
            constraints: input.constraints || [],
            seed: input.seed ?? Math.floor(Math.random() * 1000000),
            mode: input.mode || 'mock',
            experiment: input.experiment || 'single',
            use_operators: input.use_operators !== false
          }, config);

          active.run = run;
          await store.save(run);
          const controller = active.controller;

          active.promise = executeRun(run, {
            store,
            signal: controller.signal,
            mockDelayMs: 20,
            onEvent: data => streamEvents.emit(run.id, data)
          }).catch(async e => {
            run.status = 'failed';
            run.error = `执行失败：${e.message}`;
            run.completed_at = new Date().toISOString();
            await store.save(run).catch(() => {});
          }).finally(() => { active = null; });

          return json(202, summary(run));
        } catch (e) {
          active = null;
          throw e;
        }
      }

      const match = route.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)(?:\/(stream|answer|export))?$/);
      if (match) {
        const [, id, action] = match;
        if (action === 'stream' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
          });
          res.write(': keepalive\n\n');
          const send = data => {
            try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
          };
          streamEvents.on(id, send);
          req.on('close', () => streamEvents.off(id, send));
          return;
        }
        if (req.method === 'GET') {
          const run = await store.get(id);
          if (action === 'answer') {
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
            return res.end(run.final?.text || '');
          }
          if (action === 'export') {
            return json(200, run);
          }
          return json(200, run);
        }
      }

      // Serve standalone MCP WebUI
      if (route === '/' || route === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderMcpUiHtml());
      }

      json(404, { error: 'Not Found' });
    } catch (e) {
      json(e.code === 'ENOENT' ? 404 : 400, { error: e.message });
    }
  });

  return { server, store, stop: async () => { active?.controller.abort(); await active?.promise; } };
}

function renderMcpUiHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aha · MCP Agent 架构外脑控制台</title>
  <style>
    :root {
      --bg: #0f1412;
      --card-bg: #161e1a;
      --border: #233029;
      --accent: #4ade80;
      --accent-dim: #1f422e;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --danger: #f87171;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 16px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-badge {
      background: var(--accent-dim);
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
      border: 1px solid #2d5a40;
    }
    .brand-title {
      font-size: 18px;
      font-weight: 650;
      letter-spacing: -0.5px;
    }
    .nav-tabs {
      display: flex;
      gap: 8px;
      background: #0b0f0e;
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab-btn.active {
      background: var(--card-bg);
      color: var(--accent);
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    main {
      flex: 1;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 28px 24px;
    }
    .panel { display: none; }
    .panel.active { display: block; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 650;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 18px;
    }
    pre {
      background: #0a0d0c;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: #93c5fd;
      overflow-x: auto;
      margin-bottom: 12px;
    }
    .btn {
      background: var(--accent);
      color: #062413;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: opacity 0.15s ease;
    }
    .btn:hover { opacity: 0.9; }
    .btn.secondary {
      background: #1f2923;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn.secondary:hover { background: #26332c; }
    .field {
      margin-bottom: 16px;
    }
    .field label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--text-muted);
    }
    input, select, textarea {
      width: 100%;
      background: #0c110f;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 12px;
      color: var(--text);
      font-size: 13px;
      outline: none;
      font-family: inherit;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .grid-seats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-top: 10px;
    }
    .seat-cell {
      background: #0e1412;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .seat-tag {
      font-weight: 700;
      font-size: 11px;
      background: var(--accent-dim);
      color: var(--accent);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding: 12px 0;
    }
    .model-row:last-child { border-bottom: none; }
    .token-meter {
      height: 6px;
      background: #1f2923;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }
    .token-meter-fill {
      height: 100%;
      width: 0%;
      background: var(--accent);
      transition: all 0.2s ease;
    }
    .alert-box {
      background: #1b261e;
      border: 1px solid #2a4733;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 12px;
      color: #a7f3d0;
      margin-bottom: 16px;
    }
    .alert-box.warn {
      background: #2a2012;
      border-color: #593f18;
      color: #fde047;
    }
    .status-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: #1f2923;
      color: var(--text-muted);
    }
    .status-pill.success { background: #133a24; color: #86efac; }
    .status-pill.failed { background: #3d1b1b; color: #fca5a5; }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #334155;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: none;
      z-index: 100;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-badge">MCP CONSOLE</span>
      <h1 class="brand-title">Aha · Agent 架构外脑控制台</h1>
    </div>
    <nav class="nav-tabs">
      <button class="tab-btn active" data-tab="setup">🔌 宿主挂载</button>
      <button class="tab-btn" data-tab="config">⚙️ 席位与模型</button>
      <button class="tab-btn" data-tab="simulator">🧪 模拟调用</button>
      <button class="tab-btn" data-tab="history">📜 调用历史</button>
      <button class="tab-btn" data-tab="guide">📖 防爆指南</button>
    </nav>
  </header>

  <main>
    <!-- TAB 1: 宿主挂载 -->
    <section id="panel-setup" class="panel active">
      <div class="card">
        <div class="card-title">
          <span>接入外部 Coding Agent</span>
          <span class="status-pill success">stdio 协议就绪</span>
        </div>
        <p class="card-desc">将 Aha 挂载为 MCP Server 后，Claude Code、Cursor、Claude Desktop 或 Codex 可以在面临架构两难时随时调用。</p>
        
        <div class="field">
          <label>Claude Code 配置 (~/.claude.json 或 项目根目录)</label>
          <pre id="cfg-claude"></pre>
          <button class="btn secondary" onclick="copySnippet('cfg-claude')">📋 复制配置</button>
        </div>

        <div class="field" style="margin-top:20px">
          <label>Cursor MCP 设置 (.cursor/mcp.json 或 Settings -> MCP)</label>
          <pre id="cfg-cursor"></pre>
          <button class="btn secondary" onclick="copySnippet('cfg-cursor')">📋 复制配置</button>
        </div>

        <div class="field" style="margin-top:20px">
          <label>Claude Desktop 配置 (claude_desktop_config.json)</label>
          <pre id="cfg-desktop"></pre>
          <button class="btn secondary" onclick="copySnippet('cfg-desktop')">📋 复制配置</button>
        </div>
      </div>
    </section>

    <!-- TAB 2: 席位与模型设置 -->
    <section id="panel-config" class="panel">
      <div id="mcp-adaptive-banner" class="alert-box" style="display:none;margin-bottom:16px"></div>
      <div class="card">
        <div class="card-title">
          <span>MCP 席位与全局角色模型分工</span>
          <button class="btn" id="save-cfg-btn">💾 保存配置并生效</button>
        </div>
        <p class="card-desc">配置保存后持久化写入本地 <code>config.local.json</code>。外部 Agent 调用 MCP 时将直接按此生效，外部客户端零 Key 感知。</p>

        <div class="grid-2">
          <div class="field">
            <label>Chair 排序裁决模型</label>
            <select id="sel-role-chair"></select>
          </div>
          <div class="field">
            <label>Dedup 观点去重合并模型</label>
            <select id="sel-role-dedup"></select>
          </div>
        </div>
        <div class="field">
          <label>Dealer 发卡选择模型（评估问题并挑选领域算子）</label>
          <select id="sel-role-dealer"></select>
        </div>

        <div class="field" style="margin-top:20px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label style="margin-bottom:0">8 个创意推演席位分配</label>
            <button type="button" class="btn secondary" id="auto-balance-seats-btn" style="padding:4px 10px;font-size:11px">⚡ 一键在可用模型间均匀排席</button>
          </div>
          <div class="grid-seats" id="seats-container"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">已配置模型接入点与 API Key 凭据</div>
        <p class="card-desc">在下方直接输入对应模型的 API Key。支持任意 K 个模型自适应运行（哪怕只填 1 个 Key 也可正常运转所有席位）。</p>
        <div id="models-list"></div>
      </div>
    </section>

    <!-- TAB 3: 模拟调用 -->
    <section id="panel-simulator" class="panel">
      <div class="card">
        <div class="card-title">模拟 Coding Agent 发起架构设计请求</div>
        <p class="card-desc">在此调试输入表达与 Token 防爆规范，测试 Aha 针对该架构命题的推演效果。</p>

        <div class="alert-box">
          <b>💡 Token 防爆守则</b>：严禁粘贴长篇源文件或大段代码。请作为调用端提炼“死锁矛盾”、“硬约束”和“拓扑说明”。
        </div>

        <div class="field">
          <label>架构命题 / 核心死锁矛盾 (problem, 上限 4000 字符)</label>
          <textarea id="sim-problem" rows="4" placeholder="例如：设计一个支持跨地域多活的 Session 状态同步机制。当前集中式 Redis 面临 150ms 专线延迟，而异步最终一致性又存在跨区漫游越权风险……"></textarea>
          <div class="token-meter"><div class="token-meter-fill" id="meter-problem"></div></div>
          <small id="counter-problem" style="color:var(--text-muted);font-size:11px">0 / 4000 字符</small>
        </div>

        <div class="field">
          <label>不可违背的硬约束 (constraints, 每行一条，最多 20 条)</label>
          <textarea id="sim-constraints" rows="3" placeholder="单区读写 P99 延迟 < 5ms&#10;漫游权限撤销在 1 秒内收敛&#10;不得引入两阶段提交 (2PC) 组件"></textarea>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>实验模式</label>
            <select id="sim-experiment">
              <option value="single" selected>single (单轮快速，约15秒出方案)</option>
              <option value="treatment">treatment (五轮深度协作演化，约90秒)</option>
            </select>
          </div>
          <div class="field">
            <label>运行模式</label>
            <select id="sim-mode">
              <option value="live">live (调用已配置大模型)</option>
              <option value="mock" selected>mock (本地无费用模拟)</option>
            </select>
          </div>
        </div>

        <button class="btn" id="run-sim-btn" style="margin-top:10px">🚀 发起模拟设计会议</button>
      </div>

      <div class="card" id="sim-result-card" style="display:none">
        <div class="card-title">
          <span>推演结果与方案排行榜</span>
          <span class="status-pill success" id="sim-status">已完成</span>
        </div>
        <div id="sim-progress-log" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-bottom:12px;background:#090d0b;padding:8px 12px;border-radius:6px"></div>
        <pre id="sim-output-text" style="max-height:500px;overflow-y:auto;white-space:pre-wrap;color:#cbd5e1"></pre>
      </div>
    </section>

    <!-- TAB 4: 调用历史 -->
    <section id="panel-history" class="panel">
      <div class="card">
        <div class="card-title">MCP 运行记录</div>
        <p class="card-desc">所有通过 MCP 工具或模拟台发起的运行均持久化保留在此。</p>
        <div id="runs-table-wrap"></div>
      </div>
    </section>

    <!-- TAB 5: 防爆指南 -->
    <section id="panel-guide" class="panel">
      <div class="card">
        <div class="card-title">外部 Agent 提炼规范 (Prompt Snippet)</div>
        <p class="card-desc">可直接将以下指令添加至项目根目录的 <code>.cursorrules</code> 或 <code>CLAUDE.md</code>，引导 Coding Agent 正确调用 Aha：</p>
        <pre><code>### 架构共创技能：调用 Aha 外脑 (\`aha_design_architecture\`)

当遇到架构选型两难、方案死锁或机制设计难题时，调用 MCP 工具 \`aha_design_architecture\`。

**调用前的强制性信息浓缩守则**：
- **绝对禁止倾泻源码**：严禁将文件全文或大段代码块放入 \`problem\`。
- **提炼三要素**：
  1. \`problem\`: 提炼核心矛盾与死锁点（为什么常规解法行不通？限制 4000 字符内）；
  2. \`constraints\`: 梳理不可退让的硬约束列表（性能、依赖限制、兼容性等）；
  3. \`context_summary\`: 仅用自然语言概述架构拓扑与关键流向（禁止贴源码）。
- **参数建议**：常规推荐 \`experiment: "single"\`（15秒快速产出8席方案树）；重大疑难可选 \`treatment\`。</code></pre>
      </div>
    </section>
  </main>

  <div id="toast" class="toast"></div>

  <script>
    let globalConfig = null;
    function showToast(text) {
      const t = document.getElementById('toast');
      t.textContent = text;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3000);
    }

    function copySnippet(id) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.textContent);
      showToast('✅ 已复制到剪贴板');
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'history') loadHistory();
      });
    });

    async function loadConfig() {
      const res = await fetch('/api/config');
      const data = await res.json();
      globalConfig = data;

      const mcpPath = data.mcpPath || 'c:/Users/15611/Desktop/Aha/prototype/mcp.mjs';
      const claudeCfg = {
        mcpServers: {
          aha: { command: "node", args: [mcpPath] }
        }
      };
      document.getElementById('cfg-claude').textContent = JSON.stringify(claudeCfg, null, 2);
      document.getElementById('cfg-cursor').textContent = JSON.stringify(claudeCfg, null, 2);
      document.getElementById('cfg-desktop').textContent = JSON.stringify(claudeCfg, null, 2);

      const cfg = data.liveConfig || data.mockConfig;
      const modelOpts = cfg.models.map(m => \`<option value="\${m.id}">\${m.id} (\${m.model})</option>\`).join('');
      
      document.getElementById('sel-role-chair').innerHTML = modelOpts;
      document.getElementById('sel-role-dedup').innerHTML = modelOpts;
      document.getElementById('sel-role-dealer').innerHTML = modelOpts;

      document.getElementById('sel-role-chair').value = cfg.roles.chair;
      document.getElementById('sel-role-dedup').value = cfg.roles.dedup;
      document.getElementById('sel-role-dealer').value = cfg.roles.dealer || cfg.roles.chair;

      // Render adaptive banner
      const banner = document.getElementById('mcp-adaptive-banner');
      if (data.routingPreview) {
        const rp = data.routingPreview;
        banner.style.display = 'block';
        banner.className = 'alert-box' + (rp.isAdaptive ? ' warn' : '');
        banner.innerHTML = \`<b>💡 模型就绪状态:</b> 已配置 <b>\${rp.activeModels.length} / \${rp.totalModels}</b> 个模型（\${rp.activeModels.join(', ')}）。\` +
          (rp.isAdaptive ? \`<br><span style="font-size:11px">检测到部分席位对应模型未激活，Aha 自适应调度机制已就绪：空缺席位将在调用时自动按最大多样性均衡分配给可用模型，会议可正常完成。</span>\` :
          \`<br><span style="font-size:11px">所有模型配置完整，当前处于完全异构模型协同状态。</span>\`);
      } else {
        banner.style.display = 'none';
      }

      const seatsHtml = cfg.seats.map((s, idx) => \`
        <div class="seat-cell">
          <span class="seat-tag">\${s.id}</span>
          <select class="seat-sel" data-idx="\${idx}" style="font-size:11px;padding:4px 6px">
            \${cfg.models.map(m => \`<option value="\${m.id}" \${s.modelId === m.id ? 'selected' : ''}>\${m.id} \${m.hasKey ? '🟢' : '⚪'}</option>\`).join('')}
          </select>
        </div>
      \`).join('');
      document.getElementById('seats-container').innerHTML = seatsHtml;

      const modelsHtml = cfg.models.map(m => \`
        <div class="model-row" style="padding:14px 0">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px">
              <b>\${m.id}</b> · <span style="color:var(--text-muted)">\${m.model}</span>
              <span class="status-pill \${m.hasKey ? 'success' : ''}" id="badge-\${m.id}">
                \${m.hasKey ? '🟢 已配置' + (m.keySource === 'env' ? ' (环境变量)' : '') : '⚪ 未配置'}
              </span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin:4px 0">\${m.baseUrl}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
              <input type="password" id="input-key-\${m.id}" placeholder="\${m.hasKey ? (m.maskedKey || '已配置 (输入新密钥以替换)') : '输入 API Key (如 sk-...)'}" style="max-width:320px;font-family:var(--font-mono);font-size:11px;padding:5px 8px">
              <button type="button" class="btn secondary" onclick="toggleKeyVis('\${m.id}')" style="padding:4px 8px;font-size:11px" title="显示/隐藏密钥">👁️</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <button class="btn secondary" onclick="testModel('\${m.id}')" style="padding:5px 12px;font-size:11px">⚡ 测试连通性</button>
            <span id="probe-\${m.id}" style="font-size:11px"></span>
          </div>
        </div>
      \`).join('');
      document.getElementById('models-list').innerHTML = modelsHtml;
    }

    function toggleKeyVis(modelId) {
      const input = document.getElementById('input-key-' + modelId);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    async function testModel(modelId) {
      const probeEl = document.getElementById('probe-' + modelId);
      const inputKey = document.getElementById('input-key-' + modelId)?.value;
      probeEl.innerHTML = '<span style="color:var(--text-muted)">正在测试...</span>';
      try {
        const res = await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, apiKey: inputKey })
        });
        const d = await res.json();
        if (d.ok) {
          probeEl.innerHTML = \`<span style="color:var(--accent)">✓ 正常 (\${d.latencyMs}ms)</span>\`;
        } else {
          probeEl.innerHTML = \`<span style="color:var(--danger)">✗ 失败: \${d.error || '错误'}</span>\`;
        }
      } catch (err) {
        probeEl.innerHTML = \`<span style="color:var(--danger)">✗ 异常: \${err.message}</span>\`;
      }
    }

    document.getElementById('auto-balance-seats-btn').addEventListener('click', () => {
      const cfg = globalConfig.liveConfig || globalConfig.mockConfig;
      if (!cfg) return;
      const activeModels = cfg.models.filter(m => {
        const v = document.getElementById('input-key-' + m.id)?.value;
        return m.hasKey || (v && v.trim());
      });
      if (activeModels.length === 0) {
        showToast('⚠️ 请至少先填写一个模型的 API Key');
        return;
      }
      const counts = new Map(activeModels.map(m => [m.id, 0]));
      document.querySelectorAll('.seat-sel').forEach(sel => {
        let minCount = Infinity;
        let targetId = activeModels[0].id;
        for (const m of activeModels) {
          const c = counts.get(m.id) || 0;
          if (c < minCount) { minCount = c; targetId = m.id; }
        }
        sel.value = targetId;
        counts.set(targetId, minCount + 1);
      });
      showToast(\`✅ 已按 \${activeModels.length} 个可用模型完成 8 席均衡分配！请点击保存生效。\`);
    });

    document.getElementById('save-cfg-btn').addEventListener('click', async () => {
      const cfg = globalConfig.liveConfig;
      if (!cfg) return showToast('未就绪真实配置');
      const updated = structuredClone(cfg);
      updated.roles.chair = document.getElementById('sel-role-chair').value;
      updated.roles.dedup = document.getElementById('sel-role-dedup').value;
      updated.roles.dealer = document.getElementById('sel-role-dealer').value;

      document.querySelectorAll('.seat-sel').forEach(sel => {
        const idx = Number(sel.dataset.idx);
        if (updated.seats[idx]) updated.seats[idx].modelId = sel.value;
      });

      updated.models = updated.models.map(m => {
        const inputVal = document.getElementById('input-key-' + m.id)?.value;
        const out = { ...m };
        if (inputVal && inputVal.trim()) {
          out.apiKey = inputVal.trim();
        }
        return out;
      });

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated)
        });
        const d = await res.json();
        if (d.ok) {
          showToast('✅ 配置与 API Key 已保存并实时生效！');
          loadConfig();
        } else {
          showToast('保存失败: ' + d.error);
        }
      } catch (e) {
        showToast('保存异常: ' + e.message);
      }
    });

    // Token Meter for Problem input
    const probInput = document.getElementById('sim-problem');
    const meter = document.getElementById('meter-problem');
    const counter = document.getElementById('counter-problem');
    probInput.addEventListener('input', () => {
      const len = probInput.value.length;
      counter.textContent = \`\${len} / 4000 字符\`;
      const pct = Math.min(100, (len / 4000) * 100);
      meter.style.width = pct + '%';
      if (len > 3500) meter.style.background = 'var(--danger)';
      else if (len > 2000) meter.style.background = '#f59e0b';
      else meter.style.background = 'var(--accent)';
    });

    // Simulator
    document.getElementById('run-sim-btn').addEventListener('click', async () => {
      const problem = probInput.value.trim();
      if (!problem) return showToast('请输入架构命题');
      const constraints = document.getElementById('sim-constraints').value.split('\\n').map(s => s.trim()).filter(Boolean);
      const experiment = document.getElementById('sim-experiment').value;
      const mode = document.getElementById('sim-mode').value;

      const btn = document.getElementById('run-sim-btn');
      btn.disabled = true;
      btn.textContent = '推演中...';
      const resCard = document.getElementById('sim-result-card');
      const logEl = document.getElementById('sim-progress-log');
      const outEl = document.getElementById('sim-output-text');
      resCard.style.display = 'block';
      logEl.textContent = '发起会议中...';
      outEl.textContent = '推演进行中，请稍候...';

      try {
        const res = await fetch('/api/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ problem, constraints, experiment, mode })
        });
        const run = await res.json();
        if (!res.ok) throw new Error(run.error || '创建失败');

        // Connect SSE
        const es = new EventSource(\`/api/runs/\${run.id}/stream\`);
        es.onmessage = e => {
          try {
            const data = JSON.parse(e.data);
            if (data.message) logEl.textContent = \`[\${data.phase}] \${data.message}\`;
          } catch {}
        };

        // Poll for completion
        const timer = setInterval(async () => {
          const detailRes = await fetch(\`/api/runs/\${run.id}\`);
          const d = await detailRes.json();
          if (d.status !== 'running') {
            clearInterval(timer);
            es.close();
            btn.disabled = false;
            btn.textContent = '🚀 发起模拟设计会议';
            document.getElementById('sim-status').textContent = d.status === 'completed' ? '已完成' : d.status;
            document.getElementById('sim-status').className = 'status-pill ' + (d.status === 'completed' ? 'success' : 'failed');
            outEl.textContent = d.final?.text || d.error || '无输出方案';
          }
        }, 1000);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '🚀 发起模拟设计会议';
        showToast('执行失败: ' + err.message);
      }
    });

    async function loadHistory() {
      const res = await fetch('/api/runs');
      const data = await res.json();
      const wrap = document.getElementById('runs-table-wrap');
      if (!data.runs || !data.runs.length) {
        wrap.innerHTML = '<p style="color:var(--text-muted);font-size:12px">暂无调用记录</p>';
        return;
      }
      const html = data.runs.map(r => \`
        <div style="background:#0c110f;border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <b>\${r.problem.slice(0, 45)}...</b>
            <div style="font-size:11px;color:var(--text-muted)">\${r.id} · \${r.mode} · \${r.experiment} · \${new Date(r.started_at).toLocaleString('zh-CN')}</div>
          </div>
          <span class="status-pill \${r.status === 'completed' ? 'success' : 'failed'}">\${r.status}</span>
        </div>
      \`).join('');
      wrap.innerHTML = html;
    }

    loadConfig();
  </script>
</body>
</html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, stop } = await createMcpApp();
  const port = Number(process.env.MCP_UI_PORT ?? 4318);
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`  Aha · MCP Agent 架构外脑控制台 (Dedicated WebUI)`);
    console.log(`  访问地址: http://127.0.0.1:${port}`);
    console.log(`======================================================\n`);
  });
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请更改环境变量 MCP_UI_PORT` : e.message);
    process.exitCode = 1;
  });
  for (const s of ['SIGINT', 'SIGTERM']) {
    process.on(s, async () => { await stop(); server.close(); });
  }
}
