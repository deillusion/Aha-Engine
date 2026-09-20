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
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'InitProject', 'RestoreBackup', 'ListBackups', 'ExploreDesign'
]);

export const AGENT_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取工作区文件内容（支持行号切片）',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区根目录的文件路径' },
          start_line: { type: 'integer', description: '起始行号（从 1 开始，包含）' },
          end_line: { type: 'integer', description: '结束行号（包含）' }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: '按 glob 模式匹配文件路径列表',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '匹配模式，如 **/*.md' },
          max_results: { type: 'integer', description: '最多返回的结果数，默认 200' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: '在工作区文件中快速检索文本或正则表达式匹配',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词或正则表达式' },
          is_regex: { type: 'boolean', description: '是否作为正则表达式处理' },
          path_filter: { type: 'string', description: '文件过滤 glob，默认 **/*' },
          max_results: { type: 'integer', description: '最多返回的结果数，默认 100' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: '精确替换文件中的特定文本块。必须经由用户显式写意图确认',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件相对路径' },
          old_string: { type: 'string', description: '被替换的现有文本块' },
          new_string: { type: 'string', description: '替换后的新文本块' },
          expected_hash: { type: 'string', description: '操作前文件的 sha256' }
        },
        required: ['file_path', 'old_string', 'new_string', 'expected_hash'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '写入或覆盖文件内容。必须经由用户显式写意图确认',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件相对路径' },
          content: { type: 'string', description: '完整文件内容' },
          expected_hash: { type: ['string', 'null'], description: '覆盖前文件的预期 sha256，新建文件为 null' }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'InitProject',
      description: '初始化或更新 VARINA.md 项目心智模型。仅在用户输入 /init 时调用',
      parameters: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: '项目清单对象' }
        },
        required: ['manifest'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'RestoreBackup',
      description: '从备份恢复文件',
      parameters: {
        type: 'object',
        properties: {
          backup_id: { type: 'string', description: '备份 ID' }
        },
        required: ['backup_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ListBackups',
      description: '列出可恢复的备份',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: ['string', 'null'], description: '指定文件路径，若为 null 则列出所有备份' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ExploreDesign',
      description: '触发 Varina 深度设计探索流水线，推演多视角机制组合与系统取舍',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: '短小中立的任务定义' },
          user_constraints: {
            type: 'array',
            description: '从用户原话中直接摘录的约束列表',
            items: {
              type: 'object',
              properties: {
                constraint: { type: 'string' },
                source_quote: { type: 'string' }
              },
              required: ['constraint', 'source_quote'],
              additionalProperties: false
            }
          },
          source_excerpts: {
            type: 'array',
            description: '从已 Read 文件中提取的真实高信息量行范围',
            items: {
              type: 'object',
              properties: {
                source_path: { type: 'string' },
                start_line: { type: 'integer' },
                end_line: { type: 'integer' }
              },
              required: ['source_path', 'start_line', 'end_line'],
              additionalProperties: false
            }
          },
          agent_hypotheses: {
            type: 'array',
            description: 'Agent 提出的可被挑战的假说',
            items: { type: 'string' }
          },
          relevant_files: {
            type: 'array',
            description: '本轮或此前由 Read 实际加载过的文件路径',
            items: { type: 'string' }
          }
        },
        required: ['problem'],
        additionalProperties: false
      }
    }
  }
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
  varina_seat: seatResponseSchema,
  varina_grounder: groundingSchema,
  varina_dedup: dedupSchema,
  varina_assembly: assemblySchema,
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

export function cleanJsonText(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }
  return cleaned;
}

export function parseStructuredJson(text, schema) {
  if (typeof text !== 'string') throw new Error('模型未返回有效文本');
  const cleaned = cleanJsonText(text);
  let value;
  try { value = JSON.parse(cleaned); }
  catch { throw new Error('模型未返回有效 JSON'); }
  if (schema) return validateJsonSchema(value, schema);
  return value;
}

