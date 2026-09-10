import { validateRanking } from './schema.mjs';

// Each ID identifies an immutable, complete version. Concurrent revisions of
// one parent get separate IDs; no writer can replace another seat's proposal.
export function materializeProposals(items, round, seatId, phase) {
  return items.map((p, index) => ({
    ...structuredClone(p),
    proposal_id: `S-R${round}-${seatId}-${String(index + 1).padStart(2, '0')}`,
    round, seat_id: seatId, phase
  }));
}

export function proposalContext(proposals) {
  // Author identity and support counts are omitted from shared model inputs.
  return proposals.map(({ proposal_id, title, text, parent_proposal_ids, change_summary, point_refs }) => ({
    proposal_id, title, text, parent_proposal_ids, change_summary, point_refs
  }));
}

export function proposalText(p) {
  return `## ${p.title.replace(/[\r\n]+/g, ' ')}\n\n方案 ID：${p.proposal_id}\n\n来源方案：${p.parent_proposal_ids.join('、') || '新方案'}\n\n变更说明：${p.change_summary}\n\n${p.text}`;
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
