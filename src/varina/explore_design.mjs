import { createHash, randomUUID } from 'node:crypto';
import { operators, random, sampleOperators } from '../operators.mjs';
import { ExplorationReact } from './react.mjs';
import { generationFor } from '../agent/model_gateway.mjs';
import {
  decompositionSeatResponseSchema,
  POINT_TYPES,
  subproblemAnswerResponseSchema,
  seatResponseSchema
} from '../agent/schemas.mjs';
import {
  decompositionSeatMessages,
  subproblemAnswerMessages,
  seatMessages
} from '../agent/prompts.mjs';

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function snapshotId(files) {
  return digest(canonical(files.map(file => ({ file_path: file.filePath, content_hash: file.contentHash })).sort((a, b) => a.file_path.localeCompare(b.file_path))));
}

function renderLoadedFiles(files) {
  return files.map(file => `\n<workspace-data path="${file.filePath}" sha256="${file.contentHash}">\n${file.renderedContent}\n</workspace-data>`).join('\n');
}

function activeFacts(facts) {
  return facts.map(fact => ({
    fact_id: fact.fact_id, fact_ref: fact.fact_ref, claim: fact.claim,
    status: fact.status, semantic_summary: fact.semantic_summary,
    correction: fact.correction ?? null, evidence: fact.evidence,
    affected_point_ids: fact.affected_point_ids
  }));
}

function buildCommonPrefix(runtime, repositorySnapshotId, packetToken, focus = '') {
  return JSON.stringify(canonical({
    frozen_shared_input_packet: {
      original_user_request: runtime.original_user_request,
      task_framing: runtime.task_framing,
      project_context: runtime.project_context,
      user_constraints: runtime.hard_constraints,
      verified_investigation_context: runtime.code_context,
      agent_hypotheses: runtime.agent_hypotheses,
      verified_facts: activeFacts(runtime.fact_ledger),
      current_board: { ...runtime.current_board, points: runtime.current_board.points.filter(point => point.status === 'active') },
      rejected_directions: runtime.board_changes?.filter(change => change.action === 'delete').map(change => ({ text: change.before.text, reason: change.reason })) ?? [],
      focus,
      repository_snapshot_id: repositorySnapshotId,
      packet_token: packetToken
    },
    output_contract: 'Return the required CreativeSeatResponse JSON. The packet above is frozen and identical for all seats.'
  }));
}

export function normalizeSeatResponse(response) {
  if (!response || typeof response !== 'object') return response;
  if (typeof response.seat_id === 'string') response.seat_id = response.seat_id.trim();
  if (typeof response.packet_token === 'string') response.packet_token = response.packet_token.trim();

  if (Array.isArray(response.contributions)) {
    response.contributions = response.contributions.filter(c =>
      c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim() && typeof c.failure_condition === 'string' && c.failure_condition.trim()
    );
    if (response.contributions.length > 3) {
      response.contributions = response.contributions.slice(0, 3);
    }
    const idMap = new Map();
    response.contributions.forEach((c, index) => {
      const canonicalId = `C${index + 1}`;
      const rawId = typeof c.local_id === 'string' ? c.local_id.trim() : '';
      const finalId = (/^C[1-9]\d*$/.test(rawId) && !idMap.has(rawId)) ? rawId : canonicalId;
      if (rawId) idMap.set(rawId, finalId);
      idMap.set(canonicalId, finalId);
      c.local_id = finalId;
    });

    if (Array.isArray(response.verification_requests)) {
      if (response.verification_requests.length > 2) {
        response.verification_requests = response.verification_requests.slice(0, 2);
      }
      const validLocalIds = new Set(response.contributions.map(c => c.local_id));
      const claimIds = new Set();
      response.verification_requests.forEach((v, index) => {
        if (v && typeof v === 'object') {
          const canonicalClaimId = `V${index + 1}`;
          const rawClaimId = typeof v.claim_id === 'string' ? v.claim_id.trim() : '';
          const finalClaimId = (/^V[1-9]\d*$/.test(rawClaimId) && !claimIds.has(rawClaimId)) ? rawClaimId : canonicalClaimId;
          claimIds.add(finalClaimId);
          v.claim_id = finalClaimId;

          if (Array.isArray(v.affected_local_ids)) {
            v.affected_local_ids = v.affected_local_ids
              .map(id => idMap.get(id) ?? id)
              .filter(id => validLocalIds.has(id));
            if (v.affected_local_ids.length === 0 && response.contributions.length > 0) {
              v.affected_local_ids = [response.contributions[0].local_id];
            }
          } else {
            v.affected_local_ids = response.contributions.length > 0 ? [response.contributions[0].local_id] : [];
          }
        }
      });
    }
  }
  return response;
}

export function checkSeat(response, { seatId, packetToken }) {
  if (response.seat_id !== seatId) throw new Error(`席位 ID 不匹配：${response.seat_id}`);
  if (response.packet_token !== packetToken) throw new Error('席位回传了过期 packet_token');
  if (response.contributions.length > 3 || response.verification_requests.length > 2) throw new Error('席位贡献或核验请求超过上限');
  const contributionIds = new Set();
  for (const contribution of response.contributions) {
    if (!/^C[1-9]\d*$/.test(contribution.local_id) || contributionIds.has(contribution.local_id)) throw new Error('席位 local_id 无效或重复');
    if (!contribution.text.trim() || !contribution.failure_condition.trim()) throw new Error('观点与失效边界不能为空');
    contributionIds.add(contribution.local_id);
  }
  const claimIds = new Set();
  for (const request of response.verification_requests) {
    if (!/^V[1-9]\d*$/.test(request.claim_id) || claimIds.has(request.claim_id)) throw new Error('claim_id 无效或重复');
    if (request.affected_local_ids.some(id => !contributionIds.has(id))) throw new Error('核验请求引用了不存在的本席位观点');
    claimIds.add(request.claim_id);
  }
}

function candidatesFromResponses(round, responses) {
  return responses.flatMap(response => response.contributions.map(contribution => ({
    candidate_id: `R${round}:${response.seat_id}:${contribution.local_id}`,
    seat_id: response.seat_id,
    ...contribution
  })));
}

function requestsFromResponses(round, responses) {
  return responses.flatMap(response => response.verification_requests.map(request => ({
    fact_ref: `R${round}:${response.seat_id}:${request.claim_id}`,
    claim: request.claim,
    why_it_matters: request.why_it_matters,
    search_hints: request.search_hints,
    affected_candidate_ids: request.affected_local_ids.map(id => `R${round}:${response.seat_id}:${id}`)
  })));
}

