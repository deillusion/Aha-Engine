import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { messages } from '../prompts.mjs';
import { buildPayload, chatCompletion } from '../provider.mjs';
import { mockCompletion } from '../mock.mjs';
import { ModelGate } from '../scheduler.mjs';

function retryFeedback(request, error, lastResponse = null) {
  if (lastResponse) request.messages.push({ role: 'assistant', content: String(lastResponse).slice(0, 4000) });
  request.messages.push({ role: 'user', content: `上一次回答未通过校验：${String(error?.message ?? error).slice(0, 500)}\n只修复该问题后重新返回完整 JSON。不要复述或回显 schema，不要输出多余字段。` });
}

export function createModelExecutor(run, config, {
  signal,
  provider,
  mockDelayMs = 180,
  retryDelayMs = config.retryDelayMs ?? 500,
  onEvent,
  checkpoint = async () => {},
  now = () => new Date()
} = {}) {
  const gates = new Map(config.models.map(m => [m.id, new ModelGate(m.maxConcurrent ?? 32, m.requestIntervalMs ?? 0)]));

  function abortCheck() { signal?.throwIfAborted(); }

  return async function invoke(phase, modelId, context, validate, seatId = null, onStreamChunk = null, onFailure = null) {
    abortCheck();
    const model = config.models.find(m => m.id === modelId);
    if (!model) throw new Error(`执行计划引用了不存在的模型：${modelId}`);
    const genKey = phase === 'direct' ? 'chair' : (config.generation[phase] ? phase : 'chair');
    const request = {
      phase,
      messages: messages(phase, run, context),
      generation: config.generation[genKey],
      seed: createHash('sha256').update(`${run.seed}/${phase}/${context.round}/${seatId ?? modelId}`).digest().readUInt32LE(0) & 0x7fffffff,
      context
    };
    // Keep one provider payload across attempts: validation feedback is appended to this exact
    // conversation, while the original failed call retains its frozen audit snapshot.
    const payload = buildPayload(model, request);
    const logicalId = `${phase}-${context.round}-${seatId ?? modelId}`;
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      abortCheck();
      const queuedAt = now().getTime();
      const release = await gates.get(modelId).acquire(signal);
      const startedAt = now();
      const call = {
        id: `${logicalId}-${attempt}`,
        logical_id: logicalId,
        phase,
        round: context.round,
        seat_id: seatId,
        model_id: modelId,
        model: model.model,
        base_url: model.baseUrl,
        attempt,
        queue_wait_ms: startedAt.getTime() - queuedAt,
        requested_output_limit: request.generation.max_output_tokens,
        effective_output_limit: payload[model.tokenParameter] ?? payload.generationConfig?.maxOutputTokens,
        board_version_read: context.board?.version ?? null,
        proposal_ids_read: context.proposals?.map(p => p.proposal_id) ?? null,
        status: 'running',
        started_at: startedAt.toISOString(),
        request: structuredClone(payload),
        usage: null,
        estimated_cost: null,
        thinking: ''
      };
      run.calls.push(call);
      let result;
      try {
        await checkpoint();
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
        call.response = result.text;
        call.usage = result.usage;
        call.finish_reason = result.finish_reason;
        call.resolved_model = result.resolved_model;
        call.provider_request_id = result.provider_request_id ?? null;
        if (result.thinking) {
          if (!call.thinking) {
            call.thinking = result.thinking;
            onStreamChunk?.({ type: 'thinking', text: result.thinking });
            onStreamChunk?.({ type: 'thinking_done', text: result.thinking });
          } else call.thinking = result.thinking;
        }
        const value = JSON.parse(result.text);
        if (typeof value === 'string' && !value.trim()) throw new Error('模型回答为空');
        if (validate) validate(value);
        abortCheck();
        call.status = 'completed';
        return value;
      } catch (error) {
        if (error.result) {
          call.response = error.result.text;
          call.usage = error.result.usage;
          call.finish_reason = error.result.finish_reason;
        }
        call.status = signal?.aborted ? 'cancelled' : 'failed';
        call.error = error instanceof SyntaxError ? '模型未返回有效 JSON' : error.message;
        if (onFailure && !signal?.aborted) {
          try {
            const salvaged = onFailure(error, call.response ?? null);
            if (salvaged?.value !== undefined && salvaged.value !== null) {
              if (validate) validate(salvaged.value);
              call.salvage = salvaged.value;
              call.salvaged = true;
              call.salvage_repairs = salvaged.repairs ?? [];
            }
          } catch {}
        }
        if (signal?.aborted || attempt === config.retries) {
          if (call.salvage !== undefined) {
            const final = new Error(call.error);
            final.salvage = call.salvage;
            throw final;
          }
          throw error;
        }
        retryFeedback(payload, error, call.response ?? null);
      } finally {
        call.completed_at = now().toISOString();
        call.latency_ms = Date.parse(call.completed_at) - Date.parse(call.started_at);
        if (Number.isFinite(call.usage?.prompt_tokens) && Number.isFinite(call.usage?.completion_tokens) && model.inputPricePerMillion != null && model.outputPricePerMillion != null) {
          call.estimated_cost = (call.usage.prompt_tokens * model.inputPricePerMillion + call.usage.completion_tokens * model.outputPricePerMillion) / 1e6;
        }
        try { await checkpoint(); } finally { release(); }
      }
      await delay(retryDelayMs * (attempt + 1), undefined, { signal });
    }
  };
}
