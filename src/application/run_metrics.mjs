import { expectedCalls } from '../engine.mjs';

function ratio(a, b) { return b ? a / b : null; }

export function calculateMetrics(run, now = () => new Date()) {
  const finished = run.calls.filter(c => c.status !== 'running');
  const withUsage = finished.filter(c => Number.isFinite(c.usage?.prompt_tokens) && Number.isFinite(c.usage?.completion_tokens));
  const priced = finished.filter(c => c.estimated_cost !== null && c.estimated_cost !== undefined);
  const board = run.snapshots.at(-1);
  const adopted = (run.final?.adopted_points ?? []).map(ref => board.points.find(p => p.point_id === ref.point_id)).filter(Boolean);
  const end = run.completed_at ? Date.parse(run.completed_at) : now().getTime();
  const metrics = {
    expected_calls: expectedCalls(run.experiment, run.config.seats.length, run.use_operators, run.use_domain_operators),
    attempted_calls: run.calls.length,
    completed_calls: finished.filter(c => c.status === 'completed').length,
    failed_attempts: finished.filter(c => c.status === 'failed').length,
    input_tokens: withUsage.length ? withUsage.reduce((n, c) => n + c.usage.prompt_tokens, 0) : null,
    output_tokens: withUsage.length ? withUsage.reduce((n, c) => n + c.usage.completion_tokens, 0) : null,
    usage_coverage: ratio(withUsage.length, finished.length),
    estimated_cost: run.mode === 'mock' ? 0 : priced.length ? priced.reduce((n, c) => n + c.estimated_cost, 0) : null,
    cost_complete: run.mode === 'mock' || (finished.length > 0 && priced.length === finished.length),
    duration_ms: end - Date.parse(run.started_at),
    board_points: board.points.length,
    board_characters: board.rendered_text.length,
    adopted_points: adopted.length,
    late_round_value: ratio(adopted.filter(p => p.first_seen_round >= 4).length, adopted.length),
    late_revision_value: ratio(adopted.filter(p => p.revisions.some(r => r.round >= 4)).length, adopted.length),
    adoption_by_round: [1, 2, 3, 4, 5].map(round => ({
      round,
      born: board.points.filter(p => p.first_seen_round === round).length,
      adopted: adopted.filter(p => p.first_seen_round === round).length,
      adopted_with_revision_in_round: adopted.filter(p => p.revisions.some(r => r.round === round)).length
    }))
  };
  if (run.workflow_version === 2) {
    for (const key of ['adopted_points', 'late_round_value', 'late_revision_value', 'adoption_by_round']) delete metrics[key];
    const count = run.proposals.length;
    metrics.proposal_count = count;
    metrics.ranked_proposals = run.final?.rankings?.length ?? 0;
    metrics.ranking_coverage = run.final?.kind === 'ranking' ? ratio(metrics.ranked_proposals, count) : null;
    metrics.proposals_by_round = [1, 2, 3, 4, 5, 6].map(round => ({
      round,
      count: run.proposals.filter(p => p.round === round).length,
      derived: run.proposals.filter(p => p.round === round && p.parent_proposal_ids.length).length
    }));
  }
  return metrics;
}
