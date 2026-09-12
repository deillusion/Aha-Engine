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
// A closed enum cannot anticipate every word a model reaches for when the reasoning operators are
// named "简化" or "缺失环节". These are the observed off-vocabulary spellings of an existing type,
// mapped instead of rejected: the taxonomy stays fixed so metrics remain comparable across runs.
const typeSynonyms = {
  simplification: 'modification', simplify: 'modification', simplifying: 'modification', reduction: 'modification',
  'missing-link-argument': 'argument', missing_link: 'argument', missinglink: 'argument', gap: 'argument',
  guardrail: 'mechanism', requirement: 'assumption', constraint: 'assumption', risk: 'counterexample', caveat: 'counterexample'
};
export function canonicalContributionType(value) {
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (types.includes(key)) return key;
  return typeSynonyms[key] ?? typeSynonyms[key.replace(/-/g, '_')] ?? value;
}
const proposal = obj({ title: str, mechanisms: arr(str), text: str, parent_proposal_ids: arr(str), change_summary: str, point_refs: arr(obj({ point_id: str, revision: { type: 'integer' } })) });
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
// A single schema node may be missing when a caller walks a value whose keys are not declared.
// Reporting it as a validation failure keeps model output from crashing the validator itself.
function checkType(value, schema, path) {
  const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const matches = ts.includes(type) || (type === 'number' && ts.includes('integer') && Number.isInteger(value));
  assert(matches, `${path} 类型错误`);
  return type;
}
export function validateSchema(value, schema, path = '$') {
  assert(schema !== null && typeof schema === 'object', `${path} 缺少可校验的 schema 定义`);
  const type = checkType(value, schema, path);
  if (schema.enum) assert(schema.enum.includes(value), `${path} 枚举值错误`);
  if (type === 'object') {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${path}.${key} 缺失`);
    const properties = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      // Object.hasOwn, never a truthiness check: a key named like a prototype member must stay undeclared.
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`校验失败：${path}.${key} 未定义（该字段不在 schema 允许的属性中，请删除）`);
        continue;
      }
      if (properties[key] != null) validateSchema(v, properties[key], `${path}.${key}`);
    }
  }
  if (type === 'array') value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`));
}
// The board is rendered to models as "#P001 (rev 2)" while point_id is stored as "P001".
// A model that copies the rendered id is making a formatting mistake, not a semantic one,
// so references are normalized instead of rejected.
export function normalizePointId(value) { return typeof value === 'string' ? value.trim().replace(/^#/, '') : value; }
// A revision mismatch is not a wrong reference. Dedup bumps a point's revision every time it merges a
// candidate, so a model that read board v2 legitimately cites "P002@2" while the board is already at
// revision 3. The point it meant still exists and says what it read, so the revision is aligned to the
// current one instead of discarding the whole proposal. A point that is gone is still an error.
function alignPointRef(ref, board) {
  const point = board.points.find(p => p.point_id === normalizePointId(ref.point_id));
  if (!point) return { ok: false, aligned: false };
  const aligned = point.current_revision !== ref.revision;
  if (aligned) ref.revision = point.current_revision;
  return { ok: true, aligned };
}
// Collects the revisions realigned while validating one response. The board is the mutable working copy,
// so realignment never touches the previous round's frozen snapshot.
export function alignedPointRefs(proposals) {
  const aligned = [];
  for (const proposal of proposals ?? []) {
    for (const ref of proposal?.point_refs ?? []) {
      if (ref?.__alignedFrom !== undefined) aligned.push({ point_id: normalizePointId(ref.point_id), revision: ref.revision, read_revision: ref.__alignedFrom });
    }
  }
  return aligned;
}
export function validateProposal(proposal, board, available, maxMechanisms = 3) {
  const title = proposal.title.trim();
  assert(title && proposal.text.trim(), '方案标题及完整正文不能为空');
  
  assert(Array.isArray(proposal.mechanisms), '方案必须包含 mechanisms 机制列表');
  assert(proposal.mechanisms.length >= 1, '方案必须至少包含 1 个核心机制');
  assert(proposal.mechanisms.length <= maxMechanisms, `方案包含机制数（${proposal.mechanisms.length}）超过当前上限（最多 ${maxMechanisms} 个机制组合）`);
  for (const m of proposal.mechanisms) {
    assert(typeof m === 'string' && m.trim().length > 0, '机制名称不能为空');
    assert([...m.trim()].length <= 20, `机制名称【${m}】过长，最多20个字`);
    assert(!/(?:[加与及、+&]|同时|并且)/.test(m), `机制名称【${m}】违规：机制名称必须是单一原子概念，严禁使用“与/加/及/并且/同时”等连词拼凑复合机制！`);
  }

  // A parent id that was never available cannot be resolved, and round 6 inherits ids proposed in the
  // same round. Drop the unresolvable reference and keep the proposal: the body is the deliverable, and
  // the dropped ids are recorded on the raw response so the lineage loss stays visible.
  const offered = new Set((available ?? []).map(p => p.proposal_id));
  const cited = proposal.parent_proposal_ids ?? [];
  proposal.dropped_parent_proposal_ids = cited.filter(id => !offered.has(id));
  proposal.parent_proposal_ids = cited.filter(id => offered.has(id));
  const parents = proposal.parent_proposal_ids;
  // change_summary describes a change, so it is only required when there is a parent to have changed.
  // A new proposal has nothing to describe, and live runs lost seven complete proposal bodies to this.
  assert(parents.length === 0 || (proposal.change_summary ?? '').trim(), '修订或派生方案必须说明相对来源方案的实质变化');
  assert([...title].length <= 32, '方案标题最多32个字');
  assert(!/[（(][A-Za-z][^）)]*[）)]/.test(title), '方案标题不要添加英文副标题');
  assert([...proposal.text].length <= 1500, '单个方案正文最多1500字');
  assert(!/[【](?:方案目标|完整机制|组件配合|必要条件|取舍与失效条件|验证办法)[】]/.test(proposal.text), '方案正文不要使用公文模板标题');
  assert(new Set(parents).size === parents.length, '父方案引用重复');
  // Duplicate detection must compare normalized ids, or "P002" and "#P002" read as two distinct points.
  assert(new Set(proposal.point_refs.map(p => normalizePointId(p.point_id))).size === proposal.point_refs.length, '方案观点引用重复');
  for (const ref of proposal.point_refs) {
    const before = ref.revision;
    const result = alignPointRef(ref, board);
    assert(result.ok, `方案引用了不存在的观点（${ref.point_id}）`);
    if (result.aligned) ref.__alignedFrom = before;
  }
}
export function validateCreative(data, board, available, requireProposal = false, maxMechanisms = 3) {
  validateSchema(data, schemas.creative);
  assert(data.contributions.length > 0 || data.proposals.length > 0, '至少贡献观点或完整方案');
  assert(!requireProposal || data.proposals.length > 0, '单轮实验至少需要一个完整方案');
  for (const c of data.contributions) {
    assert(c.text.trim().length > 0, '观点文本不能为空');
    if (c.type === 'mechanism') {
      assert(!/(?:第一[步阶段]|第二[步阶段]|1\.|2\.|首先.*然后)/.test(c.text), `机制观点【${c.text.slice(0, 20)}...】违规：原子机制只能包含一条核心计算规则，严禁划分多步骤、多阶段流水线！`);
    }
  }
  for (const p of data.proposals) validateProposal(p, board, available, maxMechanisms);
}
export function validateMemo(data, board, available, maxMechanisms = 3) {
  validateSchema(data, schemas.decision);
  assert(data.proposals.length > 0, '第六轮至少需要一个完整候选方案');
  for (const p of data.proposals) validateProposal(p, board, available, maxMechanisms);
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
  assert(data.selected_operator_ids.length <= 4, '最多选择 4 个行业诊断算子');
  const seen = new Set();
  for (const id of data.selected_operator_ids) {
    if (availableOperatorIds) assert(availableOperatorIds.has(id), `未知的行业诊断算子 ID: ${id}`);
    assert(!seen.has(id), `行业诊断算子 ID 重复: ${id}`);
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
