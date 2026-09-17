import { randomUUID } from 'node:crypto';
import { AhaGateController } from './gate.mjs';
import { MAIN_AGENT_SYSTEM_PROMPT, trustedStateMessage } from './prompts.mjs';
import { agentTurnSchema, validateJsonSchema } from './schemas.mjs';
import { generationFor } from './model_gateway.mjs';
import { applyToolResultBudget, renderToolResults } from './tool_result_budget.mjs';
import { ExploreDesignEngine } from '../aha/explore_design.mjs';

function cleanError(error) {
  const code = error?.code ?? 'TOOL_ERROR';
  const message = String(error?.message ?? error).replace(/[A-Z]:\\[^\s]+/gi, '[workspace path]').slice(0, 500);
  return { code, message };
}

function parseArguments(call) {
  let args;
  try { args = JSON.parse(call.arguments_json); }
  catch { throw new Error(`${call.name} 的 arguments_json 不是有效 JSON`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${call.name} 参数必须是对象`);
  return args;
}

function writeIntent(message) {
  if (/(?:不要|不用|别)(?:[^。！？\n]{0,12})(?:写|改|保存|落盘|编辑|创建)/.test(message)) return false;
  if (/(?:如何|怎么|怎样)(?:[^。！？\n]{0,16})(?:修改|更新|编辑|保存|写入|落盘)/.test(message) && !/(?:请|帮我|替我|需要|直接)/.test(message)) return false;
  return /^(?:修改|更新|编辑|重写|替换|保存|写入|创建|删除)|(?:请|帮我|麻烦|需要|直接|现在|替我)(?:[^。！？\n]{0,48})(?:保存|写入|落盘|修改|更新|编辑|重写|替换|创建|删除)|(?:把|将)(?:[^。！？\n]{1,100})(?:改成|修改|更新|编辑|重写|替换|保存|写入|落盘|删除)/.test(message);
}

function restoreIntent(message) {
  return /(?:恢复|还原|撤销).*(?:备份|版本|修改)|(?:恢复|还原)\s*backup-/i.test(message);
}

function assertString(value, name, { optional = false, max = 20000 } = {}) {
  if (optional && value == null) return;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new Error(`${name} 参数无效`);
}

function upsertManifest(session, read, snapshotId = `read-${Date.now()}`) {
  const next = {
    file_path: read.filePath,
    content_hash: read.contentHash,
    loaded_at: new Date().toISOString(),
    snapshot_id: snapshotId
  };
  const index = session.loaded_files_manifest.findIndex(item => item.file_path === read.filePath);
  if (index === -1) session.loaded_files_manifest.push(next);
  else session.loaded_files_manifest[index] = next;
}

async function refreshLoadedFacts(session, host) {
  for (const manifest of session.loaded_files_manifest) {
    let changed = false;
    try { changed = (await host.readFile(manifest.file_path)).contentHash !== manifest.content_hash; }
    catch { changed = true; }
    if (!changed) continue;
    for (const run of session.aha_runs) {
      for (const fact of run.final_fact_ledger ?? []) {
        if (fact.evidence?.some(evidence => evidence.filePath === manifest.file_path)) fact.status = 'stale';
      }
    }
  }
}

export class AgentSession {
  constructor({ state, host, store, gateway, config, signal, onEvent = () => {}, gate = new AhaGateController(), maxToolIterations = 8 }) {
    this.state = state;
    this.host = host;
    this.store = store;
    this.gateway = gateway;
    this.config = config;
    this.signal = signal;
    this.onEvent = onEvent;
    this.gate = gate;
    this.maxToolIterations = maxToolIterations;
  }

  async save() {
    this.state.updated_at = new Date().toISOString();
    await this.store.save(this.state);
  }

  modelMessages(currentUserMessage) {
    const prior = this.state.messages.slice(0, -1).map(message => ({ role: message.role, content: message.content }));
    const systemNotes = [];
    if (this.turnEnableAha === false) {
      systemNotes.push({ role: 'system', content: 'Notice: Aha deep exploration is currently DISABLED by the user for this turn. Do NOT call ExploreDesign. Answer questions directly in conversation, and use workspace tools (Read, Grep, Glob, Edit, Write) as requested.' });
    } else if (this.turnEnableAha === true) {
      systemNotes.push({ role: 'system', content: 'Notice: Aha deep exploration is ENABLED by the user for this turn. If the query involves game mechanics, creative system design, numerical boundaries, or architectural trade-offs, you may invoke ExploreDesign without requiring an explicit /aha command.' });
    }
    return [
      { role: 'system', content: MAIN_AGENT_SYSTEM_PROMPT },
      ...prior,
      { role: 'system', content: trustedStateMessage(this.state) },
      ...systemNotes,
      { role: 'user', content: currentUserMessage }
    ];
  }

  async turn(userMessage, { enable_aha } = {}) {
    assertString(userMessage, 'message', { max: 20000 });
    this.signal?.throwIfAborted();
    this.turnEnableAha = enable_aha;
    delete this.state.pending_confirmation;
    await refreshLoadedFacts(this.state, this.host);
    this.state.current_turn += 1;
    if (this.state.title === '新会话' || this.state.title === 'CLI 会话') this.state.title = userMessage.trim().replace(/\s+/g, ' ').slice(0, 48);
    this.state.messages.push({ id: `msg-${randomUUID().slice(0, 8)}`, role: 'user', content: userMessage.trim(), created_at: new Date().toISOString() });
    this.state.status = 'running';
    this.state.active_turn = {
      turn: this.state.current_turn,
      steps: []
    };
    await this.save();
    const messages = this.modelMessages(userMessage.trim());
    const toolResultsById = new Map();
    let finalMessage = '';
    let partial = false;
    try {
      for (let iteration = 1; iteration <= this.maxToolIterations; iteration++) {
        this.signal?.throwIfAborted();
        const thinkStart = Date.now();
        const thinkingStep = {
          id: `step-think-${this.state.current_turn}-${iteration}`,
          type: 'thinking',
          iteration,
          status: 'running',
          title: `思考过程 · 第 ${iteration} 轮`,
          content: '',
          started_at: thinkStart
        };
        this.state.active_turn.steps.push(thinkingStep);
        await this.save();
        this.onEvent({
          event: 'agent_thinking',
          session_id: this.state.session_id,
          turn: this.state.current_turn,
          iteration,
          step_id: thinkingStep.id,
          status: 'running',
          content: ''
        });
        const output = await this.gateway.invoke({
          phase: 'agent_turn', modelId: this.config.roles.main ?? this.config.roles.chair,
          messages, schema: agentTurnSchema, generation: generationFor(this.config, 'agent_turn'),
          context: { turn: this.state.current_turn, iteration, enable_aha: this.turnEnableAha },
          logicalId: `${this.state.session_id}:T${this.state.current_turn}:I${iteration}`
        });
        validateJsonSchema(output, agentTurnSchema);
        thinkingStep.status = 'completed';
        thinkingStep.completed_at = Date.now();
        thinkingStep.duration_ms = thinkingStep.completed_at - thinkStart;
        thinkingStep.content = output.thought || (output.tool_calls?.length ? output.message : '') || '';
        await this.save();
        this.onEvent({
          event: 'agent_thinking',
          session_id: this.state.session_id,
          turn: this.state.current_turn,
          iteration,
          step_id: thinkingStep.id,
          status: 'completed',
          content: thinkingStep.content,
          duration_ms: thinkingStep.duration_ms
        });

        const ids = output.tool_calls.map(call => call.id);
        if (new Set(ids).size !== ids.length || ids.some(id => !id.trim())) throw new Error('tool_call_id 为空或重复');
        if (!output.tool_calls.length) {
          if (!output.done) throw new Error('没有工具调用时 done 必须为 true');
          finalMessage = output.message.trim();
          if (!finalMessage) throw new Error('Agent 最终回答为空');
          break;
        }
        if (output.done) throw new Error('仍有工具调用时 done 不能为 true');
        messages.push({ role: 'assistant', content: JSON.stringify(output) });
        const results = [];
        for (const call of output.tool_calls) {
          let parsedArgs = null;
          try { parsedArgs = JSON.parse(call.arguments_json); } catch {}
          let toolStep = this.state.active_turn.steps.find(s => s.id === call.id);
          if (!toolStep) {
            toolStep = {
              id: call.id,
              type: 'tool',
              name: call.name,
              input: parsedArgs,
              arguments_json: call.arguments_json,
              status: 'running',
              iteration
            };
            this.state.active_turn.steps.push(toolStep);
            await this.save();
          }
          let result = toolResultsById.get(call.id);
          if (!result) {
            result = await this.executeTool(call, userMessage.trim());
            toolResultsById.set(call.id, result);
          }
          toolStep.status = result.ok ? 'completed' : 'failed';
          toolStep.ok = result.ok;
          toolStep.result = result.result;
          toolStep.error = result.error;
          await this.save();
          results.push({ id: call.id, name: call.name, ...result });
        }
        // 体积闸门：单条超限（Grep 20K，其余 50K）或单轮合计超 200K 的结果落盘，
        // 只在对话里留预览与 persisted_path。见 src/agent/tool_result_budget.mjs。
        const budgeted = await applyToolResultBudget(results, {
          label: `T${this.state.current_turn}-I${iteration}`,
          persist: (label, text) => this.host.persistToolResult(`${this.state.session_id}-${label}`, text)
        });
        if (budgeted.persisted.length) {
          this.onEvent({ event: 'tool_results_persisted', session_id: this.state.session_id, turn: this.state.current_turn, iteration, persisted: budgeted.persisted });
        }
        messages.push({ role: 'user', content: renderToolResults(budgeted.results) });
        await this.save();
      }
      if (!finalMessage) {
        partial = true;
        finalMessage = `本轮达到 ${this.maxToolIterations} 次工具续轮上限，已保留当前会话和工具结果，但任务尚未完整结束。请缩小范围或继续下一条消息。`;
      }
      this.state.status = 'idle';
    } catch (error) {
      this.state.status = this.signal?.aborted ? 'cancelled' : 'failed';
      finalMessage = this.signal?.aborted ? '本轮已取消，已完成的读取与 Aha 中间结果已经保留。' : `本轮未能完成：${cleanError(error).message}`;
      partial = true;
    }
    const completedSteps = this.state.active_turn?.steps ? [...this.state.active_turn.steps] : [];
    delete this.state.active_turn;
    const assistantMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`, role: 'assistant', content: finalMessage,
      created_at: new Date().toISOString(), partial,
      steps: completedSteps
    };
    const turnAhaRun = [...this.state.aha_runs].reverse().find(run => run.turn_invoked === this.state.current_turn);
    if (turnAhaRun) assistantMessage.aha_run_id = turnAhaRun.run_id;
    if (this.state.pending_confirmation) assistantMessage.confirmation = this.state.pending_confirmation;
    this.state.messages.push(assistantMessage);
    await this.save();
    this.onEvent({ event: 'agent_done', session_id: this.state.session_id, turn: this.state.current_turn, message: assistantMessage });
    return assistantMessage;
  }

  async executeTool(call, currentUserMessage) {
    let args;
    try {
      args = parseArguments(call);
    } catch (e) {
      const cleaned = cleanError(e);
      this.onEvent({
        event: 'tool_result',
        session_id: this.state.session_id,
        turn: this.state.current_turn,
        tool_call_id: call.id,
        name: call.name,
        ok: false,
        error: cleaned
      });
      return { ok: false, error: cleaned };
    }
    this.onEvent({
      event: 'tool_call',
      session_id: this.state.session_id,
      turn: this.state.current_turn,
      tool_call_id: call.id,
      name: call.name,
      input: args,
      arguments_json: call.arguments_json,
      status: 'running'
    });
    try {
      let result;
      if (call.name === 'Read') {
        assertString(args.file_path, 'file_path');
        result = await this.host.readFile(args.file_path, { startLine: args.start_line ?? 1, endLine: args.end_line ?? null, signal: this.signal });
        upsertManifest(this.state, result);
      } else if (call.name === 'Glob') {
        result = await this.host.listFiles(args.pattern ?? '**/*', { maxResults: args.max_results ?? 200, signal: this.signal });
      } else if (call.name === 'Grep') {
        assertString(args.query, 'query', { max: 500 });
        result = await this.host.grep(args.query, { isRegex: args.is_regex === true, pathFilter: args.path_filter ?? '**/*', maxResults: args.max_results ?? 100, signal: this.signal });
      } else if (call.name === 'Edit') {
        if (!writeIntent(currentUserMessage)) throw new Error('用户本轮没有明确要求写入，Edit 已拒绝');
        for (const key of ['file_path', 'old_string', 'new_string', 'expected_hash']) assertString(args[key], key, { max: key === 'new_string' ? 200000 : 50000 });
        result = await this.host.editFile(args.file_path, args.old_string, args.new_string, { expectedHash: args.expected_hash, createBackup: true });
      } else if (call.name === 'Write') {
        if (!writeIntent(currentUserMessage)) throw new Error('用户本轮没有明确要求写入，Write 已拒绝');
        assertString(args.file_path, 'file_path'); assertString(args.content, 'content', { optional: true, max: 500000 });
        if (args.expected_hash !== null) assertString(args.expected_hash, 'expected_hash');
        result = await this.host.writeFile(args.file_path, args.content ?? '', { expectedHash: args.expected_hash ?? null, createBackup: true });
      } else if (call.name === 'RestoreBackup') {
        if (!restoreIntent(currentUserMessage)) throw new Error('用户本轮没有明确要求恢复备份');
        assertString(args.backup_id, 'backup_id');
        result = await this.host.restoreBackup(args.backup_id);
      } else if (call.name === 'ListBackups') {
        result = await this.host.listBackups(args.file_path ?? null);
      } else if (call.name === 'ExploreDesign') {
        if (this.turnEnableAha === false) throw new Error('Aha 深度探索已被用户关闭。请直接在对话中分析回答，或使用工作区工具。');
        result = await this.explore(args, currentUserMessage);
      } else throw new Error(`未知工具：${call.name}`);
      this.onEvent({
        event: 'tool_result',
        session_id: this.state.session_id,
        turn: this.state.current_turn,
        tool_call_id: call.id,
        name: call.name,
        ok: true,
        result,
        status: 'completed'
      });
      return { ok: true, result };
    } catch (error) {
      const cleaned = cleanError(error);
      this.onEvent({
        event: 'tool_result',
        session_id: this.state.session_id,
        turn: this.state.current_turn,
        tool_call_id: call.id,
        name: call.name,
        ok: false,
        error: cleaned,
        status: 'failed'
      });
      return { ok: false, error: cleaned };
    }
  }

  async explore(args, currentUserMessage) {
    assertString(args.problem, 'problem', { max: 10000 });
    if (!Array.isArray(args.constraints) || args.constraints.length > 40 || args.constraints.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('constraints 参数无效');
    assertString(args.code_context ?? '', 'code_context', { optional: true, max: 12000 });
    if (!Array.isArray(args.relevant_files) || args.relevant_files.some(item => typeof item !== 'string')) throw new Error('relevant_files 参数无效');
    const isExplicit = this.turnEnableAha === true || currentUserMessage.trim().startsWith('/aha');
    const gate = await this.gate.evaluateTrigger({
      isExplicitAha: isExplicit,
      sessionState: this.state,
      signal: this.signal
    });
    if (gate.decision === 'CONFIRM') {
      this.state.pending_confirmation = { id: `confirm-${randomUUID().slice(0, 8)}`, ...gate, original_problem: args.problem };
      return { confirmation_required: true, ...this.state.pending_confirmation };
    }
    if (gate.decision !== 'ALLOW') return { started: false, reason: gate.reason };
    delete this.state.pending_confirmation;
    const runRecord = {
      run_id: `aha-${Date.now()}-${randomUUID().slice(0, 6)}`,
      turn_invoked: this.state.current_turn,
      trigger_mode: gate.trigger_mode,
      problem: args.problem.trim(), rounds_executed: 0, state: 'active'
    };
    this.state.aha_runs.push(runRecord);
    await this.save();
    const engine = new ExploreDesignEngine({
      host: this.host, gateway: this.gateway, config: this.config, signal: this.signal,
      onEvent: this.onEvent,
      checkpoint: async runtime => {
        this.state.active_aha_runtime = runtime;
        await this.save();
      }
    });
    const handoff = await engine.run({
      sessionId: this.state.session_id, runId: runRecord.run_id,
      problem: args.problem.trim(), constraints: args.constraints.map(item => item.trim()).filter(Boolean),
      codeContext: args.code_context ?? '', relevantFiles: args.relevant_files,
      seed: this.state.current_turn * 1009 + this.state.aha_runs.length
    });
    runRecord.rounds_executed = handoff.rounds_executed;
    runRecord.state = handoff.state;
    runRecord.stop_reason = handoff.stop_reason;
    runRecord.final_meeting_board = handoff.meeting_board;
    runRecord.final_fact_ledger = handoff.fact_ledger;
    runRecord.solutions = handoff.solutions;
    runRecord.rejected_directions = handoff.rejected_directions;
    runRecord.degradations = handoff.degradations;
    runRecord.unresolved_questions = handoff.unresolved_questions;
    runRecord.round_records = handoff.round_records;
    runRecord.seat_responses = handoff.seat_responses;
    runRecord.board_history = handoff.board_history;
    runRecord.repository_snapshot_id = handoff.repository_snapshot_id;
    for (const manifest of handoff.loaded_files_manifest) {
      const index = this.state.loaded_files_manifest.findIndex(item => item.file_path === manifest.file_path);
      if (index === -1) this.state.loaded_files_manifest.push(manifest);
      else this.state.loaded_files_manifest[index] = manifest;
    }
    delete this.state.active_aha_runtime;
    await this.save();
    return handoff;
  }
}

export function createSessionState(workspaceRoot, { title = '新会话' } = {}) {
  const now = new Date().toISOString();
  return {
    session_id: `session-${Date.now()}-${randomUUID().slice(0, 8)}`,
    title, created_at: now, updated_at: now, workspace_root: workspaceRoot,
    current_turn: 0, status: 'idle', messages: [], aha_runs: [],
    loaded_files_manifest: [], calls: [], pending_confirmation: null,
    active_turn: null
  };
}
