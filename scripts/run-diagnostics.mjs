// 运行诊断：把一次 run 的调用耗时、思考 token、重试与失败原因摊开，并给出瓶颈判断。
//
//   node scripts/run-diagnostics.mjs                      # 诊断 data/runs 里最近一次运行
//   node scripts/run-diagnostics.mjs --last 3             # 最近三次，逐个列出
//   node scripts/run-diagnostics.mjs --all                # 全部运行，只输出汇总表
//   node scripts/run-diagnostics.mjs run-1789063068165-1a072a6c
//   node scripts/run-diagnostics.mjs --live               # 只看真实模式运行
//   node scripts/run-diagnostics.mjs --out data/diagnostics/xxx.md   # 同时把 Markdown 报告写到文件
//
// 只读 data/runs，不发起模型请求，不修改任何运行记录。
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runsDir = path.join(root, 'data', 'runs');

const formatMs = ms => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const formatTokens = n => (n == null ? '—' : n.toLocaleString('en-US'));
const average = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const reasoningTokens = usage => usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? null;

function parseArgs(argv) {
  const options = { ids: [], last: 0, all: false, live: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--last') options.last = Number(argv[++i] ?? 0) || 0;
    else if (arg === '--all') options.all = true;
    else if (arg === '--live') options.live = true;
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`);
    else options.ids.push(arg);
  }
  return options;
}

function loadRuns(options) {
  const files = readdirSync(runsDir)
    .filter(name => /^run-.+\.json$/.test(name))
    .map(name => ({ name, full: path.join(runsDir, name) }))
    .map(file => {
      let run = null;
      try { run = JSON.parse(readFileSync(file.full, 'utf8')); } catch { /* 半截写入或非运行记录 */ }
      return { ...file, run, order: run?.started_at ? Date.parse(run.started_at) : 0 };
    })
    .filter(file => file.run && Array.isArray(file.run.calls))
    .sort((a, b) => b.order - a.order);
  const wanted = options.ids.length
    ? files.filter(f => options.ids.some(id => f.name === `${id}.json` || f.name.startsWith(id)))
    : options.all
      ? files
      : files.slice(0, options.last > 1 ? options.last : 1);
  if (!wanted.length) throw new Error(`data/runs 里没有匹配的运行记录：${options.ids.join(', ') || '(空)'}`);
  const missing = options.ids.filter(id => !wanted.some(f => f.name === `${id}.json` || f.name.startsWith(id)));
  if (missing.length) throw new Error(`找不到运行记录：${missing.join(', ')}`);
  return wanted;
}

function callRow(call) {
  const usage = call.usage ?? {};
  const reasoning = reasoningTokens(usage);
  return {
    call,
    reasoning,
    promptTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    reasoningShare: reasoning != null && usage.completion_tokens ? reasoning / usage.completion_tokens : null,
  };
}

function groupRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function summarizeGroup(rows) {
  const latencies = rows.map(r => r.call.latency_ms).filter(v => Number.isFinite(v));
  const reasoning = rows.map(r => r.reasoning).filter(v => Number.isFinite(v));
  const outputs = rows.map(r => r.outputTokens).filter(v => Number.isFinite(v));
  const queue = rows.map(r => r.call.queue_wait_ms).filter(v => Number.isFinite(v) && v > 0);
  return {
    attempts: rows.length,
    logical: new Set(rows.map(r => r.call.logical_id)).size,
    completed: rows.filter(r => r.call.status === 'completed').length,
    failed: rows.filter(r => r.call.status === 'failed' || r.call.status === 'cancelled').length,
    latencySum: latencies.reduce((a, b) => a + b, 0),
    latencyAvg: average(latencies),
    latencyMedian: median(latencies),
    latencyMax: latencies.length ? Math.max(...latencies) : null,
    reasoningAvg: average(reasoning),
    reasoningMedian: median(reasoning),
    reasoningMax: reasoning.length ? Math.max(...reasoning) : null,
    reasoningCoverage: `${reasoning.length}/${rows.length}`,
    outputAvg: average(outputs),
    queueSum: queue.reduce((a, b) => a + b, 0),
  };
}

function groupTable(title, groups, labelOf) {
  const lines = [`| ${title} | 尝试 | 逻辑调用 | 完成/失败 | 平均耗时 | 中位耗时 | 最长 | 平均思考 tok | 思考 tok 样本 | 平均输出 tok | 排队合计 |`, '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const entries = [...groups.entries()].sort((a, b) => summarizeGroup(b[1]).latencySum - summarizeGroup(a[1]).latencySum);
  for (const [key, rows] of entries) {
    const s = summarizeGroup(rows);
    lines.push(`| ${labelOf(key)} | ${s.attempts} | ${s.logical} | ${s.completed}/${s.failed} | ${formatMs(s.latencyAvg)} | ${formatMs(s.latencyMedian)} | ${formatMs(s.latencyMax)} | ${formatTokens(s.reasoningAvg == null ? null : Math.round(s.reasoningAvg))} | ${s.reasoningCoverage} | ${formatTokens(s.outputAvg == null ? null : Math.round(s.outputAvg))} | ${formatMs(s.queueSum)} |`);
  }
  return lines.join('\n');
}

function reportOne({ name, run }) {
  const rows = (run.calls ?? []).map(callRow);
  const out = [];
  const wall = run.started_at && run.completed_at ? Date.parse(run.completed_at) - Date.parse(run.started_at) : null;
  const dangling = (run.calls ?? []).filter(c => c.status === 'running').length;
  const status = dangling ? `${run.status}（有 ${dangling} 次调用未收尾）` : run.status;
  out.push(`## ${run.id}`);
  out.push('');
  out.push(`- 文件：\`data/runs/${name}\`（${(statSync(path.join(runsDir, name)).size / 1048576).toFixed(2)} MB）`);
  out.push(`- 模式：${run.mode === 'mock' ? '模拟' : '真实'} · 实验：${run.experiment} · 思维刺激：${run.use_operators ? '开' : '关'} · 种子：${run.seed}`);
  out.push(`- 状态：${status} · 开始：${run.started_at ?? '—'} · 结束：${run.completed_at ?? '—'}`);
  out.push(`- 墙钟耗时：${formatMs(wall)} · 调用尝试：${rows.length}（预期 ${run.metrics?.expected_calls ?? '—'}）`);
  if (run.error) out.push(`- 中止原因：${run.error}`);

  if (!rows.length) {
    out.push('');
    out.push('没有调用记录。');
    return out.join('\n');
  }

  const latencies = rows.map(r => r.call.latency_ms).filter(Number.isFinite);
  const reasoning = rows.map(r => r.reasoning).filter(Number.isFinite);
  const outputs = rows.map(r => r.outputTokens).filter(Number.isFinite);
  const busy = rows.reduce((a, r) => a + (r.call.latency_ms || 0), 0);
  const biggest = [...rows].sort((a, b) => (b.call.latency_ms || 0) - (a.call.latency_ms || 0))[0];
  const reasoningShare = reasoning.length
    ? average(rows.filter(r => Number.isFinite(r.reasoning) && r.outputTokens).map(r => r.reasoning / r.outputTokens))
    : null;

  out.push('');
  out.push('**关键数字**');
  out.push('');
  out.push(`- 单次调用耗时：中位 ${formatMs(median(latencies))} · 平均 ${formatMs(average(latencies))} · 最长 ${formatMs(latencies.length ? Math.max(...latencies) : null)}`);
  out.push(`- 思考 token（服务端上报的 reasoning_tokens）：平均 ${formatTokens(reasoning.length ? Math.round(average(reasoning)) : null)} · 最长 ${formatTokens(reasoning.length ? Math.max(...reasoning) : null)} · 覆盖 ${reasoning.length}/${rows.length} 次调用`);
  if (reasoningShare != null) out.push(`- 思考占输出比例：约 ${(reasoningShare * 100).toFixed(0)}%（这些 token 也要逐字生成，直接决定耗时）`);
  out.push(`- 输出 token：平均 ${formatTokens(outputs.length ? Math.round(average(outputs)) : null)}`);
  out.push(`- 各调用耗时累加 ${formatMs(busy)}${wall ? `；墙钟 ${formatMs(wall)}（累加/墙钟 ≈ ${(busy / wall).toFixed(1)}×，说明席位并行程度）` : ''}`);
  if (biggest) out.push(`- 最慢一次：${biggest.call.phase} R${biggest.call.round} ${biggest.call.seat_id ?? '(无席位)'} ${biggest.call.model} ${formatMs(biggest.call.latency_ms)}（思考 ${formatTokens(biggest.reasoning)} / 输出 ${formatTokens(biggest.outputTokens)}）`);

  const requests = rows.map(r => r.call.request ?? {});
  const efforts = [...new Set(requests.map(r => (r.reasoning_effort == null ? '(未发送)' : r.reasoning_effort)))];
  const limits = [...new Set(rows.map(r => `${r.call.requested_output_limit ?? '—'}/${r.call.effective_output_limit ?? '—'}`))];
  out.push(`- 请求里的思考档位：${efforts.join('、')}`);
  out.push(`- 输出上限（请求/实际生效）：${limits.join('、')}`);
  const truncated = rows.filter(r => r.call.finish_reason === 'length');
  if (truncated.length) out.push(`- ⚠ 被输出上限截断的调用：${truncated.length} 次（finish_reason=length）`);

  const retries = rows.filter(r => r.call.attempt > 0);
  out.push('');
  out.push(`**重试：${retries.length} 次额外尝试**（逻辑调用 ${new Set(rows.map(r => r.call.logical_id)).size} 个）`);
  out.push('');
  if (retries.length) {
    out.push('| 调用 | 模型 | 尝试 | 耗时 | 结束原因 | 错误 |');
    out.push('|---|---|---:|---:|---|---|');
    for (const r of retries.sort((a, b) => a.call.logical_id.localeCompare(b.call.logical_id) || a.call.attempt - b.call.attempt)) {
      out.push(`| ${r.call.logical_id} | ${r.call.model} | #${r.call.attempt} | ${formatMs(r.call.latency_ms)} | ${r.call.finish_reason ?? '—'} | ${(r.call.error ?? '—').replace(/\|/g, '/')} |`);
    }
  } else out.push('没有重试。');

  out.push('');
  out.push(groupTable('阶段+模型', groupRows(rows, r => `${r.call.phase}|${r.call.model}`), key => key.replace('|', ' · ')));
  out.push('');
  out.push(groupTable('席位', groupRows(rows, r => `${r.call.seat_id ?? '(无席位)'}|${r.call.model}`), key => key.replace('|', ' · ')));
  out.push('');
  out.push(groupTable('轮次', groupRows(rows, r => `R${r.call.round}`), key => key));

  const slowest = [...rows].sort((a, b) => (b.call.latency_ms || 0) - (a.call.latency_ms || 0)).slice(0, 10);
  out.push('');
  out.push('**最慢 10 次调用**');
  out.push('');
  out.push('| 阶段 | 轮 | 席位 | 模型 | 耗时 | 思考 tok | 输出 tok | 结束 | 状态 |');
  out.push('|---|---:|---|---|---:|---:|---:|---|---|');
  for (const r of slowest) {
    out.push(`| ${r.call.phase} | ${r.call.round} | ${r.call.seat_id ?? '—'} | ${r.call.model} | ${formatMs(r.call.latency_ms)} | ${formatTokens(r.reasoning)} | ${formatTokens(r.outputTokens)} | ${r.call.finish_reason ?? '—'} | ${r.call.status} |`);
  }

  const byModel = groupRows(rows, r => r.call.model);
  const notes = [];
  const heavy = [...byModel.entries()]
    .map(([model, group]) => ({ model, s: summarizeGroup(group) }))
    .sort((a, b) => b.s.latencySum - a.s.latencySum);
  if (heavy.length) {
    const top = heavy[0];
    notes.push(`最慢的模型是 ${top.model}：${top.s.attempts} 次尝试累计 ${formatMs(top.s.latencySum)}，平均思考 ${formatTokens(top.s.reasoningAvg == null ? null : Math.round(top.s.reasoningAvg))} tok。`);
  }
  const unfinished = rows.filter(r => r.call.status === 'running');
  if (unfinished.length) notes.push(`有 ${unfinished.length} 次调用没有收尾（进程被强杀或重启），这些记录的耗时与用量为空，统计时已排除。`);
  if (run.status === 'interrupted') notes.push('本次运行被中断，后面的阶段没有执行，所以累计耗时低于完整流程。');
  if (notes.length) {
    out.push('');
    out.push('**判断**');
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
  }
  return out.join('\n');
}

function overviewTable(loaded) {
  const lines = ['| 运行 | 时间 | 模式 | 状态 | 尝试 | 完成/失败 | 墙钟 | 调用耗时累加 | 平均思考 tok | 平均输出 tok | 重试 |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const { run } of loaded) {
    const rows = (run.calls ?? []).map(callRow);
    const latencies = rows.map(r => r.call.latency_ms).filter(Number.isFinite);
    const reasoning = rows.map(r => r.reasoning).filter(Number.isFinite);
    const outputs = rows.map(r => r.outputTokens).filter(Number.isFinite);
    const wall = run.started_at && run.completed_at ? Date.parse(run.completed_at) - Date.parse(run.started_at) : null;
    lines.push(`| ${run.id} | ${run.started_at ?? '—'} | ${run.mode === 'mock' ? '模拟' : '真实'} | ${run.status} | ${rows.length} | ${rows.filter(r => r.call.status === 'completed').length}/${rows.filter(r => r.call.status !== 'completed').length} | ${formatMs(wall)} | ${formatMs(latencies.reduce((a, b) => a + b, 0))} | ${formatTokens(reasoning.length ? Math.round(average(reasoning)) : null)} | ${formatTokens(outputs.length ? Math.round(average(outputs)) : null)} | ${rows.filter(r => r.call.attempt > 0).length} |`);
  }
  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const loaded = loadRuns(options).filter(({ run }) => !options.live || run.mode === 'live');
if (!loaded.length) throw new Error('没有符合条件的运行记录（--live 只保留真实模式）');

const sections = ['# 运行诊断报告', '', `生成时间：${new Date().toISOString()} · 数据目录：\`data/runs\` · 本次纳入 ${loaded.length} 次运行`, ''];
if (loaded.length > 1) {
  sections.push('## 总览', '', overviewTable(loaded), '');
}
for (const item of loaded) {
  sections.push(reportOne(item), '');
}

const text = sections.join('\n');
if (options.out) {
  const target = path.isAbsolute(options.out) ? options.out : path.join(root, options.out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${text}\n`, 'utf8');
  console.log(`报告已写入 ${path.relative(root, target)}`);
}
console.log(text);
