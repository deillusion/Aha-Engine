import fs from 'node:fs';
import path from 'node:path';

const v5Path = path.resolve('../aha_operator_cards_v5.md');
const content = fs.readFileSync(v5Path, 'utf8');
const lines = content.split('\n');

const families = {};
let currentFamily = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.startsWith('## ') && !line.includes('用法与设计规范')) {
    currentFamily = line.replace('## ', '').trim();
    families[currentFamily] = [];
  } else if (line.startsWith('### ') && currentFamily) {
    const parts = line.replace('### ', '').trim().split(/\s+/);
    const operator_id = parts[0];
    const name = parts.slice(1).join(' ');
    let pLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('### ') || lines[j].startsWith('## ') || lines[j].startsWith('---')) break;
      pLines.push(lines[j]);
    }
    const prompt = pLines.join('\n').trim();
    families[currentFamily].push([operator_id, name, prompt]);
  }
}

const fileHeader = "export const OPERATOR_VERSION = 'operators-v5';\nconst families = ";
const fileFooter = `;\nexport const operators = Object.entries(families).flatMap(([family, rows]) => rows.map(([operator_id, name, prompt]) => ({ operator_id, family, name, prompt, enabled: true })));
export function random(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function sampleOperators(rng, pool = operators) {
  const enabled = pool.filter(o => o.enabled);
  const available = [...new Set(enabled.map(o => o.family))].sort();
  if (available.length < 3) throw new Error('至少需要 3 个启用的 operator family');
  return Array.from({ length: 3 }, () => {
    const family = available.splice(Math.floor(rng() * available.length), 1)[0];
    const choices = enabled.filter(o => o.family === family);
    return choices[Math.floor(rng() * choices.length)];
  });
}
`;

const output = fileHeader + JSON.stringify(families, null, 2) + fileFooter;
fs.writeFileSync('src/operators.mjs', output, 'utf8');
console.log('OK! Families:', Object.keys(families).length, 'Operators:', Object.values(families).reduce((acc, r) => acc + r.length, 0));
