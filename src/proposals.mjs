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

export function proposalText(p) {
  const title = String(p.title ?? '').replace(/[\r\n]+/g, ' ');
  const mechs = Array.isArray(p.mechanisms) && p.mechanisms.length ? `\n\n采用机制：${p.mechanisms.join(' + ')}` : '';
  return `## ${title}\n\n方案 ID：${p.proposal_id}${mechs}\n\n来源方案：${p.parent_proposal_ids.join('、') || '新方案'}\n\n变更说明：${p.change_summary ?? ''}\n\n${p.text}`;
}

export function rankedFinal(result, proposals) {
  validateRanking(result, proposals);
  const byId = new Map(proposals.map(p => [p.proposal_id, p]));
  const rankings = result.rankings.map((r, index) => ({ ...r, rank: index + 1 }));
  // Text is assembled locally from the stored originals, never authored by Chair.
  const text = '# 候选方案排序\n\n所有候选方案及其修订版本均保留。名次仅为模型排序，最终选择由你决定。\n\n' + rankings.map(r => {
    const p = byId.get(r.proposal_id);
    return `# 第 ${r.rank} 名 · ${p.title.replace(/[\r\n]+/g, ' ')}\n\n排序理由：${r.reason}\n\n${proposalText(p)}`;
  }).join('\n\n---\n\n');
  return { kind: 'ranking', rankings, text };
}
