const str = { type: 'string' };
const nullable = { type: ['string', 'null'] };
const arr = items => ({ type: 'array', items });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const types = ['proposal', 'mechanism', 'argument', 'counterexample', 'modification', 'connection', 'assumption', 'reframing', 'other'];
export const typeLabels = {
  proposal: '方案',
  mechanism: '机制',
  argument: '论据',
  counterexample: '反例',
  modification: '改造',
  connection: '新联系',
  assumption: '隐藏假设',
  reframing: '问题重构',
  other: '其他'
};
export const reasons = ['novel', 'adds_condition', 'adds_mechanism', 'adds_consequence', 'adds_counterexample', 'semantic_duplicate', 'fully_covered', 'low_information', 'other'];
const proposal = obj({ title: str, text: str, parent_proposal_ids: arr(str), change_summary: str, point_refs: arr(obj({ point_id: str, revision: { type: 'integer' } })) });
const legacyFinal = obj({ text: str, adopted_points: arr(obj({ point_id: str, revision: { type: 'integer' }, usage: str })) });
export const schemas = {
  creative: obj({ reasoning: str, contributions: arr(obj({ text: str, type: { type: 'string', enum: types }, failure_condition: str })), proposals: arr(proposal) }),
  dedup: obj({ groups: arr(obj({ target_point_id: nullable, result_text: nullable, decisions: arr(obj({ candidate_id: str, action: { type: 'string', enum: ['ADD', 'MERGE', 'DROP'] }, reason_code: { type: 'string', enum: reasons } })) })) }),
  decision: obj({ proposals: arr(proposal) }),
  chair: obj({ rankings: arr(obj({ proposal_id: str, reason: str })) }),
  direct: obj({ text: str }),
  dealer: obj({ reasoning: str, selected_operator_ids: arr(str) })
};
export function assert(condition, message) { if (!condition) throw new Error(`校验失败：${message}`); }
export function validateSchema(value, schema, path = '$') {
  const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  assert(ts.includes(type) || (ts.includes('integer') && Number.isInteger(value)), `${path} 类型错误`);
  if (schema.enum) assert(schema.enum.includes(value), `${path} 枚举值错误`);
  if (type === 'object') {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${path}.${key} 缺失`);
    for (const [key, v] of Object.entries(value)) { assert(Object.hasOwn(schema.properties, key), `${path}.${key} 未定义`); validateSchema(v, schema.properties[key], `${path}.${key}`); }
  }
  if (type === 'array') value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`));
}
export function validateProposal(proposal, board, available) {
  assert(proposal.title.trim() && proposal.text.trim() && proposal.change_summary.trim(), '方案标题、完整正文及变更说明不能为空');
  assert(new Set(proposal.parent_proposal_ids).size === proposal.parent_proposal_ids.length, '父方案引用重复');
  for (const id of proposal.parent_proposal_ids) assert(available.some(p => p.proposal_id === id), '父方案不在本次可读快照中');
  assert(new Set(proposal.point_refs.map(p => p.point_id)).size === proposal.point_refs.length, '方案观点引用重复');
  for (const ref of proposal.point_refs) assert(board.points.some(p => p.point_id === ref.point_id && p.current_revision === ref.revision), '方案引用的观点或 revision 不在本次快照中');
}
export function validateCreative(data, board, available, requireProposal = false) {
  validateSchema(data, schemas.creative);
  assert(data.contributions.length > 0 || data.proposals.length > 0, '至少贡献观点或完整方案');
  assert(!requireProposal || data.proposals.length > 0, '单轮实验至少需要一个完整方案');
  for (const c of data.contributions) {
    assert(c.text.trim().length > 0, '观点文本不能为空');
  }
  for (const p of data.proposals) validateProposal(p, board, available);
}
export function validateMemo(data, board, available) {
  validateSchema(data, schemas.decision);
  assert(data.proposals.length > 0, '第六轮至少需要一个完整候选方案');
  for (const p of data.proposals) validateProposal(p, board, available);
}
export function validateRanking(data, proposals) {
  validateSchema(data, schemas.chair);
  assert(proposals.length > 0, '没有可排序的方案');
  const ids = new Set(proposals.map(p => p.proposal_id)), seen = new Set();
  for (const row of data.rankings) {
    assert(ids.has(row.proposal_id), '排序引用了不存在的方案');
    assert(!seen.has(row.proposal_id), '方案排序重复');
    assert(row.reason.trim(), '排序理由不能为空');
    seen.add(row.proposal_id);
  }
  assert(seen.size === ids.size, '排序必须覆盖全部候选方案');
}
export function validateDirect(data) {
  validateSchema(data, schemas.direct);
  assert(data.text.trim(), '直接回答不能为空');
}
export function validateDealer(data, availableOperatorIds = null) {
  validateSchema(data, schemas.dealer);
  assert(Array.isArray(data.selected_operator_ids), 'selected_operator_ids 必须为数组');
  assert(data.selected_operator_ids.length <= 8, '最多选择 8 个特化算子');
  const seen = new Set();
  for (const id of data.selected_operator_ids) {
    if (availableOperatorIds) assert(availableOperatorIds.has(id), `未知的特化算子 ID: ${id}`);
    assert(!seen.has(id), `特化算子 ID 重复: ${id}`);
    seen.add(id);
  }
}
// Read-only validation of archives written before ranking-only Chair.
export function validateFinal(data, board) {
  validateSchema(data, legacyFinal);
  assert(data.text.trim(), '最终答案为空');
  const seen = new Set();
  for (const ref of data.adopted_points) {
    assert(!seen.has(ref.point_id), '最终引用重复'); seen.add(ref.point_id);
    assert(board.points.some(p => p.point_id === ref.point_id && p.current_revision === ref.revision), '最终引用的观点或 revision 不存在');
    assert(ref.usage.trim(), '采用用途为空');
  }
}
