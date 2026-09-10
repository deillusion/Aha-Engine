import { schemas } from './schema.mjs';
import { postJSON } from './transport.mjs';
import { getModelApiKey } from './config.mjs';
export function buildPayload(model, request) {
  const effectiveOutputLimit = Math.min(request.generation.max_output_tokens, model.maxOutputTokens ?? Infinity);
  if (model.protocol === 'gemini') {
    const generationConfig = { maxOutputTokens: effectiveOutputLimit };
    if (model.supportsTemperature) generationConfig.temperature = request.generation.temperature;
    if (model.supportsReasoning) generationConfig.thinkingConfig = { thinkingLevel: request.generation.reasoning_effort.toUpperCase() };
    if (schemas[request.phase]) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = schemas[request.phase]; }
    return { systemInstruction: { parts: request.messages.filter(m => m.role === 'system').map(m => ({ text: m.content })) }, contents: request.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig };
  }
  const payload = { model: model.model, messages: structuredClone(request.messages), [model.tokenParameter]: effectiveOutputLimit };
  if (model.supportsTemperature) payload.temperature = request.generation.temperature;
  if (model.supportsReasoning) payload.reasoning_effort = model.reasoningEffortMap?.[request.generation.reasoning_effort] ?? request.generation.reasoning_effort;
  if (model.supportsSeed) payload.seed = request.seed;
  if (model.thinking) payload.thinking = { type: model.thinking };
  const schema = schemas[request.phase];
  if (schema) {
    if (model.structuredOutput === 'json_schema') payload.response_format = { type: 'json_schema', json_schema: { name: request.phase, strict: true, schema } };
    else if (model.structuredOutput === 'json_object') payload.response_format = { type: 'json_object' };
    payload.messages.push({ role: 'user', content: `严格返回符合以下 JSON Schema 的 JSON，不输出代码围栏或解释：\n${JSON.stringify(schema)}` });
  }
  return payload;
}
export async function chatCompletion(model, request, { signal, timeoutMs, payload = buildPayload(model, request), onChunk } = {}) {
  const key = getModelApiKey(model);
  const native = model.protocol === 'gemini';
  const endpoint = `${model.baseUrl.replace(/\/$/, '')}/${native ? `${encodeURIComponent(model.model)}:generateContent` : 'chat/completions'}`;
  const response = await postJSON(endpoint, payload, { 'Content-Type': 'application/json', ...(key ? native ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` } : {}) }, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    let detail = typeof response.error?.message === 'string' ? response.error.message.slice(0, 1500) : '';
    for (const [name, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET/i.test(name) && value && value.length >= 8) detail = detail.replaceAll(value, '[REDACTED]');
    if (key && key.length >= 8) detail = detail.replaceAll(key, '[REDACTED]');
    throw new Error(`模型服务 HTTP ${response.status} (${model.id})${detail ? `：${detail}` : ''}`);
  }
  const data = response.data;
  if (native) {
    const candidate = data.candidates?.[0], u = data.usageMetadata;
    const thinking = (candidate?.content?.parts ?? []).filter(p => p.thought).map(p => p.text ?? '').join('');
    if (thinking && onChunk) {
      onChunk({ type: 'thinking', text: thinking });
      onChunk({ type: 'thinking_done' });
    }
    const result = { text: (candidate?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join(''), thinking, usage: u ? { prompt_tokens: u.promptTokenCount ?? 0, completion_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), total_tokens: u.totalTokenCount ?? null, cached_prompt_tokens: u.cachedContentTokenCount ?? 0 } : null, finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : candidate?.finishReason ?? 'unknown', resolved_model: data.modelVersion ?? model.model, provider_request_id: response.requestId };
    if (result.finish_reason !== 'stop' || !result.text.trim()) { const error = new Error(`Gemini 输出不完整或被拒绝：${result.finish_reason}`); error.result = result; throw error; }
    return result;
  }
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || null;
  if (reasoning && onChunk) {
    onChunk({ type: 'thinking', text: reasoning });
    onChunk({ type: 'thinking_done' });
  }
  const result = { text: typeof text === 'string' ? text : '', thinking: reasoning || '', usage: data.usage ?? null, finish_reason: choice?.finish_reason ?? 'unknown', provider_request_id: response.requestId, resolved_model: data.model ?? model.model };
  if (choice?.message?.refusal || choice?.finish_reason !== 'stop' || !result.text.trim()) {
    const error = new Error(`模型输出不完整或被拒绝：${result.finish_reason}`); error.result = result; throw error;
  }
  return result;
}
