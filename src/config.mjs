import { readFile, writeFile } from 'node:fs/promises';
import { assert } from './schema.mjs';

export function getModelApiKey(model) {
  if (model?.apiKey && typeof model.apiKey === 'string' && model.apiKey.trim()) {
    return model.apiKey.trim();
  }
  if (model?.apiKeyEnv && typeof model.apiKeyEnv === 'string' && process.env[model.apiKeyEnv]) {
    return process.env[model.apiKeyEnv].trim();
  }
  return null;
}

export function isModelAvailable(model, mode = 'live') {
  if (mode === 'mock') return true;
  if (!model) return false;
  if (model.isKeyless || (model.apiKeyEnv === null && !model.apiKey)) return true;
  try {
    const u = new URL(model.baseUrl);
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !model.apiKey && !model.apiKeyEnv) {
      return true;
    }
  } catch {}
  return getModelApiKey(model) !== null;
}

export function resolveActiveConfig(config, mode = 'live') {
  if (mode === 'mock') {
    return {
      config,
      routing: {
        totalModels: config.models.length,
        activeModels: config.models.map(m => m.id),
        inactiveModels: [],
        seatDistribution: Object.fromEntries(config.models.map(m => [m.id, config.seats.filter(s => s.modelId === m.id).length])),
        remappedSeats: [],
        remappedRoles: {},
        isAdaptive: false
      }
    };
  }

  const activeModels = config.models.filter(m => isModelAvailable(m, mode));
  assert(activeModels.length > 0, '未检测到任何可用模型的 API Key。请在 WebUI 中至少为一个模型配置 API Key。');

  const activeIds = new Set(activeModels.map(m => m.id));
  const resolved = structuredClone(config);
  const remappedSeats = [];
  const remappedRoles = {};

  // 1. Role Fallback:
  const preferredFallbackRoleModel = activeIds.has(config.roles?.chair) ? config.roles.chair : activeModels[0].id;
  for (const roleKey of ['chair', 'dedup', 'dealer', 'main', 'grounder', 'assembly']) {
    const currentModelId = resolved.roles?.[roleKey];
    if (currentModelId && !activeIds.has(currentModelId)) {
      resolved.roles[roleKey] = preferredFallbackRoleModel;
      remappedRoles[roleKey] = { from: currentModelId, to: preferredFallbackRoleModel };
    }
  }

  // 2. Seat Greedy Load Balancing:
  const activeModelSeatCounts = new Map(activeModels.map(m => [m.id, 0]));
  for (const seat of resolved.seats) {
    if (activeIds.has(seat.modelId)) {
      activeModelSeatCounts.set(seat.modelId, activeModelSeatCounts.get(seat.modelId) + 1);
    }
  }

  for (const seat of resolved.seats) {
    if (!activeIds.has(seat.modelId)) {
      let minCount = Infinity;
      let targetModelId = activeModels[0].id;
      for (const m of activeModels) {
        const count = activeModelSeatCounts.get(m.id) || 0;
        if (count < minCount) {
          minCount = count;
          targetModelId = m.id;
        }
      }
      remappedSeats.push({ seatId: seat.id, from: seat.modelId, to: targetModelId });
      seat.modelId = targetModelId;
      activeModelSeatCounts.set(targetModelId, (activeModelSeatCounts.get(targetModelId) || 0) + 1);
    }
  }

  const isAdaptive = remappedSeats.length > 0 || Object.keys(remappedRoles).length > 0;
  const routing = {
    totalModels: config.models.length,
    activeModels: activeModels.map(m => m.id),
    inactiveModels: config.models.filter(m => !activeIds.has(m.id)).map(m => m.id),
    seatDistribution: Object.fromEntries(activeModelSeatCounts),
    remappedSeats,
    remappedRoles,
    isAdaptive
  };

  return { config: resolved, routing };
}