async function refreshWorkingFiles(host, loadedFiles, facts, degradations, signal) {
  const refreshed = [];
  for (const loaded of loadedFiles) {
    signal?.throwIfAborted();
    try {
      const current = await host.readFile(loaded.filePath, { signal });
      if (current.contentHash !== loaded.contentHash) {
        for (const fact of facts) {
          if (fact.evidence?.some(evidence => evidence.filePath === loaded.filePath)) fact.status = 'stale';
        }
        degradations.push(`${loaded.filePath} 内容已变化；依赖事实已标记 stale 并重新载入`);
      }
      refreshed.push(current);
    } catch (error) {
      for (const fact of facts) {
        if (fact.evidence?.some(evidence => evidence.filePath === loaded.filePath)) fact.status = 'stale';
      }
      degradations.push(`${loaded.filePath} 已不可读；依赖事实已标记 stale`);
    }
  }
  loadedFiles.splice(0, loadedFiles.length, ...refreshed);
}

function fallbackOperations(candidates) {
  return candidates.map(candidate => ({
    action: 'ADD', candidate_ids: [candidate.candidate_id], target_point_id: null,
    text: candidate.text, failure_condition: candidate.failure_condition, type: candidate.type,
    reason: null, duplicate_of: null, evidence_refs: []
  }));
}

// Merge levels run in parallel; each level waits for the preceding level.
// The final board comparison uses the same frozen board for every survivor.
export async function deduplicateIdeas({ decisionGateway, parentProblem, candidates, board, logicalId, signal }) {
  const decisions = [];
  const errors = [];
  const dropped = new Set();
  const compare = async (candidate, referenceItems, stage) => {
    signal?.throwIfAborted();
    try {
      if (!decisionGateway?.evaluateIdeaRedundancy) throw new Error('发散观点去重未连接 Jev');
      const result = await decisionGateway.evaluateIdeaRedundancy({
        parentProblem, referenceItems, candidate,
        logicalId: `${logicalId}:${stage}:${candidate.candidate_id}`
      });
      if (typeof result.duplicate !== 'boolean') throw new Error('Jev 观点判重缺少布尔结果');
      decisions.push({ stage, candidate_id: candidate.candidate_id, reference_ids: referenceItems.map(item => item.id ?? item.candidate_id), ...result });
      if (result.duplicate) dropped.add(candidate.candidate_id);
      return !result.duplicate;
    } catch (error) {
      signal?.throwIfAborted();
      errors.push({ stage, candidate_id: candidate.candidate_id, error: String(error.message).slice(0, 220) });
      return true; // Only this failed comparison is kept, not the entire round.
    }
  };
  let groups = candidates.map(candidate => [candidate]);
  let level = 0;
  while (groups.length > 1) {
    level++;
    const pairs = [];
    for (let index = 0; index < groups.length; index += 2) pairs.push([groups[index], groups[index + 1]]);
    groups = await Promise.all(pairs.map(async ([left, right]) => {
      if (!right) return left;
      const keep = await Promise.all(right.map(candidate => compare(candidate, left, `increment-L${level}`)));
      return [...left, ...right.filter((_, index) => keep[index])];
    }));
  }
  const survivors = groups[0] ?? [];
  await Promise.all(survivors.map(candidate => compare(candidate, board.points, 'board')));
  const operations = fallbackOperations(candidates).map(operation => dropped.has(operation.candidate_ids[0])
    ? { ...operation, action: 'DROP', text: null, failure_condition: null, type: null, reason: 'Jev 判定已有观点实质覆盖', duplicate_of: null }
    : operation);
  return { operations, decisions, errors, increment_survivor_ids: survivors.map(candidate => candidate.candidate_id) };
}

function validateOperations(operations, candidates, board, factRefs) {
  const candidateIds = new Set(candidates.map(candidate => candidate.candidate_id));
  const covered = [];
  for (const operation of operations) {
    if (!operation.candidate_ids.length) throw new Error('去重操作缺少 candidate_ids');
    for (const id of operation.candidate_ids) {
      if (!candidateIds.has(id)) throw new Error(`去重引用未知候选 ${id}`);
      covered.push(id);
    }
    if (operation.evidence_refs.some(ref => !factRefs.has(ref))) throw new Error('去重引用了不存在的事实');
    if (operation.action === 'ADD') {
      if (!operation.text?.trim() || !operation.failure_condition?.trim() || !operation.type) throw new Error('ADD 缺少完整观点字段');
      if (operation.target_point_id !== null) throw new Error('ADD 不应指定 target_point_id');
    } else if (operation.action === 'MERGE') {
      const target = board.points.find(point => point.id === operation.target_point_id && point.status === 'active');
      if (!target) throw new Error('MERGE 目标不存在或不活跃');
      if (target.type === 'subproblem') throw new Error('创意观点不能合并进子问题节点');
      if (!operation.text?.trim() || !operation.failure_condition?.trim() || !operation.type) throw new Error('MERGE 缺少完整观点字段');
      if (target.text === operation.text && target.failure_condition === operation.failure_condition) throw new Error('MERGE 未产生实质变化');
    } else {
      if (!operation.reason?.trim()) throw new Error('DROP 缺少理由');
      if (operation.duplicate_of && !board.points.some(point => point.id === operation.duplicate_of)) throw new Error('DROP duplicate_of 引用了不存在的 Point');
      if (operation.duplicate_of && board.points.some(point => point.id === operation.duplicate_of && point.type === 'subproblem')) throw new Error('创意观点不能以子问题作为重复代表');
    }
  }
  if (covered.length !== candidateIds.size || new Set(covered).size !== covered.length || covered.some(id => !candidateIds.has(id))) {
    throw new Error('候选没有被恰好覆盖一次');
  }
}

