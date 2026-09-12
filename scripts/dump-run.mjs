// Throwaway inspection helper: dump the original problem, config and all 42 proposals of one archived run.
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
const out = process.argv[3] ?? 'proposal_dump.md';
const run = JSON.parse(await readFile(file, 'utf8'));
const L = [];
L.push(`# ${run.id}`);
L.push(`mode=${run.mode} experiment=${run.experiment} use_operators=${run.use_operators} seed=${run.seed}`);
L.push(`prompt_version=${run.prompt_version} operator_version=${run.operator_version}`);
L.push(`\n## problem\n${run.problem}`);
L.push(`\n## constraints\n${JSON.stringify(run.constraints, null, 2)}`);
L.push(`\n## config\n\`\`\`json\n${JSON.stringify(run.config, null, 2)}\n\`\`\``);
L.push(`\n## dealer_decision\n\`\`\`json\n${JSON.stringify(run.dealer_decision, null, 2)}\n\`\`\``);
L.push(`\n## metrics\n\`\`\`json\n${JSON.stringify(run.metrics, null, 2)}\n\`\`\``);
L.push(`\n## proposals (${run.proposals.length})`);
for (const p of run.proposals) {
  L.push(`\n### ${p.proposal_id} · ${p.title}`);
  L.push(`round=${p.round} seat=${p.seat_id} phase=${p.phase} parents=${JSON.stringify(p.parent_proposal_ids)}`);
  L.push(`change_summary: ${p.change_summary}`);
  L.push(`refs: ${JSON.stringify(p.point_refs)}`);
  L.push(`\n${p.text}`);
}
await writeFile(out, L.join('\n'), 'utf8');
console.log(`wrote ${out} (${L.length} lines, ${run.proposals.length} proposals)`);
