import { setTimeout as delay } from 'node:timers/promises';
import { postJSON } from '../transport.mjs';
import { isRetryableProviderError } from '../retry_policy.mjs';

export const DEFAULT_JEV_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 30000,
  retries: 2,
  askProbabilityThreshold: 0.9,
  askConfidenceThreshold: 0.8,
  subproblemDuplicateThreshold: 0.85
});

export function normalizedJevConfig(config = {}) {
  const configured = config.decisionProviders?.jev ?? config.jev ?? {};
  return { ...DEFAULT_JEV_CONFIG, ...configured };
}

export function getJevApiKey(config = {}, env = process.env) {
  const jev = normalizedJevConfig(config);
  if (typeof jev.apiKey === 'string' && jev.apiKey.trim()) return jev.apiKey.trim();
  if (typeof jev.apiKeyEnv === 'string' && env[jev.apiKeyEnv]?.trim()) return env[jev.apiKeyEnv].trim();
  return null;
}

function redactSecrets(text, key, env) {
  let safe = String(text ?? '').slice(0, 1500);
  for (const [name, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET/i.test(name) && value && value.length >= 8) safe = safe.replaceAll(value, '[REDACTED]');
  }
  if (key?.length >= 8) safe = safe.replaceAll(key, '[REDACTED]');
  return safe;
}

function systemOneEndpoint(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/v1/systemone') ? clean : `${clean}/v1/systemone`;
}

function decisionData(response) {
  const data = response?.data?.data ?? response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Jev 返回了无效的响应对象');
  if (!data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) throw new Error('Jev 响应缺少 answers');
  return data;
}

