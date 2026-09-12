// Throwaway measurement: how much of one archived run's proposal corpus is genuinely distinct?
// Reports (a) how often each coined term appears, (b) pairwise character-bigram overlap between
// proposal bodies, and (c) chain depth for derived proposals.
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const run = JSON.parse(await readFile(file, 'utf8'));
const proposals = run.proposals;

function bigrams(text) {
  const clean = text.replace(/[\s，。、：；（）()【】《》“”"'·—\-+0-9A-Za-z]/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < clean.length; i++) set.add(clean.slice(i, i + 2));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const grams = proposals.map(p => bigrams(`${p.title}${p.text}`));

// Coined compound terms: 2-6 char CJK fragments that are rare in ordinary Chinese prose but recur here.
const candidates = new Map();
for (const p of proposals) {
  const clean = `${p.title}${p.text}`.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const chunk of clean.split(/\s+/)) {
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i + n <= chunk.length; i++) {
        const term = chunk.slice(i, i + n);
        if (!candidates.has(term)) candidates.set(term, new Set());
        candidates.get(term).add(p.proposal_id);
      }
    }
  }
}
const coined = [...candidates.entries()]
  .filter(([term, ids]) => ids.size >= 6 && ids.size <= proposals.length * 0.9)
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 40);

console.log(`proposals: ${proposals.length}`);
console.log(`\n## recurring terms (appear in >=6 proposals, <=90% of them)`);
for (const [term, ids] of coined) console.log(`  ${term.padEnd(6)} ${String(ids.size).padStart(3)}  ${[...ids].slice(0, 6).join(',')}${ids.size > 6 ? ' …' : ''}`);

console.log(`\n## pairwise bigram overlap`);
const pairs = [];
for (let i = 0; i < proposals.length; i++) {
  for (let j = i + 1; j < proposals.length; j++) {
    pairs.push({ a: proposals[i].proposal_id, b: proposals[j].proposal_id, s: jaccard(grams[i], grams[j]) });
  }
}
pairs.sort((x, y) => y.s - x.s);
const buckets = { '>=0.6': 0, '0.5-0.6': 0, '0.4-0.5': 0, '0.3-0.4': 0, '0.2-0.3': 0, '<0.2': 0 };
for (const p of pairs) {
  if (p.s >= 0.6) buckets['>=0.6']++;
  else if (p.s >= 0.5) buckets['0.5-0.6']++;
  else if (p.s >= 0.4) buckets['0.4-0.5']++;
  else if (p.s >= 0.3) buckets['0.3-0.4']++;
  else if (p.s >= 0.2) buckets['0.2-0.3']++;
  else buckets['<0.2']++;
}
console.log(`  total pairs: ${pairs.length}`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);
console.log(`\n  top 12 most redundant pairs:`);
for (const p of pairs.slice(0, 12)) console.log(`    ${p.s.toFixed(3)}  ${p.a} ~ ${p.b}`);

// Nearest-neighbour overlap: as redundancy rises, every proposal is a near-copy of something.
const nn = proposals.map((p, i) => {
  let best = 0, who = null;
  for (let j = 0; j < proposals.length; j++) {
    if (i === j) continue;
    const s = jaccard(grams[i], grams[j]);
    if (s > best) { best = s; who = proposals[j].proposal_id; }
  }
  return { id: p.proposal_id, best, who };
});
nn.sort((a, b) => b.best - a.best);
console.log(`\n## each proposal's nearest neighbour (how standalone is it?)`);
for (const r of nn) console.log(`  ${r.id}  ${r.best.toFixed(3)}  ->  ${r.who}`);

// Text length growth by round.
console.log(`\n## body length by round`);
for (const round of [...new Set(proposals.map(p => p.round))].sort((a, b) => a - b)) {
  const group = proposals.filter(p => p.round === round).map(p => [...p.text].length).sort((a, b) => a - b);
  const sum = group.reduce((n, x) => n + x, 0);
  console.log(`  R${round}: n=${group.length} min=${group[0]} median=${group[Math.floor(group.length / 2)]} max=${group.at(-1)} total=${sum}`);
}
