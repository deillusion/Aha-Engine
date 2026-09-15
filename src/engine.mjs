import { emptyBoard, applyPlan, validatePlan, salvagePlan, fallbackAddAllPlan } from './board.mjs';
import { random, sampleMixedOperators } from './operators.mjs';
import { domainCatalog, domainOperatorsMap } from './domain_operators.mjs';
import { eligibleDomainCatalog } from './domain_routing.mjs';
import { validateCreative, validateRanking, validateDirect, validateMemo, validateDealer, canonicalContributionType, alignedPointRefs } from './schema.mjs';
import { materializeProposals, rankedResult } from './proposals.mjs';
export const EXPERIMENT_IDS = Object.freeze(['treatment', 'independent', 'single', 'direct']);
export function expectedCalls(experiment, seats, useOperators = true, useDomainOperators = false) {
  const dealerCall = useOperators && useDomainOperators && ['treatment', 'independent', 'single'].includes(experiment) ? 1 : 0;
  return experiment === 'direct' ? 1 : experiment === 'single' ? seats + 1 + dealerCall : 6 * seats + 6 + dealerCall;
}
function ratio(a, b) { return b ? a / b : null; }
export async function executeWorkflow(run, {
  workflowPlan,
  signal,
  invoke,
  checkpoint = async () => {},
  onEvent,
  now = () => new Date(),
} = {}) {
  if (!workflowPlan || typeof invoke !== 'function') throw new Error('内核需要已解析的执行计划与模型调用端口');
  const flush = checkpoint;
  const emit = async (phase, round, message) => {
    run.phase = phase;
    run.round = round;
    run.events.push({ time: now().toISOString(), phase, round, message });
    await flush();
  };
  function abortCheck() { signal?.throwIfAborted(); }
  async function saveProposalSnapshot(round) {
    run.proposals.sort((a, b) => a.round - b.round || workflowPlan.seats.findIndex(s => s.id === a.seat_id) - workflowPlan.seats.findIndex(s => s.id === b.seat_id) || a.proposal_id.localeCompare(b.proposal_id));
    run.proposal_snapshots.push({ version: round, proposal_ids: run.proposals.map(p => p.proposal_id) });
    await flush();
  }
  async function creative(round, board, proposals, rng) {
    const activeDomainOps = run.use_domain_operators ? run.domain_operators : [];
    const assignments = workflowPlan.seats.map(seat => ({ round, seat_id: seat.id, operators: run.use_operators ? sampleMixedOperators(rng, run.operator_pool, activeDomainOps) : [] }));
    run.assignments.push(...assignments);
    await emit('创意发言', round, `R${round}：${workflowPlan.seats.length} 个席位读取 board v${board.version}`);
    const results = await Promise.allSettled(workflowPlan.seats.map(async (seat, seatIndex) => {
      const record = { response_id: `R${round}-${seat.id}`, round, seat_id: seat.id, board_version_read: board.version, operator_ids: assignments[seatIndex].operators.map(o => o.operator_id), status: 'running', thinking: '', started_at: now().toISOString() };
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
        record.status = 'completed';
        record.completed_at = now().toISOString();
        return record;
      }
      catch (e) { record.status = signal?.aborted ? 'cancelled' : 'failed'; record.error = e.message; throw e; }
      finally { await flush(); }
    }));
    await saveProposalSnapshot(round);
    abortCheck();
    const raw = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    if (raw.length < Math.ceil(workflowPlan.seats.length * workflowPlan.minimumCreativeRatio)) throw new Error(`R${round} 成功席位不足：${raw.length}/${workflowPlan.seats.length}`);
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
        const dealerModel = workflowPlan.roles.dealer || workflowPlan.roles.chair || workflowPlan.seats[0].modelId;
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
          plan = await invoke('dedup', workflowPlan.roles.dedup, { round, board: input, candidates }, p => validatePlan(p, candidates, input), null, null, (error, response) => {
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
      const results = await Promise.allSettled(workflowPlan.seats.map(async (seat, seatIndex) => {
        const memo = { memo_id: `R6-${seat.id}`, seat_id: seat.id, board_version_read: 5, status: 'running', thinking: '', started_at: now().toISOString() }; run.memos.push(memo);
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
          memo.status = 'completed';
          memo.completed_at = now().toISOString();
          return memo;
        }
        catch (e) { memo.status = signal?.aborted ? 'cancelled' : 'failed'; memo.error = e.message; throw e; }
        finally { await flush(); }
      }));
      await saveProposalSnapshot(6);
      abortCheck();
      const successful = results.filter(r => r.status === 'fulfilled').length;
      if (successful < Math.ceil(workflowPlan.seats.length * workflowPlan.minimumDecisionRatio)) throw new Error(`R6 成功方案席位不足：${successful}/${workflowPlan.seats.length}`);
    }
    const round = ['single', 'direct'].includes(run.experiment) ? 1 : 6;
    if (run.experiment === 'direct') {
      await emit('直接回答', round, '单模型直接回答，不调用 Chair 排序角色');
      // The direct answer is the entire deliverable, so its one call stays terminal on failure.
      run.final = { kind: 'direct', ...await invoke('direct', workflowPlan.roles.chair, { round }, validateDirect) };
    } else {
      const proposals = structuredClone(run.proposals);
      await emit('方案排序', round, `Chair 对全部 ${proposals.length} 个方案版本排序，正文原样保留`);
      const onStreamChunk = chunk => {
        if (chunk.type === 'thinking') run.chair_thinking = (run.chair_thinking || '') + chunk.text;
      };
      try {
        const board = run.snapshots.at(-1) || { points: [], rendered_text: '' };
        const ranking = await invoke('chair', workflowPlan.roles.chair, { round, proposals, board }, v => validateRanking(v, proposals), 'chair', onStreamChunk);
        run.final = rankedResult(ranking, proposals);
      } catch (error) {
        abortCheck();
        // Every proposal was already produced and paid for. Losing the run at the last call would throw
        // all of it away, so fall back to a declared neutral order instead of a ranked one.
        run.chair_degraded = error.message;
        await emit('排序降级', round, `Chair 排序校验失败，跳过模型排序并保留全部 ${proposals.length} 个方案：${error.message}`);
        run.final = rankedResult({ rankings: proposals.map(p => ({ proposal_id: p.proposal_id, summary: p.title || '无一句话概括（保序占位）', reason: 'Chair 排序未通过校验，此处为保序占位，不代表模型名次。' })) }, proposals);
        run.final.degraded = true;
      }
    }
    abortCheck(); run.status = 'completed'; run.phase = '已完成';
  } catch (error) {
    run.status = signal?.aborted ? 'cancelled' : 'failed'; run.error = signal?.aborted ? '用户已停止运行' : error.message; run.phase = run.status === 'cancelled' ? '已停止' : '运行失败';
  } finally {
    run.completed_at = now().toISOString();
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
