import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPayload, chatCompletion } from '../provider.mjs';
import { ModelGate } from '../scheduler.mjs';
import { isRetryableProviderError, shouldAppendRepairFeedback } from '../retry_policy.mjs';
import { parseStructuredJson } from './schemas.mjs';

function mockAgentTurn(request) {
  const messages = request.messages ?? [];
  const lastTool = [...messages].reverse().find(message => message.role === 'user' && message.content.startsWith('Tool results'));
  if (lastTool) {
    let parsed = [];
    try { parsed = JSON.parse(lastTool.content.slice(lastTool.content.indexOf('\n') + 1)); } catch {}
    const exploration = parsed.find(item => item.name === 'ExploreDesign' && item.ok);
    if (exploration) {
      const result = exploration.result;
      if (result.confirmation_required) {
        return {
          message: result.question,
          tool_calls: [],
          done: true
        };
      }
      return {
        message: `Aha 深度探索已完成，共推进 ${result.rounds_executed} 轮，形成 ${result.meeting_board?.points?.length ?? 0} 个原子观点和 ${result.solutions?.length ?? 0} 套机制装配。\n\n${(result.solutions ?? []).map(solution => `- ${solution.name}：核心 ${solution.core_mechanism_ids.join(' + ') || '暂无'}；代价：${solution.inherent_costs.join('；') || '待核验'}`).join('\n')}\n\n这些是正交装配方向，不是排名。你可以指定一个方向继续细化。`,
        tool_calls: [],
        done: true
      };
    }
    return {
      message: parsed.map(item => item.ok
        ? `${item.name} 已完成：${JSON.stringify(item.result).slice(0, 1200)}`
        : `${item.name} 未完成：${item.error}`).join('\n'),
      tool_calls: [],
      done: true
    };
  }
  const user = [...messages].reverse().find(message => message.role === 'user' && !message.content.startsWith('Trusted session state'))?.content ?? '';
  const explicit = user.trim().startsWith('/aha');
  const design = /(?:机制|架构|系统设计|数值边界|取舍|困境|玩法设计|design|architecture)/i.test(user);
  const ahaDisabled = request.context?.enable_aha === false;
  if (!ahaDisabled && (explicit || design)) {
    return {
      message: '',
      tool_calls: [{
        id: 'mock-explore-1',
        name: 'ExploreDesign',
        arguments_json: JSON.stringify({
          problem: user.replace(/^\s*\/aha\s*/i, '').trim(),
          constraints: [],
          code_context: '离线模拟模式；没有额外工作区事实。',
          relevant_files: []
        })
      }],
      done: false
    };
  }
  return { message: `我会把它作为持续对话来处理，而不是启动固定流水线。你刚才说的是：${user}`, tool_calls: [], done: true };
}

function mockSeat(request) {
  const context = request.context;
  const index = Number(String(context.seat_id).match(/\d+/)?.[0] ?? 1);
  const round = context.round;
  const mechanisms = [
    ['可逆承诺窗', '把不可逆决定拆成短暂可撤销的承诺窗；窗口结束后才结算长期后果。', '撤销成本过低时，选择会退化成无风险试探。'],
    ['局部债务表', '即时收益会生成只对当前策略路径可见的未来债务，迫使玩家在后续节点偿还或转嫁。', '债务反馈延迟过长时，玩家无法建立因果理解。'],
    ['信息竞价权', '稀缺资源不直接兑换强度，而是购买下一轮信息的精度或公开范围。', '信息对决策价值低时，该资源失去竞争性。'],
    ['反事实回声', '系统周期性展示未选择路径的局部结果，但不允许回滚，以强化取舍的可理解性。', '展示过全会泄漏最优路线并消灭探索。'],
    ['协作否决券', '每位参与者拥有有限次数的否决权，否决必须同时提交可验证替代承诺。', '替代承诺无法核验时会成为拖延工具。'],
    ['弹性阈值', '触发阈值根据近期行为分布缓慢移动，让边界成为可被观察和利用的系统状态。', '移动速度高于用户学习速度时会显得随机。'],
    ['损失转译器', '失败不会返还原资源，而是转译成只适用于另一类行动的窄资源。', '转译资源适用面过宽时等同于无损返还。'],
    ['公开预测契约', '行动前公开预测结果区间，结算时按偏差改变下一轮的行动权限。', '结果噪声不可控时会惩罚正确推理。']
  ];
  const chosen = mechanisms[(index + round - 2) % mechanisms.length];
  return {
    seat_id: context.seat_id,
    packet_token: context.packet_token,
    analysis_summary: '算子把注意力从功能堆叠转向单一因果杠杆与失效边界。',
    contributions: round <= 2 ? [{ local_id: 'C1', type: 'mechanism', text: chosen[1], failure_condition: chosen[2] }] : [],
    verification_requests: []
  };
}

function mockGrounder(request) {
  return {
    facts: (request.context.requests ?? []).map(item => ({
      fact_ref: item.fact_ref,
      claim: item.claim,
      status: 'unknown',
      evidence_strength: 'unverified',
      evidence: [],
      search_coverage: ['离线模拟未加载可核验实现资料'],
      correction: null,
      semantic_summary: '当前资料不足，不能把该假设视为事实。',
      affected_candidate_ids: item.affected_candidate_ids
    })),
    load_requests: []
  };
}

