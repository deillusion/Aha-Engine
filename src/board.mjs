import { assert, schemas, validateSchema, normalizePointId } from './schema.mjs';
export const emptyBoard = () => ({ version: 0, points: [], rendered_text: '' });
export function renderBoard(points) { return points.map(p => `#${p.point_id} (rev ${p.current_revision})\n${p.text}`).join('\n\n'); }
// Salvage a dedup plan before judging it. Only formatting mistakes are repaired: a rendered
// "#P001" reference becomes "P001", and keys the schema does not allow are dropped. Nothing
// semantic is invented — an ADD group with no result_text is still rejected.
export function salvagePlan(plan) {
  const repairs = [];
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return { plan, repairs };
  const clean = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'groups') clean.groups = value;
    else repairs.push(`删除未定义字段 ${key}`);
  }
  if (Array.isArray(clean.groups)) {
    for (const group of clean.groups) {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) continue;
      if (typeof group.target_point_id === 'string' && group.target_point_id.startsWith('#')) {
        repairs.push(`目标引用 ${group.target_point_id} 归一化为 ${normalizePointId(group.target_point_id)}`);
        group.target_point_id = normalizePointId(group.target_point_id);
      }
    }
  }
  return { plan: Object.hasOwn(clean, 'groups') ? clean : plan, repairs };
}
// Last-resort plan used when the dedup call cannot be salvaged. Candidates become new points
// instead of being dropped: the round's observations survive and later rounds can still read them.
export function fallbackAddAllPlan(candidates) {
  return { groups: candidates.filter(c => typeof c?.text === 'string' && c.text.trim()).map(c => ({ target_point_id: null, result_text: c.text, decisions: [{ candidate_id: c.candidate_id, action: 'ADD', reason_code: 'novel' }] })) };
}
export function validatePlan(plan, candidates, board) {
  validateSchema(plan, schemas.dedup);
  const seen = new Set(), targets = new Set();
  for (const group of plan.groups) {
    assert(group.decisions.length > 0, '空合并分组');
    const added = group.decisions.filter(d => d.action === 'ADD');
    const modified = group.decisions.some(d => d.action !== 'DROP');
    if (group.target_point_id !== null) {
      assert(board.points.some(p => p.point_id === group.target_point_id), '目标 point 不存在');
      assert(!targets.has(group.target_point_id), '同一目标必须聚合为一个分组'); targets.add(group.target_point_id);
      assert(added.length === 0, '旧观点不能 ADD');
    } else if (modified) {
      assert(added.length === 1 && group.decisions[0].action === 'ADD', '新分组必须以唯一 ADD 开始');
    } else {
      assert(group.decisions.every(d => d.reason_code === 'low_information'), '无目标 DROP 仅适用于低信息内容');
    }
    assert(modified ? typeof group.result_text === 'string' && group.result_text.trim().length > 0 : group.result_text === null, 'result_text 与操作不一致');
    if (modified && group.target_point_id) assert(group.result_text !== board.points.find(p => p.point_id === group.target_point_id).text, 'MERGE 必须产生实质文本修改');
    for (const d of group.decisions) {
      assert(candidates.some(c => c.candidate_id === d.candidate_id), '候选 ID 不存在');
      assert(!seen.has(d.candidate_id), '每个候选只能执行一次操作'); seen.add(d.candidate_id);
    }
  }
  assert(seen.size === candidates.length, '有候选未处理');
}
export function applyPlan(previous, plan, candidates, round) {
  validatePlan(plan, candidates, previous);
  const points = structuredClone(previous.points), operations = [];
  let nextId = Math.max(0, ...points.map(p => Number(p.point_id.slice(1)))) + 1;
  // Stable candidate order, independent of model output group order and request completion order.
  const rank = id => candidates.findIndex(c => c.candidate_id === id);
  const groups = [...plan.groups].sort((a, b) => Math.min(...a.decisions.map(d => rank(d.candidate_id))) - Math.min(...b.decisions.map(d => rank(d.candidate_id))));
  for (const [index, group] of groups.entries()) {
    const modifies = group.decisions.some(d => d.action !== 'DROP');
    let point = points.find(p => p.point_id === group.target_point_id);
    const before = point?.text ?? null;
    if (!point && modifies) {
      const first = candidates.find(c => c.candidate_id === group.decisions[0].candidate_id);
      point = { point_id: `P${String(nextId++).padStart(3, '0')}`, first_seen_round: round, first_seen_seat: first.source_seat_id, current_revision: 1, text: group.result_text, source_candidate_ids: [], source_seat_ids: [], revisions: [], status: 'active' };
      points.push(point);
    } else if (point && modifies) { point.current_revision++; point.text = group.result_text; }
    if (point && modifies) point.revisions.push({ revision: point.current_revision, round, text: point.text, contributing_candidate_ids: group.decisions.filter(d => d.action !== 'DROP').map(d => d.candidate_id) });
    for (const d of group.decisions) {
      const candidate = candidates.find(c => c.candidate_id === d.candidate_id);
      if (point) {
        point.source_candidate_ids.push(d.candidate_id);
        point.source_seat_ids = [...new Set([...point.source_seat_ids, candidate.source_seat_id])];
      }
      operations.push({ ...d, operation_id: `OP-${round}-${operations.length + 1}`, group_id: `G-${round}-${index + 1}`, round, target_point_id: point?.point_id ?? null, before_text: before, after_text: modifies ? point.text : before, revision: point?.current_revision ?? null });
    }
  }
  return { board: { version: round, points, rendered_text: renderBoard(points) }, operations };
}
