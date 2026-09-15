import { executeWorkflow } from '../engine.mjs';
import { executionConfigFor } from './run_factory.mjs';
import { calculateMetrics } from './run_metrics.mjs';
import { createModelExecutor } from './model_executor.mjs';
import { markdownPresenter } from '../presenters/markdown.mjs';
import { typeLabels } from '../schema.mjs';

function decorateRun(run, presenter) {
  for (const record of run.raw_responses) {
    if (record.status !== 'completed' || !Array.isArray(record.contributions)) continue;
    record.text = `【推演过程】\n${record.reasoning}\n\n【核心观点】\n${record.contributions.map(c => `- [${typeLabels[c.type] ?? c.type}] ${c.text}${c.failure_condition ? `（失效条件：${c.failure_condition}）` : ''}`).join('\n')}`;
    if (record.proposals?.length) record.text += `\n\n【完整方案】\n${record.proposals.map(presenter.proposalText).join('\n\n')}`;
  }
  for (const memo of run.memos) {
    if (memo.status !== 'completed' || !Array.isArray(memo.proposal_ids)) continue;
    const proposals = memo.proposal_ids.map(id => run.proposals.find(p => p.proposal_id === id)).filter(Boolean);
    memo.text = proposals.map(presenter.proposalText).join('\n\n');
  }
  if (run.final?.kind === 'ranking') {
    const degraded = run.final.degraded;
    const source = { rankings: run.final.chair_rankings ?? run.final.rankings.filter(r => !r.unranked) };
    run.final = presenter.rankedFinal(source, run.proposals);
    if (degraded) run.final.degraded = true;
  }
}

export async function executeRun(run, {
  config = executionConfigFor(run),
  store,
  signal,
  provider,
  mockDelayMs = 180,
  retryDelayMs,
  onEvent,
  now = () => new Date(),
  presenter = markdownPresenter
} = {}) {
  const checkpoint = async () => {
    decorateRun(run, presenter);
    run.metrics = calculateMetrics(run, now);
    if (store) await store.save(run);
  };
  const invoke = createModelExecutor(run, config, { signal, provider, mockDelayMs, retryDelayMs, onEvent, checkpoint, now });
  const workflowPlan = {
    seats: config.seats.map(({ id, modelId }) => ({ id, modelId })),
    roles: structuredClone(config.roles),
    minimumCreativeRatio: config.minimumCreativeRatio,
    minimumDecisionRatio: config.minimumDecisionRatio
  };
  return executeWorkflow(run, { workflowPlan, signal, invoke, checkpoint, onEvent, now });
}
