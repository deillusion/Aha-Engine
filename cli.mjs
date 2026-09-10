import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './src/config.mjs';
import { Store } from './src/store.mjs';
import { createRun, executeRun } from './src/engine.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const demo = process.argv.includes('--demo'), inputPath = process.argv.slice(2).find(a => !a.startsWith('--'));
try {
  if (!demo && !inputPath) throw new Error('用法：npm run demo；或 npm run run -- problem.json [--demo]');
  const input = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : { problem: '设计一个让玩家持续做有意义选择的轻量合作玩法。', constraints: ['单局10分钟', '两周内可以验证原型'] };
  const config = await loadConfig(root, demo ? 'mock' : 'live');
  const run = createRun({ seed: 20260909, experiment: 'treatment', use_operators: true, ...input, mode: demo ? 'mock' : 'live' }, config);
  const store = new Store(path.join(root, 'data/runs')); await store.init();
  console.log(`开始运行：${run.id} (${run.mode}, ${run.experiment})`);
  const controller = new AbortController(); process.on('SIGINT', () => controller.abort());
  await executeRun(run, { store, signal: controller.signal });
  console.log(`${run.status}: ${run.id}\n${run.final?.text ?? run.error}\n\n记录：${store.file(run.id)}`);
  if (run.status !== 'completed') process.exitCode = 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
