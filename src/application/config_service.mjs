import { loadConfig, saveConfig, getModelApiKey, isModelAvailable, resolveActiveConfig } from '../config.mjs';
import { chatCompletion } from '../provider.mjs';
import { operators } from '../operators.mjs';
import { domainCatalog } from '../domain_operators.mjs';
import { EXPERIMENTS } from './experiment_catalog.mjs';

function sanitizedConfig(config) {
  if (!config) return null;
  const cloned = structuredClone(config);
  cloned.models = cloned.models.map(model => {
    const rawKey = getModelApiKey(model);
    const hasKey = rawKey !== null;
    const maskedKey = rawKey ? (rawKey.length > 8 ? `${rawKey.slice(0, 4)}••••${rawKey.slice(-4)}` : '••••••••') : '';
    const keySource = model.apiKey ? 'config' : (model.apiKeyEnv && process.env[model.apiKeyEnv] ? 'env' : 'none');
    const { apiKey, ...rest } = model;
    return { ...rest, hasKey, maskedKey, keySource };
  });
  return cloned;
}

export class ConfigService {
  constructor({ root } = {}) { this.root = root; }

  async overview(extra = {}) {
    let liveConfig = null;
    let liveError = null;
    let routingPreview = null;
    try {
      liveConfig = await loadConfig(this.root, 'live', { allowKeyless: true });
      try {
        routingPreview = resolveActiveConfig(liveConfig, 'live').routing;
      } catch {
        const activeModels = liveConfig.models.filter(model => isModelAvailable(model, 'live'));
        const activeIds = new Set(activeModels.map(model => model.id));
        routingPreview = {
          totalModels: liveConfig.models.length,
          activeModels: [...activeIds],
          inactiveModels: liveConfig.models.filter(model => !activeIds.has(model.id)).map(model => model.id),
          seatDistribution: {}, remappedSeats: [], remappedRoles: {}, isAdaptive: false
        };
      }
    } catch (error) {
      liveError = error.message;
    }
    return {
      mockConfig: await loadConfig(this.root, 'mock'),
      liveConfig: sanitizedConfig(liveConfig),
      rawConfigPresent: !!liveConfig,
      liveError,
      routingPreview,
      experiments: EXPERIMENTS,
      operators,
      domainCatalog,
      ...extra
    };
  }

  save(config) { return saveConfig(this.root, config); }

  async testModel({ modelConfig, modelId, apiKey } = {}) {
    let model;
    if (modelConfig && typeof modelConfig === 'object') {
      model = structuredClone(modelConfig);
    } else if (modelId) {
      const liveConfig = await loadConfig(this.root, 'live', { allowKeyless: true });
      const found = liveConfig.models.find(item => item.id === modelId);
      if (!found) {
        const error = new Error(`未找到模型配置: ${modelId}`);
        error.code = 'MODEL_NOT_FOUND';
        throw error;
      }
      model = structuredClone(found);
    } else {
      throw new Error('缺少 modelId 或 modelConfig');
    }
    if (typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•••')) model.apiKey = apiKey.trim();
    model.protocol ||= 'chat';
    model.structuredOutput ||= 'json_object';
    model.tokenParameter ||= 'max_tokens';
    model.supportsTemperature ??= true;
    model.supportsReasoning ??= true;
    model.supportsSeed ??= false;

    let isLocal = false;
    try { isLocal = ['localhost', '127.0.0.1', '::1'].includes(new URL(model.baseUrl).hostname); } catch {}
    if (!getModelApiKey(model) && model.apiKeyEnv !== null && !isLocal && !model.isKeyless) {
      return { ok: false, error: '未检测到 API Key，请先输入 Key 后测试' };
    }
    const started = Date.now();
    try {
      const result = await chatCompletion(model, {
        phase: 'direct',
        messages: [{ role: 'user', content: '严格返回 JSON: {"text":"ok"}' }],
        generation: { max_output_tokens: 64, temperature: 0.1, reasoning_effort: 'low' },
        seed: 1
      }, { timeoutMs: 15000 });
      return { ok: true, latencyMs: Date.now() - started, model: model.model, response: result.text };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, model: model.model, error: error.message };
    }
  }

  async discoverModels({ baseUrl, apiKey, protocol, modelId } = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') throw new Error('请提供有效的 baseUrl');
    try {
      const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
      let effectiveKey = typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•••') && apiKey !== '__EXISTING__'
        ? apiKey.trim()
        : null;
      if (!effectiveKey && modelId) {
        try {
          const liveConfig = await loadConfig(this.root, 'live');
          const existing = liveConfig.models?.find(model => model.id === modelId);
          if (existing) effectiveKey = getModelApiKey(existing);
        } catch {}
      }
      let isLocal = false;
      try { isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(new URL(baseUrl).hostname); } catch {}
      if (!isLocal && !effectiveKey) return { ok: false, needsKey: true, error: '探测云端服务商模型必须提供 API Key 凭据。请在下方填入 API Key 后重试。' };

      if (protocol === 'gemini') {
        const endpoint = `${cleanUrl}/models${effectiveKey ? `?key=${encodeURIComponent(effectiveKey)}` : ''}`;
        const response = await fetch(endpoint, { headers: effectiveKey ? { 'x-goog-api-key': effectiveKey } : {}, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          const text = await response.text();
          if ([400, 401, 403].includes(response.status)) return { ok: false, isAuthError: true, error: `Gemini API Key 认证未通过 (HTTP ${response.status})，请核对 Key 是否正确` };
          return { ok: false, error: `Gemini HTTP ${response.status}: ${text.slice(0, 300)}` };
        }
        const data = await response.json();
        return { ok: true, models: (data.models || []).map(model => {
          const name = model.name?.replace(/^models\//, '') || model.name;
          return { id: name, name: model.displayName || name };
        }) };
      }

      const headers = { 'Content-Type': 'application/json' };
      if (effectiveKey) {
        if (cleanUrl.includes('anthropic.com')) {
          headers['x-api-key'] = effectiveKey;
          headers['anthropic-version'] = '2023-06-01';
        } else headers.Authorization = `Bearer ${effectiveKey}`;
      }
      let endpoint = `${cleanUrl}/models`;
      let response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok && response.status === 404 && !cleanUrl.endsWith('/v1')) {
        endpoint = `${cleanUrl}/v1/models`;
        response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
      }
      if (!response.ok) {
        const text = await response.text();
        if ([401, 403].includes(response.status)) return { ok: false, isAuthError: true, error: `API Key 认证未通过 (HTTP ${response.status})：密钥无效或无权访问模型列表，请核对下方 API Key` };
        if (response.status === 404) return { ok: false, isNotFound: true, error: '该服务端点未开放 /models 模型探测接口 (HTTP 404)。请直接使用下方推荐选型或手动输入模型标识。' };
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
      }
      const data = await response.json();
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      return { ok: true, models: list.map(model => ({ id: model.id || model.name, name: model.name || model.id })).filter(model => model.id) };
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.message?.includes('timeout');
      return { ok: false, error: isTimeout ? '连接服务端点超时，请检查 Base URL 是否正确或网络是否畅通' : error.message };
    }
  }
}
