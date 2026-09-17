import { createHash, randomUUID } from 'node:crypto';
import { operators, random, sampleOperators } from '../operators.mjs';
import { generationFor } from '../agent/model_gateway.mjs';
import { assemblySchema, dedupSchema, groundingSchema, seatResponseSchema } from '../agent/schemas.mjs';
import {
  ASSEMBLY_SYSTEM_PROMPT, DEDUP_SYSTEM_PROMPT, GROUNDER_SYSTEM_PROMPT, seatMessages
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
  return facts.filter(fact => !['unknown', 'stale'].includes(fact.status)).map(fact => ({
    fact_id: fact.fact_id,
    fact_ref: fact.fact_ref,
    status: fact.status,
    semantic_summary: fact.semantic_summary,
    correction: fact.correction ?? null
  }));
}

function buildCommonPrefix(runtime, repositorySnapshotId, packetToken) {
  return JSON.stringify(canonical({
    frozen_shared_input_packet: {
      problem: runtime.problem,
      constraints: runtime.hard_constraints,
      investigation_context: runtime.code_context,
      verified_facts: activeFacts(runtime.fact_ledger),
      current_board: runtime.current_board,
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

function validateGrounding(grounding, requests) {
  const expected = new Map(requests.map(request => [request.fact_ref, request]));
  const seen = new Set();
  for (const fact of grounding.facts) {
    const request = expected.get(fact.fact_ref);
    if (!request || seen.has(fact.fact_ref)) throw new Error(`Grounder fact_ref 未知或重复：${fact.fact_ref}`);
    seen.add(fact.fact_ref);
    if (fact.claim !== request.claim) throw new Error(`Grounder 改写了待核验 claim：${fact.fact_ref}`);
    if (fact.affected_candidate_ids.some(id => !request.affected_candidate_ids.includes(id))) throw new Error(`Grounder 引用了无关候选：${fact.fact_ref}`);
    if (['contradicted', 'partially_true'].includes(fact.status) && !fact.correction?.trim()) throw new Error(`${fact.status} 必须提供 correction`);
    if (['confirmed', 'contradicted', 'partially_true'].includes(fact.status) && (fact.evidence_strength === 'unverified' || fact.evidence.length === 0)) throw new Error(`${fact.status} 必须提供可核验证据`);
  }
  if (seen.size !== expected.size) throw new Error('Grounder 未逐条覆盖全部核验请求');
  for (const request of grounding.load_requests) if (!expected.has(request.claim_ref)) throw new Error(`load_request 引用了未知 claim_ref：${request.claim_ref}`);
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

async function verifyEvidence(host, facts, repositorySnapshotId, degradations) {
  const verified = [];
  for (const draft of facts) {
    const fact = structuredClone(draft);
    if (['confirmed', 'contradicted', 'partially_true'].includes(fact.status)) {
      if (fact.evidence_strength === 'unverified' || fact.evidence.length === 0) {
        fact.status = 'unknown';
        fact.evidence_strength = 'unverified';
        fact.evidence = [];
        degradations.push(`证据不足，${fact.fact_ref} 已降级为 unknown`);
      } else {
        let stale = false;
        let invalid = false;
        for (const evidence of fact.evidence) {
          try {
            if (!Array.isArray(evidence.lineRange) || evidence.lineRange.length !== 2 || evidence.lineRange[0] < 1 || evidence.lineRange[1] < evidence.lineRange[0]) throw new Error('行范围无效');
            const current = await host.readFile(evidence.filePath, { startLine: evidence.lineRange[0], endLine: evidence.lineRange[1] });
            if (current.contentHash !== evidence.content_hash) { stale = true; break; }
            const normalizedSnippet = evidence.snippet.replace(/\r\n?/g, '\n').trim();
            if (!normalizedSnippet || !current.content.includes(normalizedSnippet)) throw new Error('snippet 与行范围不匹配');
          } catch (error) {
            if (error.code === 'ENOENT') stale = true;
            else invalid = true;
            break;
          }
        }
        if (stale || invalid) {
          fact.status = stale ? 'stale' : 'unknown';
          fact.evidence_strength = 'unverified';
          degradations.push(`${fact.fact_ref} 的证据${stale ? '已陈旧' : '未通过路径/行号/snippet 验真'}`);
        }
      }
    }
    verified.push({ ...fact, source_snapshot_id: repositorySnapshotId });
  }
  return verified;
}

function fallbackOperations(candidates) {
  return candidates.map(candidate => ({
    action: 'ADD', candidate_ids: [candidate.candidate_id], target_point_id: null,
    text: candidate.text, failure_condition: candidate.failure_condition, type: candidate.type,
    reason: null, duplicate_of: null, evidence_refs: []
  }));
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
      if (!operation.text?.trim() || !operation.failure_condition?.trim() || !operation.type) throw new Error('MERGE 缺少完整观点字段');
      if (target.text === operation.text && target.failure_condition === operation.failure_condition) throw new Error('MERGE 未产生实质变化');
    } else {
      if (!operation.reason?.trim()) throw new Error('DROP 缺少理由');
      if (operation.duplicate_of && !board.points.some(point => point.id === operation.duplicate_of)) throw new Error('DROP duplicate_of 引用了不存在的 Point');
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
  const active = new Set(board.points.filter(point => point.status === 'active').map(point => point.id));
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
  for (const filePath of [...new Set(relevantFiles ?? [])].slice(0, 4)) {
    try { loaded.push(await host.readFile(filePath)); }
    catch (error) { degradations.push(`无法加载 ${filePath}：${String(error.message).slice(0, 180)}`); }
  }
  return loaded;
}

async function fulfillLoadRequests(host, requests, loaded, degradations, signal) {
  const known = new Set(loaded.map(file => file.filePath));
  const paths = [];
  for (const request of requests.filter(item => item.blocking)) {
    paths.push(...request.candidate_paths);
    for (const hint of request.search_hints.slice(0, 2)) {
      try { paths.push(...(await host.grep(hint, { maxResults: 8, signal })).map(match => match.file)); }
      catch (error) { degradations.push(`load_request 检索失败：${String(error.message).slice(0, 180)}`); }
    }
  }
  for (const filePath of [...new Set(paths)].slice(0, 12)) {
    if (known.has(filePath)) continue;
    try { const file = await host.readFile(filePath, { signal }); loaded.push(file); known.add(file.filePath); }
    catch (error) { degradations.push(`load_request 无法读取 ${filePath}：${String(error.message).slice(0, 180)}`); }
  }
}

export class ExploreDesignEngine {
  constructor({ host, gateway, config, signal, onEvent = () => {}, checkpoint = async () => {} }) {
    this.host = host;
    this.gateway = gateway;
    this.config = config;
    this.signal = signal;
    this.onEvent = onEvent;
    this.checkpoint = checkpoint;
  }

  async run({ sessionId, problem, constraints = [], codeContext = '', relevantFiles = [], seed = Date.now(), runId = `aha-${Date.now()}-${randomUUID().slice(0, 6)}` }) {
    const runtime = {
      run_id: runId, session_id: sessionId, problem, hard_constraints: constraints, code_context: codeContext,
      status: 'active', repository_snapshot_id: '', current_round: 0, max_rounds: 5,
      consecutive_no_change_rounds: 0, board_history: [{ version: 0, points: [] }],
      current_board: { version: 0, points: [] }, fact_ledger: [], working_memory_files: [],
      round_records: [], seat_responses: [], current_packet_token: '', applied_idempotency_keys: [],
      rejected_directions: [], degradations: []
    };
    const loadedFiles = await loadInitialFiles(this.host, relevantFiles, runtime.degradations);
    const rng = random(Number(seed) >>> 0);
    const seats = this.config.seats.slice(0, 8);
    let stopReason = 'fixed_round_limit';
    let solutions = [];
    let unresolvedQuestions = [];
    try {
      if (!problem?.trim()) throw new Error('ExploreDesign problem 不能为空');
      if (!seats.length) throw new Error('Aha 至少需要一个创意席位');
      for (let round = 1; round <= runtime.max_rounds; round++) {
        this.signal?.throwIfAborted();
        runtime.current_round = round;
        await refreshWorkingFiles(this.host, loadedFiles, runtime.fact_ledger, runtime.degradations, this.signal);
        runtime.repository_snapshot_id = snapshotId(loadedFiles);
        runtime.working_memory_files = loadedFiles.map(file => ({ file_path: file.filePath, loaded_at_round: round, token_count: Math.ceil(file.content.length / 4), content_hash: file.contentHash, snapshot_id: runtime.repository_snapshot_id }));
        const packetMaterial = canonical({ run_id: runId, round, board_version: runtime.current_board.version, repository_snapshot_id: runtime.repository_snapshot_id, problem, constraints, code_context: codeContext, facts: activeFacts(runtime.fact_ledger), board: runtime.current_board });
        const packetToken = digest(packetMaterial);
        runtime.current_packet_token = packetToken;
        const commonPrefix = buildCommonPrefix(runtime, runtime.repository_snapshot_id, packetToken);
        const assignments = seats.map(seat => ({ seat, operators: sampleOperators(rng, operators) }));
        this.onEvent({ phase: 'aha_seats', round, message: `${seats.length} 个席位正在从同一冻结包发散` });
        const settled = await Promise.allSettled(assignments.map(({ seat, operators: cards }) => this.gateway.invoke({
          phase: 'aha_seat', modelId: seat.modelId,
          messages: seatMessages({ commonPrefix, seatId: seat.id, operators: cards }),
          schema: seatResponseSchema, generation: generationFor(this.config, 'aha_seat'),
          context: { round, seat_id: seat.id, packet_token: packetToken },
          logicalId: `${runId}:R${round}:${seat.id}`,
          validator: response => {
            normalizeSeatResponse(response);
            checkSeat(response, { seatId: seat.id, packetToken });
            return response;
          }
        }).then(response => {
          normalizeSeatResponse(response);
          checkSeat(response, { seatId: seat.id, packetToken });
          return response;
        })));
        const responses = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
        settled.forEach((item, index) => {
          if (item.status === 'rejected') runtime.degradations.push(`R${round} ${seats[index].id} 失败：${String(item.reason?.message ?? item.reason).slice(0, 180)}`);
        });
        if (responses.length < Math.ceil(seats.length / 2)) throw new Error(`R${round} 成功席位不足：${responses.length}/${seats.length}`);
        runtime.seat_responses.push({ round, packet_token: packetToken, responses: structuredClone(responses) });
        const candidates = candidatesFromResponses(round, responses);
        const verificationRequests = requestsFromResponses(round, responses);

        let grounding = { facts: [], load_requests: [] };
        if (verificationRequests.length) {
          const invokeGrounder = () => this.gateway.invoke({
            phase: 'aha_grounder', modelId: this.config.roles.grounder ?? this.config.roles.dedup,
            messages: [
              { role: 'system', content: GROUNDER_SYSTEM_PROMPT },
              { role: 'user', content: `Loaded context:\n${renderLoadedFiles(loadedFiles)}\n\nClaims:\n${JSON.stringify(verificationRequests)}` }
            ],
            schema: groundingSchema, generation: generationFor(this.config, 'aha_grounder'),
            context: { round, requests: verificationRequests }, logicalId: `${runId}:R${round}:grounder`,
            validator: grounding => validateGrounding(grounding, verificationRequests)
          });
          this.onEvent({ phase: 'aha_grounding', round, message: `核验 ${verificationRequests.length} 条实现假设` });
          grounding = await invokeGrounder();
          validateGrounding(grounding, verificationRequests);
          if (grounding.load_requests.some(request => request.blocking)) {
            const before = loadedFiles.length;
            await fulfillLoadRequests(this.host, grounding.load_requests, loadedFiles, runtime.degradations, this.signal);
            if (loadedFiles.length > before) {
              runtime.repository_snapshot_id = snapshotId(loadedFiles);
              grounding = await invokeGrounder();
              validateGrounding(grounding, verificationRequests);
            }
          }
          grounding.facts = await verifyEvidence(this.host, grounding.facts, runtime.repository_snapshot_id, runtime.degradations);
        }
        const factStart = runtime.fact_ledger.length + 1;
        const roundFacts = grounding.facts.map((fact, index) => ({
          ...fact, fact_id: `F${String(factStart + index).padStart(3, '0')}`,
          round_introduced: round, affected_point_ids: []
        }));

        this.onEvent({ phase: 'aha_dedup', round, message: `归一化 ${candidates.length} 条原子候选` });
        let operations;
        let degradation;
        if (!candidates.length) operations = [];
        else {
          try {
            const result = await this.gateway.invoke({
              phase: 'aha_dedup', modelId: this.config.roles.dedup,
              messages: [
                { role: 'system', content: DEDUP_SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify({ board: runtime.current_board, facts: roundFacts, candidates }) }
              ], schema: dedupSchema, generation: generationFor(this.config, 'aha_dedup'),
              context: { round, board: runtime.current_board, facts: roundFacts, candidates }, logicalId: `${runId}:R${round}:dedup`
            });
            validateOperations(result.operations, candidates, runtime.current_board, new Set(roundFacts.flatMap(fact => [fact.fact_id, fact.fact_ref])));
            operations = result.operations;
          } catch (error) {
            degradation = `R${round} dedup 降级：${String(error.message).slice(0, 220)}`;
            runtime.degradations.push(degradation);
            operations = fallbackOperations(candidates);
          }
        }
        const applied = applyOperations(runtime, round, operations, candidates);
        for (const fact of roundFacts) {
          fact.affected_point_ids = [...new Set((fact.affected_candidate_ids ?? []).map(id => applied.candidateToPoint.get(id)).filter(Boolean))];
          delete fact.affected_candidate_ids;
        }
        runtime.fact_ledger.push(...roundFacts);
        const unresolvedBlocking = grounding.load_requests.filter(request => request.blocking).length + roundFacts.filter(fact => fact.status === 'unknown').length;
        runtime.consecutive_no_change_rounds = applied.add === 0 && applied.merge === 0 && unresolvedBlocking === 0 ? runtime.consecutive_no_change_rounds + 1 : 0;
        const idempotencyKey = digest({ runId, round, packetToken });
        runtime.applied_idempotency_keys.push(idempotencyKey);
        runtime.round_records.push({
          round_index: round,
          allocated_operators: Object.fromEntries(assignments.map(item => [item.seat.id, item.operators.map(operator => operator.operator_id)])),
          new_points_added: applied.add, points_merged: applied.merge, points_dropped: applied.drop,
          claims_verified: roundFacts.filter(fact => !['unknown', 'stale'].includes(fact.status)).length,
          unresolved_blocking_claims: unresolvedBlocking, packet_token: packetToken, degradation
        });
        await this.checkpoint(runtime);
        this.onEvent({ phase: 'aha_round_complete', round, message: `新增 ${applied.add}，合并 ${applied.merge}，丢弃 ${applied.drop}` });
        if (runtime.consecutive_no_change_rounds >= 2) { stopReason = 'early_convergence'; break; }
      }

      this.onEvent({ phase: 'aha_assembly', round: runtime.current_round, message: '从观点板生成正交机制装配索引' });
      try {
        const assembly = await this.gateway.invoke({
          phase: 'aha_assembly', modelId: this.config.roles.assembly ?? this.config.roles.chair,
          messages: [
            { role: 'system', content: ASSEMBLY_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ board: runtime.current_board, fact_ledger: runtime.fact_ledger, rejected_directions: runtime.rejected_directions }) }
          ], schema: assemblySchema, generation: generationFor(this.config, 'aha_assembly'),
          context: { board: runtime.current_board, fact_ledger: runtime.fact_ledger }, logicalId: `${runId}:assembly`,
          validator: res => validateAssembly(res, runtime.current_board)
        });
        validateAssembly(assembly, runtime.current_board);
        solutions = assembly.solutions;
        unresolvedQuestions = assembly.unresolved_questions;
      } catch (error) {
        runtime.degradations.push(`机制装配失败：${String(error.message).slice(0, 220)}`);
      }
      runtime.status = 'complete';
    } catch (error) {
      runtime.status = this.signal?.aborted ? 'cancelled' : 'failed';
      stopReason = this.signal?.aborted ? 'user_cancelled' : 'provider_failure';
      runtime.degradations.push(String(error.message).slice(0, 500));
    }
    const handoff = {
      run_id: runId, terminal: true, state: runtime.status,
      stop_reason: stopReason, rounds_executed: runtime.round_records.length,
      meeting_board: runtime.current_board, fact_ledger: runtime.fact_ledger,
      rejected_directions: runtime.rejected_directions, solutions,
      unresolved_questions: unresolvedQuestions, degradations: runtime.degradations,
      round_records: runtime.round_records, seat_responses: runtime.seat_responses,
      board_history: runtime.board_history,
      repository_snapshot_id: runtime.repository_snapshot_id,
      loaded_files_manifest: loadedFiles.map(file => ({ file_path: file.filePath, content_hash: file.contentHash, loaded_at: new Date().toISOString(), snapshot_id: runtime.repository_snapshot_id })),
      code_context: codeContext
    };
    await this.checkpoint({ ...runtime, handoff });
    return handoff;
  }
}