function applyOperations(runtime, round, operations, candidates) {
  const candidateIndex = new Map(candidates.map((candidate, index) => [candidate.candidate_id, index]));
  const sorted = [...operations].sort((a, b) => Math.min(...a.candidate_ids.map(id => candidateIndex.get(id))) - Math.min(...b.candidate_ids.map(id => candidateIndex.get(id))));
  const points = structuredClone(runtime.current_board.points);
  const candidateToPoint = new Map();
  let nextPoint = points.reduce((max, point) => Math.max(max, Number(point.id.slice(1)) || 0), 0) + 1;
  let add = 0, merge = 0, drop = 0;
  for (const operation of sorted) {
    if (operation.action === 'ADD') {
      const id = `P${String(nextPoint++).padStart(3, '0')}`;
      const point = {
        id, revision: 1, status: 'active', type: operation.type, text: operation.text,
        failure_condition: operation.failure_condition,
        source_candidate_ids: [...operation.candidate_ids], evidence_refs: [...operation.evidence_refs],
        round_introduced: round,
        revisions: [{ revision: 1, round, text: operation.text, failure_condition: operation.failure_condition, source_candidate_ids: [...operation.candidate_ids], evidence_refs: [...operation.evidence_refs] }]
      };
      points.push(point);
      operation.candidate_ids.forEach(candidateId => candidateToPoint.set(candidateId, id));
      add++;
    } else if (operation.action === 'MERGE') {
      const point = points.find(item => item.id === operation.target_point_id);
      point.revision += 1;
      point.type = operation.type;
      point.text = operation.text;
      point.failure_condition = operation.failure_condition;
      point.source_candidate_ids.push(...operation.candidate_ids.filter(id => !point.source_candidate_ids.includes(id)));
      point.evidence_refs.push(...operation.evidence_refs.filter(ref => !point.evidence_refs.includes(ref)));
      point.revisions.push({ revision: point.revision, round, text: point.text, failure_condition: point.failure_condition, source_candidate_ids: [...operation.candidate_ids], evidence_refs: [...operation.evidence_refs] });
      operation.candidate_ids.forEach(candidateId => candidateToPoint.set(candidateId, point.id));
      merge++;
    } else {
      const texts = operation.candidate_ids.map(id => candidates.find(candidate => candidate.candidate_id === id)?.text ?? id);
      runtime.rejected_directions.push({
        rejection_id: `RJ${String(runtime.rejected_directions.length + 1).padStart(3, '0')}`,
        round, candidate_ids: [...operation.candidate_ids], texts, reason: operation.reason,
        duplicate_of: operation.duplicate_of ?? undefined, evidence_refs: [...operation.evidence_refs]
      });
      if (operation.duplicate_of) operation.candidate_ids.forEach(candidateId => candidateToPoint.set(candidateId, operation.duplicate_of));
      drop++;
    }
  }
  runtime.current_board = { version: runtime.current_board.version + 1, points };
  runtime.board_history.push(structuredClone(runtime.current_board));
  return { add, merge, drop, candidateToPoint };
}

function validateAssembly(result, board) {
  const active = new Set(board.points.filter(point => point.status === 'active' && point.type !== 'subproblem').map(point => point.id));
  const solutionIds = new Set();
  if (result.solutions.length > 3) throw new Error('装配方案最多 3 个');
  for (const solution of result.solutions) {
    if (solutionIds.has(solution.solution_id)) throw new Error('solution_id 重复');
    solutionIds.add(solution.solution_id);
    const ids = [...solution.core_mechanism_ids, ...solution.defensive_patch_ids];
    if (!solution.name.trim() || !solution.core_mechanism_ids.length || !solution.inherent_costs.length || ids.some(id => !active.has(id))) throw new Error('装配方案字段或 Point 引用无效');
    if (new Set(ids).size !== ids.length) throw new Error('同一装配方案重复引用 Point');
  }
}

async function loadInitialFiles(host, relevantFiles, degradations) {
  const loaded = [];
  for (const filePath of [...new Set(relevantFiles ?? [])].slice(0, 5)) {
    try { loaded.push(await host.readFile(filePath)); }
    catch (error) { degradations.push(`无法加载 ${filePath}：${String(error.message).slice(0, 180)}`); }
  }
  return loaded;
}

function normalizedQuestionText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeDecompositionResponse(response, { round, seatId, maxQuestions }) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.questions)) {
    throw new Error('拆解席位没有返回 questions 数组');
  }
  const seen = new Set();
  const questions = [];
  for (const raw of response.questions) {
    if (typeof raw !== 'string') continue;
    const question = normalizedQuestionText(raw);
    if (!question || seen.has(question)) continue;
    seen.add(question);
    questions.push(question);
    if (questions.length >= maxQuestions) break;
  }
  return questions.map((question, index) => ({
    candidate_id: `D${round}:${seatId}:Q${index + 1}`,
    question,
    decomposition_round: round,
    origin_seat_id: seatId,
    local_index: index
  }));
}

function exactDuplicateDecisions(reference, candidates) {
  const referenceTexts = new Set(reference.map(item => normalizedQuestionText(item.question).toLocaleLowerCase()));
  const duplicates = [];
  const undecided = [];
  for (const candidate of candidates) {
    if (referenceTexts.has(normalizedQuestionText(candidate.question).toLocaleLowerCase())) {
      duplicates.push({ candidate_id: candidate.candidate_id, probability: 1, method: 'exact' });
    } else undecided.push(candidate);
  }
  return { duplicates, undecided };
}

async function mergeSubproblemSets({
  decisionGateway,
  parentProblem,
  left,
  right,
  logicalId
}) {
  if (!right.length) return { items: [...left], survivors: [], rejected: [], incomplete: false };
  if (!left.length) return { items: [...right], survivors: [...right], rejected: [], incomplete: false };

  const exact = exactDuplicateDecisions(left, right);
  const rejected = exact.duplicates.map(item => ({
    ...item,
    question: right.find(candidate => candidate.candidate_id === item.candidate_id)?.question ?? ''
  }));
  if (!exact.undecided.length) return { items: [...left], survivors: [], rejected, incomplete: false };
  if (!decisionGateway) {
    return {
      items: [...left, ...exact.undecided],
      survivors: [...exact.undecided],
      rejected,
      incomplete: true
    };
  }

  try {
    const result = await decisionGateway.evaluateSubproblemRedundancy({
      parentProblem,
      referenceSubproblems: left,
      candidateSubproblems: exact.undecided,
      logicalId
    });
    const decisionById = new Map(result.decisions.map(item => [item.candidate_id, item]));
    const survivors = [];
    for (const candidate of exact.undecided) {
      const decision = decisionById.get(candidate.candidate_id);
      if (!decision) throw new Error(`Jev 缺少 ${candidate.candidate_id} 的判重结果`);
      if (decision.duplicate) {
        rejected.push({
          candidate_id: candidate.candidate_id,
          question: candidate.question,
          probability: decision.probability,
          method: 'jev'
        });
      } else survivors.push(candidate);
    }
    return { items: [...left, ...survivors], survivors, rejected, incomplete: false };
  } catch (error) {
    return {
      items: [...left, ...exact.undecided],
      survivors: [...exact.undecided],
      rejected,
      incomplete: true,
      error
    };
  }
}

