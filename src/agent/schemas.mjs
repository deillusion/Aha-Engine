const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const integer = { type: 'integer' };
const array = items => ({ type: 'array', items });
const object = properties => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});

export const POINT_TYPES = Object.freeze([
  'proposal', 'mechanism', 'argument', 'counterexample', 'modification',
  'connection', 'assumption', 'reframing', 'other'
]);

export const AGENT_TOOL_NAMES = Object.freeze([
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'RestoreBackup', 'ListBackups', 'ExploreDesign'
]);

export const agentTurnSchema = object({
  message: string,
  tool_calls: array(object({
    id: string,
    name: { type: 'string', enum: AGENT_TOOL_NAMES },
    arguments_json: string
  })),
  done: { type: 'boolean' }
});

export const seatResponseSchema = object({
  seat_id: string,
  packet_token: string,
  analysis_summary: string,
  contributions: array(object({
    local_id: string,
    type: { type: 'string', enum: POINT_TYPES },
    text: string,
    failure_condition: string
  })),
  verification_requests: array(object({
    claim_id: string,
    claim: string,
    why_it_matters: string,
    search_hints: array(string),
    affected_local_ids: array(string)
  }))
});

const evidenceSchema = object({
  filePath: string,
  lineRange: array(integer),
  symbol: nullableString,
  snippet: string,
  content_hash: string
});

export const groundingSchema = object({
  facts: array(object({
    fact_ref: string,
    claim: string,
    status: { type: 'string', enum: ['confirmed', 'contradicted', 'partially_true', 'unknown', 'stale'] },
    evidence_strength: { type: 'string', enum: ['unverified', 'documentary', 'structural', 'reachable', 'runtime', 'coverage'] },
    evidence: array(evidenceSchema),
    search_coverage: array(string),
    correction: nullableString,
    semantic_summary: string,
    affected_candidate_ids: array(string)
  })),
  load_requests: array(object({
    request_id: string,
    claim_ref: string,
    reason: string,
    search_hints: array(string),
    candidate_paths: array(string),
    blocking: { type: 'boolean' }
  }))
});

export const dedupSchema = object({
  operations: array(object({
    action: { type: 'string', enum: ['ADD', 'MERGE', 'DROP'] },
    candidate_ids: array(string),
    target_point_id: nullableString,
    text: nullableString,
    failure_condition: nullableString,
    type: { type: ['string', 'null'], enum: [...POINT_TYPES, null] },
    reason: nullableString,
    duplicate_of: nullableString,
    evidence_refs: array(string)
  }))
});

export const assemblySchema = object({
  solutions: array(object({
    solution_id: string,
    name: string,
    core_mechanism_ids: array(string),
    defensive_patch_ids: array(string),
    inherent_costs: array(string)
  })),
  unresolved_questions: array(string)
});

export const agentSchemas = Object.freeze({
  agent_turn: agentTurnSchema,
  aha_seat: seatResponseSchema,
  aha_grounder: groundingSchema,
  aha_dedup: dedupSchema,
  aha_assembly: assemblySchema
});

export function validateJsonSchema(value, schema, path = '$') {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (!allowedTypes.includes(actual) && !(actual === 'integer' && allowedTypes.includes('number'))) {
    throw new Error(`${path} 类型错误，期望 ${allowedTypes.join('|')}，实际 ${actual}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} 枚举值无效`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} 缺失`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key} 未定义`);
        continue;
      }
      validateJsonSchema(child, properties[key], `${path}.${key}`);
    }
  }
  if (actual === 'array') value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`));
  return value;
}

export function parseStructuredJson(text, schema) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('模型未返回有效 JSON'); }
  return validateJsonSchema(value, schema);
}