export async function saveConfig(root, newConfig) {
  let existing = null;
  try {
    existing = JSON.parse(await readFile(`${root}/config.local.json`, 'utf8'));
  } catch {}

  if (existing && Array.isArray(existing.models)) {
    const existingMap = new Map(existing.models.map(m => [m.id, m]));
    for (const m of newConfig.models) {
      const prev = existingMap.get(m.id);
      if (prev?.apiKey) {
        if (m.apiKey === undefined || m.apiKey === '' || (typeof m.apiKey === 'string' && m.apiKey.includes('•••'))) {
          m.apiKey = prev.apiKey;
        } else if (m.apiKey === '__CLEAR__') {
          delete m.apiKey;
        }
      } else if (m.apiKey === '__CLEAR__' || m.apiKey === '') {
        delete m.apiKey;
      }
    }
  }

  // Fallback for seats and roles if a model was deleted
  const validModelIds = new Set(newConfig.models.map(m => m.id));
  const fallbackModelId = newConfig.models[0]?.id;
  if (fallbackModelId) {
    if (Array.isArray(newConfig.seats)) {
      for (const seat of newConfig.seats) {
        if (!validModelIds.has(seat.modelId)) {
          seat.modelId = fallbackModelId;
        }
      }
    }
    if (newConfig.roles) {
      for (const roleKey of ['chair', 'dedup', 'dealer', 'main', 'grounder', 'assembly']) {
        if (!validModelIds.has(newConfig.roles[roleKey])) {
          newConfig.roles[roleKey] = fallbackModelId;
        }
      }
    }
  }

  validateConfig(newConfig, 'live');
  const targetPath = `${root}/config.local.json`;
  await writeFile(targetPath, JSON.stringify(newConfig, null, 2) + '\n', 'utf8');
  return newConfig;
}

