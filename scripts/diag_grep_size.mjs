// 诊断：量一次 Grep 结果在 agent 消息里会有多大（字节 / 估算 token）
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFsHost } from '../src/host/node_fs_host.mjs';

const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queries = process.argv.slice(3);
const useQueries = queries.length ? queries : ['text', '机制', 'operator', 'point'];

const host = await new NodeFsHost(root).init();

// 先看 runs 下超大单行文件的行结构（已归入 .varina/data/runs）
const files = (await host.listFiles('**/*', { maxResults: 5000 })).filter(f => f.includes('/runs/'));
const lineShapes = [];
for (const file of files) {
  const text = (await readFile(new URL(`file:///${root.replace(/\\/g, '/')}/${file}`), 'utf8'));
  const lines = text.split('\n');
  lineShapes.push({ file, bytes: Buffer.byteLength(text), lines: lines.length, maxLine: Math.max(...lines.map(l => l.length)) });
}
lineShapes.sort((a, b) => b.bytes - a.bytes);
console.log('=== data/runs 文件形状（前 8）===');
for (const shape of lineShapes.slice(0, 8)) {
  console.log(`${String(shape.bytes).padStart(9)} bytes  ${String(shape.lines).padStart(6)} 行  最长行 ${shape.maxLine}  ${shape.file}`);
}
console.log(`\ndata/runs 文件总数 ${lineShapes.length}，合计 ${lineShapes.reduce((s, x) => s + x.bytes, 0)} bytes`);

console.log('\n=== 各检索词命中体积（maxResults 默认 100 / 上限 2000）===');
for (const query of useQueries) {
  for (const maxResults of [100, 2000]) {
    let matches;
    try { matches = await host.grep(query, { maxResults }); }
    catch (error) { console.log(`query=${query} max=${maxResults} 失败：${error.message}`); continue; }
    const payload = JSON.stringify(matches.map(m => ({ id: 'x', name: 'Grep', ok: true, result: m })));
    const bytes = Buffer.byteLength(payload);
    const fromRuns = matches.filter(m => m.file.includes('/runs/')).length;
    console.log(`query="${query}" max=${String(maxResults).padStart(4)}  命中 ${String(matches.length).padStart(4)} 条（其中 data/runs ${fromRuns} 条）  JSON ${(bytes / 1048576).toFixed(2)} MB  ≈ ${Math.round(bytes / 3.4).toLocaleString()} tokens(粗估)`);
  }
}