function mockDedup(request) {
  const seen = new Set();
  return {
    operations: request.context.candidates.map(candidate => {
      const key = candidate.text.trim();
      if (seen.has(key)) return { action: 'DROP', candidate_ids: [candidate.candidate_id], target_point_id: null, text: null, failure_condition: null, type: null, reason: '与本轮已有候选重复', duplicate_of: null, evidence_refs: [] };
      seen.add(key);
      return { action: 'ADD', candidate_ids: [candidate.candidate_id], target_point_id: null, text: candidate.text, failure_condition: candidate.failure_condition, type: candidate.type, reason: null, duplicate_of: null, evidence_refs: [] };
    })
  };
}

function mockAssembly(request) {
  const ids = request.context.board.points.filter(point => point.status === 'active').map(point => point.id);
  const split = Math.max(1, Math.ceil(ids.length / 2));
  const groups = [ids.slice(0, split), ids.slice(split)].filter(group => group.length);
  return {
    solutions: groups.slice(0, 3).map((group, index) => ({
      solution_id: `SOL_${index + 1}`,
      name: index === 0 ? '可逆反馈方向' : '承诺与约束方向',
      core_mechanism_ids: group.slice(0, 2),
      defensive_patch_ids: group.slice(2, 3),
      inherent_costs: ['需要额外的规则解释与一次小规模验证']
    })),
    unresolved_questions: []
  };
}

export function mockStructuredCompletion(request) {
  if (request.phase === 'agent_turn') return mockAgentTurn(request);
  if (request.phase === 'aha_seat') return mockSeat(request);
  if (request.phase === 'aha_grounder') return mockGrounder(request);
  if (request.phase === 'aha_dedup') return mockDedup(request);
  if (request.phase === 'aha_assembly') return mockAssembly(request);
  throw new Error(`没有 ${request.phase} 的离线模拟器`);
}

export class ModelGateway {
  constructor(config, {
    mode = 'live',
    provider = chatCompletion,
    mockProvider = mockStructuredCompletion,
    signal,
    onCall,
    retryDelayMs = config.retryDelayMs ?? 500
  } = {}) {
    this.config = config;
    this.mode = mode;
    this.provider = provider;
    this.mockProvider = mockProvider;
    this.signal = signal;
    this.onCall = onCall;
    this.retryDelayMs = retryDelayMs;
    this.gates = new Map(config.models.map(model => [model.id, new ModelGate(model.maxConcurrent ?? 32, model.requestIntervalMs ?? 0)]));
  }

  async invoke({ phase, modelId, messages, schema, generation, context = {}, logicalId = phase, validator }) {
    const model = this.config.models.find(item => item.id === modelId);
    if (!model) throw new Error(`模型不存在：${modelId}`);
    const request = {
      phase,
      messages: structuredClone(messages),
      schema,
      generation,
      context,
      seed: createHash('sha256').update(logicalId).digest().readUInt32LE(0) & 0x7fffffff
    };
    let lastError;
    for (let attempt = 0; attempt <= (this.config.retries ?? 1); attempt++) {
      this.signal?.throwIfAborted();
      const release = await this.gates.get(modelId).acquire(this.signal);
      const call = { phase, model_id: modelId, logical_id: logicalId, attempt, started_at: new Date().toISOString(), status: 'running' };
      try {
        let value;
        if (this.mode === 'mock') value = await this.mockProvider(request);
        else {
          const result = await this.provider(model, request, {
            signal: this.signal,
            timeoutMs: this.config.timeoutMs ?? 180000,
            payload: buildPayload(model, request)
          });
          call.usage = result.usage ?? null;
          call.finish_reason = result.finish_reason;
          value = parseStructuredJson(result.text, schema);
        }
        if (this.mode === 'mock') parseStructuredJson(JSON.stringify(value), schema);
        if (validator) validator(value);
        call.status = 'completed';
        call.completed_at = new Date().toISOString();
        this.onCall?.(call);
        return value;
      } catch (error) {
        lastError = error;
        call.status = this.signal?.aborted ? 'cancelled' : 'failed';
        call.error = String(error?.message ?? error).slice(0, 500);
        call.completed_at = new Date().toISOString();
        this.onCall?.(call);
        // HTTP 400（上下文超限、参数非法）重发同样的包只会再错一次，还会把整个请求体再传一遍：
        // 只有 408/409/429/5xx 与本地校验失败才重试。见 src/retry_policy.mjs。
        if (this.signal?.aborted || attempt >= (this.config.retries ?? 1) || !isRetryableProviderError(error)) throw error;
        if (shouldAppendRepairFeedback(error)) {
          request.messages.push({ role: 'user', content: `上一次 JSON 未通过校验：${call.error}。只修复格式或引用错误，返回完整 JSON。` });
        }
      } finally {
        release();
      }
      await delay(this.retryDelayMs * (attempt + 1), undefined, { signal: this.signal });
    }
    throw lastError;
  }
}

export function generationFor(config, phase) {
  const fallback = { temperature: 0.2, reasoning_effort: 'low', max_output_tokens: 8192 };
  if (phase === 'agent_turn') return config.generation.agent ?? config.generation.chair ?? fallback;
  if (phase === 'aha_seat') return config.generation.creative ?? fallback;
  if (phase === 'aha_grounder') return config.generation.grounder ?? config.generation.dedup ?? fallback;
  if (phase === 'aha_dedup') return config.generation.dedup ?? fallback;
  if (phase === 'aha_assembly') return config.generation.assembly ?? config.generation.chair ?? fallback;
  return fallback;
}
