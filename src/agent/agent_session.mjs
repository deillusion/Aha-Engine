import { randomUUID } from 'node:crypto';
import { AhaGateController, VarinaGateController } from './gate.mjs';
import { MAIN_AGENT_SYSTEM_PROMPT, projectContextMessage, trustedStateMessage } from './prompts.mjs';
// agentTurnSchema removed: Main agent now uses native tool calling / resilient ReAct
import { generationFor } from './model_gateway.mjs';
import { applyToolResultBudget, renderToolResults } from './tool_result_budget.mjs';
import { ExploreDesignEngine } from '../varina/explore_design.mjs';
import { renderVarinaMarkdown } from './project_manifest.mjs';
import {
  CHECKPOINT_HEADER,
  SUMMARY_PREFIX,
  ensureMessageTurns,
  shouldCompactPreTurn,
  compactSessionHistory,
  compactWorkingMessages,
  resolveCompactionThresholds,
  approxTokens
} from './compaction.mjs';

function cleanError(error) {
  const code = error?.code ?? 'TOOL_ERROR';
  const message = String(error?.message ?? error).replace(/[A-Z]:\\[^\s]+/gi, '[workspace path]').slice(0, 500);
  return { code, message };
}

function parseArguments(call) {
  let args;
  if (typeof call.arguments_json === 'object' && call.arguments_json !== null) {
    args = call.arguments_json;
  } else {
    try { args = JSON.parse(call.arguments_json); }
    catch { throw new Error(`${call.name} 的 arguments_json 不是有效 JSON`); }
  }
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

function initMode(message) {
  if (/^\/init\s+--refresh(?:\s+|$)/i.test(message.trim())) return 'refresh';
  if (/^\/init(?:\s+|$)/i.test(message.trim())) return 'create';
  return null;
}

function assertString(value, name, { optional = false, max = 20000 } = {}) {
  if (optional && value == null) return;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new Error(`${name} 参数无效`);
}

function tracedUserConstraints(constraints, rawRequest) {
  if (!Array.isArray(constraints)) throw new Error('user_constraints 参数无效');
  return constraints.map((item, index) => {
    assertString(item.constraint, `user_constraints[${index}].constraint`);
    assertString(item.source_quote, `user_constraints[${index}].source_quote`);
    if (!rawRequest.includes(item.source_quote)) {
      throw new Error(`user_constraints[${index}] 无法追溯到用户原话：${item.source_quote}`);
    }
    return item.constraint;
  });
}

function originalRequest(message) {
  return message.replace(/^\/(?:varina|aha)\s*/i, '').trim();
}

async function renderedSourceContext(excerpts, loadedManifest, host, signal) {
  if (!Array.isArray(excerpts)) throw new Error('source_excerpts 参数无效');
  const loadedMap = new Map((loadedManifest ?? []).map(item => [item.file_path, item.content_hash]));
  const rendered = [];
  for (const [index, item] of excerpts.entries()) {
    assertString(item.source_path, `source_excerpts[${index}].source_path`);
    const expectedHash = loadedMap.get(item.source_path);
    if (!expectedHash) throw new Error(`source_excerpts[${index}] 引用了尚未 Read 的文件：${item.source_path}`);
    const read = await host.readFile(item.source_path, { startLine: item.start_line, endLine: item.end_line, signal });
    if (read.contentHash !== expectedHash) throw new Error(`source_excerpts[${index}] 的文件已在 Read 后变化：${item.source_path}`);
    rendered.push(`<source-excerpt path="${item.source_path}" lines="${item.start_line}-${item.end_line}">\n${read.renderedContent}\n</source-excerpt>`);
  }
  return rendered.join('\n\n');
}

function upsertManifest(session, read, snapshotId = `read-${Date.now()}`) {
  if (!Array.isArray(session.loaded_files_manifest)) session.loaded_files_manifest = [];
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
  for (const manifest of session.loaded_files_manifest ?? []) {
    let changed = false;
    try { changed = (await host.readFile(manifest.file_path)).contentHash !== manifest.content_hash; }
    catch { changed = true; }
    if (!changed) continue;
    const runs = session.varina_runs ?? session.aha_runs ?? [];
    for (const run of runs) {
      for (const fact of run.final_fact_ledger ?? []) {
        if (fact.evidence?.some(evidence => evidence.filePath === manifest.file_path)) fact.status = 'stale';
      }
    }
  }
}

export class AgentSession {
  constructor({ state, host, store, gateway, config, signal, onEvent = () => {}, gate = new VarinaGateController(), maxToolIterations } = {}) {
    this.state = state;
    this.host = host;
    this.store = store;
    this.gateway = gateway;
    this.config = config;
    this.signal = signal;
    this.onEvent = onEvent;
    this.gate = gate;
    const envVal = process.env.VARINA_MAX_TOOL_ITERATIONS || process.env.AHA_MAX_TOOL_ITERATIONS;
    this.maxToolIterations = Number(config?.max_tool_iterations ?? (envVal ? Number(envVal) : null) ?? maxToolIterations ?? 100);
  }

  async save() {
    this.state.updated_at = new Date().toISOString();
    await this.store.save(this.state);
  }

  async loadProjectContext() {
    try {
      const read = await this.host.readFile('VARINA.md', { maxBytes: 64 * 1024, signal: this.signal });
      if (read.content.length > 30000) {
        return { error: 'VARINA.md 超过 30000 字符，未自动注入；请精简为项目级认知并把细节移入资料地图。' };
      }
      upsertManifest(this.state, read, `project-context-${read.contentHash}`);
      return { content: read.content, content_hash: read.contentHash, file_path: read.filePath };
    } catch (error) {
      if (error?.code === 'ENOENT' || /文件不存在/.test(String(error?.message))) return null;
      return { error: `VARINA.md 无法加载：${String(error?.message ?? error).slice(0, 300)}` };
    }
  }

  modelMessages(currentUserMessage, projectContext = null) {
    ensureMessageTurns(this.state.messages);
    const lastCompactedTurn = this.state.compaction?.last_compacted_turn ?? 0;
    const priorMessages = this.state.messages.slice(0, -1);
    const activePrior = lastCompactedTurn > 0
      ? priorMessages.filter(msg => (msg.turn ?? 0) > lastCompactedTurn)
      : priorMessages;
    const prior = activePrior.map(message => ({ role: message.role, content: message.content }));

    const checkpointMessages = [];
    if (this.state.compaction?.summary) {
      checkpointMessages.push({
        role: 'system',
        content: `${CHECKPOINT_HEADER}\n${SUMMARY_PREFIX}\n\n${this.state.compaction.summary}`
      });
    }

    const systemNotes = [];
    if (projectContext?.error) systemNotes.push({ role: 'system', content: `Notice: ${projectContext.error}` });
    const enabled = this.turnEnableVarina ?? this.turnEnableAha;
    if (enabled === false) {
      systemNotes.push({ role: 'system', content: 'Notice: Varina deep exploration is currently DISABLED by the user for this turn. Do NOT call ExploreDesign. Answer questions directly in conversation, and use workspace tools (Read, Grep, Glob, Edit, Write) as requested.' });
    } else if (enabled === true) {
      systemNotes.push({ role: 'system', content: 'Notice: Varina deep exploration is ENABLED by the user for this turn. If the query involves game mechanics, creative system design, numerical boundaries, or architectural trade-offs, you may invoke ExploreDesign without requiring an explicit /varina command.' });
    }
    const projectMessage = projectContextMessage(projectContext);
    return [
      { role: 'system', content: MAIN_AGENT_SYSTEM_PROMPT },
      ...(projectMessage ? [{ role: 'system', content: projectMessage }] : []),
      ...checkpointMessages,
      ...prior,
      { role: 'system', content: trustedStateMessage(this.state) },
      ...systemNotes,
      { role: 'user', content: currentUserMessage }
    ];
  }

  async turn(userMessage, { enable_varina, enable_aha } = {}) {
    assertString(userMessage, 'message', { max: 20000 });
    this.signal?.throwIfAborted();
    this.turnEnableVarina = enable_varina ?? enable_aha;
    this.turnEnableAha = this.turnEnableVarina;
    delete this.state.pending_confirmation;
    await refreshLoadedFacts(this.state, this.host);
    this.turnProjectContext = await this.loadProjectContext();
    this.state.current_turn += 1;
    if (this.state.title === '新会话' || this.state.title === 'CLI 会话') this.state.title = userMessage.trim().replace(/\s+/g, ' ').slice(0, 48);

    ensureMessageTurns(this.state.messages);

    const compactionCheck = shouldCompactPreTurn({
      messages: this.state.messages,
      compaction: this.state.compaction,
      config: this.config,
      currentTurn: this.state.current_turn
    });

    if (compactionCheck.shouldCompact) {
      try {
        const newSummary = await compactSessionHistory({
          messagesToCompact: compactionCheck.messagesToCompact,
          previousSummary: this.state.compaction?.summary,
          gateway: this.gateway,
          config: this.config,
          sessionId: this.state.session_id,
          currentTurn: this.state.current_turn,
          signal: this.signal
        });
        const charsBefore = compactionCheck.currentChars;
        const charsAfter = newSummary.length;
        const tokensBefore = compactionCheck.currentTokens ?? approxTokens(charsBefore);
        const tokensAfter = approxTokens(charsAfter);
        this.state.compaction = {
          last_compacted_turn: compactionCheck.toTurn,
          summary: newSummary,
          compacted_at: new Date().toISOString(),
          chars_before: charsBefore,
          chars_after: charsAfter,
          tokens_before: tokensBefore,
          tokens_after: tokensAfter
        };
        await this.save();
        this.onEvent({
          event: 'context_compacted',
          session_id: this.state.session_id,
          turn: this.state.current_turn,
          phase: 'pre_turn',
          last_compacted_turn: compactionCheck.toTurn,
          chars_before: charsBefore,
          chars_after: charsAfter,
          tokens_before: tokensBefore,
          tokens_after: tokensAfter,
          summary: newSummary
        });
      } catch (compactError) {
        this.onEvent({
          event: 'context_compaction_failed',
          session_id: this.state.session_id,
          turn: this.state.current_turn,
          phase: 'pre_turn',
          error: String(compactError?.message ?? compactError)
        });
      }
    }

    this.state.messages.push({
      id: `msg-${randomUUID().slice(0, 8)}`,
      role: 'user',
      content: userMessage.trim(),
      created_at: new Date().toISOString(),
      turn: this.state.current_turn
    });
    this.state.status = 'running';
    this.state.active_turn = {
      turn: this.state.current_turn,
      steps: []
    };
    await this.save();
    const messages = this.modelMessages(userMessage.trim(), this.turnProjectContext);
    const seenCallIds = new Set();
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
          messages, generation: generationFor(this.config, 'agent_turn'),
          context: { turn: this.state.current_turn, iteration, enable_varina: this.turnEnableVarina, enable_aha: this.turnEnableAha },
          logicalId: `${this.state.session_id}:T${this.state.current_turn}:I${iteration}`
        });
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

        const toolCalls = Array.isArray(output.tool_calls) ? output.tool_calls : [];
        if (!toolCalls.length) {
          finalMessage = (output.message ?? '').trim() || (output.thought ?? '').trim() || '（已完成思考与回复）';
          break;
        }

        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          if (!call.id || typeof call.id !== 'string' || !call.id.trim()) {
            call.id = `call_${iteration}_${i + 1}`;
          }
          if (seenCallIds.has(call.id)) {
            let candidate = `${call.id}_${iteration}`;
            let suffix = 2;
            while (seenCallIds.has(candidate)) {
              candidate = `${call.id}_${iteration}_${suffix++}`;
            }
            call.id = candidate;
          }
          seenCallIds.add(call.id);
          if (output.raw_tool_calls?.[i]) {
            output.raw_tool_calls[i].id = call.id;
          }
        }

        const results = [];
        for (const call of toolCalls) {
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
          const result = await this.executeTool(call, userMessage.trim());
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
          for (const item of budgeted.results) {
            if (item.persisted) {
              const step = this.state.active_turn?.steps?.find(s => s.id === item.id);
              if (step) {
                step.persisted = true;
                step.persisted_path = item.persisted_path;
                step.result = {
                  persisted: true,
                  persisted_path: item.persisted_path,
                  preview: item.preview
                };
              }
            }
          }
        }
        if (output.raw_tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: output.message || null,
            tool_calls: output.raw_tool_calls
          });
          for (const item of budgeted.results) {
            messages.push({
              role: 'tool',
              tool_call_id: item.id,
              content: JSON.stringify(item)
            });
          }
        } else {
          messages.push({ role: 'assistant', content: JSON.stringify(output) });
          messages.push({ role: 'user', content: renderToolResults(budgeted.results) });
        }

        const thresholds = resolveCompactionThresholds(this.config);
        const midResult = compactWorkingMessages(messages, {
          midTurnThreshold: thresholds.midTurnChars,
          currentIteration: iteration
        });
        if (midResult.compacted) {
          this.onEvent({
            event: 'context_compacted',
            session_id: this.state.session_id,
            turn: this.state.current_turn,
            iteration,
            phase: 'mid_turn',
            chars_before: midResult.charsBefore,
            chars_after: midResult.charsAfter,
            tokens_before: approxTokens(midResult.charsBefore),
            tokens_after: approxTokens(midResult.charsAfter),
            folded_count: midResult.foldedCount
          });
        }
        await this.save();
      }
      if (!finalMessage) {
        partial = true;
        finalMessage = `本轮达到 ${this.maxToolIterations} 次工具续轮上限，已保留当前会话和工具结果，但任务尚未完整结束。请缩小范围或继续下一条消息。`;
      }
      this.state.status = 'idle';
    } catch (error) {
      this.state.status = this.signal?.aborted ? 'cancelled' : 'failed';
      finalMessage = this.signal?.aborted ? '本轮已取消，已完成的读取与 Varina 中间结果已经保留。' : `本轮未能完成：${cleanError(error).message}`;
      partial = true;
    }
    const completedSteps = this.state.active_turn?.steps ? [...this.state.active_turn.steps] : [];
    delete this.state.active_turn;
    const assistantMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`, role: 'assistant', content: finalMessage,
      created_at: new Date().toISOString(), partial,
      steps: completedSteps,
      turn: this.state.current_turn
    };
    const runs = this.state.varina_runs ?? this.state.aha_runs ?? [];
    const turnRun = [...runs].reverse().find(run => run.turn_invoked === this.state.current_turn);
    if (turnRun) {
      assistantMessage.varina_run_id = turnRun.run_id;
      assistantMessage.aha_run_id = turnRun.run_id;
    }
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
      } else if (call.name === 'InitProject') {
        const mode = initMode(currentUserMessage);
        if (!mode) throw new Error('InitProject 只允许在用户明确输入 /init 或 /init --refresh 时调用');
        const content = renderVarinaMarkdown(args.manifest);
        let current = null;
        try { current = await this.host.readFile('VARINA.md', { signal: this.signal }); }
        catch (error) { if (error?.code !== 'ENOENT' && !/文件不存在/.test(String(error?.message))) throw error; }
        // /init is intentionally repeatable for non-programmer users. The runtime,
        // not the model, owns the current hash so a concurrent edit still cannot be lost.
        const expectedHash = current?.contentHash ?? null;
        const receipt = await this.host.writeFile('VARINA.md', content, {
          expectedHash,
          createBackup: true
        });
        const written = await this.host.readFile('VARINA.md', { signal: this.signal });
        upsertManifest(this.state, written, `project-context-${written.contentHash}`);
        this.turnProjectContext = { content: written.content, content_hash: written.contentHash, file_path: written.filePath };
        result = {
          ...receipt,
          mode,
          project_name: args.manifest?.project_name,
          characters: content.length,
          message: current ? 'VARINA.md 已重新生成，旧版本已自动备份' : 'VARINA.md 已创建；后续会话将自动加载它'
        };
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
    const rawRequest = originalRequest(currentUserMessage) || args.problem.trim();
    const userConstraints = tracedUserConstraints(args.user_constraints ?? [], rawRequest);
    const agentHypotheses = args.agent_hypotheses ?? [];
    if ((typeof args.verified_context === 'string' && args.verified_context.trim()) || (typeof args.code_context === 'string' && args.code_context.trim()) || args.verified_facts != null) {
      throw new Error('自由文本 verified_context/code_context 与 verified_facts 已停用；请用 source_excerpts 选择已读原文');
    }
    const verifiedContext = await renderedSourceContext(args.source_excerpts ?? [], this.state.loaded_files_manifest, this.host, this.signal);
    if (!Array.isArray(agentHypotheses) || agentHypotheses.length > 20 || agentHypotheses.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('agent_hypotheses 参数无效');
    if (!Array.isArray(args.relevant_files) || args.relevant_files.some(item => typeof item !== 'string')) throw new Error('relevant_files 参数无效');
    const loadedPaths = new Set((this.state.loaded_files_manifest ?? []).map(item => item.file_path));
    const unreadPath = args.relevant_files.find(file => !loadedPaths.has(file));
    if (unreadPath) throw new Error(`relevant_files 只能包含本轮或此前由 Read 加载的文件：${unreadPath}`);
    const isExplicit = (this.turnEnableVarina ?? this.turnEnableAha) === true || currentUserMessage.trim().startsWith('/varina') || currentUserMessage.trim().startsWith('/aha');
    const gate = await this.gate.evaluateTrigger({
      isExplicitVarina: isExplicit,
      isExplicitAha: isExplicit,
      sessionState: this.state,
      signal: this.signal
    });
    if (gate.decision === 'CONFIRM') {
      this.state.pending_confirmation = { id: `confirm-${randomUUID().slice(0, 8)}`, ...gate, original_problem: rawRequest };
      return { confirmation_required: true, ...this.state.pending_confirmation };
    }
    if (gate.decision !== 'ALLOW') return { started: false, reason: gate.reason };
    delete this.state.pending_confirmation;
    const runRecord = {
      run_id: `varina-${Date.now()}-${randomUUID().slice(0, 6)}`,
      turn_invoked: this.state.current_turn,
      trigger_mode: gate.trigger_mode,
      problem: rawRequest,
      task_framing: args.problem.trim(),
      original_user_request: rawRequest,
      user_constraints: userConstraints,
      agent_hypotheses: agentHypotheses,
      source_excerpts: args.source_excerpts ?? [],
      code_context: verifiedContext,
      project_context: this.turnProjectContext?.content ?? '',
      project_context_hash: this.turnProjectContext?.content_hash ?? null,
      rounds_executed: 0, state: 'active'
    };
    if (!this.state.varina_runs) this.state.varina_runs = [];
    this.state.varina_runs.push(runRecord);
    if (!this.state.aha_runs) this.state.aha_runs = this.state.varina_runs;
    else if (this.state.aha_runs !== this.state.varina_runs) this.state.aha_runs.push(runRecord);
    await this.save();
    const engine = new ExploreDesignEngine({
      host: this.host, gateway: this.gateway, config: this.config, signal: this.signal,
      onEvent: this.onEvent,
      checkpoint: async runtime => {
        this.state.active_varina_runtime = runtime;
        this.state.active_aha_runtime = runtime;
        await this.save();
      }
    });
    const handoff = await engine.run({
      sessionId: this.state.session_id, runId: runRecord.run_id,
      problem: rawRequest,
      originalRequest: rawRequest,
      taskFraming: args.problem.trim(),
      constraints: userConstraints.map(item => item.trim()).filter(Boolean),
      agentHypotheses: agentHypotheses.map(item => item.trim()).filter(Boolean),
      codeContext: verifiedContext,
      projectContext: this.turnProjectContext?.content ?? '',
      relevantFiles: this.turnProjectContext?.content
        ? ['VARINA.md', ...args.relevant_files.filter(file => file !== 'VARINA.md')]
        : args.relevant_files,
      seed: this.state.current_turn * 1009 + (this.state.varina_runs ?? this.state.aha_runs).length
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
    runRecord.common_prefix = handoff.common_prefix ?? null;
    runRecord.frozen_packet = handoff.frozen_packet ?? null;
    if (handoff.user_constraints) runRecord.user_constraints = handoff.user_constraints;
    if (handoff.agent_hypotheses) runRecord.agent_hypotheses = handoff.agent_hypotheses;
    if (handoff.code_context) runRecord.code_context = handoff.code_context;
    if (handoff.project_context) runRecord.project_context = handoff.project_context;
    for (const manifest of handoff.loaded_files_manifest) {
      const index = this.state.loaded_files_manifest.findIndex(item => item.file_path === manifest.file_path);
      if (index === -1) this.state.loaded_files_manifest.push(manifest);
      else this.state.loaded_files_manifest[index] = manifest;
    }
    delete this.state.active_varina_runtime;
    delete this.state.active_aha_runtime;
    await this.save();
    const cleanPoints = (handoff.meeting_board?.points ?? []).map(point => {
      const item = {
        id: point.id,
        type: point.type,
        status: point.status,
        text: point.text,
        failure_condition: point.failure_condition
      };
      if (point.evidence_refs?.length) item.evidence_refs = point.evidence_refs;
      return item;
    });
    const toolResult = {
      run_id: handoff.run_id,
      terminal: handoff.terminal,
      state: handoff.state,
      stop_reason: handoff.stop_reason,
      rounds_executed: handoff.rounds_executed,
      meeting_board: {
        version: handoff.meeting_board?.version,
        points: cleanPoints
      },
      fact_ledger: handoff.fact_ledger ?? [],
      solutions: handoff.solutions ?? [],
      rejected_directions: handoff.rejected_directions ?? [],
      unresolved_questions: handoff.unresolved_questions ?? [],
      degradations: handoff.degradations ?? [],
      repository_snapshot_id: handoff.repository_snapshot_id
    };
    return toolResult;
  }
}

export function createSessionState(workspaceRoot, { title = '新会话' } = {}) {
  const now = new Date().toISOString();
  const runs = [];
  return {
    session_id: `session-${Date.now()}-${randomUUID().slice(0, 8)}`,
    title, created_at: now, updated_at: now, workspace_root: workspaceRoot,
    current_turn: 0, status: 'idle', messages: [], varina_runs: runs, aha_runs: runs,
    loaded_files_manifest: [], calls: [], pending_confirmation: null,
    active_turn: null,
    compaction: null
  };
}