async function deduplicateSubproblemGroup({
  decisionGateway,
  parentProblem,
  candidates,
  logicalId
}) {
  let groups = candidates.map(item => [item]);
  const rejected = [];
  const errors = [];
  let incomplete = false;
  let level = 0;
  while (groups.length > 1) {
    level++;
    const next = [];
    const merges = [];
    for (let index = 0; index < groups.length; index += 2) {
      if (index + 1 >= groups.length) {
        next.push(groups[index]);
        continue;
      }
      const slot = next.length;
      next.push(null);
      merges.push({ slot, left: groups[index], right: groups[index + 1], index: index / 2 });
    }
    const results = await Promise.all(merges.map(merge => mergeSubproblemSets({
      decisionGateway,
      parentProblem,
      left: merge.left,
      right: merge.right,
      logicalId: `${logicalId}:L${level}:M${merge.index + 1}`
    })));
    merges.forEach((merge, index) => {
      const result = results[index];
      next[merge.slot] = result.items;
      rejected.push(...result.rejected);
      incomplete ||= result.incomplete;
      if (result.error) errors.push(result.error);
    });
    groups = next;
  }
  return { survivors: groups[0] ?? [], rejected, incomplete, errors };
}

function appendSubproblemsToBoard(runtime, subproblems) {
  if (!subproblems.length) return [];
  const points = structuredClone(runtime.current_board.points);
  const existingSources = new Set(points.flatMap(point => point.source_candidate_ids ?? []));
  let nextPoint = points.reduce((max, point) => Math.max(max, Number(point.id.slice(1)) || 0), 0) + 1;
  const added = [];
  for (const subproblem of subproblems) {
    if (existingSources.has(subproblem.candidate_id)) continue;
    const id = `P${String(nextPoint++).padStart(3, '0')}`;
    const point = {
      id,
      revision: 1,
      status: 'active',
      type: 'subproblem',
      text: subproblem.question,
      failure_condition: '',
      source_candidate_ids: [subproblem.candidate_id],
      evidence_refs: [],
      round_introduced: 0,
      source: 'decomposition',
      decomposition_round: subproblem.decomposition_round,
      origin_seat_id: subproblem.origin_seat_id,
      arrival_index: subproblem.arrival_index,
      revisions: [{
        revision: 1,
        round: 0,
        text: subproblem.question,
        failure_condition: '',
        source_candidate_ids: [subproblem.candidate_id],
        evidence_refs: []
      }]
    };
    points.push(point);
    added.push(point);
  }
  if (added.length) {
    runtime.current_board = { version: runtime.current_board.version + 1, points };
    runtime.board_history.push(structuredClone(runtime.current_board));
  }
  return added;
}

export function normalizeSubproblemAnswer(response, {
  subproblemId,
  answerIndex,
  seatId,
  modelId,
  maxElements
}) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.elements)) {
    throw new Error('子问题回答没有返回 elements 数组');
  }
  const seen = new Set();
  const elements = [];
  for (const raw of response.elements) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type ?? '').trim();
    const text = normalizedQuestionText(raw.text);
    const failureCondition = normalizedQuestionText(raw.failure_condition);
    if (!POINT_TYPES.includes(type) || !text || !failureCondition) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({ type, text, failure_condition: failureCondition });
    if (elements.length >= maxElements) break;
  }
  return elements.map((element, index) => ({
    candidate_id: `S:${subproblemId}:A${answerIndex}:E${index + 1}`,
    parent_subproblem_id: subproblemId,
    answer_index: answerIndex,
    answer_seat_id: seatId,
    answer_model_id: modelId,
    ...element
  }));
}

function selectSubproblemAnswerAssignments(seats, count, offset) {
  const rotated = seats.map((_, index) => seats[(index + offset) % seats.length]);
  const selected = [];
  const usedModels = new Set();
  const usedSeats = new Set();
  for (const seat of rotated) {
    if (usedModels.has(seat.modelId)) continue;
    selected.push(seat);
    usedModels.add(seat.modelId);
    usedSeats.add(seat.id);
    if (selected.length >= count) break;
  }
  if (selected.length < count) {
    for (const seat of rotated) {
      if (usedSeats.has(seat.id)) continue;
      selected.push(seat);
      usedSeats.add(seat.id);
      if (selected.length >= count) break;
    }
  }
  while (selected.length < count) selected.push(rotated[selected.length % rotated.length]);
  return selected.map((seat, index) => ({
    answer_index: index + 1,
    seat_id: seat.id,
    model_id: seat.modelId
  }));
}

function appendSubproblemElementsToBoard(runtime, elements, state) {
  if (!elements.length) return [];
  const points = structuredClone(runtime.current_board.points);
  const existingTexts = new Set(points
    .filter(point => point.status === 'active' && point.type !== 'subproblem')
    .map(point => normalizedQuestionText(point.text).toLocaleLowerCase()));
  const existingSources = new Set(points.flatMap(point => point.source_candidate_ids ?? []));
  let nextPoint = points.reduce((max, point) => Math.max(max, Number(point.id.slice(1)) || 0), 0) + 1;
  const added = [];
  for (const element of elements) {
    if (existingSources.has(element.candidate_id)) continue;
    const textKey = normalizedQuestionText(element.text).toLocaleLowerCase();
    if (existingTexts.has(textKey)) {
      state.rejected_exact_duplicates.push({
        candidate_id: element.candidate_id,
        parent_subproblem_id: element.parent_subproblem_id,
        text: element.text
      });
      continue;
    }
    existingTexts.add(textKey);
    const id = `P${String(nextPoint++).padStart(3, '0')}`;
    const point = {
      id,
      revision: 1,
      status: 'active',
      type: element.type,
      text: element.text,
      failure_condition: element.failure_condition,
      source_candidate_ids: [element.candidate_id],
      evidence_refs: [],
      round_introduced: 0,
      source: 'subproblem_expansion',
      parent_subproblem_id: element.parent_subproblem_id,
      answer_index: element.answer_index,
      answer_seat_id: element.answer_seat_id,
      answer_model_id: element.answer_model_id,
      revisions: [{
        revision: 1,
        round: 0,
        text: element.text,
        failure_condition: element.failure_condition,
        source_candidate_ids: [element.candidate_id],
        evidence_refs: []
      }]
    };
    points.push(point);
    added.push(point);
  }
  if (added.length) {
    runtime.current_board = { version: runtime.current_board.version + 1, points };
    runtime.board_history.push(structuredClone(runtime.current_board));
  }
  return added;
}

export class ExploreDesignEngine {
  constructor({ host, gateway, decisionGateway = null, config, signal, onEvent = () => {}, checkpoint = async () => {} }) {
    this.host = host;
    this.gateway = gateway;
    this.decisionGateway = decisionGateway;
    this.config = config;
    this.signal = signal;
    this.onEvent = onEvent;
    this.checkpoint = checkpoint;
  }

