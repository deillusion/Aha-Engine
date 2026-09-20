// Replays the responses a saved run rejected, against the current validators and salvage rules.
// This is the regression check for the live failure that ended run-1789079578302-da7edfdd at round 4:
// an echoed "type" key reached a missing schema node and crashed the validator instead of being reported.
// Usage: node scripts/replay-run-failures.mjs [.varina/data/runs/<run-id>.json]
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { validatePlan, salvagePlan } from '../src/board.mjs';
import { validateCreative, canonicalContributionType } from '../src/schema.mjs';

let file = process.argv[2];
if (!file) {
  const defaults = [
    '.varina/data/runs/live/run-1789079578302-da7edfdd.json',
    '.varina/data/runs/mock/run-1789079578302-da7edfdd.json',
    '.varina/data/runs/run-1789079578302-da7edfdd.json',
    'data/runs/live/run-1789079578302-da7edfdd.json',
    'data/runs/mock/run-1789079578302-da7edfdd.json',
    'data/runs/run-1789079578302-da7edfdd.json'
  ];
  file = defaults.find(existsSync) || defaults[0];
} else if (!existsSync(file)) {
  const id = path.basename(file, '.json');
  const candidates = [
    path.join('.varina/data/runs/live', `${id}.json`),
    path.join('.varina/data/runs/mock', `${id}.json`),
    path.join('.varina/data/runs', `${id}.json`),
    path.join('data/runs/live', `${id}.json`),
    path.join('data/runs/mock', `${id}.json`),
    path.join('data/runs', `${id}.json`)
  ];
  file = candidates.find(existsSync) || file;
}
const run = JSON.parse(await readFile(file, 'utf8'));
const snapshots = new Map(run.snapshots.map(s => [s.version, s]));
const failed = run.calls.filter(c => c.status === 'failed');

const counts = { accepted_as_is: 0, accepted_after_repair: 0, accepted_with_dropped_refs: 0, still_rejected: 0, crashed: 0, unparseable: 0 };
const rows = [];
for (const call of failed) {
  let value;
  try { value = JSON.parse(call.response); } catch { counts.unparseable++; rows.push([call.id, 'UNPARSEABLE', 'raw response is not JSON; retried with the error appended']); continue; }
  try {
    if (call.phase === 'dedup') {
      const candidates = run.candidates.filter(c => c.round === call.round);
      const board = snapshots.get(call.board_version_read ?? call.round - 1);
      try { validatePlan(value, candidates, board); counts.accepted_as_is++; rows.push([call.id, 'ACCEPTED', '']); }
      catch {
        const { plan, repairs } = salvagePlan(value);
        try { validatePlan(plan, candidates, board); counts.accepted_after_repair++; rows.push([call.id, 'REPAIRED', repairs.join(' | ')]); }
        catch (error) { counts.still_rejected++; rows.push([call.id, 'REJECTED', error.message]); }
      }
    } else {
      for (const item of value?.contributions ?? []) if (item && typeof item === 'object') item.type = canonicalContributionType(item.type);
      try {
        validateCreative(value, snapshots.get(call.board_version_read), run.proposals.filter(p => p.round < call.round));
        const dropped = (value?.proposals ?? []).flatMap(p => p.dropped_parent_proposal_ids ?? []);
        const aligned = (value?.proposals ?? []).flatMap(p => (p.point_refs ?? []).filter(r => r.__alignedFrom !== undefined).map(r => `${r.point_id}:${r.__alignedFrom}->${r.revision}`));
        if (dropped.length) { counts.accepted_with_dropped_refs++; rows.push([call.id, 'DROPPED-REFS', `悬空父方案引用已丢弃：${dropped.join('、')}`]); }
        else if (aligned.length) { counts.accepted_after_repair++; rows.push([call.id, 'REALIGNED', `revision 对齐：${aligned.join('、')}`]); }
        else { counts.accepted_as_is++; rows.push([call.id, 'ACCEPTED', '']); }
      } catch (error) { counts.still_rejected++; rows.push([call.id, 'REJECTED', error.message]); }
    }
  } catch (error) { counts.crashed++; rows.push([call.id, 'CRASHED', `${error.constructor.name}: ${error.message}`]); }
}

for (const [id, verdict, detail] of rows) console.log(id.padEnd(24), verdict.padEnd(12), detail);
console.log(`\n${file}: ${failed.length} rejected calls replayed`);
console.log(JSON.stringify(counts, null, 1));
console.log('\ncrashed must be 0: a validation failure is a report, never an exception.');
if (counts.crashed) process.exitCode = 1;
