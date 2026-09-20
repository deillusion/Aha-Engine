const MAX_RENDERED_CHARACTERS = 6000;
const MAX_RENDERED_LINES = 120;

function text(value, name, { optional = false, max = 3000 } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} 必须是${optional ? '可选的' : ''}非空字符串，且不超过 ${max} 字符`);
  }
  return value.trim().replace(/\r\n?/g, '\n');
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value;
}

function list(value, name, mapper, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} 必须是包含 ${min}—${max} 项的数组`);
  }
  return value.map((item, index) => mapper(item, `${name}[${index}]`));
}

function stringList(value, name, { min = 0, max = 20, itemMax = 1200 } = {}) {
  return list(value, name, (item, itemName) => text(item, itemName, { max: itemMax }), { min, max });
}

function inline(value) {
  return value.replace(/\s+/g, ' ').replace(/`/g, '\'');
}

function bullets(items) {
  return items.map(item => `- ${item}`).join('\n');
}

export function normalizeProjectManifest(input) {
  const manifest = object(input, 'manifest');
  const identity = object(manifest.identity, 'manifest.identity');
  return {
    project_name: text(manifest.project_name, 'manifest.project_name', { max: 120 }),
    identity: {
      what_it_is: text(identity.what_it_is, 'manifest.identity.what_it_is', { max: 1600 }),
      serves: stringList(identity.serves, 'manifest.identity.serves', { min: 1, max: 5, itemMax: 500 }),
      what_it_is_not: stringList(identity.what_it_is_not, 'manifest.identity.what_it_is_not', { min: 1, max: 5, itemMax: 500 }),
      operational_boundary: text(identity.operational_boundary, 'manifest.identity.operational_boundary', { max: 1600 })
    },
    system_flow: list(manifest.system_flow, 'manifest.system_flow', (item, name) => {
      const stage = object(item, name);
      return {
        name: text(stage.name, `${name}.name`, { max: 100 }),
        purpose: text(stage.purpose, `${name}.purpose`, { max: 900 }),
        flow: text(stage.flow, `${name}.flow`, { max: 900 })
      };
    }, { min: 2, max: 6 }),
    ontology: list(manifest.ontology, 'manifest.ontology', (item, name) => {
      const concept = object(item, name);
      return {
        term: text(concept.term, `${name}.term`, { max: 100 }),
        definition: text(concept.definition, `${name}.definition`, { max: 700 }),
        ecosystem_role: text(concept.ecosystem_role, `${name}.ecosystem_role`, { max: 700 }),
        not_to_confuse_with: text(concept.not_to_confuse_with, `${name}.not_to_confuse_with`, { max: 500 })
      };
    }, { min: 3, max: 5 }),
    structural_examples: stringList(manifest.structural_examples, 'manifest.structural_examples', { min: 0, max: 2, itemMax: 700 }),
    negative_guardrails: stringList(manifest.negative_guardrails, 'manifest.negative_guardrails', { min: 3, max: 8, itemMax: 700 }),
    operational_constraints: stringList(manifest.operational_constraints, 'manifest.operational_constraints', { min: 0, max: 6, itemMax: 500 }),
    verification_map: list(manifest.verification_map, 'manifest.verification_map', (item, name) => {
      const source = object(item, name);
      return {
        path: text(source.path, `${name}.path`, { max: 500 }),
        answers: text(source.answers, `${name}.answers`, { max: 700 })
      };
    }, { min: 3, max: 6 }),
    unresolved_conflicts: stringList(manifest.unresolved_conflicts, 'manifest.unresolved_conflicts', { min: 0, max: 3, itemMax: 700 })
  };
}

export function renderVarinaMarkdown(input) {
  const manifest = normalizeProjectManifest(input);
  const sections = [
    `# ${manifest.project_name}`,
    '> Level-1 System Mental Model and Domain Ontology. Use it to orient interpretation; never treat it as proof of current implementation.',
    `## 1. System Identity & Mission Boundary\n\n**What it is:** ${manifest.identity.what_it_is}\n\n**Who it serves:**\n${bullets(manifest.identity.serves)}\n\n**What it is not:**\n${bullets(manifest.identity.what_it_is_not)}\n\n**Operational boundary:** ${manifest.identity.operational_boundary}`,
    `## 2. Architecture & High-Level System Flow\n\n${manifest.system_flow.map(stage => `### ${stage.name}\n- Purpose: ${stage.purpose}\n- Flow: ${stage.flow}`).join('\n\n')}`,
    `## 3. Core Domain Ontology\n\n${manifest.ontology.map(concept => `### ${concept.term}\n- Definition: ${concept.definition}\n- Ecosystem role: ${concept.ecosystem_role}\n- Do not confuse with: ${concept.not_to_confuse_with}`).join('\n\n')}`
  ];

  if (manifest.structural_examples.length) sections.push(`### Structural Examples\n${bullets(manifest.structural_examples)}`);

  sections.push(`## 4. Invariants & Negative Guardrails\n\n### Truth Hierarchy\n- The user's explicit current request and authoritative product/design documents are Level-0 truth for product intent, domain meaning, and desired direction.\n- Live code and passing tests are Level-0 truth for currently implemented behavior.\n- This file is Level-1 prior guidance. It guides interpretation but is never sufficient evidence that a behavior is implemented.\n- When Level-0 sources conflict, expose the conflict. Never silently rewrite product intent to match current code.\n\n### Negative Guardrails\n${bullets(manifest.negative_guardrails)}\n- Treat this file as a stable constitution, not a dynamic scratchpad. Do not mutate it after ordinary tasks.`);

  if (manifest.operational_constraints.length) {
    sections.push(`## 5. Non-Negotiable Operational Constraints\n\n${bullets(manifest.operational_constraints)}`);
  }

  let verification = `## ${manifest.operational_constraints.length ? '6' : '5'}. Authoritative Verification Map\n\n${manifest.verification_map.map(item => `- \`${inline(item.path)}\`: ${item.answers}`).join('\n')}`;
  if (manifest.unresolved_conflicts.length) verification += `\n\n### Unresolved Source Conflicts\n${bullets(manifest.unresolved_conflicts)}`;
  sections.push(verification);

  const rendered = `${sections.join('\n\n')}\n`;
  const lineCount = rendered.split('\n').length;
  if (lineCount > MAX_RENDERED_LINES) throw new Error(`生成的 VARINA.md 有 ${lineCount} 行，超过 ${MAX_RENDERED_LINES} 行上限；请压缩结构后重试`);
  if (rendered.length > MAX_RENDERED_CHARACTERS) throw new Error(`生成的 VARINA.md 有 ${rendered.length} 字符，超过 ${MAX_RENDERED_CHARACTERS} 字符上限；请删除实现细节后重试`);
  return rendered;
}

export const PROJECT_MANIFEST_LIMITS = Object.freeze({
  maxCharacters: MAX_RENDERED_CHARACTERS,
  maxLines: MAX_RENDERED_LINES
});
