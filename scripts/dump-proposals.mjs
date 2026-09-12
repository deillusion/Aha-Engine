// Throwaway inspection helper: list every proposal stored in one archived run, in run order.
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
const out = process.argv[3] ?? null;
const run = JSON.parse(await readFile(file, 'utf8'));
const calls = run.calls ?? run.records ?? run.turns ?? [];
const lines = [];
lines.push(`# proposals in ${file}`);
lines.push(`mode: ${run.mode ?? run.config?.mode ?? '?'} · calls: ${calls.length}`);
for (const call of calls) {
  const body = call.response_parsed ?? call.parsed ?? null;
  const proposals = body?.proposals ?? call.proposals ?? [];
  if (!proposals.length) continue;
  lines.push(`\n## ${call.logical_id ?? call.id} (phase=${call.phase} round=${call.round} seat=${call.seat_id} model=${call.model})`);
  for (const p of proposals) {
    lines.push(`- [${p.proposal_id ?? '-'}] ${p.title}`);
  }
}
// Chair rankings and final answer, if present.
if (run.metrics) lines.push(`\nmetrics: ${JSON.stringify(run.metrics).slice(0, 600)}`);
lines.push(`\nkeys: ${Object.keys(run).join(', ')}`);
const text = lines.join('\n');
if (out) await writeFile(out, text, 'utf8');
console.log(text.slice(0, 20000));
