import { rankedResult } from '../proposals.mjs';

export function proposalText(p) {
  const title = String(p.title ?? '').replace(/[\r\n]+/g, ' ');
  const mechs = Array.isArray(p.mechanisms) && p.mechanisms.length ? `\n\n采用机制：${p.mechanisms.join(' + ')}` : '';
  return `## ${title}\n\n方案 ID：${p.proposal_id}${mechs}\n\n来源方案：${p.parent_proposal_ids.join('、') || '新方案'}\n\n变更说明：${p.change_summary ?? ''}\n\n${p.text}`;
}

export function rankedFinal(result, proposals) {
  const normalized = rankedResult(result, proposals);
  const byId = new Map(proposals.map(p => [p.proposal_id, p]));
  const finalRankings = normalized.rankings;
  const text = '# 候选方案排序\n\n所有候选方案及其修订版本均保留。名次仅为模型排序，最终选择由你决定。\n\n' + finalRankings.map((r, idx) => {
    const p = byId.get(r.proposal_id);
    const title = (p?.title || r.proposal_id).replace(/[\r\n]+/g, ' ');
    let section = '';
    if (r.unranked && (idx === 0 || !finalRankings[idx - 1].unranked)) section += '> ⚠️ **以下为未被 Chair 排序覆盖的方案**：为防止遗漏潜在优秀方案，在此处保留供重点考察（不设具体名次，原方案正文完整保留）。\n\n';
    else if (!r.unranked && idx > 0 && finalRankings[idx - 1].unranked) section += '> 📋 **以下继续展示第 11 名及后续方案**：\n\n';
    const header = r.unranked ? `## 【未排方案】· ${title}` : `# 第 ${r.rank} 名 · ${title}`;
    return `${section}${header}\n\n> **核心速览（一句话）**：${r.summary}\n\n**排序理由**：${r.reason}\n\n${p ? proposalText(p) : '方案正文缺失'}`;
  }).join('\n\n---\n\n');
  return { ...normalized, text };
}

export const markdownPresenter = { proposalText, rankedFinal };
