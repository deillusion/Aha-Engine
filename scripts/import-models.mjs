import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Explicit local import; never print input lines, keys or environment contents.
const source = process.argv[2] ?? path.join(root, '..', '模型列表.txt');
for (const file of ['.env', 'config.local.json']) {
  try { await access(path.join(root, file)); throw new Error(`${file} 已存在，请直接编辑现有文件，导入不会覆盖`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const lines = (await readFile(source, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
if (lines.length !== 6) throw new Error('预期模型名和密钥交替排列，共三个模型、六行');
const config = JSON.parse(await readFile(path.join(root, 'config.example.json'), 'utf8'));
const defaults = config.models[0];
const endpoints = { DEEPSEEK: 'https://api.deepseek.com', GLM: 'https://open.bigmodel.cn/api/paas/v4', GEMINI: 'https://generativelanguage.googleapis.com/v1beta/openai' };
const pairs = [0, 2, 4].map(i => ({ model: lines[i], key: lines[i + 1] }));
config.models = pairs.map(({ model, key }) => {
  const id = /^deepseek/i.test(model) ? 'DEEPSEEK' : /^glm/i.test(model) ? 'GLM' : /^gemini/i.test(model) ? 'GEMINI' : null;
  if (!id) throw new Error('未识别的模型系列');
  return { ...defaults, id, model, protocol: 'chat', baseUrl: endpoints[id], apiKeyEnv: `${id}_API_KEY`, structuredOutput: id === 'GEMINI' ? 'json_schema' : 'json_object', tokenParameter: 'max_tokens', supportsReasoning: true, ...(id === 'GLM' ? { reasoningEffortMap: { medium: 'high' } } : {}), ...(id === 'GEMINI' ? { maxOutputTokens: 65536, maxConcurrent: 1, requestIntervalMs: 2500 } : {}) };
});
if (new Set(config.models.map(m => m.id)).size !== 3) throw new Error('需要 DeepSeek、GLM、Gemini 各一个模型');
config.seats = config.models.flatMap(m => Array.from({ length: m.id === 'GEMINI' ? 4 : 2 }, (_, i) => ({ id: `${m.id === 'DEEPSEEK' ? 'D' : m.id === 'GLM' ? 'Z' : 'G'}${i + 1}`, modelId: m.id })));
config.roles = { dedup: 'GLM', chair: 'GEMINI' };
config.retryDelayMs = 5000;
config.timeoutMs = 180000;
await writeFile(path.join(root, 'config.local.json'), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const env = pairs.map((p, i) => `${config.models[i].apiKeyEnv}=${p.key}`).join('\n') + '\nPORT=4317\n# Optional: AHA_PROXY_URL=http://127.0.0.1:7890 (or direct)\n';
await writeFile(path.join(root, '.env'), env, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log('已导入三个模型，席位 DeepSeek 2 / GLM 2 / Gemini 4。密钥仅写入本地 .env。');
console.log('Gemini 使用 AI Studio 官方兼容端点；密钥前缀不用于判断账户平台。新密钥仍需连通验证。');
