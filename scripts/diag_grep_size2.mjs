// 诊断 2：按 agent_session.mjs 的真实拼装方式，量出一次 Grep 会往 messages 里塞多少字节
import { readFile } from 'node:fs/promises';
import { NodeFsHost } from '../src/host/node_fs_host.mjs';

const root = process.argv[2] ?? 'C:\\Users\\15611\\Desktop\\Aha\\prototype';
const host = await new NodeFsHost(root).init();

// grep 的单文件上限
const CAP = 2 * 1024 * 1024;
const all = await host.listFiles('**/*', { maxResults: 5000 });
const eligible = [];
for (const file of all) {
  try {
    const text = await readFile(new URL(`file:///${root.replace(/\\/g, '/')}/${file}`), 'utf8');
    const bytes = Buffer.byteLength(text);
    if (bytes > CAP) continue;
    const maxLine = Math.max(...text.split('\n').map(l => l.length));
    eligible.push({ file, bytes, maxLine });
  } catch { /* 非 UTF-8 等 */ }
}
eligible.sort((a, b) => b.maxLine - a.maxLine);
console.log('=== 可被 Grep 读取（≤2MB）的文件中，最长行 Top 6 ===');
for (const item of eligible.slice(0, 6)) console.log(`最长行 ${String(item.maxLine).padStart(8)}  文件 ${String(item.bytes).padStart(8)}  ${item.file}`);

console.log('\n=== 按 agent_session 真实拼装：Tool results 消息字节数 ===');
for (const query of ['text', 'operator', 'point', '机制', 'operator_id']) {
  for (const maxResults of [100, 2000]) {
    let matches;
    try { matches = await host.grep(query, { maxResults }); } catch { continue; }
    const results = [{ id: 'call_1', name: 'Grep', ok: true, result: matches }];
    const content = `Tool results (trusted execution data; matched 1:1 by id):\n${JSON.stringify(results)}`;
    const bytes = Buffer.byteLength(content);
    const bidx = matches.map(m => Buffer.byteLength(m.content)).sort((a, b) => b - a);
    console.log(`query="${query}" max=${maxResults}: 命中 ${matches.length}，单条最大 ${(bidx[0] / 1048576).toFixed(2)}MB，Tool results 消息 ${(bytes / 1048576).toFixed(2)} MB（≈${(bytes / 3.93e6).toFixed(2)}M tokens @3.93B/token）`);
  }
}

const runFiles = eligible.filter(f => f.file.startsWith('data/runs/'));
console.log(`\n可被 Grep 命中的 data/runs 文件 ${runFiles.length} 个，合计 ${(runFiles.reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(1)} MB`);
console.log(`其中「整文件就是一行」的文件数：${runFiles.filter(f => f.maxLine >= f.bytes - 2).length}`);
