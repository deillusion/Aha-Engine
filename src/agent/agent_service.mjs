import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readdir, realpath, stat } from 'node:fs/promises';
import { loadConfig, resolveActiveConfig } from '../config.mjs';
import { NodeFsHost } from '../host/node_fs_host.mjs';
import { AgentSession, createSessionState } from './agent_session.mjs';
import { AgentSessionStore } from './session_store.mjs';
import { ModelGateway } from './model_gateway.mjs';

export class AgentTurnConflictError extends Error {
  constructor(message = '这个会话已有一轮正在处理') {
    super(message);
    this.name = 'AgentTurnConflictError';
    this.code = 'AGENT_TURN_ACTIVE';
  }
}

export class AgentService {
  constructor({
    root,
    dataDir = path.join(root, '.varina/data/sessions'),
    workspaceRoot = path.resolve(root, '..'),
    store = new AgentSessionStore(dataDir),
    configLoader = loadConfig,
    hostFactory = workspace => new NodeFsHost(workspace),
    gatewayFactory = (config, options) => new ModelGateway(config, options)
  } = {}) {
    this.root = root;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.store = store;
    this.configLoader = configLoader;
    this.hostFactory = hostFactory;
    this.gatewayFactory = gatewayFactory;
    this.active = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(128);
    this.initialized = false;
    this.workspaceRealRoot = null;
  }

  async init() {
    if (this.initialized) return this;
    this.workspaceRealRoot = await realpath(this.workspaceRoot);
    if (!(await stat(this.workspaceRealRoot)).isDirectory()) throw new Error('允许的工作区根路径不是目录');
    await this.store.init();
    for (const session of await this.store.list()) {
      if (session.status === 'running') {
        session.status = 'interrupted';
        delete session.active_turn;
        const activeRuntime = session.active_varina_runtime ?? session.active_aha_runtime;
        if (activeRuntime) {
          const runs = session.varina_runs ?? session.aha_runs ?? [];
          const run = runs.find(item => item.run_id === activeRuntime.run_id);
          if (run?.state === 'active') {
            run.state = 'interrupted';
            run.stop_reason = 'process_interrupted';
          }
        }
        await this.store.save(session);
      }
    }
    this.initialized = true;
    return this;
  }

  async resolveWorkspace(requested) {
    const target = path.resolve(requested || this.workspaceRoot);
    const relative = path.relative(this.workspaceRoot, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('会话工作区必须位于允许的工作区根目录内');
    const resolved = await realpath(target);
    const realRelative = path.relative(this.workspaceRealRoot, resolved);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('目录通过符号链接越出了允许范围');
    if (!(await stat(resolved)).isDirectory()) throw new Error('选择的工作区不是目录');
    return resolved;
  }

  async browseDirectories(requested = null) {
    await this.init();
    const current = await this.resolveWorkspace(requested || this.workspaceRealRoot);
    const entries = await readdir(current, { withFileTypes: true });
    const directories = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      try {
        const resolved = await this.resolveWorkspace(candidate);
        directories.push({ name: entry.name, path: resolved, hidden: entry.name.startsWith('.') });
      } catch { /* omit inaccessible and escaping links */ }
    }
    const parentCandidate = path.dirname(current);
    const parent = current === this.workspaceRealRoot ? null : await this.resolveWorkspace(parentCandidate);
    return { root: this.workspaceRealRoot, current, parent, directories };
  }

  async create({ workspace_root, title, mode = 'live' } = {}) {
    await this.init();
    if (!['live', 'mock'].includes(mode)) throw new Error('mode 必须是 live 或 mock');
    const state = createSessionState(await this.resolveWorkspace(workspace_root), { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : '新会话' });
    state.mode = mode;
    await this.store.save(state);
    return state;
  }

  async get(sessionId) { await this.init(); return this.store.get(sessionId); }

  async list(mode) {
    await this.init();
    return (await this.store.list(mode)).map(session => this.summary(session));
  }

  async delete(sessionId) {
    await this.init();
    const slot = this.active.get(sessionId);
    if (slot) {
      slot.controller.abort('session_deleted');
      this.active.delete(sessionId);
    }
    const ok = await this.store.delete(sessionId);
    return { ok, session_id: sessionId };
  }

