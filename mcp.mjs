import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { AgentService, AgentTurnConflictError } from './src/agent/agent_service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(process.env.AHA_WORKSPACE_ROOT || path.resolve(root, '..'));
const MCP_PROTOCOL_VERSION = '2024-11-05';
let agentService;

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(root, '.env')); } catch {}
}

function log(message) {
  process.stderr.write(`[Aha-MCP] ${new Date().toISOString()} ${message}\n`);
}

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message, data = null) {
  const error = { code, message };
  if (data !== null) error.data = data;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
}

function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const CHAT_TOOL = {
  name: 'aha_chat',
  description: `与 Aha-Grounded 创作 Agent 对话。Agent 会按需读取工作区资料；普通创作和局部修改保持低延迟，复杂机制/架构开放题才启动 ExploreDesign。传回 session_id 可继续同一会话、复用观点板与事实账本。写文件必须在 message 中明确提出。`,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '本轮用户消息，最多 20000 字符' },
      session_id: { type: 'string', description: '可选；继续已有会话' },
      mode: { type: 'string', enum: ['live', 'mock'], default: 'live' }
    },
    required: ['message']
  }
};

const COMPATIBILITY_TOOL = {
  name: 'aha_design_architecture',
  description: `兼容旧客户端的显式深度探索入口。内部已改为 Aha-Grounded Agent：无 Chair、无 R6、无唯一赢家；返回完整观点板、事实账本和正交机制装配。新接入建议使用 aha_chat，并用 /aha 显式触发新的探索。`,
  inputSchema: {
    type: 'object',
    properties: {
      problem: { type: 'string', description: '核心机制或架构困境，最多 4000 字符' },
      constraints: { type: 'array', items: { type: 'string' }, description: '最多 20 条硬约束' },
      context_summary: { type: 'string', description: '已核查背景摘要，最多 3000 字符；不要粘贴源码' },
      experiment: { type: 'string', enum: ['single', 'treatment'], description: '兼容字段；新引擎固定最多五轮并支持早停' },
      mode: { type: 'string', enum: ['live', 'mock'], default: 'live' },
      use_domain_operators: { type: 'boolean', description: '兼容字段；新引擎使用版本化算子库' }
    },
    required: ['problem']
  }
};

const TOOLS = [CHAT_TOOL, COMPATIBILITY_TOOL];

function validateDistilledInput({ problem, constraints = [], context_summary = '' }) {
  if (typeof problem !== 'string' || !problem.trim()) throw new Error('缺少必填参数 problem');
  if (problem.length > 4000) throw new Error(`【Token 防爆拦截】problem 长度达 ${problem.length} 字符（上限 4000 字符）。请先提炼核心矛盾。`);
  if (typeof context_summary !== 'string' || context_summary.length > 3000) throw new Error('【Token 防爆拦截】context_summary 上限为 3000 字符。');
  if (!Array.isArray(constraints) || constraints.length > 20 || constraints.some(item => typeof item !== 'string' || item.length > 500)) throw new Error('constraints 最多 20 条，每条不超过 500 字符');
  const fences = `${problem}${context_summary}`.match(/```[\s\S]*?```/g) ?? [];
  if (fences.reduce((sum, block) => sum + block.length, 0) > 1500) throw new Error('【Token 防爆拦截】检测到大段源码围栏。请改用自然语言概述关键约束。');
}

async function runChat(args) {
  const message = args?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 20000) throw new Error('message 必填且最多 20000 字符');
  let session;
  if (args.session_id) session = await agentService.get(args.session_id);
  else session = await agentService.create({ mode: args.mode ?? 'live', title: message.trim().slice(0, 48) });
  const unsubscribe = agentService.subscribe(session.session_id, event => {
    if (event.message && event.phase?.startsWith('aha_')) sendNotification('notifications/message', { level: 'info', logger: 'aha', data: `[Aha] R${event.round ?? '-'} ${event.message}` });
    else if (event.event === 'tool_call') sendNotification('notifications/message', { level: 'info', logger: 'aha', data: `[Aha] 使用 ${event.name}` });
  });
  try {
    const answer = await agentService.turn(session.session_id, message);
    return { sessionId: session.session_id, answer };
  } finally { unsubscribe(); }
}

async function handleToolCall(id, name, args = {}) {
  try {
    if (name === 'aha_chat') {
      const { sessionId, answer } = await runChat(args);
      return sendResponse(id, {
        content: [{ type: 'text', text: `${answer.content}\n\n---\n会话 ID：${sessionId}（后续调用传回此 ID 可继续收敛）` }],
        structuredContent: { session_id: sessionId, partial: answer.partial === true }
      });
    }
    if (name !== 'aha_design_architecture') return sendError(id, -32601, `未知工具：${name}`);
    validateDistilledInput(args);
    const constraints = (args.constraints ?? []).map(item => item.trim()).filter(Boolean);
    const context = args.context_summary?.trim() ? `\n\n已核查背景：${args.context_summary.trim()}` : '';
    const prompt = `/aha ${args.problem.trim()}${context}${constraints.length ? `\n\n硬约束：\n${constraints.map(item => `- ${item}`).join('\n')}` : ''}`;
    const { sessionId, answer } = await runChat({ message: prompt, mode: args.mode ?? 'live' });
    const localWebUrl = `http://127.0.0.1:4317/#${sessionId}`;
    return sendResponse(id, {
      content: [{
        type: 'text',
        text: `${answer.content}\n\n> 候选方案排序已取消：以上仅为可追溯的机制装配候选，决策权保留给用户。\n\n---\n**🔍 查看完整推演血统与演化板**：若本地工作台已启动，可访问 [${localWebUrl}](${localWebUrl})。`
      }],
      structuredContent: { session_id: sessionId }
    });
  } catch (error) {
    log(`Tool error: ${error.message}`);
    const code = error instanceof AgentTurnConflictError ? -32000 : error.code === 'ENOENT' ? -32602 : -32603;
    return sendError(id, code, error.message);
  }
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('Client initialized');
    return;
  }
  if (method === 'initialize') return sendResponse(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false }, logging: {} },
    serverInfo: { name: 'aha-architect', version: '2.0.0' }
  });
  if (method === 'ping') return sendResponse(id, {});
  if (method === 'tools/list') return sendResponse(id, { tools: TOOLS });
  if (method === 'tools/call') return void handleToolCall(id, params?.name, params?.arguments);
  if (method === 'resources/list') return sendResponse(id, { resources: [] });
  if (method === 'prompts/list') return sendResponse(id, { prompts: [] });
  return sendError(id, -32601, `Method not found: ${method}`);
}

export async function startMcpServer() {
  agentService = new AgentService({ root, workspaceRoot });
  await agentService.init();
  const lines = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  lines.on('close', () => { void agentService.stop(); });
  lines.on('line', line => {
    if (!line.trim()) return;
    try { handleMessage(JSON.parse(line)); }
    catch (error) { sendError(null, -32700, `Parse error: ${error.message}`); }
  });
  log('Aha-Grounded Agent MCP Server started on stdio');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startMcpServer();
