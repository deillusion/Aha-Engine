import { loadConfig } from '../src/config.mjs';
import { chatCompletion } from '../src/provider.mjs';
import { validateSchema, schemas } from '../src/schema.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = await loadConfig(root, 'live');
const selected = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (process.argv.includes('--gemini-ai-studio')) {
  const model = config.models.find(m => m.id === 'GEMINI');
  model.protocol = 'chat'; model.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
}
const results = [];
await Promise.allSettled(config.models.filter(m => !selected.length || selected.includes(m.id)).map(async model => {
  for (const phase of ['creative', 'decision']) {
    const started = Date.now();
    const request = { phase, seed: 42, generation: { ...config.generation[phase], reasoning_effort: 'low', ...(process.argv.includes('--configured-limits') ? {} : { max_output_tokens: 2048 }) }, messages: [{ role: 'system', content: '你正在接受接口连通测试。请简短作答。' }, { role: 'user', content: phase === 'creative' ? '只输出：连接成功' : '返回 JSON 对象：text 为“连接成功”，cited_point_ids 为空数组。' }] };
    const record = { model_id: model.id, model: model.model, base_url: model.baseUrl, phase, started_at: new Date(started).toISOString() };
    try {
      const result = await chatCompletion(model, request, { timeoutMs: 60000 });
      if (phase === 'decision') validateSchema(JSON.parse(result.text), schemas.decision);
      Object.assign(record, { status: 'passed', latency_ms: Date.now() - started, usage: result.usage, resolved_model: result.resolved_model, text: result.text });
    } catch (e) { Object.assign(record, { status: 'failed', latency_ms: Date.now() - started, error: e.message, usage: e.result?.usage ?? null }); }
    results.push(record); console.log(JSON.stringify(record));
    if (record.status === 'failed') break;
  }
}));
await mkdir(path.join(root, 'data/checks'), { recursive: true });
const filename = `models-${Date.now()}.json`;
await writeFile(path.join(root, 'data/checks', filename), JSON.stringify(results, null, 2));
console.log(`检查记录：data/checks/${filename}`);
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
