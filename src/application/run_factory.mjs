import { randomUUID } from 'node:crypto';
import { emptyBoard } from '../board.mjs';
import { operators, OPERATOR_VERSION } from '../operators.mjs';
import { DOMAIN_OPERATORS_VERSION } from '../domain_operators.mjs';
import { PROMPT_VERSION } from '../prompts.mjs';
import { resolveActiveConfig, validateConfig } from '../config.mjs';
import { EXPERIMENT_IDS, expectedCalls } from '../engine.mjs';

const executionConfigs = new WeakMap();

function publicModel(model) {
  const { apiKey, ...safe } = model;
  return safe;
}

export function publicConfig(config) {
  return {
    ...structuredClone(config),
    models: config.models.map(publicModel)
  };
}

export function createRun(input, rawConfig, {
  now = () => new Date(),
  idGenerator = () => randomUUID().slice(0, 8)
} = {}) {
  if (typeof input.problem !== 'string' || !input.problem.trim() || input.problem.length > 20000) throw new Error('问题必填，最多20000字符');
  if (!Array.isArray(input.constraints) || input.constraints.some(c => typeof c !== 'string' || c.length > 2000) || input.constraints.length > 40) throw new Error('硬约束须为文本数组，最多40条，每条2000字符');
  if (!EXPERIMENT_IDS.includes(input.experiment) || !['mock', 'live'].includes(input.mode)) throw new Error('未知实验或运行模式');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647) throw new Error('种子须为0–2147483647的整数');
  if (typeof input.use_operators !== 'boolean') throw new Error('use_operators 须为布尔值');
  const use_domain_operators = input.use_domain_operators === true;
  const max_mechanisms = Number.isInteger(input.max_mechanisms) && input.max_mechanisms >= 1
    ? input.max_mechanisms
    : (Number.isInteger(rawConfig.default_max_mechanisms) && rawConfig.default_max_mechanisms >= 1 ? rawConfig.default_max_mechanisms : 3);

  const effectiveConfig = structuredClone(rawConfig);
  if (Array.isArray(input.seats) && input.seats.length > 0) effectiveConfig.seats = structuredClone(input.seats);
  if (input.roles && typeof input.roles === 'object') effectiveConfig.roles = { ...effectiveConfig.roles, ...input.roles };
  validateConfig(effectiveConfig, input.mode, { allowKeyless: true });

  const { config, routing } = resolveActiveConfig(effectiveConfig, input.mode);
  const startedAt = now().toISOString();
  const run = {
    workflow_version: 2,
    id: `run-${Date.parse(startedAt)}-${idGenerator()}`,
    problem: input.problem.trim(),
    constraints: input.constraints.filter(c => c.trim()),
    seed: input.seed,
    mode: input.mode,
    experiment: input.experiment,
    use_operators: input.use_operators,
    use_domain_operators,
    max_mechanisms,
    // A run is an audit record, not a credential store. Runtime credentials stay in executionConfigs.
    config: publicConfig(config),
    routing,
    prompt_version: PROMPT_VERSION,
    operator_version: OPERATOR_VERSION,
    domain_operator_version: DOMAIN_OPERATORS_VERSION,
    operator_pool: structuredClone(operators),
    domain_operators: [],
    dealer_decision: null,
    status: 'running',
    phase: '准备',
    round: 0,
    started_at: startedAt,
    completed_at: null,
    assignments: [],
    raw_responses: [],
    candidates: [],
    operations: [],
    snapshots: [emptyBoard()],
    proposals: [],
    proposal_snapshots: [{ version: 0, proposal_ids: [] }],
    memos: [],
    final: null,
    calls: [],
    events: [],
    round_metrics: [],
    metrics: { expected_calls: expectedCalls(input.experiment, config.seats.length, input.use_operators, use_domain_operators), attempted_calls: 0 }
  };
  executionConfigs.set(run, config);
  return run;
}

export function executionConfigFor(run) {
  return executionConfigs.get(run) ?? run.config;
}