  async runSubproblemExpansion({ runtime, runId }) {
    const settings = this.config.subproblemExpansion;
    if (!settings?.enabled) return;
    const subproblems = runtime.current_board.points.filter(point => point.status === 'active' && point.type === 'subproblem');
    const seats = this.config.seats;
    if (!seats.length) return;

    const state = {
      status: 'active',
      answers_per_subproblem: settings.answersPerSubproblem,
      max_elements_per_answer: settings.maxElementsPerAnswer,
      subproblem_count: subproblems.length,
      total_requests: subproblems.length * settings.answersPerSubproblem,
      successful_answers: 0,
      failed_answers: 0,
      records: [],
      rejected_exact_duplicates: [],
      added_point_ids: []
    };
    runtime.subproblem_expansion = state;
    await this.checkpoint(runtime);
    this.onEvent({
      phase: 'varina_subproblem_expansion_start',
      round: 0,
      message: `${subproblems.length} 个子问题分别启动 ${settings.answersPerSubproblem} 个回答席位`
    });

    const boardSnapshot = structuredClone(runtime.current_board);
    const jobs = subproblems.map((subproblem, subproblemIndex) => (async () => {
      this.signal?.throwIfAborted();
      const assignments = selectSubproblemAnswerAssignments(
        seats,
        settings.answersPerSubproblem,
        subproblemIndex % seats.length
      );
      const packet = canonical({
        original_user_request: runtime.original_user_request,
        task_framing: runtime.task_framing,
        user_constraints: runtime.hard_constraints,
        project_context: runtime.project_context,
        verified_investigation_context: runtime.code_context,
        target_subproblem: { id: subproblem.id, question: subproblem.text },
        sibling_subproblems: subproblems
          .filter(point => point.id !== subproblem.id)
          .map(point => ({ id: point.id, question: point.text })),
        existing_points: boardSnapshot.points
          .filter(point => point.status === 'active' && point.type !== 'subproblem')
          .map(point => ({ id: point.id, type: point.type, text: point.text, failure_condition: point.failure_condition }))
      });
      const packetToken = digest({ run_id: runId, phase: 'subproblem_expansion', subproblem_id: subproblem.id, packet });
      const record = {
        subproblem_id: subproblem.id,
        question: subproblem.text,
        packet_token: packetToken,
        answers: assignments.map(assignment => ({
          ...assignment,
          status: 'running',
          candidate_ids: [],
          elements: []
        }))
      };
      state.records.push(record);
      await this.checkpoint(runtime).catch(() => {});
      await Promise.all(record.answers.map(async answer => {
        try {
          const response = await this.gateway.invoke({
            phase: 'varina_subproblem_answer',
            modelId: answer.model_id,
            messages: subproblemAnswerMessages({ packet, maxElements: settings.maxElementsPerAnswer }),
            schema: subproblemAnswerResponseSchema,
            generation: generationFor(this.config, 'varina_subproblem_answer'),
            context: {
              subproblem_id: subproblem.id,
              subproblem_question: subproblem.text,
              answer_index: answer.answer_index,
              seat_id: answer.seat_id,
              packet_token: packetToken
            },
            logicalId: `${runId}:${subproblem.id}:answer-${answer.answer_index}`
          });
          const elements = normalizeSubproblemAnswer(response, {
            subproblemId: subproblem.id,
            answerIndex: answer.answer_index,
            seatId: answer.seat_id,
            modelId: answer.model_id,
            maxElements: settings.maxElementsPerAnswer
          });
          answer.status = 'completed';
          answer.candidate_ids = elements.map(element => element.candidate_id);
          answer.elements = elements;
          state.successful_answers++;
        } catch (error) {
          answer.status = 'failed';
          answer.error = String(error?.message ?? error).slice(0, 220);
          state.failed_answers++;
          runtime.degradations.push(`${subproblem.id} 回答席位 ${answer.answer_index} 失败：${answer.error}`);
        }
        await this.checkpoint(runtime).catch(() => {});
      }));
      this.onEvent({
        phase: 'varina_subproblem_expansion_done',
        round: 0,
        subproblem_id: subproblem.id,
        message: `${subproblem.id} 完成 ${record.answers.filter(answer => answer.status === 'completed').length}/${assignments.length} 个回答`
      });
      return record;
    })());

    const records = await Promise.all(jobs);
    state.records = records;
    const elements = records.flatMap(record => record.answers.flatMap(answer => answer.elements));
    state.added_point_ids = appendSubproblemElementsToBoard(runtime, elements, state).map(point => point.id);
    for (const record of state.records) {
      for (const answer of record.answers) delete answer.elements;
    }
    state.status = 'complete';
    await this.checkpoint(runtime);
    this.onEvent({
      phase: 'varina_subproblem_expansion_complete',
      round: 0,
      message: `子问题发散完成，观点板新增 ${state.added_point_ids.length} 个回答元素`
    });
  }

