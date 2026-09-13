import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyBoard, applyPlan, validatePlan, salvagePlan, fallbackAddAllPlan } from './board.mjs';
import { operators, OPERATOR_VERSION, random, sampleOperators, sampleMixedOperators } from './operators.mjs';
import { DOMAIN_OPERATORS_VERSION, domainCatalog, domainOperatorsMap } from './domain_operators.mjs';
import { eligibleDomainCatalog } from './domain_routing.mjs';
import { messages, PROMPT_VERSION } from './prompts.mjs';
import { validateCreative, validateRanking, validateDirect, validateMemo, validateDealer, typeLabels, canonicalContributionType, alignedPointRefs } from './schema.mjs';
import { materializeProposals, proposalText, rankedFinal } from './proposals.mjs';
import { buildPayload, chatCompletion } from './provider.mjs';
import { mockCompletion } from './mock.mjs';
import { ModelGate } from './scheduler.mjs';
import { resolveActiveConfig, validateConfig } from './config.mjs';
export const EXPERIMENTS = {
  treatment: { name: '五轮协作', description: '5 轮共享观点与完整方案 → R6完善方案 → Chair仅排序' },
  independent: { name: '五轮独立采样', description: '创意席位读取空观点板与空方案池；R6读取全部成果；Chair仅排序' },
  single: { name: '单轮多席位', description: '所有席位独立生成完整方案一次，再由 Chair 排序' },
  direct: { name: '单模型直接回答', description: '使用相同模型配置直接回答一次，不经过 Chair 排序' }
};
export function expectedCalls(experiment, seats, useOperators = true, useDomainOperators = false) {
  const dealerCall = useOperators && useDomainOperators && ['treatment', 'independent', 'single'].includes(experiment) ? 1 : 0;
  return experiment === 'direct' ? 1 : experiment === 'single' ? seats + 1 + dealerCall : 6 * seats + 6 + dealerCall;
}
export function createRun(input, rawConfig) {
  if (typeof input.problem !== 'string' || !input.problem.trim() || input.problem.length > 20000) throw new Error('问题必填，最多20000字符');
  if (!Array.isArray(input.constraints) || input.constraints.some(c => typeof c !== 'string' || c.length > 2000) || input.constraints.length > 40) throw new Error('硬约束须为文本数组，最多40条，每条2000字符');
  if (!Object.hasOwn(EXPERIMENTS, input.experiment) || !['mock', 'live'].includes(input.mode)) throw new Error('未知实验或运行模式');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647) throw new Error('种子须为0–2147483647的整数');
  if (typeof input.use_operators !== 'boolean') throw new Error('use_operators 须为布尔值');
  const use_domain_operators = input.use_domain_operators === true;
  const max_mechanisms = Number.isInteger(input.max_mechanisms) && input.max_mechanisms >= 1
    ? input.max_mechanisms
    : (Number.isInteger(rawConfig.default_max_mechanisms) && rawConfig.default_max_mechanisms >= 1 ? rawConfig.default_max_mechanisms : 3);

  const effectiveConfig = structuredClone(rawConfig);
  if (Array.isArray(input.seats) && input.seats.length > 0) {
    effectiveConfig.seats = structuredClone(input.seats);
  }
  if (input.roles && typeof input.roles === 'object') {
    effectiveConfig.roles = { ...effectiveConfig.roles, ...input.roles };
  }
  validateConfig(effectiveConfig, input.mode, { allowKeyless: true });

  const { config, routing } = resolveActiveConfig(effectiveConfig, input.mode);
  return { workflow_version: 2, id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`, problem: input.problem.trim(), constraints: input.constraints.filter(c => c.trim()), seed: input.seed, mode: input.mode, experiment: input.experiment, use_operators: input.use_operators, use_domain_operators, max_mechanisms, config: structuredClone(config), routing, prompt_version: PROMPT_VERSION, operator_version: OPERATOR_VERSION, domain_operator_version: DOMAIN_OPERATORS_VERSION, operator_pool: structuredClone(operators), domain_operators: [], dealer_decision: null, status: 'running', phase: '准备', round: 0, started_at: new Date().toISOString(), completed_at: null, assignments: [], raw_responses: [], candidates: [], operations: [], snapshots: [emptyBoard()], proposals: [], proposal_snapshots: [{ version: 0, proposal_ids: [] }], memos: [], final: null, calls: [], events: [], round_metrics: [], metrics: { expected_calls: expectedCalls(input.experiment, config.seats.length, input.use_operators, use_domain_operators), attempted_calls: 0 } };
}
function ratio(a, b) { return b ? a / b : null; }
export function calculateMetrics(run) {
  const finished = run.calls.filter(c => c.status !== 'running');
  const withUsage = finished.filter(c => Number.isFinite(c.usage?.prompt_tokens) && Number.isFinite(c.usage?.completion_tokens));
  const priced = finished.filter(c => c.estimated_cost !== null && c.estimated_cost !== undefined);
  const board = run.snapshots.at(-1);
  const adopted = (run.final?.adopted_points ?? []).map(ref => board.points.find(p => p.point_id === ref.point_id)).filter(Boolean);
  const end = run.completed_at ? Date.parse(run.completed_at) : Date.now();
  const metrics = { expected_calls: expectedCalls(run.experiment, run.config.seats.length, run.use_operators, run.use_domain_operators), attempted_calls: run.calls.length, completed_calls: finished.filter(c => c.status === 'completed').length, failed_attempts: finished.filter(c => c.status === 'failed').length, input_tokens: withUsage.length ? withUsage.reduce((n, c) => n + c.usage.prompt_tokens, 0) : null, output_tokens: withUsage.length ? withUsage.reduce((n, c) => n + c.usage.completion_tokens, 0) : null, usage_coverage: ratio(withUsage.length, finished.length), estimated_cost: run.mode === 'mock' ? 0 : priced.length ? priced.reduce((n, c) => n + c.estimated_cost, 0) : null, cost_complete: run.mode === 'mock' || (finished.length > 0 && priced.length === finished.length), duration_ms: end - Date.parse(run.started_at), board_points: board.points.length, board_characters: board.rendered_text.length, adopted_points: adopted.length, late_round_value: ratio(adopted.filter(p => p.first_seen_round >= 4).length, adopted.length), late_revision_value: ratio(adopted.filter(p => p.revisions.some(r => r.round >= 4)).length, adopted.length), adoption_by_round: [1, 2, 3, 4, 5].map(round => ({ round, born: board.points.filter(p => p.first_seen_round === round).length, adopted: adopted.filter(p => p.first_seen_round === round).length, adopted_with_revision_in_round: adopted.filter(p => p.revisions.some(r => r.round === round)).length })) };
  if (run.workflow_version === 2) {
    for (const key of ['adopted_points', 'late_round_value', 'late_revision_value', 'adoption_by_round']) delete metrics[key];
    const count = run.proposals.length;
    metrics.proposal_count = count;
    metrics.ranked_proposals = run.final?.rankings?.length ?? 0;
    metrics.ranking_coverage = run.final?.kind === 'ranking' ? ratio(metrics.ranked_proposals, count) : null;
    metrics.proposals_by_round = [1, 2, 3, 4, 5, 6].map(round => ({ round, count: run.proposals.filter(p => p.round === round).length, derived: run.proposals.filter(p => p.round === round && p.parent_proposal_ids.length).length }));
  }
  return metrics;
}
// A rejected response is fed back verbatim as the failed assistant turn, followed by the concrete
// validation error. Repetition alone is resampling: at temperature 1 it is a coin flip. Without the
// exact error the model cannot know which field was wrong, and a formatting slip costs a whole cell.
function retryFeedback(payload, error) {
  payload.messages.push({ role: 'assistant', content: String(payload.messages.at(-1)?.content ?? '').slice(0, 4000) });
  payload.messages.push({ role: 'user', content: `上一次回答未通过校验：${String(error?.message ?? error).slice(0, 500)}\n只修复该问题后重新返回完整 JSON。不要复述或回显 schema，不要输出多余字段。` });
}
export async function executeRun(run, { store, signal, provider, mockDelayMs = 180, retryDelayMs, onEvent } = {}) {
  const config = run.config;
  retryDelayMs ??= config.retryDelayMs ?? 500;
  const gates = new Map(config.models.map(m => [m.id, new ModelGate(m.maxConcurrent ?? 32, m.requestIntervalMs ?? 0)]));
  const flush = async () => { run.metrics = calculateMetrics(run); if (store) await store.save(run); };
  const emit = async (phase, round, message) => { run.phase = phase; run.round = round; run.events.push({ time: new Date().toISOString(), phase, round, message }); await flush(); };
  function abortCheck() { signal?.throwIfAborted(); }
  async function invoke(phase, modelId, context, validate, seatId = null, onStreamChunk = null, onFailure = null) {
    abortCheck();
    const model = config.models.find(m => m.id === modelId);
    const genKey = phase === 'direct' ? 'chair' : (config.generation[phase] ? phase : 'chair');
    const request = { phase, messages: messages(phase, run, context), generation: config.generation[genKey], seed: createHash('sha256').update(`${run.seed}/${phase}/${context.round}/${seatId ?? modelId}`).digest().readUInt32LE(0) & 0x7fffffff, context };
    const payload = buildPayload(model, request);
    const logicalId = `${phase}-${context.round}-${seatId ?? modelId}`;
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      abortCheck();
      const queuedAt = Date.now();
      const release = await gates.get(modelId).acquire(signal);
      const call = { id: `${logicalId}-${attempt}`, logical_id: logicalId, phase, round: context.round, seat_id: seatId, model_id: modelId, model: model.model, base_url: model.baseUrl, attempt, queue_wait_ms: Date.now() - queuedAt, requested_output_limit: request.generation.max_output_tokens, effective_output_limit: payload[model.tokenParameter] ?? payload.generationConfig?.maxOutputTokens, board_version_read: context.board?.version ?? null, proposal_ids_read: context.proposals?.map(p => p.proposal_id) ?? null, status: 'running', started_at: new Date().toISOString(), request: structuredClone(payload), usage: null, estimated_cost: null, thinking: '' };
      run.calls.push(call);
      let result;
      try {
        await flush();
        const fn = provider ?? (run.mode === 'mock' ? mockCompletion : chatCompletion);
        const chunkHandler = chunk => {
          onStreamChunk?.(chunk);
          if (chunk.type === 'thinking') {
            call.thinking = (call.thinking || '') + chunk.text;
            onEvent?.({ event: 'thinking', run_id: run.id, phase, round: context.round, seat_id: seatId, model_id: modelId, delta: chunk.text, text: call.thinking });
          } else if (chunk.type === 'thinking_done') {
            onEvent?.({ event: 'thinking_done', run_id: run.id, phase, round: context.round, seat_id: seatId, model_id: modelId, text: call.thinking });
          }
        };
        result = await fn(model, request, { signal, timeoutMs: config.timeoutMs, mockDelayMs, payload, onChunk: chunkHandler });
        call.response = result.text; call.usage = result.usage; call.finish_reason = result.finish_reason; call.resolved_model = result.resolved_model; call.provider_request_id = result.provider_request_id ?? null;
        if (result.thinking) {
          if (!call.thinking) {
            call.thinking = result.thinking;
            onStreamChunk?.({ type: 'thinking', text: result.thinking });
            onStreamChunk?.({ type: 'thinking_done', text: result.thinking });
          } else {
            call.thinking = result.thinking;
          }
        }
        const value = JSON.parse(result.text);
        if (typeof value === 'string' && !value.trim()) throw new Error('模型回答为空');
        if (validate) validate(value);
        abortCheck();
        call.status = 'completed';
        return value;
      } catch (error) {
        if (error.result) { call.response = error.result.text; call.usage = error.result.usage; call.finish_reason = error.result.finish_reason; }
        call.status = signal?.aborted ? 'cancelled' : 'failed';
        // Do not log provider response bodies or arbitrary headers, which can echo credentials.
        call.error = error instanceof SyntaxError ? '模型未返回有效 JSON' : error.message;
        // A salvage attempt is recorded only on calls that actually failed, and only if it validates.
        if (onFailure && !signal?.aborted) {
          try {
            const salvaged = onFailure(error, call.response ?? null);
            if (salvaged?.value !== undefined && salvaged.value !== null) {
              if (validate) validate(salvaged.value);
              call.salvage = salvaged.value;
              call.salvaged = true;
              call.salvage_repairs = salvaged.repairs ?? [];
            }
          } catch { /* Salvage is best-effort: the original failure always stands on its own. */ }
        }
        if (signal?.aborted || attempt === config.retries) {
          // A validated salvage on the final attempt is better than any fallback: hand it to the caller.
          if (call.salvage !== undefined) {
            const final = new Error(call.error);
            final.salvage = call.salvage;
            throw final;
          }
          throw error;
        }
        // Retry with the concrete validation error appended; one bad field must not cost the whole cell.
        retryFeedback(payload, error);
      } finally {
        call.completed_at = new Date().toISOString(); call.latency_ms = Date.parse(call.completed_at) - Date.parse(call.started_at);
        if (Number.isFinite(call.usage?.prompt_tokens) && Number.isFinite(call.usage?.completion_tokens) && model.inputPricePerMillion != null && model.outputPricePerMillion != null) call.estimated_cost = (call.usage.prompt_tokens * model.inputPricePerMillion + call.usage.completion_tokens * model.outputPricePerMillion) / 1e6;
        try { await flush(); } finally { release(); }
      }
      await delay(retryDelayMs * (attempt + 1), undefined, { signal });
    }
  }
  async function saveProposalSnapshot(round) {
    run.proposals.sort((a, b) => a.round - b.round || config.seats.findIndex(s => s.id === a.seat_id) - config.seats.findIndex(s => s.id === b.seat_id) || a.proposal_id.localeCompare(b.proposal_id));
    run.proposal_snapshots.push({ version: round, proposal_ids: run.proposals.map(p => p.proposal_id) });
    await flush();
  }
  async function creative(round, board, proposals, rng) {
    const activeDomainOps = run.use_domain_operators ? run.domain_operators : [];
    const assignments = config.seats.map(seat => ({ round, seat_id: seat.id, operators: run.use_operators ? sampleMixedOperators(rng, run.operator_pool, activeDomainOps) : [] }));
    run.assignments.push(...assignments);
    await emit('创意发言', round, `R${round}：${config.seats.length} 个席位读取 board v${board.version}`);
    const results = await Promise.allSettled(config.seats.map(async (seat, seatIndex) => {
      const record = { response_id: `R${round}-${seat.id}`, round, seat_id: seat.id, board_version_read: board.version, operator_ids: assignments[seatIndex].operators.map(o => o.operator_id), status: 'running', thinking: '', started_at: new Date().toISOString() };
      run.raw_responses.push(record);
      try {
        const onStreamChunk = chunk => {
          if (chunk.type === 'thinking') record.thinking = (record.thinking || '') + chunk.text;
        };
        // Operators are named in Chinese ("简化", "缺失环节"), so a model may reach for the matching
        // English word instead of the enum member. Canonicalize before validating, and in place so the
        // stored contributions carry the taxonomy member rather than the model's free spelling.
        const validateAndCanonicalize = value => {
          for (const item of (Array.isArray(value?.contributions) ? value.contributions : [])) {
            if (item !== null && typeof item === 'object') item.type = canonicalContributionType(item.type);
          }
          validateCreative(value, board, proposals, run.experiment === 'single', run.max_mechanisms);
        };
        const val = await invoke('creative', seat.modelId, { board, proposals, round, operators: assignments[seatIndex].operators, seatIndex }, validateAndCanonicalize, seat.id, onStreamChunk);
        // A stale revision is realigned to the board's current one during validation. Record it, then
        // drop the internal marker so it never reaches the stored proposal or any later prompt.
        const aligned = alignedPointRefs(val.proposals);
        if (aligned.length) record.aligned_point_refs = aligned;
        const droppedParents = val.proposals.flatMap(p => (p.dropped_parent_proposal_ids ?? []).map(id => ({ proposal_title: p.title, parent_proposal_id: id })));
        if (droppedParents.length) record.dropped_parent_proposal_ids = droppedParents;
        for (const proposal of val.proposals) {
          delete proposal.dropped_parent_proposal_ids;
          for (const ref of proposal.point_refs ?? []) delete ref.__alignedFrom;
        }
        record.thinking = val.thinking || record.thinking || val.reasoning || '';
        record.reasoning = val.reasoning || record.thinking || '';
        record.contributions = val.contributions;
        record.proposals = materializeProposals(val.proposals, round, seat.id, 'creative');
        run.proposals.push(...record.proposals);
        record.text = `【推演过程】\n${record.reasoning}\n\n【核心观点】\n${val.contributions.map(c => `- [${typeLabels[c.type] ?? c.type}] ${c.text}${c.failure_condition ? `（失效条件：${c.failure_condition}）` : ''}`).join('\n')}`;
        if (record.proposals.length) record.text += `\n\n【完整方案】\n${record.proposals.map(proposalText).join('\n\n')}`;
        record.status = 'completed';
        record.completed_at = new Date().toISOString();
        return record;
      }
      catch (e) { record.status = signal?.aborted ? 'cancelled' : 'failed'; record.error = e.message; throw e; }
      finally { await flush(); }
    }));
    await saveProposalSnapshot(round);
    abortCheck();
    const raw = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    if (raw.length < Math.ceil(config.seats.length * config.minimumCreativeRatio)) throw new Error(`R${round} 成功席位不足：${raw.length}/${config.seats.length}`);
    return raw;
  }
  try {
    await flush();
    if (run.routing?.isAdaptive) {
      const activeCount = run.routing.activeModels.length;
      const totalCount = run.routing.totalModels;
      await emit('自适应调度', 0, `自适应调度生效：${totalCount} 个模型中就绪 ${activeCount} 个 (${run.routing.activeModels.join(', ')})，空缺席位已自动均衡承载`);
    }
    let board = emptyBoard();
    const rng = random(run.seed);
    if (run.use_operators && run.use_domain_operators && run.experiment !== 'direct') {
      const eligibleCatalog = eligibleDomainCatalog(domainCatalog, run.problem, run.constraints);
      await emit('发卡节点', 0, `发卡节点评估问题，从 ${eligibleCatalog.length} 个行业通用诊断视角中挑选匹配卡片（最多 4 张）`);
      const availableIds = new Set(eligibleCatalog.map(o => o.operator_id));
      const onStreamChunk = chunk => {
        if (chunk.type === 'thinking') run.dealer_thinking = (run.dealer_thinking || '') + chunk.text;
      };
      try {
        const dealerModel = config.roles.dealer || config.roles.chair || config.seats[0].modelId;
        const decision = await invoke('dealer', dealerModel, { round: 0, catalog: eligibleCatalog, problem: run.problem, constraints: run.constraints }, d => validateDealer(d, availableIds), 'dealer', onStreamChunk);
        run.dealer_decision = decision;
        const selected = (decision.selected_operator_ids || []).map(id => domainOperatorsMap.get(id)).filter(Boolean);
        run.domain_operators = selected;
        await emit('发卡完成', 0, `发卡节点选中 ${selected.length} 张行业诊断视角：${selected.map(s => s.name).join('、') || '无（采用纯通用算子推演）'}`);
      } catch (err) {
        run.domain_operators = [];
        await emit('发卡降级', 0, `发卡节点执行异常，降级为纯通用算子模式：${err.message}`);
      }
    } else if (run.use_operators && !run.use_domain_operators && run.experiment !== 'direct') {
      run.domain_operators = [];
      await emit('发卡跳过', 0, '已关闭行业算子，仅从通用认知算子库抽卡推演');
    }
    if (run.experiment === 'single') {
      await creative(1, board, [], rng);
    } else if (run.experiment !== 'direct') {
      for (let round = 1; round <= 5; round++) {
        const input = structuredClone(board);
        const sharedProposals = run.experiment === 'independent' ? [] : structuredClone(run.proposals);
        const raw = await creative(round, run.experiment === 'independent' ? emptyBoard() : input, sharedProposals, rng);
        let cIndex = 1;
        const candidates = raw.flatMap(r =>
          (r.contributions ?? []).map(c => ({
            candidate_id: `R${round}-C${String(cIndex++).padStart(3, '0')}`,
            source_seat_id: r.seat_id,
            source_response_id: `R${round}-${r.seat_id}`,
            round,
            text: c.text,
            type: c.type,
            failure_condition: c.failure_condition ?? null
          }))
        );
        run.candidates.push(...candidates); await flush();
        await emit('去重合并', round, `R${round}：${candidates.length} 条候选与历史及同轮观点统一去重`);
        let plan, degraded = null;
        try {
          plan = await invoke('dedup', config.roles.dedup, { round, board: input, candidates }, p => validatePlan(p, candidates, input), null, null, (error, response) => {
            // Formatting-only repair: strip undeclared keys and normalize a rendered "#P001" reference.
            if (typeof response !== 'string') return null;
            let parsed;
            try { parsed = JSON.parse(response); } catch { return null; }
            const { plan: salvaged, repairs } = salvagePlan(parsed);
            return repairs.length ? { value: salvaged, repairs } : null;
          });
        } catch (error) {
          abortCheck();
          if (error.salvage !== undefined) {
            // The answer was only mis-formatted. Keep the repaired plan and say so, without degrading.
            plan = error.salvage;
            const repairs = run.calls.at(-1)?.salvage_repairs ?? [];
            await emit('去重修复', round, `R${round} 去重回答仅格式不合规，已修复后沿用${repairs.length ? `（${repairs.join('；')}）` : ''}：${error.message}`);
          } else {
            // Dedup runs once per round with no redundancy, so a single unrecoverable answer must not
            // end the whole run. Degrade to keeping every candidate as a new point, and say so out loud.
            degraded = error.message;
            plan = fallbackAddAllPlan(candidates);
            await emit('去重降级', round, `R${round} 去重校验失败，本轮候选全部保留为新观点（不合并、不丢弃）：${error.message}`);
          }
        }
        const update = applyPlan(input, plan, candidates, round);
        abortCheck(); board = update.board;
        run.operations.push(...update.operations); run.snapshots.push(structuredClone(board));
        const lengths = candidates.map(c => [...c.text].length).sort((a, b) => a - b);
        const count = action => update.operations.filter(o => o.action === action).length;
        run.round_metrics.push({ round, successful_seats: raw.length, candidate_count: candidates.length, add: count('ADD'), merge: count('MERGE'), drop: count('DROP'), degraded: degraded ?? null, novelty_rate: ratio(count('ADD'), candidates.length), duplicate_rate: ratio(count('DROP'), candidates.length), board_size: board.points.length, board_growth: board.points.length - input.points.length, board_characters: board.rendered_text.length, extraction_yield: ratio(candidates.length, raw.length), compression_ratio_characters: ratio(candidates.reduce((n, c) => n + c.text.length, 0), raw.reduce((n, r) => n + r.text.length, 0)), candidate_length_p50: lengths.length ? lengths[Math.floor((lengths.length - 1) * .5)] : null, candidate_length_p95: lengths.length ? lengths[Math.ceil((lengths.length - 1) * .95)] : null, over_150: lengths.filter(n => n > 150).length });
        await emit('观点板已更新', round, `R${round} 完成：新增 ${count('ADD')}，合并 ${count('MERGE')}，丢弃 ${count('DROP')}${degraded ? '（降级模式）' : ''}`);
      }
      await emit('完善候选方案', 6, 'R6：所有席位读取完整方案池，补全机制并保留各自候选方案');
      const available = structuredClone(run.proposals);
      const results = await Promise.allSettled(config.seats.map(async (seat, seatIndex) => {
        const memo = { memo_id: `R6-${seat.id}`, seat_id: seat.id, board_version_read: 5, status: 'running', thinking: '', started_at: new Date().toISOString() }; run.memos.push(memo);
        try {
          const onStreamChunk = chunk => {
            if (chunk.type === 'thinking') memo.thinking = (memo.thinking || '') + chunk.text;
          };
          const value = await invoke('decision', seat.modelId, { round: 6, board, proposals: available, seatIndex }, v => validateMemo(v, board, available, run.max_mechanisms), seat.id, onStreamChunk);
          const aligned = alignedPointRefs(value.proposals);
          if (aligned.length) memo.aligned_point_refs = aligned;
          const droppedParents = value.proposals.flatMap(p => (p.dropped_parent_proposal_ids ?? []).map(id => ({ proposal_title: p.title, parent_proposal_id: id })));
          if (droppedParents.length) memo.dropped_parent_proposal_ids = droppedParents;
          for (const proposal of value.proposals) {
            delete proposal.dropped_parent_proposal_ids;
            for (const ref of proposal.point_refs ?? []) delete ref.__alignedFrom;
          }
          memo.thinking = memo.thinking || '';
          const proposals = materializeProposals(value.proposals, 6, seat.id, 'decision');
          run.proposals.push(...proposals);
          memo.proposal_ids = proposals.map(p => p.proposal_id);
          memo.text = proposals.map(proposalText).join('\n\n');
          memo.status = 'completed';
          memo.completed_at = new Date().toISOString();
          return memo;
        }
        catch (e) { memo.status = signal?.aborted ? 'cancelled' : 'failed'; memo.error = e.message; throw e; }
        finally { await flush(); }
      }));
      await saveProposalSnapshot(6);
      abortCheck();
      const successful = results.filter(r => r.status === 'fulfilled').length;
      if (successful < Math.ceil(config.seats.length * config.minimumDecisionRatio)) throw new Error(`R6 成功方案席位不足：${successful}/${config.seats.length}`);
    }
    const round = ['single', 'direct'].includes(run.experiment) ? 1 : 6;
    if (run.experiment === 'direct') {
      await emit('直接回答', round, '单模型直接回答，不调用 Chair 排序角色');
      // The direct answer is the entire deliverable, so its one call stays terminal on failure.
      run.final = { kind: 'direct', ...await invoke('direct', config.roles.chair, { round }, validateDirect) };
    } else {
      const proposals = structuredClone(run.proposals);
      await emit('方案排序', round, `Chair 对全部 ${proposals.length} 个方案版本排序，正文原样保留`);
      const onStreamChunk = chunk => {
        if (chunk.type === 'thinking') run.chair_thinking = (run.chair_thinking || '') + chunk.text;
      };
      try {
        const board = run.snapshots.at(-1) || { points: [], rendered_text: '' };
        const ranking = await invoke('chair', config.roles.chair, { round, proposals, board }, v => validateRanking(v, proposals), 'chair', onStreamChunk);
        run.final = rankedFinal(ranking, proposals);
      } catch (error) {
        abortCheck();
        // Every proposal was already produced and paid for. Losing the run at the last call would throw
        // all of it away, so fall back to a declared neutral order instead of a ranked one.
        run.chair_degraded = error.message;
        await emit('排序降级', round, `Chair 排序校验失败，跳过模型排序并保留全部 ${proposals.length} 个方案：${error.message}`);
        run.final = rankedFinal({ rankings: proposals.map(p => ({ proposal_id: p.proposal_id, summary: p.title || '无一句话概括（保序占位）', reason: 'Chair 排序未通过校验，此处为保序占位，不代表模型名次。' })) }, proposals);
        run.final.degraded = true;
      }
    }
    abortCheck(); run.status = 'completed'; run.phase = '已完成';
  } catch (error) {
    run.status = signal?.aborted ? 'cancelled' : 'failed'; run.error = signal?.aborted ? '用户已停止运行' : error.message; run.phase = run.status === 'cancelled' ? '已停止' : '运行失败';
  } finally {
    run.completed_at = new Date().toISOString();
    // A completed run may still have degraded somewhere. Summarize it so a degraded result can never
    // be mistaken for a fully validated one when the run is read back later.
    const degraded_dedup_rounds = run.round_metrics.filter(m => m.degraded).map(m => m.round);
    run.degraded = run.chair_degraded || degraded_dedup_rounds.length
      ? { dedup_rounds: degraded_dedup_rounds, chair: run.chair_degraded ?? null }
      : null;
    await flush();
  }
  return run;
}
