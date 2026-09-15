import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { RunService, RunConflictError } from './src/application/run_service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(root, '.env')); } catch {}
}

const MCP_PROTOCOL_VERSION = '2024-11-05';
let runService = null;

function log(msg) {
  process.stderr.write(`[Aha-MCP] ${new Date().toISOString()} ${msg}\n`);
}

function sendResponse(id, result) {
  const message = { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendError(id, code, message, data = null) {
  const errorObj = { code, message };
  if (data !== null) errorObj.data = data;
  const response = { jsonrpc: '2.0', id, error: errorObj };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendNotification(method, params) {
  const notification = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(notification) + '\n');
}

const TOOLS = [
  {
    name: 'aha_design_architecture',
    description: `【Aha 架构与机制共创外脑】
调用多模型异构席位（Gemini, 智谱GLM, DeepSeek等），在数十种专业认知算子（第一性原理、因果倒置、机制移植、隐藏变量等）刺激下，为复杂架构方案、系统机制设计与技术路线分歧生成多份高创新度、高可行性的候选方案树，并由 Chair 进行客观对比排序。

⚠️【调用端极为重要的 Token 防爆与浓缩规则】：
绝对禁止直接灌入整个代码库、大段源文件或冗长日志（严禁贴数百行源码）！Aha 会对问题进行多轮多席位深度推演（通常产生 10~55 次并发模型调用），若传入未浓缩的源码将导致 50+ 倍的灾难性 Token 消耗。
作为调用端 Agent，你的核心职责是充当“信息过滤器与病灶提炼器”：
1. problem: 提炼核心架构困境或机制设计目标（清晰陈述死锁矛盾，为什么常规解法行不通，限制4000字以内）。
2. constraints: 提炼不可违背的硬约束列表（如：延迟门槛、不能引入外部组件、保持向下兼容等）。
3. context_summary: 仅用自然语言概述现有架构拓扑与关键数据流，禁止贴原始代码。`,
    inputSchema: {
      type: 'object',
      properties: {
        problem: {
          type: 'string',
          description: '核心架构困境、机制设计目标或技术路线分歧（必须提炼死锁矛盾，最多 4000 字符，严禁贴大段源码）'
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: '不可违背的硬约束列表（最多 20 条，每条不超过 500 字符，例如性能指标、依赖限制等）'
        },
        context_summary: {
          type: 'string',
          description: '浓缩的现状架构拓扑与数据流概述（仅用自然语言概括，最多 3000 字符，严禁包含源代码文件）'
        },
        experiment: {
          type: 'string',
          enum: ['single', 'treatment'],
          description: "实验模式：'single'（推荐：单轮 8 席快速探索 + Chair 排序，耗时约 15 秒），'treatment'（完整 5 轮深度演化，耗时约 90 秒）",
          default: 'single'
        },
        mode: {
          type: 'string',
          enum: ['live', 'mock'],
          description: "运行模式：'live'（调用真实配置的大模型），'mock'（离线模拟演示，零费用）",
          default: 'live'
        },
        use_domain_operators: {
          type: 'boolean',
          description: "是否启用行业通用诊断视角。启用后 Dealer 按适用范围选择，且每个席位最多抽取一张。默认 false",
          default: false
        }
      },
      required: ['problem']
    }
  }
];

async function handleToolCall(id, name, args) {
  if (name !== 'aha_design_architecture') {
    return sendError(id, -32601, `未知工具：${name}`);
  }

  const {
    problem,
    constraints = [],
    context_summary = '',
    experiment = 'single',
    mode = 'live',
    use_domain_operators = false
  } = args || {};

  // Strict caller distillation enforcement (Token flood firewall)
  if (!problem || typeof problem !== 'string' || !problem.trim()) {
    return sendError(id, -32602, '缺少必填参数 problem');
  }

  if (problem.length > 4000) {
    return sendError(id, -32602, `【Token 防爆拦截】problem 长度达 ${problem.length} 字符（上限 4000 字符）。请作为调用端 Agent 先提炼核心矛盾与设计目标，严禁直接转储源文件代码。`);
  }

  if (context_summary && context_summary.length > 3000) {
    return sendError(id, -32602, `【Token 防爆拦截】context_summary 长度达 ${context_summary.length} 字符（上限 3000 字符）。请仅用简明自然语言概述关键流向，避免粘贴代码。`);
  }

  if (!Array.isArray(constraints)) {
    return sendError(id, -32602, 'constraints 必须为字符串数组');
  }

  if (constraints.length > 20) {
    return sendError(id, -32602, 'constraints 超过 20 条，请提炼最关键的硬约束');
  }

  for (const c of constraints) {
    if (typeof c !== 'string' || c.length > 500) {
      return sendError(id, -32602, '每条约束不能超过 500 字符');
    }
  }

  // Check code blocks flood in problem
  const codeBlockMatches = (problem + context_summary).match(/```[\s\S]*?```/g) || [];
  const codeLength = codeBlockMatches.reduce((acc, cur) => acc + cur.length, 0);
  if (codeLength > 1500) {
    return sendError(id, -32602, '【Token 防爆拦截】检测到大段源码围栏（>1500字符）。Aha 用于高阶机制与架构推演，请勿粘贴大段实现代码，改用自然语言描述架构与协议。');
  }

  // Combine context_summary into problem if provided
  let enrichedProblem = problem.trim();
  if (context_summary && context_summary.trim()) {
    enrichedProblem = `【现状背景与拓扑】\n${context_summary.trim()}\n\n【待解架构命题】\n${enrichedProblem}`;
  }

  const cleanConstraints = constraints.map(c => String(c).trim()).filter(Boolean);

  const runInput = {
    problem: enrichedProblem,
    constraints: cleanConstraints,
    seed: Math.floor(Math.random() * 1000000),
    mode,
    experiment: ['single', 'treatment'].includes(experiment) ? experiment : 'single',
    use_operators: true,
    use_domain_operators: use_domain_operators === true
  };

  // Progress emitter
  const onEvent = ({ phase, round, message }) => {
    sendNotification('notifications/message', {
      level: 'info',
      logger: 'aha',
      data: `[Aha 进度] R${round} ${phase}: ${message}`
    });
  };

  try {
    const started = await runService.startRun(runInput, { onEvent, mockDelayMs: 20 });
    const { run } = started;
    log(`Run started: ${run.id} (${run.mode}, ${run.experiment}${run.routing?.isAdaptive ? `, adaptive: ${run.routing.activeModels.join('+')}` : ''})`);
    await started.completion;
    
    if (run.status !== 'completed') {
      return sendResponse(id, {
        content: [
          {
            type: 'text',
            text: `❌ Aha 会议未能顺利完成。\n状态: ${run.status}\n错误信息: ${run.error || '未知错误'}\n记录ID: ${run.id}`
          }
        ],
        isError: true
      });
    }

    const localWebUrl = `http://127.0.0.1:4317/?run=${run.id}`;
    let outputText = run.final?.text || '（无方案输出）';
    
    outputText += `\n\n---\n**🔍 查看完整推演血统与演化板**：若本地工作台已启动，可访问 [${localWebUrl}](${localWebUrl}) 查看各席位原始推演、原子观点去重记录及算子激活情况。`;

    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: outputText
        }
      ]
    });
  } catch (err) {
    log(`Run error: ${err.message}`);
    sendError(id, err instanceof RunConflictError ? -32000 : -32603, `执行 Aha 会议失败：${err.message}`);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { jsonrpc, id, method, params } = msg;
  if (jsonrpc !== '2.0') return;

  // Handle Notifications (no ID)
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      log('Client initialized');
    }
    return;
  }

  // Handle Requests
  switch (method) {
    case 'initialize': {
      sendResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          logging: {}
        },
        serverInfo: {
          name: 'aha-architect',
          version: '1.0.0'
        }
      });
      break;
    }

    case 'ping': {
      sendResponse(id, {});
      break;
    }

    case 'tools/list': {
      sendResponse(id, { tools: TOOLS });
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      handleToolCall(id, name, args).catch(err => {
        sendError(id, -32603, `工具执行未捕获异常: ${err.message}`);
      });
      break;
    }

    case 'resources/list': {
      sendResponse(id, { resources: [] });
      break;
    }

    case 'prompts/list': {
      sendResponse(id, { prompts: [] });
      break;
    }

    default: {
      sendError(id, -32601, `Method not found: ${method}`);
      break;
    }
  }
}

export async function startMcpServer() {
  runService = new RunService({ root, mockDelayMs: 20 });
  await runService.init();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  rl.on('close', () => { void runService.stop(); });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg);
    } catch (e) {
      log(`JSON parse error: ${e.message}`);
      sendError(null, -32700, 'Parse error: Invalid JSON');
    }
  });

  log('Aha MCP Server started on stdio');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMcpServer();
}