  async runDecomposition({ runtime, runId, loadedFiles }) {
    const settings = this.config.decomposition;
    if (!settings?.enabled) return;
    const seats = this.config.seats.slice(0, settings.seatCount);
    if (!seats.length) return;

    const state = {
      status: 'active',
      current_round: 0,
      max_rounds: settings.maxRounds,
      seat_count: seats.length,
      max_questions_per_seat: settings.maxQuestionsPerSeat,
      max_accepted_subproblems: settings.maxAcceptedSubproblems,
      accepted: [],
      rejected: [],
      round_records: [],
      arrival_counter: 0,
      stop_reason: null,
      dedup_incomplete: false
    };
    runtime.decomposition = state;
    await this.checkpoint(runtime);
    this.onEvent({
      phase: 'varina_decomposition_start',
      round: 0,
      message: `${seats.length} 个席位开始拆解问题`
    });

    if (!this.decisionGateway) {
      runtime.degradations.push('问题拆解未连接 Jev；仅执行完全相同文本去重，并在第一轮后停止');
      state.dedup_incomplete = true;
    }

    for (let round = 1; round <= settings.maxRounds; round++) {
      this.signal?.throwIfAborted();
      state.current_round = round;
      const packetToken = digest(canonical({
        run_id: runId,
        phase: 'decomposition',
        round,
        original_user_request: runtime.original_user_request,
        task_framing: runtime.task_framing,
        user_constraints: runtime.hard_constraints,
        board_version: runtime.current_board.version,
        accepted: state.accepted.map(item => ({ candidate_id: item.candidate_id, question: item.question })),
        repository_snapshot_id: runtime.repository_snapshot_id
      }));
      state.current_packet_token = packetToken;
      state.partial_groups = [];
      await this.checkpoint(runtime);
      this.onEvent({
        phase: 'varina_decomposition_round_start',
        round,
        message: `第 ${round} 轮问题拆解开始`
      });

      const packet = canonical({
        original_user_request: runtime.original_user_request,
        task_framing: runtime.task_framing,
        user_constraints: runtime.hard_constraints,
        project_context: runtime.project_context,
        verified_investigation_context: runtime.code_context,
        baseline_points: runtime.current_board.points
          .filter(point => point.type !== 'subproblem')
          .map(point => ({ id: point.id, type: point.type, text: point.text, failure_condition: point.failure_condition })),
        accepted_subproblems: state.accepted.map(item => item.question),
        decomposition_round: round
      });

      let accepted = [...state.accepted];
      let mergeChain = Promise.resolve();
      let stopAfterRound = false;
      let roundDedupIncomplete = !this.decisionGateway;
      const groupRecords = [];
      const tasks = seats.map(seat => (async () => {
        const response = await this.gateway.invoke({
          phase: 'varina_decomposition_seat',
          modelId: seat.modelId,
          messages: decompositionSeatMessages({ packet, maxSubproblems: settings.maxQuestionsPerSeat }),
          schema: decompositionSeatResponseSchema,
          generation: generationFor(this.config, 'varina_decomposition_seat'),
          context: { round, seat_id: seat.id, packet_token: packetToken },
          logicalId: `${runId}:D${round}:${seat.id}`
        });
        if (state.current_packet_token !== packetToken) throw new Error(`拆解席位 ${seat.id} 返回了过期轮次结果`);
        const candidates = normalizeDecompositionResponse(response, {
          round,
          seatId: seat.id,
          maxQuestions: settings.maxQuestionsPerSeat
        });
        const internal = await deduplicateSubproblemGroup({
          decisionGateway: this.decisionGateway,
          parentProblem: runtime.original_user_request,
          candidates,
          logicalId: `${runId}:D${round}:${seat.id}:internal`
        });
        roundDedupIncomplete ||= internal.incomplete;
        if (internal.errors.length) {
          runtime.degradations.push(`D${round} ${seat.id} 组内判重降级：${String(internal.errors[0]?.message ?? internal.errors[0]).slice(0, 180)}`);
        }
        state.rejected.push(...internal.rejected.map(item => ({
          ...item,
          decomposition_round: round,
          seat_id: seat.id,
          stage: 'within_group'
        })));

        const previousMerge = mergeChain;
        const queuedMerge = previousMerge.then(async () => {
          const arrivalIndex = ++state.arrival_counter;
          const ready = internal.survivors.map(item => ({ ...item, arrival_index: arrivalIndex }));
          const available = Math.max(0, settings.maxAcceptedSubproblems - accepted.length);
          const candidatesWithinBudget = ready.slice(0, available);
          const overflow = ready.slice(available);
          const merged = await mergeSubproblemSets({
            decisionGateway: this.decisionGateway,
            parentProblem: runtime.original_user_request,
            left: accepted,
            right: candidatesWithinBudget,
            logicalId: `${runId}:D${round}:arrival-${arrivalIndex}`
          });
          accepted = merged.items;
          roundDedupIncomplete ||= merged.incomplete;
          if (merged.error) {
            runtime.degradations.push(`D${round} ${seat.id} 组间判重降级：${String(merged.error.message ?? merged.error).slice(0, 180)}`);
          }
          state.rejected.push(...merged.rejected.map(item => ({
            ...item,
            decomposition_round: round,
            seat_id: seat.id,
            arrival_index: arrivalIndex,
            stage: 'between_groups'
          })));
          state.rejected.push(...overflow.map(item => ({
            candidate_id: item.candidate_id,
            question: item.question,
            decomposition_round: round,
            seat_id: seat.id,
            arrival_index: arrivalIndex,
            stage: 'question_limit',
            method: 'limit'
          })));
          const record = {
            seat_id: seat.id,
            model_id: seat.modelId,
            arrival_index: arrivalIndex,
            raw_count: candidates.length,
            internal_survivor_count: internal.survivors.length,
            global_survivor_count: merged.survivors.length,
            fully_redundant: candidates.length === 0 || merged.survivors.length === 0,
            questions: candidates.map(item => item.question),
            surviving_candidate_ids: merged.survivors.map(item => item.candidate_id)
          };
          groupRecords.push(record);
          state.partial_groups.push(record);
          if (record.fully_redundant) stopAfterRound = true;
          if (overflow.length || accepted.length >= settings.maxAcceptedSubproblems) stopAfterRound = true;
          await this.checkpoint(runtime);
          this.onEvent({
            phase: 'varina_decomposition_group_done',
            round,
            seat_id: seat.id,
            message: `席位 ${seat.id} 保留 ${record.global_survivor_count}/${record.raw_count} 个子问题`
          });
          return record;
        });
        mergeChain = queuedMerge.catch(() => {});
        return queuedMerge;
      })());

      const settled = await Promise.allSettled(tasks);
      await mergeChain;
      let failedSeats = 0;
      settled.forEach((item, index) => {
        if (item.status === 'rejected') {
          failedSeats++;
          runtime.degradations.push(`D${round} ${seats[index].id} 拆解失败：${String(item.reason?.message ?? item.reason).slice(0, 180)}`);
        }
      });
      if (failedSeats) roundDedupIncomplete = true;
      state.accepted = accepted;
      state.dedup_incomplete ||= roundDedupIncomplete;
      state.round_records.push({
        round_index: round,
        packet_token: packetToken,
        successful_seats: seats.length - failedSeats,
        failed_seats: failedSeats,
        groups: [...groupRecords].sort((a, b) => a.arrival_index - b.arrival_index),
        accepted_total: accepted.length,
        stop_after_round: stopAfterRound,
        dedup_incomplete: roundDedupIncomplete
      });
      delete state.partial_groups;
      delete state.current_packet_token;
      await this.checkpoint(runtime);
      this.onEvent({
        phase: 'varina_decomposition_round_complete',
        round,
        message: `第 ${round} 轮拆解后保留 ${accepted.length} 个子问题`
      });

      if (roundDedupIncomplete) {
        state.stop_reason = 'dedup_incomplete';
        break;
      }
      if (stopAfterRound) {
        state.stop_reason = accepted.length >= settings.maxAcceptedSubproblems ? 'question_limit' : 'redundant_seat';
        break;
      }
      if (round === settings.maxRounds) state.stop_reason = 'max_rounds';
    }

    state.added_point_ids = appendSubproblemsToBoard(runtime, state.accepted).map(point => point.id);
    state.status = 'complete';
    state.stop_reason ??= 'max_rounds';
    await this.checkpoint(runtime);
    this.onEvent({
      phase: 'varina_decomposition_complete',
      round: state.current_round,
      message: `问题拆解完成，观点板新增 ${state.added_point_ids.length} 个子问题`
    });
  }