export async function loadConfig(root, mode = 'mock', { allowKeyless = false } = {}) {
  let config;
  if (mode === 'mock') {
    config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
    config.models = config.models.map(m => ({ ...m, baseUrl: 'mock://local', apiKeyEnv: null }));
  } else {
    try { config = JSON.parse(await readFile(`${root}/config.local.json`, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') {
        try { config = JSON.parse(await readFile(`${root}/config.example.json`, 'utf8')); }
        catch { config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')); }
      } else {
        throw new Error(`配置无法读取：${e.message}`);
      }
    }
  }
  // Accept older config files, but do not expose or freeze the retired stage.
  if (config.roles) {
    delete config.roles.extractor;
    if (!config.roles.dealer) config.roles.dealer = config.roles.chair || config.seats[0]?.modelId;
    if (!config.roles.main) config.roles.main = config.roles.chair || config.seats[0]?.modelId;
    if (!config.roles.grounder) config.roles.grounder = config.roles.dedup || config.roles.main;
    if (!config.roles.assembly) config.roles.assembly = config.roles.chair || config.roles.main;
  }
  if (config.generation) {
    delete config.generation.extractor;
    if (!config.generation.dealer) config.generation.dealer = structuredClone(config.generation.chair || config.generation.creative || { max_output_tokens: 1024, temperature: 0.2 });
    if (!config.generation.agent) config.generation.agent = structuredClone(config.generation.chair || { max_output_tokens: 8192, temperature: 0.3, reasoning_effort: 'low' });
    if (!config.generation.grounder) config.generation.grounder = structuredClone(config.generation.dedup || { max_output_tokens: 16384, temperature: 0.1, reasoning_effort: 'low' });
    if (!config.generation.assembly) config.generation.assembly = structuredClone(config.generation.chair || { max_output_tokens: 8192, temperature: 0.3, reasoning_effort: 'low' });
    if (config.generation.dedup && config.generation.dedup.reasoning_effort === 'low') {
      config.generation.dedup.reasoning_effort = 'none';
      config.generation.dedup.thinking ??= 'disabled';
    }
  }
  validateConfig(config, mode, { allowKeyless });
  return config;
}

export function validateConfig(c, mode, { allowKeyless = false } = {}) {
  assert(Array.isArray(c.models) && c.models.length > 0 && Array.isArray(c.seats) && c.seats.length > 0 && c.seats.length <= 32, '模型和席位不能为空，席位上限32');
  const ids = c.models.map(m => m.id);
  assert(new Set(ids).size === ids.length && new Set(c.seats.map(s => s.id)).size === c.seats.length, '模型或席位 ID 重复');
  for (const s of c.seats) assert(/^[A-Za-z0-9_-]+$/.test(s.id) && ids.includes(s.modelId), '席位模型引用错误');
  for (const role of ['dedup', 'chair']) assert(ids.includes(c.roles?.[role]), `缺少 ${role} 模型`);
  if (c.roles?.dealer) assert(ids.includes(c.roles.dealer), '缺少 dealer 模型');
  for (const role of ['main', 'grounder', 'assembly']) if (c.roles?.[role]) assert(ids.includes(c.roles[role]), `缺少 ${role} 模型`);
  for (const phase of ['creative', 'dedup', 'decision', 'chair']) {
    const g = c.generation?.[phase];
    assert(g && Number.isInteger(g.max_output_tokens) && g.max_output_tokens > 0, `${phase} token 上限错误`);
    assert(Number.isFinite(g.temperature) && g.temperature >= 0 && g.temperature <= 2, `${phase} temperature 错误`);
    assert(g.thinking == null || ['enabled', 'disabled'].includes(g.thinking), `${phase} thinking 必须是 enabled 或 disabled`);
  }
  if (c.generation?.dealer) {
    const g = c.generation.dealer;
    assert(Number.isInteger(g.max_output_tokens) && g.max_output_tokens > 0, 'dealer token 上限错误');
    assert(Number.isFinite(g.temperature) && g.temperature >= 0 && g.temperature <= 2, 'dealer temperature 错误');
  }
  for (const phase of ['agent', 'grounder', 'assembly']) {
    if (!c.generation?.[phase]) continue;
    const g = c.generation[phase];
    assert(Number.isInteger(g.max_output_tokens) && g.max_output_tokens > 0, `${phase} token 上限错误`);
    assert(Number.isFinite(g.temperature) && g.temperature >= 0 && g.temperature <= 2, `${phase} temperature 错误`);
  }

  assert(Number.isInteger(c.retries) && c.retries >= 0 && c.retries <= 2, '重试次数须为0–2');
  assert(Number.isFinite(c.timeoutMs) && c.timeoutMs >= 100, 'timeoutMs 无效');
  assert(c.retryDelayMs == null || (Number.isFinite(c.retryDelayMs) && c.retryDelayMs >= 0), 'retryDelayMs 无效');
  for (const k of ['minimumCreativeRatio', 'minimumDecisionRatio']) assert(c[k] > 0 && c[k] <= 1, `${k} 须大于0且不超过1`);
  for (const m of c.models) {
    assert(m.id && typeof m.id === 'string' && /^[A-Za-z0-9_-]+$/.test(m.id), `模型 ID "${m?.id}" 格式无效，仅支持字母、数字、下划线和短横线`);
    assert(m.maxOutputTokens == null || (Number.isInteger(m.maxOutputTokens) && m.maxOutputTokens > 0), 'maxOutputTokens 无效');
    assert(m.maxConcurrent == null || (Number.isInteger(m.maxConcurrent) && m.maxConcurrent >= 1 && m.maxConcurrent <= 32), 'maxConcurrent 须为1–32');
    assert(m.requestIntervalMs == null || (Number.isFinite(m.requestIntervalMs) && m.requestIntervalMs >= 0), 'requestIntervalMs 无效');
    assert(m.protocol == null || ['chat', 'gemini'].includes(m.protocol), 'protocol 必须是 chat 或 gemini');
    assert(m.thinking == null || ['enabled', 'disabled'].includes(m.thinking), 'thinking 必须是 enabled 或 disabled');
    if (m.reasoningEffortMap != null) {
      assert(typeof m.reasoningEffortMap === 'object' && !Array.isArray(m.reasoningEffortMap), 'reasoningEffortMap 须为对象');
      for (const [key, value] of Object.entries(m.reasoningEffortMap)) assert(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(key) && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value), 'reasoningEffortMap 包含无效映射');
    }
    assert(['json_schema', 'json_object', 'prompt'].includes(m.structuredOutput), 'structuredOutput 无效');
    assert(['max_tokens', 'max_completion_tokens'].includes(m.tokenParameter), 'tokenParameter 无效');
    for (const k of ['inputPricePerMillion', 'outputPricePerMillion']) assert(m[k] == null || (Number.isFinite(m[k]) && m[k] >= 0), '价格必须为空或非负数');
    assert(!Object.hasOwn(m, 'headers'), '不允许包含未授权 headers');
    assert(m.apiKey == null || typeof m.apiKey === 'string', 'apiKey 必须为字符串或为空');
    if (mode !== 'mock') {
      const url = new URL(m.baseUrl);
      assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'baseUrl 必须是无凭据、无查询参数的 HTTP(S) URL');
      assert(typeof m.model === 'string' && m.model.trim() && !m.model.includes('YOUR_') && !m.baseUrl.includes('YOUR_'), '请替换模型或服务地址占位符');
    }
  }
  if (mode !== 'mock' && !allowKeyless) {
    const activeCount = c.models.filter(m => isModelAvailable(m, mode)).length;
    assert(activeCount > 0, '未配置任何可用的模型 API Key。请在 WebUI 中至少为一个模型配置 API Key（或配置对应环境变量）。');
  }
}
