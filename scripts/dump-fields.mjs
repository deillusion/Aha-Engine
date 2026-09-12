// Throwaway inspection helper: print top-level keys and sizes of one archived run.
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const run = JSON.parse(await readFile(file, 'utf8'));
console.log('file:', file);
for (const [k, v] of Object.entries(run)) {
  const kind = Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v;
  const size = JSON.stringify(v ?? null).length;
  console.log(`${k}: ${kind} ${size}B`);
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
    console.log('   item keys:', Object.keys(v[0]).join(','));
  }
}