  async divergeRound({ runtime, runId, loadedFiles, rng, seats, focus = '' }) {
    const round = runtime.round_records.length + 1;
    if (round > runtime.max_rounds) throw new Error('发散轮次已达到上限');
    runtime.current_round = round;
    await refreshWorkingFiles(this.host, loadedFiles, runtime.fact_ledger, runtime.degradations, this.signal);
    runtime.repository_snapshot_id = snapshotId(loadedFiles);
    const before = structuredClone(runtime.current_board);
    this.onEvent({ phase: 'varina_round_start', round, message: `第 ${round} 轮推演开始` });
    const packetMaterial = canonical({
      run_id: runId,
      round,
      board_version: runtime.current_board.version,
      repository_snapshot_id: runtime.repository_snapshot_id,
      original_user_request: runtime.original_user_request,
      task_framing: runtime.task_framing,
      project_context: runtime.project_context,
      user_constraints: runtime.hard_constraints,
      verified_context: runtime.code_context,
      agent_hypotheses: runtime.agent_hypotheses,
      facts: activeFacts(runtime.fact_ledger),
      board: runtime.current_board
    });
    const packetToken = digest(packetMaterial);
    runtime.current_packet_token = packetToken;
    const commonPrefix = buildCommonPrefix(runtime, runtime.repository_snapshot_id, packetToken, focus);
    runtime.common_prefix = commonPrefix;
    try { runtime.frozen_packet = JSON.parse(commonPrefix); } catch { runtime.frozen_packet = null; }
    const assignments = seats.map(seat => ({ seat, operators: sampleOperators(rng, operators) }));
    runtime.current_assignments = assignments.map(a => ({
      seat_id: a.seat.id,
      modelId: a.seat.modelId,
      operators: a.operators.map(op => ({
        id: op.operator_id,
        name: op.name,
        prompt: op.prompt
      }))
    }));
    runtime.partial_seat_responses = [];
    await this.checkpoint(runtime);
    this.onEvent({ phase: 'varina_seats', round, message: `${seats.length} 个席位正在从同一冻结包发散` });
    const settled = await Promise.allSettled(assignments.map(({ seat, operators: cards }) => this.gateway.invoke({
      phase: 'varina_seat', modelId: seat.modelId,
      messages: seatMessages({ commonPrefix, seatId: seat.id, operators: cards }),
      schema: seatResponseSchema, generation: generationFor(this.config, 'varina_seat'),
      context: { round, seat_id: seat.id, packet_token: packetToken },
      logicalId: `${runId}:R${round}:${seat.id}`,
      validator: response => {
        normalizeSeatResponse(response);
        checkSeat(response, { seatId: seat.id, packetToken });
        return response;
      }
    }).then(async response => {
      normalizeSeatResponse(response);
      checkSeat(response, { seatId: seat.id, packetToken });
      if (!runtime.partial_seat_responses) runtime.partial_seat_responses = [];
      runtime.partial_seat_responses.push(response);
      await this.checkpoint(runtime).catch(() => {});
      this.onEvent({ phase: 'varina_seat_done', round, seat_id: seat.id, message: `席位 ${seat.id} 完成思考` });
      return response;
    })));
    const responses = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
    settled.forEach((item, index) => {
      if (item.status === 'rejected') runtime.degradations.push(`R${round} ${seats[index].id} 失败：${String(item.reason?.message ?? item.reason).slice(0, 180)}`);
    });
    if (responses.length < Math.ceil(seats.length / 2)) throw new Error(`R${round} 成功席位不足：${responses.length}/${seats.length}`);
    runtime.seat_responses.push({ round, packet_token: packetToken, responses: structuredClone(responses) });
    delete runtime.partial_seat_responses;
    delete runtime.current_assignments;
    await this.checkpoint(runtime);
    const candidates = candidatesFromResponses(round, responses);
    const verificationRequests = requestsFromResponses(round, responses);

    this.onEvent({ phase: 'varina_dedup', round, message: `归一化 ${candidates.length} 条原子候选` });
    const dedup = await deduplicateIdeas({
      decisionGateway: this.decisionGateway, parentProblem: runtime.original_user_request,
      candidates, board: structuredClone(runtime.current_board), logicalId: `${runId}:R${round}:dedup`, signal: this.signal
    });
    const operations = dedup.operations;
    const degradation = dedup.errors.length ? `R${round} Jev 判重 ${dedup.errors.length} 项失败；仅保留对应候选` : undefined;
    if (degradation) runtime.degradations.push(degradation);
    runtime.idea_dedup_records ??= [];
    runtime.idea_dedup_records.push({ round, candidates: structuredClone(candidates), ...dedup });
    validateOperations(operations, candidates, runtime.current_board, new Set(runtime.fact_ledger.flatMap(fact => [fact.fact_id, fact.fact_ref])));
    const applied = applyOperations(runtime, round, operations, candidates);

    const linkedRequests = verificationRequests.map(request => ({
      ...request,
      affected_point_ids: [...new Set(request.affected_candidate_ids.map(id => applied.candidateToPoint.get(id)).filter(Boolean))],
      status: 'pending'
    })).filter(request => request.affected_point_ids.length);
    runtime.verification_requests.push(...linkedRequests);
    runtime.applied_idempotency_keys.push(digest({ runId, round, packetToken }));
    runtime.round_records.push({
      round_index: round,
      allocated_operators: Object.fromEntries(assignments.map(item => [item.seat.id, item.operators.map(operator => operator.operator_id)])),
      new_points_added: applied.add, points_merged: applied.merge, points_dropped: applied.drop,
      claims_verified: 0, unresolved_blocking_claims: linkedRequests.length,
      packet_token: packetToken, degradation
    });
    const oldPoints = new Map(before.points.map(point => [point.id, point]));
    const added = runtime.current_board.points.filter(point => !oldPoints.has(point.id));
    const modified = runtime.current_board.points.filter(point => oldPoints.has(point.id) && JSON.stringify(point) !== JSON.stringify(oldPoints.get(point.id)));
    for (const point of [...added, ...modified]) point.verification_status = 'unknown';
    // History and the tool result contain the same post-commit board values.
    runtime.board_history[runtime.board_history.length - 1] = structuredClone(runtime.current_board);
    await this.checkpoint(runtime);
    this.onEvent({ phase: 'varina_round_complete', round, message: `新增 ${applied.add}，合并 ${applied.merge}，丢弃 ${applied.drop}` });
    return {
      round, board_version: runtime.current_board.version,
      added_items: structuredClone(added), modified_items: structuredClone(modified),
      dropped_candidates: operations.filter(operation => operation.action === 'DROP'),
      verification_requests: linkedRequests, remaining_rounds: runtime.max_rounds - round,
      fact_updates: runtime.fact_ledger.filter(fact => fact.status === 'stale'),
      degradation: degradation ?? null
    };
  }

