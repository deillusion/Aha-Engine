import { validateRanking } from './schema.mjs';

// Each ID identifies an immutable, complete version. Concurrent revisions of
// one parent get separate IDs; no writer can replace another seat's proposal.
export function materializeProposals(items, round, seatId, phase) {
  return items.map((p, index) => ({
    ...structuredClone(p),
    // Normalize here, not at render time: an unset change_summary must never reach proposalText as "undefined".
    change_summary: typeof p.change_summary === 'string' ? p.change_summary : '',
    proposal_id: `S-R${round}-${seatId}-${String(index + 1).padStart(2, '0')}`,
    round, seat_id: seatId, phase
  }));
}

export function proposalContext(proposals) {
  // Author identity, support counts and bulky text bodies are omitted from shared inputs
  // to avoid attention sinks and multi-stage chimera contagion across rounds.
  return proposals.map(({ proposal_id, title, mechanisms, parent_proposal_ids, change_summary, point_refs }) => ({
    proposal_id, title, mechanisms: Array.isArray(mechanisms) ? mechanisms : [], parent_proposal_ids, change_summary, point_refs
  }));
}

export function rankedResult(result, proposals) {
  validateRanking(result, proposals);
  const byId = new Map(proposals.map(p => [p.proposal_id, p]));
  const seen = new Set();
  const validRanked = [];
  for (const r of (result.rankings || [])) {
    if (byId.has(r.proposal_id) && !seen.has(r.proposal_id)) {
      seen.add(r.proposal_id);
      validRanked.push({
        proposal_id: r.proposal_id,
        summary: String(r.summary ?? '').trim() || (byId.get(r.proposal_id)?.title ? `【核心机制】${byId.get(r.proposal_id).title}` : '无一句话概括'),
        reason: String(r.reason ?? '').trim() || 'Chair 未提供理由'
      });
    }
  }
  const unranked = proposals.filter(p => !seen.has(p.proposal_id)).map(p => ({
    proposal_id: p.proposal_id,
    summary: p.title ? `【未排序】${p.title.replace(/[\r\n]+/g, ' ')}` : '无一句话概括（未被Chair排序覆盖）',
    reason: 'Chair 排序未覆盖此方案（原方案正文完整保留）',
    rank: null,
    unranked: true
  }));
  const ranked = validRanked.map((r, index) => ({ ...r, rank: index + 1, unranked: false }));
  const rankings = ranked.length <= 10
    ? [...ranked, ...unranked]
    : [...ranked.slice(0, 10), ...unranked, ...ranked.slice(10)];
  return {
    kind: 'ranking',
    rankings,
    unranked_count: unranked.length,
    chair_rankings: validRanked.map(r => ({ proposal_id: r.proposal_id, summary: r.summary, reason: r.reason }))
  };
}