  async clearMock() {
    await this.init();
    for (const [id, slot] of this.active.entries()) {
      try {
        const s = await this.store.get(id);
        if (s.mode === 'mock') {
          slot.controller.abort('session_deleted');
          this.active.delete(id);
        }
      } catch {}
    }
    const count = await this.store.deleteMany({ mode: 'mock' });
    return { ok: true, count };
  }

  summary(session) {
    return {
      session_id: session.session_id,
      title: session.title,
      status: session.status,
      mode: session.mode,
      workspace_root: session.workspace_root || null,
      current_turn: session.current_turn,
      varina_runs: (session.varina_runs ?? session.aha_runs)?.length ?? 0,
      aha_runs: (session.varina_runs ?? session.aha_runs)?.length ?? 0,
      created_at: session.created_at,
      updated_at: session.updated_at,
      last_message: session.messages?.at(-1)?.content?.slice(0, 160) ?? ''
    };
  }

  subscribe(sessionId, listener) {
    this.events.on(sessionId, listener);
    return () => this.events.off(sessionId, listener);
  }

  async startTurn(sessionId, message, { enable_varina, enable_aha, max_tool_iterations } = {}) {
    await this.init();
    if (this.active.has(sessionId)) throw new AgentTurnConflictError();
    const state = await this.store.get(sessionId);
    const controller = new AbortController();
    const slot = { controller, completion: null };
    this.active.set(sessionId, slot);
    const publish = event => this.events.emit(sessionId, event);
    slot.completion = (async () => {
      const rawConfig = await this.configLoader(this.root, state.mode ?? 'live');
      const { config } = resolveActiveConfig(rawConfig, state.mode ?? 'live');
      const host = await this.hostFactory(state.workspace_root).init();
      const gateway = this.gatewayFactory(config, {
        mode: state.mode ?? 'live', signal: controller.signal,
        onCall: call => {
          state.calls.push(call);
          publish({ event: 'model_call', session_id: sessionId, phase: call.phase, status: call.status, model_id: call.model_id });
        }
      });
      const resolvedMaxIterations = Number(max_tool_iterations)
        || Number(process.env.VARINA_MAX_TOOL_ITERATIONS)
        || Number(process.env.AHA_MAX_TOOL_ITERATIONS)
        || config?.max_tool_iterations
        || config?.agent?.max_tool_iterations
        || 100;
      const agent = new AgentSession({
        state,
        host,
        store: this.store,
        gateway,
        config,
        signal: controller.signal,
        onEvent: publish,
        maxToolIterations: resolvedMaxIterations
      });
      const enabled = enable_varina ?? enable_aha;
      return agent.turn(message, { enable_varina: enabled, enable_aha: enabled });
    })().catch(async error => {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      delete state.active_turn;
      const assistant = {
        id: `msg-service-${Date.now()}`,
        role: 'assistant',
        content: controller.signal.aborted ? '本轮已取消。' : `本轮无法启动：${String(error?.message ?? error).slice(0, 500)}`,
        created_at: new Date().toISOString(),
        partial: true
      };
      state.messages.push(assistant);
      await this.store.save(state).catch(() => {});
      publish({ event: 'agent_done', session_id: sessionId, message: assistant });
      return assistant;
    }).finally(() => {
      if (this.active.get(sessionId) === slot) this.active.delete(sessionId);
    });
    return { session_id: sessionId, completion: slot.completion };
  }

  async turn(sessionId, message, options = {}) {
    const started = await this.startTurn(sessionId, message, options);
    return started.completion;
  }

  cancel(sessionId) {
    const slot = this.active.get(sessionId);
    if (!slot) throw new AgentTurnConflictError('这个会话当前没有正在处理的轮次');
    slot.controller.abort('user_cancelled');
    return { status: 'stopping' };
  }

  async stop() {
    for (const slot of this.active.values()) slot.controller.abort('server_stopping');
    await Promise.allSettled([...this.active.values()].map(slot => slot.completion));
  }
}