  async run({
    sessionId,
    problem,
    originalRequest = problem,
    taskFraming = problem,
    constraints = [],
    agentHypotheses = [],
    codeContext = '',
    projectContext = '',
    relevantFiles = [],
    initialBoard = null,
    baselineSolutions = [],
    seed = Date.now(),
    runId = `varina-${Date.now()}-${randomUUID().slice(0, 6)}`
  }) {
    const seededBoard = initialBoard
      ? structuredClone(initialBoard)
      : { version: 0, points: [] };
    if (!Number.isInteger(seededBoard.version) || seededBoard.version < 0 || !Array.isArray(seededBoard.points)) {
      throw new Error('initialBoard 无效');
    }
    const seededIds = new Set();
    for (const point of seededBoard.points) {
      if (!/^P\d+$/.test(point.id) || Number(point.id.slice(1)) < 1 || seededIds.has(point.id)) throw new Error('initialBoard Point ID 无效或重复');
      if (!point.text?.trim() || !point.type || !point.status) throw new Error('initialBoard Point 字段不完整');
      seededIds.add(point.id);
    }
    const runtime = {
      run_id: runId, session_id: sessionId, problem,
      original_user_request: originalRequest,
      task_framing: taskFraming,
      project_context: projectContext,
      hard_constraints: constraints,
      agent_hypotheses: agentHypotheses,
      code_context: codeContext,
      status: 'active', repository_snapshot_id: '', current_round: 0, max_rounds: this.config.exploration?.rounds ?? 5,
      verification_requests: [], board_changes: [], board_history: [structuredClone(seededBoard)],
      current_board: seededBoard, baseline_point_ids: [...seededIds], baseline_solutions: structuredClone(baselineSolutions),
      fact_ledger: [], working_memory_files: [],
      round_records: [], seat_responses: [], current_packet_token: '', applied_idempotency_keys: [],
      rejected_directions: [], degradations: []
    };
    await this.checkpoint(runtime);
    this.onEvent({
      phase: 'varina_start',
      round: 1,
      run_id: runId,
      problem: problem.trim(),
      message: 'Varina 深度多视角探索已开启'
    });
    const loadedFiles = await loadInitialFiles(this.host, relevantFiles, runtime.degradations);
    runtime.repository_snapshot_id = snapshotId(loadedFiles);
    runtime.working_memory_files = loadedFiles.map(file => ({
      file_path: file.filePath,
      loaded_at_round: 0,
      token_count: Math.ceil(file.content.length / 4),
      content_hash: file.contentHash,
      snapshot_id: runtime.repository_snapshot_id
    }));
    const rng = random(Number(seed) >>> 0);
    const seats = this.config.seats.slice(0, 8);
    let stopReason = 'fixed_round_limit';
    let solutions = [];
    let unresolvedQuestions = [];
    try {
      if (!problem?.trim()) throw new Error('ExploreDesign problem 不能为空');
      if (!seats.length) throw new Error('Varina 至少需要一个创意席位');
      await this.runDecomposition({ runtime, runId, loadedFiles });
      await this.runSubproblemExpansion({ runtime, runId });
      const react = new ExplorationReact({
        runtime, host: this.host, gateway: this.gateway, config: this.config,
        signal: this.signal, checkpoint: this.checkpoint, onEvent: this.onEvent,
        validateAssembly,
        diverge: args => this.divergeRound({ runtime, runId, loadedFiles, rng, seats, focus: args.focus ?? '' }),
        refreshSources: async filePath => {
          if (!loadedFiles.some(file => file.filePath === filePath)) loadedFiles.push(await this.host.readFile(filePath, { signal: this.signal }));
          await refreshWorkingFiles(this.host, loadedFiles, runtime.fact_ledger, runtime.degradations, this.signal);
          runtime.repository_snapshot_id = snapshotId(loadedFiles);
          runtime.working_memory_files = loadedFiles.map(file => ({ file_path: file.filePath, content_hash: file.contentHash, snapshot_id: runtime.repository_snapshot_id }));
        }
      });
      const final = await react.run();
      solutions = final.solutions;
      unresolvedQuestions = final.unresolved_questions;
      runtime.final_text = final.final_text;
      stopReason = 'required_rounds_complete';
      runtime.status = 'complete';
    } catch (error) {
      runtime.status = this.signal?.aborted ? 'cancelled' : 'failed';
      stopReason = this.signal?.aborted ? 'user_cancelled' : error.code ?? 'provider_failure';
      if (runtime.react) runtime.react.status = runtime.status;
      runtime.degradations.push(String(error.message).slice(0, 500));
    }
    const unresolvedClaims = runtime.verification_requests.filter(request => ['pending', 'unknown', 'stale'].includes(request.status));
    unresolvedQuestions = [...new Set([...unresolvedQuestions, ...unresolvedClaims.map(request => request.claim),
      ...runtime.fact_ledger.filter(fact => ['unknown', 'stale'].includes(fact.status)).map(fact => fact.claim)])];
    if (runtime.final_text && unresolvedQuestions.length) runtime.final_text += `\n\n尚未解决的依赖：\n${unresolvedQuestions.map(question => `- ${question}`).join('\n')}`;
    const handoff = {
      run_id: runId, terminal: true, state: runtime.status,
      final_text: runtime.final_text ?? null,
      react: runtime.react ?? null,
      board_changes: runtime.board_changes,
      verification_requests: runtime.verification_requests,
      idea_dedup_records: runtime.idea_dedup_records ?? [],
      max_rounds: runtime.max_rounds,
      stop_reason: stopReason, rounds_executed: runtime.round_records.length,
      meeting_board: runtime.current_board, fact_ledger: runtime.fact_ledger,
      rejected_directions: runtime.rejected_directions, solutions,
      unresolved_questions: unresolvedQuestions, degradations: runtime.degradations,
      decomposition: runtime.decomposition ?? null,
      subproblem_expansion: runtime.subproblem_expansion ?? null,
      round_records: runtime.round_records, seat_responses: runtime.seat_responses,
      board_history: runtime.board_history,
      baseline_point_ids: runtime.baseline_point_ids,
      baseline_solutions: runtime.baseline_solutions,
      repository_snapshot_id: runtime.repository_snapshot_id,
      loaded_files_manifest: loadedFiles.map(file => ({ file_path: file.filePath, content_hash: file.contentHash, loaded_at: new Date().toISOString(), snapshot_id: runtime.repository_snapshot_id })),
      original_user_request: originalRequest,
      task_framing: taskFraming,
      project_context: projectContext,
      user_constraints: constraints,
      agent_hypotheses: agentHypotheses,
      code_context: codeContext,
      common_prefix: runtime.common_prefix ?? null,
      frozen_packet: runtime.frozen_packet ?? null
    };
    await this.checkpoint({ ...runtime, handoff });
    return handoff;
  }
}