function finiteProbability(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

export class JevDecisionGateway {
  constructor(config = {}, {
    signal,
    onCall,
    transport = postJSON,
    env = process.env,
    retryDelayMs = 500
  } = {}) {
    this.config = normalizedJevConfig(config);
    this.signal = signal;
    this.onCall = onCall;
    this.transport = transport;
    this.env = env;
    this.retryDelayMs = retryDelayMs;
    this.apiKey = getJevApiKey(config, env);
    if (!this.apiKey) throw new Error(`Jev 未配置 ${this.config.apiKeyEnv}`);
  }

  async decide({ state, questions, phase = 'jev_decision', logicalId = phase }) {
    const payload = { model: this.config.model, state, questions };
    let lastError;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      this.signal?.throwIfAborted();
      const call = {
        phase,
        model_id: 'JEV',
        logical_id: logicalId,
        attempt,
        started_at: new Date().toISOString(),
        status: 'running'
      };
      try {
        const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
        const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
        const response = await this.transport(
          systemOneEndpoint(this.config.baseUrl),
          payload,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          { signal }
        );
        if (!response.ok) {
          const detail = redactSecrets(response.error?.message ?? response.error?.detail ?? '', this.apiKey, this.env);
          const error = new Error(`Jev 服务 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
          error.status = response.status;
          throw error;
        }
        const data = decisionData(response);
        call.status = 'completed';
        call.completed_at = new Date().toISOString();
        call.usage = data.usage ?? null;
        call.finish_reason = 'decision';
        call.provider_request_id = response.requestId ?? data.id ?? null;
        this.onCall?.(call);
        return data;
      } catch (error) {
        lastError = error;
        call.status = this.signal?.aborted ? 'cancelled' : 'failed';
        call.error = redactSecrets(error?.message ?? error, this.apiKey, this.env).slice(0, 500);
        call.completed_at = new Date().toISOString();
        this.onCall?.(call);
        if (this.signal?.aborted || attempt >= this.config.retries || !isRetryableProviderError(error)) throw error;
      }
      await delay(this.retryDelayMs * (attempt + 1), undefined, { signal: this.signal });
    }
    throw lastError;
  }

  async evaluateVarinaNeed({ originalUserRequest, baselineAnswer, logicalId = 'varina-gate' }) {
    const data = await this.decide({
      phase: 'varina_gate',
      logicalId,
      state: {
        original_user_request: originalUserRequest,
        baseline_answer: baselineAnswer
      },
      questions: {
        relevance: {
          type: 'choice',
          instructions: 'Decide whether a completed answer has any plausible value to gain from deeper exploration. Uncertainty belongs to START. Choose ASK only when deeper exploration is plainly irrelevant.',
          criteria: {
            START: 'There may be useful mechanisms, counterexamples, corrections, alternatives, trade-offs, or unresolved solution space to explore.',
            ASK: 'The request is plainly unrelated to design exploration, such as a greeting or trivial closed fact, with no meaningful mechanism or alternative space.'
          }
        }
      }
    });
    const answer = data.answers.relevance;
    if (!answer || typeof answer !== 'object') throw new Error('Jev 响应缺少 relevance 决策');
    const choice = String(answer.choice ?? answer.selected ?? '').toUpperCase();
    if (!['START', 'ASK'].includes(choice)) throw new Error(`Jev 返回了未知选择：${choice || '(empty)'}`);
    const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};
    const askProbability = finiteProbability(probabilities.ASK ?? probabilities.ask);
    const confidence = finiteProbability(answer.confidence);
    const shouldAsk = choice === 'ASK'
      && askProbability !== null
      && confidence !== null
      && askProbability >= this.config.askProbabilityThreshold
      && confidence >= this.config.askConfidenceThreshold;
    const decision = shouldAsk ? 'ASK' : 'START';
    const probabilityText = askProbability === null ? 'unknown' : askProbability.toFixed(3);
    const confidenceText = confidence === null ? 'unknown' : confidence.toFixed(3);
    return {
      decision,
      reason: shouldAsk
        ? `jev_obviously_irrelevant ask_probability=${probabilityText} confidence=${confidenceText}`
        : `jev_uncertain_or_relevant choice=${choice} ask_probability=${probabilityText} confidence=${confidenceText}`,
      jev: {
        choice,
        probabilities,
        confidence,
        model: data.model ?? this.config.model
      }
    };
  }

  async evaluateSubproblemRedundancy({
    parentProblem,
    referenceSubproblems,
    candidateSubproblems,
    logicalId = 'subproblem-dedup'
  }) {
    if (!Array.isArray(referenceSubproblems) || !Array.isArray(candidateSubproblems)) {
      throw new Error('Jev 子问题判重输入必须是数组');
    }
    if (!candidateSubproblems.length) return { decisions: [], model: this.config.model };
    if (!referenceSubproblems.length) {
      return {
        decisions: candidateSubproblems.map(candidate => ({
          candidate_id: candidate.candidate_id,
          duplicate: false,
          probability: 0
        })),
        model: this.config.model
      };
    }

    const renderItems = items => items.map(item => `${item.candidate_id}: ${item.question}`).join('\n');
    const state = `[SUBPROBLEM_DEDUP_POLICY v1]

任务：判断一个候选子问题是否应当因为与参照集合中的某一个单独子问题实质重复而删除。这里去重的是父问题的问题拆解节点，不是解决方案、实现机制、主题或最终答案。

返回 True，当且仅当参照集合中至少存在一个单独子问题，同时满足：
1. 两者在当前父问题下追问实质相同的未知量、约束或决策；
2. 若交给两个独立执行者，他们会进行基本相同的调查、实验或推理；
3. 对其中一个子问题的完整回答，无需增加新的关键事实、约束分析或推理步骤，就能实质回答另一个；
4. 差异只在措辞、例子、详略或不改变调查任务的观察角度。

以下任一情况必须返回 False：
1. 只是服务于同一个父问题、目标、方案或主题，但追问不同未知量；
2. 一个问需要实现什么作用，另一个问使用什么具体机制满足它；
3. 一个问原因或前提，另一个问后果、验证方法、失效边界、风险或解决办法；
4. 一个是上游条件，另一个是下游决策；
5. 一个更窄，并引入需要单独调查的新条件、变量或边界；
6. 完整回答其中一个之后，另一个仍可能没有答案；
7. 只有把多个参照子问题拼接起来，才能覆盖候选；
8. 无法确定是否满足 True 的全部条件。

不得因为使用相同术语、上下文相近、共享证据、指向同一最终方案或会由同一个人处理，就判定重复。不得组合多个参照子问题共同得出 True；必须存在某一个单项即可独立构成重复。

[PARENT_PROBLEM]
${parentProblem}

[REFERENCE_SUBPROBLEMS]
${renderItems(referenceSubproblems)}

[CANDIDATE_SUBPROBLEMS]
${renderItems(candidateSubproblems)}`;

    const questionEntries = candidateSubproblems.map((candidate, index) => {
      const key = `redundant_${index + 1}`;
      return [key, {
        type: 'noul',
        instructions: [
          'Apply SUBPROBLEM_DEDUP_POLICY v1. Judge only the candidate supplied next against REFERENCE_SUBPROBLEMS.',
          { candidate_id: candidate.candidate_id }
        ],
        criteria: {
          true: 'DELETE: at least one single reference subproblem independently duplicates this candidate.',
          false: 'KEEP: no single reference subproblem independently duplicates this candidate, or the evidence is uncertain.'
        }
      }];
    });
    const data = await this.decide({
      phase: 'varina_subproblem_dedup',
      logicalId,
      state,
      questions: Object.fromEntries(questionEntries)
    });
    const threshold = this.config.subproblemDuplicateThreshold;
    const decisions = candidateSubproblems.map((candidate, index) => {
      const key = `redundant_${index + 1}`;
      const answer = data.answers[key];
      if (!answer || typeof answer !== 'object') throw new Error(`Jev 响应缺少 ${key} 决策`);
      const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};
      let probability = finiteProbability(probabilities.true ?? probabilities.TRUE ?? probabilities.True);
      if (probability === null) {
        const raw = answer.noul ?? answer.boolean ?? answer.value ?? answer.choice ?? answer.selected;
        if (typeof raw === 'boolean') probability = raw ? 1 : 0;
        else if (typeof raw === 'string' && /^(?:true|yes)$/i.test(raw)) probability = 1;
        else if (typeof raw === 'string' && /^(?:false|no)$/i.test(raw)) probability = 0;
      }
      if (probability === null) throw new Error(`Jev ${key} 缺少有效的 True 概率`);
      return {
        candidate_id: candidate.candidate_id,
        duplicate: probability >= threshold,
        probability
      };
    });
    return { decisions, model: data.model ?? this.config.model, threshold };
  }
}

export function createJevDecisionGateway(config, options = {}) {
  const jev = normalizedJevConfig(config);
  if (options.mode === 'mock' || !jev.enabled || !getJevApiKey(config, options.env ?? process.env)) return null;
  return new JevDecisionGateway(config, options);
}
