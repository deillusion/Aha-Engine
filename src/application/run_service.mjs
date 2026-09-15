import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../config.mjs';
import { Store, summary } from '../store.mjs';
import { createRun } from './run_factory.mjs';
import { executeRun } from './run_executor.mjs';

export class RunConflictError extends Error {
  constructor(message = '已有会议运行中，请等待完成或停止当前会议') {
    super(message);
    this.name = 'RunConflictError';
    this.code = 'RUN_ACTIVE';
  }
}

export class RunService {
  constructor({ root, dataDir = path.join(root, 'data/runs'), mockDelayMs = 180, store = new Store(dataDir), configLoader = loadConfig } = {}) {
    this.root = root;
    this.store = store;
    this.mockDelayMs = mockDelayMs;
    this.configLoader = configLoader;
    this.events = new EventEmitter();
    this.events.setMaxListeners(64);
    this.active = null;
    this.initialized = false;
  }

  async init({ recover = true } = {}) {
    if (this.initialized) return this;
    await this.store.init();
    // A sibling Web/CLI/MCP process may legitimately own the running record.
    if (recover && !await this.store.hasActiveRunLease()) await this.store.recover();
    this.initialized = true;
    return this;
  }

  get activeRunId() { return this.active?.run?.id ?? null; }

  subscribe(runId, listener) {
    this.events.on(runId, listener);
    return () => this.events.off(runId, listener);
  }

  async startRun(input, { onEvent, mockDelayMs = this.mockDelayMs } = {}) {
    if (this.active) throw new RunConflictError();
    const slot = { run: { id: null }, controller: new AbortController(), completion: null, releaseLease: null };
    this.active = slot;
    try {
      await this.init();
      const mode = input.mode || 'live';
      const config = await this.configLoader(this.root, mode);
      const run = createRun({ ...input, mode }, config);
      slot.run = run;
      try { slot.releaseLease = await this.store.acquireRunLease(run.id); }
      catch (error) {
        if (error.code === 'RUN_LEASED') throw new RunConflictError(error.message);
        throw error;
      }
      await this.store.save(run);
      const publish = data => {
        this.events.emit(run.id, data);
        onEvent?.(data);
      };
      slot.completion = executeRun(run, {
        store: this.store,
        signal: slot.controller.signal,
        mockDelayMs,
        onEvent: publish
      }).catch(async error => {
        run.status = 'failed';
        run.error = `存储或执行失败：${error.message}`;
        run.completed_at = new Date().toISOString();
        await this.store.save(run).catch(() => {});
        return run;
      }).finally(async () => {
        await slot.releaseLease?.();
        if (this.active === slot) this.active = null;
      });
      return { run, completion: slot.completion };
    } catch (error) {
      await slot.releaseLease?.();
      if (this.active === slot) this.active = null;
      throw error;
    }
  }

  async run(input, options) {
    const started = await this.startRun(input, options);
    return started.completion;
  }

  cancel(runId) {
    if (this.active?.run?.id !== runId) throw new RunConflictError('此会议未在运行');
    this.active.controller.abort();
    return { status: 'stopping' };
  }

  async get(runId) { await this.init(); return this.store.get(runId); }
  async list(mode) { await this.init(); return this.store.list(mode); }
  summarize(run) { return summary(run); }

  async stop() {
    this.active?.controller.abort();
    await this.active?.completion;
  }
}
