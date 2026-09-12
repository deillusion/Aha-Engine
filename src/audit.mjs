import { validateFinal, validateRanking, validateDirect } from './schema.mjs';
import { rankedFinal } from './proposals.mjs';

const passes = fn => { try { fn(); return true; } catch { return false; } };
export function auditRun(run) {
  const full = ['treatment', 'independent'].includes(run.experiment);
  const creativeRounds = run.experiment === 'direct' ? [] : full ? [1, 2, 3, 4, 5] : [1];
  const board = run.snapshots.at(-1);
  const calls = run.calls.filter(c => c.phase === 'creative' && c.status === 'completed');
  const lengths = board.points.map(p => [...p.text].length).sort((a, b) => a - b);
  const percentile = q => lengths.length ? lengths[Math.ceil((lengths.length - 1) * q)] : null;
  const checks = {
    completed: run.status === 'completed',
    board_snapshots: run.snapshots.length === (full ? 6 : 1) && run.snapshots.every((s, i) => s.version === i),
    same_round_board: creativeRounds.every(round => {
      const batch = calls.filter(c => c.round === round);
      return batch.length > 0 && batch.every(c => c.board_version_read === (run.experiment === 'independent' ? 0 : round - 1));
    }),
    operator_families: run.assignments.every(a => !run.use_operators || (a.operators.length === 3 && new Set(a.operators.map(o => o.operator_id)).size === 3)),
    exactly_one_operation: run.candidates.every(c => run.operations.filter(o => o.candidate_id === c.candidate_id).length === 1),
    no_truncated_outputs_used: run.calls.filter(c => c.status === 'completed').every(c => c.finish_reason === 'stop')
  };
  if (run.workflow_version === 2) {
    const proposals = run.proposals, byId = new Map(proposals.map(p => [p.proposal_id, p]));
    checks.valid_proposal_lineage = byId.size === proposals.length && proposals.every(p => p.parent_proposal_ids.every(id => byId.has(id) && byId.get(id).round < p.round));
    checks.same_round_proposals = creativeRounds.every(round => {
      const expected = run.experiment === 'independent' ? [] : run.proposal_snapshots.find(s => s.version === round - 1)?.proposal_ids;
      return calls.filter(c => c.round === round).every(c => JSON.stringify(c.proposal_ids_read) === JSON.stringify(expected));
    });
    if (run.experiment === 'direct') {
      checks.valid_final_output = run.final?.kind === 'direct' && passes(() => validateDirect({ text: run.final.text }));
      checks.direct_without_chair = !run.calls.some(c => c.phase === 'chair');
    } else {
      const ranking = { rankings: run.final?.rankings?.map(({ proposal_id, reason }) => ({ proposal_id, reason })) };
      checks.complete_ranking = run.final?.kind === 'ranking' && passes(() => validateRanking(ranking, proposals));
      checks.original_proposals_preserved = checks.complete_ranking && run.final.rankings.every((r, i) => r.rank === i + 1) && run.final.text === rankedFinal(ranking, proposals).text;
    }
  } else {
    checks.valid_final_references = !!run.final && passes(() => validateFinal(run.final, board));
  }
  return {
    run_id: run.id, status: run.status, config_version: run.config.version, workflow_version: run.workflow_version ?? 1,
    checks, passed: Object.values(checks).every(Boolean), metrics: run.metrics, rounds: run.round_metrics,
    successful_seats_by_round: creativeRounds.map(round => ({ round, count: run.raw_responses.filter(r => r.round === round && r.status === 'completed').length })),
    successful_decision_seats: run.memos.filter(m => m.status === 'completed').length,
    failures: run.calls.filter(c => c.status === 'failed').map(c => ({ phase: c.phase, round: c.round, seat: c.seat_id, error: c.error, salvaged: c.salvaged === true, salvage_repairs: c.salvage_repairs ?? null })),
    // A degraded round or a degraded ranking is still a completed run, so it is reported separately
    // from failures. Without this a salvaged or degraded result reads exactly like a clean one.
    degraded: run.degraded ?? null,
    semantic_review_signals: { point_length_p50: percentile(.5), point_length_p95: percentile(.95), longest_point: lengths.at(-1) ?? null, points_over_150_characters: board.points.filter(p => [...p.text].length > 150).map(p => p.point_id), note: '流程校验不代表方案正确、完整或排序客观。新流程检查完整方案保留与排序覆盖；旧版采用指标是Chair自报。' }
  };
}
