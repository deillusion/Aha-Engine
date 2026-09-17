// 用真实工作区复现事故形态，把三层闸门的效果分开量出来。
// 用法: node scripts/verify_tool_budget.mjs [workspace] [query...]
import { NodeFsHost } from '../src/host/node_fs_host.mjs';
import { applyToolResultBudget, renderToolResults } from '../src/agent/tool_result_budget.mjs';

const root = process.argv[2] ?? process.cwd();
const queries = process.argv.slice(3);
const useQueries = queries.length ? queries : ['text', 'operator', 'point', '机制'];

const host = await new NodeFsHost(root).init();
// 只量体积，不往真实工作区写文件：落盘出口换成内存计数。
const countingPersist = async label => ({ filePath: `memory://${label}`, bytes: 0 });

console.log(`workspace: ${root}\n`);
// 由本次事故标定：那条 400 报的是 messages 里 8,574,870 tokens，对应的命中集合约 1.5e7 字符。
// 中文密集 JSON 大致 1.8 字符/token，比 Claude Code 里硬编码的 4 bytes/token 保守得多。
const CHARS_PER_TOKEN = 1.78;
console.log('query        命中   ①未限宽原文(下界)          ②限宽后(闸门前)      ③进对话(闸门后)  落盘');
console.log('-'.repeat(100));
for (const query of useQueries) {
  const matches = await host.grep(query, { maxResults: 100 });
  // ① 下界：命中集合若按原文进对话的体积。grep 对裁剪过的行会回报 line_chars，
  //    所以这个和是「没有 500 字符限宽时会进对话的原文量」的保守下界。
  const rawChars = matches.reduce((sum, match) => sum + (match.line_chars ?? match.content.length) + 48, 2) + 16;
  const results = [{ id: 'call_1', name: 'Grep', ok: true, result: matches }];
  const clipped = renderToolResults(results).length;              // ② 已限宽，尚未过预算
  const budgeted = await applyToolResultBudget(results, { label: 'verify', persist: countingPersist });
  const inConversation = renderToolResults(budgeted.results).length; // ③ 真正进 messages 的体积
  console.log(
    `${query.padEnd(10)} ${String(matches.length).padStart(4)}  ` +
    `${(rawChars / 1e6).toFixed(2).padStart(7)} M字符 (≈${(rawChars / CHARS_PER_TOKEN / 1e6).toFixed(1)}M tok)  ` +
    `${(clipped / 1024).toFixed(1).padStart(8)} KB  ` +
    `${(inConversation / 1024).toFixed(1).padStart(10)} KB  ${String(budgeted.persisted.length).padStart(4)}`
  );
}
console.log('\n① → ② 单条命中行裁到 500 字符（对标 ripgrep --max-columns 500）');
console.log('② → ③ Grep 单条上限 20000 字符、单轮合计上限 200000 字符，超出部分落盘换预览');
