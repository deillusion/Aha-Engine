const $ = s => document.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = n => n == null ? '—' : Number(n).toLocaleString('zh-CN');
const percent = n => n == null ? '—' : `${Math.round(n * 100)}%`;
const statusNames = { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' };
// Keep the retired phase label for existing run archives.
const phaseNames = { creative: '创意发言', extractor: '提取观点（旧版）', dedup: '去重合并', decision: '完善候选方案', chair: '方案排序', direct: '直接回答' };
const state = { page: 'workspace', runs: [], run: null, config: null, activeId: null, tab: 'board', round: null, filter: '', fingerprint: '', draft: { problem: '', constraints: '', mode: 'live', experiment: 'treatment', seed: 20260909, use_operators: true } };
let toastTimer, polling = false, loading = false;
async function api(path, options = {}) { const res = await fetch(path, options); const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data; }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 6000); }
function markdown(text) {
  const inline = s => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  let result = '', list = null, code = false;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('```')) { if (list) { result += `</${list}>`; list = null; } result += code ? '</pre>' : '<pre>'; code = !code; continue; }
    if (code) { result += `${escape(line)}\n`; continue; }
    const bullet = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.+)/);
    if (!bullet && list) { result += `</${list}>`; list = null; }
    if (bullet) { const type = bullet[1] ? 'ol' : 'ul'; if (list !== type) { if (list) result += `</${list}>`; result += `<${type}>`; list = type; } result += `<li>${inline(bullet[2])}</li>`; }
    else if (/^#{1,6}\s/.test(line)) { const m = line.match(/^(#+)\s+(.*)/); const level = m[1].length <= 2 ? 2 : 3; result += `<h${level}>${inline(m[2])}</h${level}>`; }
    else if (line.trim()) result += `<p>${inline(line)}</p>`;
  }
  return result + (list ? `</${list}>` : '') + (code ? '</pre>' : '');
}
function activeConfig() { return state.config?.liveConfig ?? state.config?.mockConfig; }
function history() {
  $('#history-count').textContent = state.runs.length;
  $('#history').innerHTML = state.runs.length ? state.runs.slice(0, 40).map(r => `<button class="history-item ${state.run?.id === r.id ? 'selected' : ''}" data-run="${escape(r.id)}"><div class="history-title">${escape(r.problem)}</div><div class="history-meta"><span class="status-${r.status}">● ${statusNames[r.status] || r.status}</span><span>${r.mode === 'mock' ? '模拟' : '真实'} · ${new Date(r.started_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></div></button>`).join('') : '<div class="small-note" style="padding:10px 12px">会议记录会保存在这里</div>';
}
function heading(eyebrow, title, subtitle, right = '') { return `<div class="heading-row"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${right}</div>`; }
function seats(config) {
  return `<div class="seat-grid">${(config.seats || []).map(s => `<div class="seat" data-model="${escape(s.modelId)}"><strong>${escape(s.id)}</strong><small>${escape(s.modelId)}</small></div>`).join('')}</div>`;
}
function renderNew() {
  const d = state.draft, config = activeConfig() ?? state.config?.mockConfig ?? { seats: [], models: [] };
  const calls = d.experiment === 'direct' ? 1 : d.experiment === 'single' ? (config.seats?.length ?? 0) + 1 : (config.seats?.length ?? 0) * 6 + 6;
  $('#main').innerHTML = `${heading('A LITTLE DIFFERENCE. A BETTER IDEA.', '给好想法，多一点碰撞。', '把一个开放式问题，交给不同视角共同思考。', '<span class="badge"><span class="online-dot"></span> 工作台已就绪</span>')}
    <div class="workspace-grid"><div><form id="run-form" class="card"><div class="card-head"><h2><span class="step">01</span> 定义这次讨论</h2><small>从一个值得探索的问题开始</small></div>
    <div class="form-body"><div class="field"><label class="field-label" for="problem">你想解决什么问题？<button type="button" class="example-button" id="load-example">试试一个玩法设计问题 ↗</button></label><textarea id="problem" name="problem" required maxlength="20000" placeholder="例如：设计一个轻量的合作玩法，让玩家在每一局中都能做出有意义的选择……">${escape(d.problem)}</textarea></div>
    <div class="field"><label class="field-label" for="constraints">必须遵守的约束 <small>选填 · 每行一条</small></label><textarea id="constraints" name="constraints" placeholder="单局不超过 10 分钟&#10;两周内可以验证核心机制">${escape(d.constraints)}</textarea></div>
    <div class="form-row"><div><label class="field-label" for="experiment">实验方案</label><select id="experiment" name="experiment">${Object.entries(state.config.experiments).map(([id, e]) => `<option value="${id}" ${id === d.experiment ? 'selected' : ''}>${escape(e.name)}</option>`).join('')}</select></div><div class="seed-field"><label class="field-label" for="seed">随机种子</label><input id="seed" name="seed" type="number" min="0" max="2147483647" value="${d.seed}" required></div></div>
    <label class="check-line"><input type="checkbox" id="use-operators" name="use_operators" ${d.use_operators ? 'checked' : ''}> 使用随机思维刺激 <span class="muted">· 关闭可进行消融对照</span></label>
    ${!state.config.liveConfig ? `
      <div class="info-box stack-gap" style="background:#fff8e6;border:1px solid #f2da99;color:#7a5a15;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:8px">
        <div>
          <b style="display:block;margin-bottom:2px">⚠️ 尚未配置任何模型 API Key</b>
          <span style="font-size:11.5px">只需配置其中任意 1 个模型，系统即可自动自适应调度 8 席开始会议。</span>
        </div>
        <button type="button" class="button secondary" id="jump-to-config-btn" style="padding:5px 12px;font-size:11.5px;white-space:nowrap">👉 前往配置 (只需填1个)</button>
      </div>` : ''}</div>
    <div class="form-bottom"><p>将问题发送至已配置的模型服务，按服务商计费。<br>本次 ${calls} 次模型调用起 · ${escape(state.config.experiments[d.experiment].description)}</p><button type="submit" class="primary" ${state.activeId || !state.config.liveConfig ? 'disabled' : ''}>${state.activeId ? '已有会议运行中' : '开始会议'} <span>→</span></button></div></form>
    <div class="lower-note"><span>每轮独立发言</span><span>完整过程可追溯</span><span>会议记录保存在本地</span></div></div>
    <aside class="right-rail"><section class="card rail-card"><span class="eyebrow">THE TABLE</span><h3 style="margin-top:12px">${config.seats?.length ?? 0} 个席位，多种思考路径</h3><p>同一问题，独立思考；有价值的贡献<br>汇入下一轮公共观点板。</p>${seats(config)}<div class="legend-row"><span>${config.models?.length ?? 0} 个模型</span><span>每席 3 个思维刺激</span></div></section>
    <section class="card rail-card"><span class="eyebrow">HOW IT WORKS</span><div class="timeline"><div class="timeline-item"><span class="timeline-number">1</span><div><h4>独立思考 · 5 轮</h4><p>原子观点去重，完整方案独立保存并持续修订。</p></div></div><div class="timeline-item"><span class="timeline-number">2</span><div><h4>完善方案 · 第 6 轮</h4><p>各席位读取完整方案，补全机制与验证办法。</p></div></div><div class="timeline-item"><span class="timeline-number">3</span><div><h4>所有方案交给你选择</h4><p>Chair 只做排序，方案正文原样保留。</p></div></div></div></section><div class="principle"><strong>保留分歧，也保留可能性。</strong>不同结论可以同时存在。让因果、约束与可执行性决定最终选择。</div></aside></div>`;
}
const typeLabels = { proposal: '方案', mechanism: '机制', argument: '论据', counterexample: '反例', modification: '改造', connection: '新联系', assumption: '隐藏假设', reframing: '问题重构', other: '其他' };
function metric(label, value, note) { return `<div class="card metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`; }
function proposalLinks(ids) {
  return ids.length ? ids.map(id => '<button class="example-button" data-proposal="' + escape(id) + '">' + escape(id) + '</button>').join(' · ') : '新方案';
}
function renderRun() {
  const r = state.run, m = r.metrics;
  const isRunning = r.status === 'running';
  const buttons = `<div class="run-actions">
    ${isRunning ? '<button class="secondary danger" id="cancel-run">停止运行</button>' : ''}
    ${r.final ? `<a class="secondary" href="/api/runs/${r.id}/answer">导出答案 ↓</a>` : ''}
    <a class="secondary" href="/api/runs/${r.id}/export">完整记录 ↓</a>
  </div>`;

  let maxRound = 0;
  if (r.experiment === 'direct') {
    maxRound = 0;
  } else if (r.experiment === 'single') {
    maxRound = 1;
  } else {
    if (r.raw_responses.length) {
      maxRound = Math.max(...r.raw_responses.map(x => x.round || 1));
    }
    if (r.round > maxRound && r.round <= 5) maxRound = r.round;
    if (maxRound < 1) maxRound = 1;
  }

  const seats = r.config.seats || [];
  const byProposalId = new Map((r.proposals || []).map(p => [p.proposal_id, p]));

  let html = `
    <div class="flow-container">
      <div class="run-header-card">
        <div class="run-header-top">
          <div class="run-title-area">
            <span class="eyebrow">${escape(state.config.experiments[r.experiment]?.name || r.experiment)} · SEED ${r.seed}</span>
            <h2>${escape(r.problem)}</h2>
            ${r.constraints.length ? `<div class="point-bottom" style="margin-top:8px">${r.constraints.map(c => `<span class="chip">${escape(c)}</span>`).join('')}</div>` : ''}
          </div>
          ${buttons}
        </div>
        <div class="run-header-meta">
          <span class="status-badge ${r.status}">● ${statusNames[r.status] || r.status}</span>
          <span>阶段：<strong>${escape(r.phase)}</strong></span>
          <span>模式：${r.mode === 'mock' ? '模拟演示' : '真实模型'}</span>
          <span>调用进度：${m.completed_calls ?? 0} / ${m.expected_calls}</span>
          <span>累计耗时：${Math.round((m.duration_ms || 0) / 1000)} 秒</span>
          ${m.estimated_cost != null ? `<span>预估费用：${m.estimated_cost.toFixed(4)}</span>` : ''}
        </div>
        ${r.mode === 'mock' ? '<div class="info-box" style="margin-top:14px;margin-bottom:0">模拟演示使用固定设计样例，不消耗模型额度。</div>' : ''}
        ${r.error ? `<div class="error-box" style="margin-top:14px;margin-bottom:0">${escape(r.error)}</div>` : ''}
      </div>
  `;

  for (let rnd = 1; rnd <= maxRound; rnd++) {
    const isCurrentRound = isRunning && r.round === rnd;
    html += `
      <div class="flow-step ${isCurrentRound ? 'step-running' : ''}" id="step-r${rnd}">
        <div class="step-header">
          <div class="step-header-left">
            <span class="step-tag">R${rnd} 探索</span>
            <div class="step-title-area">
              <h3>第 ${rnd} 轮 · 创意探索与视角碰撞</h3>
              <p>${seats.length} 个席位独立运用思维刺激算子进行机制推演</p>
            </div>
          </div>
          ${isCurrentRound ? '<span class="status-badge running"><span class="pulse-indicator"></span> 席位推演中</span>' : ''}
        </div>
        <div class="seats-grid-4x2">
    `;

    for (const seat of seats) {
      const resp = r.raw_responses.find(x => x.round === rnd && x.seat_id === seat.id);
      const assignedOps = (r.assignments.find(a => a.round === rnd && a.seat_id === seat.id)?.operators ?? []);
      const isCardRunning = resp?.status === 'running';
      const isCardFailed = resp?.status === 'failed';
      const isCardCompleted = resp?.status === 'completed';

      html += `<div class="seat-card ${isCardRunning ? 'card-running' : isCardFailed ? 'card-failed' : ''}" id="card-R${rnd}-${escape(seat.id)}">
        <div class="seat-card-top">
          <span class="seat-badge">席位 ${escape(seat.id)}</span>
          <span class="seat-model">${escape(seat.modelId)}</span>
        </div>
        ${assignedOps.length ? `<div class="seat-operators">${assignedOps.map(op => `<span class="op-pill" title="${escape(op.prompt)}">${escape(op.name)}</span>`).join('')}</div>` : ''}
      `;

      if (isCardRunning) {
        const startTime = resp.started_at ? new Date(resp.started_at).getTime() : Date.now();
        const elapsedSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
        html += `
          <div class="thinking-block-active">
            <div class="thinking-header">
              <div class="thinking-title">
                <span class="pulse-indicator"></span>
                <span>深度思考中 (Thinking)...</span>
              </div>
              <span class="thinking-timer" data-start="${startTime}">已思考 ${elapsedSec}s</span>
            </div>
            <div class="thinking-stream" id="stream-R${rnd}-${escape(seat.id)}">${resp.thinking ? escape(resp.thinking) : (assignedOps.length ? `&gt; 结合算子【${assignedOps.map(o => escape(o.name)).join('、')}】寻找破局点…\n` : '') + '正在建立思维链路…'} <span class="thinking-cursor"></span></div>
          </div>
          <div class="seat-body-waiting">
            <span>⚡ 思考结束后显示正文</span>
          </div>
        `;
      } else if (isCardCompleted) {
        const duration = (resp.completed_at && resp.started_at)
          ? ((new Date(resp.completed_at) - new Date(resp.started_at)) / 1000).toFixed(1)
          : (resp.latency_ms ? (resp.latency_ms / 1000).toFixed(1) : '—');

        html += `
          <details class="thinking-completed" id="think-R${rnd}-${escape(seat.id)}">
            <summary>
              <span>🧠 已深度思考 · 耗时 ${duration}s</span>
              <span>查看推演过程 ▾</span>
            </summary>
            <div class="thinking-content">${escape(resp.thinking || resp.reasoning || '无推演过程记录')}</div>
          </details>
          <div class="seat-body">
            ${(resp.contributions || []).map(c => `
              <div class="contrib-card">
                <div class="contrib-card-header">
                  <span class="contrib-type-pill">${escape(typeLabels[c.type] || c.type)}</span>
                </div>
                <div>${escape(c.text)}</div>
                ${c.failure_condition ? `<div class="contrib-failure">⚠️ 失效条件：${escape(c.failure_condition)}</div>` : ''}
              </div>
            `).join('')}
            ${(resp.proposals || []).map(p => `
              <div class="seat-proposal-mini">
                <b>📜 机制提案：${escape(p.title)}</b>
                <div style="font-size:10px;color:#60735b">${escape(p.change_summary || '')}</div>
              </div>
            `).join('')}
          </div>
        `;
      } else if (isCardFailed) {
        html += `<div class="error-box" style="margin:10px 0;padding:8px 10px;font-size:11px">${escape(resp.error || '推演失败')}</div>`;
      } else {
        html += `<div class="seat-body-waiting"><span>等待轮次激活…</span></div>`;
      }

      html += `</div>`;
    }

    html += `</div></div>`;

    const metricRow = r.round_metrics.find(x => x.round === rnd);
    const snap = r.snapshots.find(s => s.version === rnd);
    const roundProps = (r.proposals || []).filter(p => p.round === rnd);
    const isDedupRunning = isRunning && r.round === rnd && r.phase === '去重合并';

    if (metricRow || snap || isDedupRunning) {
      html += `
        <div class="flow-step" style="background:#f7faf5;border-color:#dbe6d5" id="convergence-r${rnd}">
          <div class="step-header">
            <div class="step-header-left">
              <span class="step-tag convergence">R${rnd} 沉淀</span>
              <div class="step-title-area">
                <h3>第 ${rnd} 轮 · 观点汇聚与公共记忆</h3>
                <p>所有席位发言经统一去重聚合后，提炼为公共观点板与方案池</p>
              </div>
            </div>
            ${metricRow ? `
              <div class="convergence-stats">
                <span class="stat-tag add">＋ 新增 ${metricRow.add} 条</span>
                <span class="stat-tag merge">～ 合并 ${metricRow.merge} 条</span>
                <span class="stat-tag drop">－ 丢弃 ${metricRow.drop} 条</span>
                <span class="stat-tag total">观点板 v${rnd} · 共 ${metricRow.board_size} 条</span>
              </div>
            ` : '<span class="status-badge running"><span class="pulse-indicator"></span> 正在去重合并中...</span>'}
          </div>
      `;

      if (snap) {
        html += `
          <details id="board-r${rnd}" style="margin-top:6px">
            <summary class="small-note" style="cursor:pointer;font-weight:600;color:#456041">
              查看本轮公共观点板（共 ${snap.points.length} 条观点） ▾
            </summary>
            <div class="convergence-points">
              ${snap.points.map(p => `
                <div class="point-card" style="margin-bottom:0;background:#fff">
                  <div class="point-top">
                    <span class="point-id">#${p.point_id}</span>
                    <span>REV ${p.current_revision} · 首见 R${p.first_seen_round}</span>
                  </div>
                  <p style="margin:6px 0;font-size:11.5px">${escape(p.text)}</p>
                  <div class="point-bottom">
                    ${p.source_seat_ids.map(s => `<span class="chip">${escape(s)}</span>`).join('')}
                    ${p.revisions.length > 1 ? `<span class="small-note">修于 ${p.revisions.map(v => `R${v.round}`).join('/')}</span>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </details>
        `;
      }

      if (roundProps.length) {
        html += `
          <div style="margin-top:14px;padding-top:12px;border-top:1px dashed #d8e4d1">
            <div class="small-note" style="font-weight:600;color:#35563c;margin-bottom:8px">本轮沉淀的完整机制提案（${roundProps.length} 个版本）：</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
              ${roundProps.map(p => `
                <details class="memo" id="prop-${escape(p.proposal_id)}" style="background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #e1e8db">
                  <summary style="font-size:12px;font-weight:600;color:#2a4531">
                    <span>${escape(p.title)}</span>
                    <span class="chip">${escape(p.proposal_id)}</span>
                  </summary>
                  <p class="small-note" style="margin:6px 0">来源席位：${escape(p.seat_id)} · 变更：${escape(p.change_summary || '初始完整方案')}</p>
                  <div class="text-content" style="font-size:11.5px;max-height:220px;overflow-y:auto">${markdown(p.text)}</div>
                </details>
              `).join('')}
            </div>
          </div>
        `;
      }

      html += `</div>`;
    }
  }

  const hasR6 = r.memos && (r.memos.length > 0 || r.round === 6 || r.phase === '完善候选方案' || r.status === 'completed');
  if (hasR6 && !['direct', 'single'].includes(r.experiment)) {
    const isR6Running = isRunning && r.round === 6;
    html += `
      <div class="flow-step ${isR6Running ? 'step-running' : ''}" id="step-r6">
        <div class="step-header">
          <div class="step-header-left">
            <span class="step-tag decision">R6 完善</span>
            <div class="step-title-area">
              <h3>第 6 轮 · 完善候选方案</h3>
              <p>各席位读取前 5 轮全部观点板与方案池，补全机制细节、执行路径与验证办法</p>
            </div>
          </div>
          ${isR6Running ? '<span class="status-badge running"><span class="pulse-indicator"></span> 席位方案完善中</span>' : ''}
        </div>
        <div class="seats-grid-4x2">
    `;

    for (const seat of seats) {
      const memo = (r.memos || []).find(m => m.seat_id === seat.id);
      const isMemoRunning = memo?.status === 'running';
      const isMemoCompleted = memo?.status === 'completed';
      const isMemoFailed = memo?.status === 'failed';

      html += `<div class="seat-card ${isMemoRunning ? 'card-running' : isMemoFailed ? 'card-failed' : ''}" id="memo-card-${escape(seat.id)}">
        <div class="seat-card-top">
          <span class="seat-badge">席位 ${escape(seat.id)}</span>
          <span class="seat-model">${escape(seat.modelId)}</span>
        </div>
      `;

      if (isMemoRunning) {
        const startTime = memo.started_at ? new Date(memo.started_at).getTime() : Date.now();
        const elapsedSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
        html += `
          <div class="thinking-block-active">
            <div class="thinking-header">
              <div class="thinking-title">
                <span class="pulse-indicator"></span>
                <span>完善机制方案思考中...</span>
              </div>
              <span class="thinking-timer" data-start="${startTime}">已思考 ${elapsedSec}s</span>
            </div>
            <div class="thinking-stream" id="stream-memo-${escape(seat.id)}">${memo.thinking ? escape(memo.thinking) : '正在补全机制闭环与验证路径…'} <span class="thinking-cursor"></span></div>
          </div>
          <div class="seat-body-waiting"><span>⚡ 思考结束后显示正文</span></div>
        `;
      } else if (isMemoCompleted) {
        const duration = (memo.completed_at && memo.started_at)
          ? ((new Date(memo.completed_at) - new Date(memo.started_at)) / 1000).toFixed(1)
          : '—';
        html += `
          <details class="thinking-completed" id="memo-think-${escape(seat.id)}">
            <summary>
              <span>🧠 方案完善完成 · 耗时 ${duration}s</span>
              <span>${memo.thinking ? '查看推演过程 ▾' : '查看详情 ▾'}</span>
            </summary>
            <div class="thinking-content">${escape(memo.thinking || ('已基于观点板完成最终机制补全。提案编号：' + (memo.proposal_ids || []).join('、')))}</div>
          </details>
          <div class="seat-body">
            <div class="text-content" style="font-size:11.5px;max-height:260px;overflow-y:auto">${markdown(memo.text || '')}</div>
          </div>
        `;
      } else if (isMemoFailed) {
        html += `<div class="error-box" style="margin:10px 0;padding:8px 10px;font-size:11px">${escape(memo.error || '完善失败')}</div>`;
      } else {
        html += `<div class="seat-body-waiting"><span>等待激活第 6 轮…</span></div>`;
      }

      html += `</div>`;
    }

    html += `</div></div>`;
  }

  const isChairRunning = isRunning && (r.phase === '方案排序' || r.phase === '直接回答');
  if (r.final || isChairRunning) {
    html += `
      <div class="flow-step" style="border-color:#5a8a65;background:#fbfdfa" id="step-final">
        <div class="step-header">
          <div class="step-header-left">
            <span class="step-tag chair">🏆 最终裁决</span>
            <div class="step-title-area">
              <h3>${r.final?.kind === 'direct' ? '直接回答结果' : '方案综合排序与决策建议'}</h3>
              <p>Chair 依据硬约束与可行性对所有方案进行综合排序，全部正文原样保留</p>
            </div>
          </div>
          ${isChairRunning ? '<span class="status-badge running"><span class="pulse-indicator"></span> Chair 综合裁决中</span>' : '<span class="status-badge">● 裁决已就绪</span>'}
        </div>
    `;

    if (isChairRunning) {
      html += `
        <div class="thinking-block-active" style="margin:10px 0">
          <div class="thinking-header">
            <div class="thinking-title">
              <span class="pulse-indicator"></span>
              <span>Chair 正在统揽全场所有方案进行对照与排序...</span>
            </div>
          </div>
          <div class="thinking-stream" id="stream-chair">${r.chair_thinking ? escape(r.chair_thinking) : '正在审视方案约束与综合权衡优先级…'} <span class="thinking-cursor"></span></div>
        </div>
      `;
    } else if (r.final) {
      if (r.final.kind === 'ranking') {
        html += `<div class="ranking-list">`;
        for (const row of r.final.rankings) {
          const p = byProposalId.get(row.proposal_id);
          const isTop = row.rank === 1;
          html += `
            <div class="ranking-card ${isTop ? 'rank-1' : ''}" id="rank-${escape(row.proposal_id)}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="display:flex;align-items:center;gap:10px">
                  <span class="rank-badge ${isTop ? 'rank-top' : ''}">第 ${row.rank} 名</span>
                  <strong style="font-size:15px;color:#274332">${escape(p?.title || row.proposal_id)}</strong>
                  <span class="chip">${escape(row.proposal_id)}</span>
                </div>
                ${p ? `<span class="small-note">席位 ${escape(p.seat_id)} · R${p.round}</span>` : ''}
              </div>
              <div style="background:#f4f7f1;border-radius:6px;padding:9px 12px;margin-bottom:12px;font-size:12px;color:#455944">
                <strong>💡 排序理由：</strong>${escape(row.reason)}
              </div>
              ${p?.change_summary ? `<div class="small-note" style="margin-bottom:8px">变更演进：${escape(p.change_summary)}</div>` : ''}
              <article class="text-content">${markdown(p?.text || '正文暂不可用')}</article>
            </div>
          `;
        }
        html += `</div>`;
      } else {
        html += `<article class="text-content" style="padding:10px 0">${markdown(r.final.text || '')}</article>`;
      }
    }

    html += `</div>`;
  }

  html += `
    <details class="tech-drawer" id="tech-drawer">
      <summary>📊 技术审计：查看底层模型调用日志与演化指标 (${r.calls.length} 次尝试 · ${number(m.completed_calls)} 完成 · 耗时 ${Math.round((m.duration_ms || 0)/1000)}s)</summary>
      <div class="tech-content">
        <div class="metrics-grid" style="margin-bottom:18px">
          ${metric('调用进度', `${m.completed_calls ?? 0}<span style="font-size:13px;color:#a4b197"> / ${m.expected_calls}</span>`, `${m.attempted_calls} 次尝试 · ${m.failed_attempts ?? 0} 次失败`)}
          ${metric('公共观点', number(m.board_points), `${number(m.board_characters)} 字符 · 完整保留`)}
          ${metric('模型 Tokens', m.input_tokens == null ? '—' : number(m.input_tokens + m.output_tokens), m.input_tokens == null ? '模拟模式' : `覆盖 ${percent(m.usage_coverage)}`)}
          ${metric('累计耗时', `${Math.round(m.duration_ms / 1000)}<span style="font-size:12px"> 秒</span>`, r.mode === 'mock' ? '模拟运行' : m.estimated_cost == null ? '费用未知' : `估算 ${m.estimated_cost.toFixed(4)}`)}
        </div>
        <div style="margin-top:14px">
          <p class="small-note" style="margin-bottom:10px">最近调用日志：</p>
          ${r.calls.slice(-20).reverse().map(c => `
            <details class="call-row" id="call-${c.id}">
              <summary>
                <span class="status-${c.status}">●</span>
                <span>R${c.round} ${phaseNames[c.phase] || c.phase} ${escape(c.seat_id || c.model_id)}</span>
                <span>${c.attempt ? `重试 ${c.attempt} · ` : ''}${c.latency_ms == null ? '进行中' : `${(c.latency_ms / 1000).toFixed(1)}s`}</span>
              </summary>
              <p class="small-note">模型 ${escape(c.resolved_model || c.model)} · ${number(c.usage?.prompt_tokens)} 输入 / ${number(c.usage?.completion_tokens)} 输出 tokens</p>
              ${c.error ? `<div class="error-box">${escape(c.error)}</div>` : ''}
              <div class="raw-text">${escape(c.response || '等待返回…')}</div>
            </details>
          `).join('')}
        </div>
      </div>
    </details>
  `;

  html += `</div>`;
  $('#main').innerHTML = html;
  document.querySelectorAll('.thinking-stream').forEach(el => { el.scrollTop = el.scrollHeight; });
}
function renderCompare() {
  $('#main').innerHTML = `${heading('COMPARE THE EVIDENCE', '同一个问题，不同的思考方式。', '比较实际用量与结果，再判断多轮协作是否值得。')}
  <div class="info-box">调用次数相同不代表 token 或费用相同。请比较同一问题、相同模型配置和多个种子的真实运行；模拟数据不能用于质量结论。导出答案后可隐藏实验名称交给独立评审。</div>
  <section class="card table-wrap"><table><thead><tr><th>问题 / 运行</th><th>实验</th><th>模式 / 状态</th><th>调用</th><th>Tokens</th><th>耗时</th><th>排序覆盖 / 旧版采用</th></tr></thead><tbody>${state.runs.map(r => `<tr><td><button class="example-button compare-problem" data-run="${r.id}" title="${escape(r.problem)}">${escape(r.problem)}</button><div class="small-note">Seed ${r.seed}</div></td><td>${escape(state.config.experiments[r.experiment]?.name)}${!r.use_operators ? '<br><span class="small-note">无思维刺激</span>' : ''}</td><td>${r.mode === 'mock' ? '模拟' : '真实'} · ${statusNames[r.status]}</td><td>${r.metrics.attempted_calls}</td><td>${r.metrics.input_tokens == null ? '—' : number(r.metrics.input_tokens + r.metrics.output_tokens)}</td><td>${Math.round((r.metrics.duration_ms ?? 0) / 1000)}s</td><td>${r.workflow_version === 2 ? (r.experiment === 'direct' ? '不适用' : `${r.metrics.ranked_proposals} / ${r.metrics.proposal_count}`) : percent(r.metrics.late_round_value)}</td></tr>`).join('') || '<tr><td colspan="7">还没有会议记录。先新建一次会议。</td></tr>'}</tbody></table></section>`;
}
function renderConfig() {
  const c = state.config.liveConfig ?? state.config.mockConfig;
  const rp = state.config.routingPreview;
  const activeCount = rp?.activeModels?.length ?? c.models.filter(m => m.hasKey).length;
  const totalCount = rp?.totalModels ?? c.models.length;
  const activeNames = rp?.activeModels?.join(', ') || c.models.filter(m => m.hasKey).map(m => m.id).join(', ');

  let bannerHtml = '';
  if (activeCount === 0) {
    bannerHtml = `<div class="config-adaptive-banner warn">⚠️ <b>尚未配置任何可用模型的 API Key</b><br><span style="font-size:11px">请在下方至少为一个模型填入 API Key 并点击保存。即使只配 1 个模型，系统也将自动调度 8 席正常运行。</span></div>`;
  } else if (activeCount === 1) {
    bannerHtml = `<div class="config-adaptive-banner">💡 <b>单模型自适应模式已就绪 (已激活: ${escape(activeNames)})</b><br><span style="font-size:11px">您无需填写其他模型！系统已自动将 8 个推演席位及裁决角色调度至该模型。各席位依旧获得不同的专业认知算子激发与独立种子多维推演，推演多样性完全保留。</span></div>`;
  } else if (activeCount < totalCount) {
    bannerHtml = `<div class="config-adaptive-banner">💡 <b>多模型均衡协同模式已就绪 (已激活: ${activeCount}/${totalCount} 个模型 [${escape(activeNames)}])</b><br><span style="font-size:11px">通用 K-of-M 自适应机制已生效：未配置 Key 的模型席位将自动按最大多样性均衡平摊至已激活模型中，无任何席位浪费。</span></div>`;
  } else {
    bannerHtml = `<div class="config-adaptive-banner">🟢 <b>全异构多模型协作模式就绪 (所有 ${totalCount} 个模型均已配置)</b><br><span style="font-size:11px">8 席推演将完全按照原始异构配置分工运转。</span></div>`;
  }

  $('#main').innerHTML = `
    ${heading('MODELS & API KEYS', '配置大模型凭据与席位规则', '本地持久化保存，下次无需重复填写；支持任意 K 个模型自适应运行。')}
    ${bannerHtml}
    
    <div class="config-grid">
      <section class="card">
        <div class="card-head">
          <h2>大模型 API Key 凭据与连通测试</h2>
          <small>${activeCount} / ${totalCount} 已就绪</small>
        </div>
        <p class="small-note" style="margin-bottom:14px">填入 Key 并保存后持久化存入本地 <code>config.local.json</code>。外部 Agent 调用 MCP 时亦将自动读取本地凭据（Claude Code / Cursor 零配置感知）。</p>
        
        <div class="config-models-container">
          ${c.models.map(m => `
            <div class="config-model-card">
              <div class="config-model-card-top">
                <div class="config-model-title">
                  <b>${escape(m.id)}</b> <span class="muted">· ${escape(m.model)}</span>
                  <span class="chip ${m.hasKey ? '' : 'failed'}" style="font-size:10px">${m.hasKey ? '🟢 已就绪' + (m.keySource === 'env' ? ' (环境变量)' : '') : '⚪ 未配置'}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span id="probe-${escape(m.id)}" class="probe-status"></span>
                  <button type="button" class="button secondary test-model-btn" data-model="${escape(m.id)}" style="padding:4px 10px;font-size:11px">⚡ 测试连通性</button>
                </div>
              </div>
              <div class="small-note">${escape(m.baseUrl)}</div>
              <div class="config-key-row">
                <input type="password" id="cfg-key-${escape(m.id)}" class="config-key-input" placeholder="${m.hasKey ? (m.maskedKey || '已配置密钥 (输入新值以替换)') : '输入 API Key (如 sk-...)'}">
                <button type="button" class="config-icon-btn toggle-key-btn" data-model="${escape(m.id)}" title="显示/隐藏明文">👁️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>席位分配与裁决角色</h2>
          <button type="button" class="button secondary" id="auto-balance-seats-btn" style="padding:4px 10px;font-size:11px">⚡ 一键在可用模型间均匀排席</button>
        </div>
        
        <div style="margin-bottom:16px">
          <div class="small-note" style="margin-bottom:6px;font-weight:600;color:var(--ink)">全局核心角色分工：</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <div>
              <label class="small-note">Chair 排序裁决模型</label>
              <select id="cfg-role-chair" class="config-select" style="width:100%;margin-top:3px">
                ${c.models.map(m => `<option value="${escape(m.id)}" ${c.roles.chair === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="small-note">Dedup 观点去重模型</label>
              <select id="cfg-role-dedup" class="config-select" style="width:100%;margin-top:3px">
                ${c.models.map(m => `<option value="${escape(m.id)}" ${c.roles.dedup === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
            </div>
          </div>
          <div>
            <label class="small-note">Dealer 领域算子发卡模型</label>
            <select id="cfg-role-dealer" class="config-select" style="width:100%;margin-top:3px">
              ${c.models.map(m => `<option value="${escape(m.id)}" ${(c.roles.dealer || c.roles.chair) === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
            </select>
          </div>
        </div>

        <div>
          <div class="small-note" style="margin-bottom:6px;font-weight:600;color:var(--ink)">8 个创意推演席位模型分配：</div>
          <div class="config-seats-grid">
            ${c.seats.map((s, idx) => `
              <div class="config-seat-cell">
                <span class="config-seat-tag">${escape(s.id)}</span>
                <select class="config-select seat-config-select" data-idx="${idx}">
                  ${c.models.map(m => `<option value="${escape(m.id)}" ${s.modelId === m.id ? 'selected' : ''}>${escape(m.id)} ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
                </select>
              </div>
            `).join('')}
          </div>
        </div>

        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between">
          <button type="button" class="button" id="save-config-btn">💾 保存配置并即时生效</button>
          <span class="small-note">修改即刻生效，无需重启服务</span>
        </div>
      </section>
    </div>

    <section class="card stack-gap">
      <div class="card-head">
        <h2>思维刺激库 (Cognitive Operators)</h2>
        <small>${state.config.operators.length} 个 operators · 8 个 families</small>
      </div>
      <div class="content-panel operator-grid">
        ${state.config.operators.map(o => `
          <div class="operator-box">
            <b>${escape(o.name)} <span class="muted">/ ${escape(o.family)}</span></b>
            <p>${escape(o.prompt)}</p>
          </div>
        `).join('')}
      </div>
    </section>
  `;

  // Bind Event Listeners for Configuration Panel
  document.querySelectorAll('.toggle-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mid = btn.dataset.model;
      const inp = document.getElementById(`cfg-key-${mid}`);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });

  document.querySelectorAll('.test-model-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mid = btn.dataset.model;
      const probe = document.getElementById(`probe-${mid}`);
      const inp = document.getElementById(`cfg-key-${mid}`);
      const typedKey = inp?.value;
      probe.className = 'probe-status loading';
      probe.textContent = '测试连通中...';
      try {
        const res = await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: mid, apiKey: typedKey })
        });
        const d = await res.json();
        if (d.ok) {
          probe.className = 'probe-status success';
          probe.textContent = `✓ 正常 (${d.latencyMs}ms)`;
        } else {
          probe.className = 'probe-status failed';
          probe.textContent = `✗ 失败: ${d.error || '连接失败'}`;
        }
      } catch (err) {
        probe.className = 'probe-status failed';
        probe.textContent = `✗ 异常: ${err.message}`;
      }
    });
  });

  $('#auto-balance-seats-btn')?.addEventListener('click', () => {
    const active = c.models.filter(m => {
      const inp = document.getElementById(`cfg-key-${m.id}`);
      return m.hasKey || (inp && inp.value.trim());
    });
    if (active.length === 0) {
      toast('⚠️ 请先至少输入一个模型的 API Key');
      return;
    }
    const counts = new Map(active.map(m => [m.id, 0]));
    document.querySelectorAll('.seat-config-select').forEach(sel => {
      let minCount = Infinity;
      let targetId = active[0].id;
      for (const m of active) {
        const c = counts.get(m.id) || 0;
        if (c < minCount) {
          minCount = c;
          targetId = m.id;
        }
      }
      sel.value = targetId;
      counts.set(targetId, minCount + 1);
    });
    toast(`✅ 已按 ${active.length} 个可用模型完成 8 席均衡分配！请点击保存生效。`);
  });

  $('#save-config-btn')?.addEventListener('click', async () => {
    const base = state.config.liveConfig || state.config.mockConfig;
    const updated = structuredClone(base);
    updated.roles.chair = $('#cfg-role-chair').value;
    updated.roles.dedup = $('#cfg-role-dedup').value;
    updated.roles.dealer = $('#cfg-role-dealer').value;

    document.querySelectorAll('.seat-config-select').forEach(sel => {
      const idx = Number(sel.dataset.idx);
      if (updated.seats[idx]) updated.seats[idx].modelId = sel.value;
    });

    updated.models = updated.models.map(m => {
      const inp = document.getElementById(`cfg-key-${m.id}`);
      const val = inp?.value;
      const out = { ...m };
      if (val && val.trim()) {
        out.apiKey = val.trim();
      }
      return out;
    });

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      const d = await res.json();
      if (d.ok) {
        toast('✅ 配置与 API Key 已持久化保存并实时生效！');
        state.config = await api('/api/config');
        renderConfig();
      } else {
        toast('保存失败: ' + (d.error || '未知错误'));
      }
    } catch (err) {
      toast('保存异常: ' + err.message);
    }
  });
}
function render() {
  for (const page of ['workspace', 'compare', 'config']) $(`#${page}-nav`).classList.toggle('active', state.page === page);
  $('#page-title').textContent = { workspace: '会议工作台', compare: '实验对照', config: '模型与规则' }[state.page];
  history();
  if (state.page === 'compare') renderCompare(); else if (state.page === 'config') renderConfig(); else if (state.run) renderRun(); else renderNew();
}
let runEventSource = null;
function disconnectEventSource() {
  if (runEventSource) {
    runEventSource.close();
    runEventSource = null;
  }
}
function connectEventSource(runId) {
  if (!runId || (runEventSource && runEventSource.__runId === runId)) return;
  disconnectEventSource();
  const es = new EventSource(`/api/runs/${runId}/stream`);
  es.__runId = runId;
  runEventSource = es;
  es.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      handleStreamEvent(data);
    } catch {}
  };
  es.onerror = () => {
    if (state.run && state.run.status !== 'running') disconnectEventSource();
  };
}
const typingStreams = new Map();
let typingTimer = null;
function ensureTypingLoop() {
  if (typingTimer) return;
  function tick() {
    let hasMore = false;
    for (const [streamId, item] of typingStreams.entries()) {
      const el = document.getElementById(streamId);
      if (!el) {
        typingStreams.delete(streamId);
        continue;
      }
      if (item.currentText.length < item.targetText.length) {
        hasMore = true;
        const diff = item.targetText.length - item.currentText.length;
        const step = diff > 80 ? 4 : diff > 30 ? 2 : 1;
        item.currentText += item.targetText.slice(item.currentText.length, item.currentText.length + step);
        el.innerHTML = `${escape(item.currentText)} <span class="thinking-cursor"></span>`;
        el.scrollTop = el.scrollHeight;
      } else if (item.done) {
        const cursor = el.querySelector('.thinking-cursor');
        if (cursor) cursor.remove();
        if (!el.querySelector('.thinking-done-notice')) {
          const doneNotice = document.createElement('div');
          doneNotice.className = 'thinking-done-notice';
          doneNotice.textContent = '✓ 思考完成，正在整理结构化正文...';
          el.appendChild(doneNotice);
          el.scrollTop = el.scrollHeight;
        }
        typingStreams.delete(streamId);
      }
    }
    if (hasMore || typingStreams.size > 0) {
      typingTimer = setTimeout(tick, 16);
    } else {
      typingTimer = null;
    }
  }
  typingTimer = setTimeout(tick, 16);
}
function feedTypingStream(streamId, text, isDone = false) {
  let item = typingStreams.get(streamId);
  if (!item) {
    const el = document.getElementById(streamId);
    const existing = el ? el.textContent.replace('✓ 思考完成，正在整理结构化正文...', '').trim() : '';
    item = { targetText: text || '', currentText: existing && text.startsWith(existing) ? existing : '', done: false };
    typingStreams.set(streamId, item);
  } else {
    item.targetText = text || item.targetText;
  }
  if (isDone) item.done = true;
  ensureTypingLoop();
}
function getStructuralFingerprint(run) {
  if (!run) return '';
  return [
    run.id,
    run.status,
    run.phase,
    run.round,
    (run.raw_responses || []).map(r => `${r.round}-${r.seat_id}:${r.status}`).join(','),
    (run.memos || []).map(m => `${m.seat_id}:${m.status}`).join(','),
    (run.snapshots || []).length,
    Boolean(run.final),
    run.error || ''
  ].join('::');
}
function updateHeaderMeta(r) {
  if (!r || !r.metrics) return;
  const m = r.metrics;
  const metaEl = document.querySelector('.run-header-meta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="status-badge ${r.status}">● ${statusNames[r.status] || r.status}</span>
      <span>阶段：<strong>${escape(r.phase)}</strong></span>
      <span>模式：${r.mode === 'mock' ? '模拟演示' : '真实模型'}</span>
      <span>调用进度：${m.completed_calls ?? 0} / ${m.expected_calls}</span>
      <span>累计耗时：${Math.round((m.duration_ms || 0) / 1000)} 秒</span>
      ${m.estimated_cost != null ? `<span>预估费用：${m.estimated_cost.toFixed(4)}</span>` : ''}
    `;
  }
}
function handleStreamEvent(data) {
  if (!state.run || state.run.id !== data.run_id) return;

  if (data.event === 'thinking') {
    if (data.phase === 'creative') {
      let resp = state.run.raw_responses?.find(x => x.round === data.round && x.seat_id === data.seat_id);
      if (resp) { resp.thinking = data.text; resp.status = 'running'; }
    } else if (data.phase === 'decision') {
      let memo = state.run.memos?.find(m => m.seat_id === data.seat_id);
      if (memo) { memo.thinking = data.text; memo.status = 'running'; }
    } else if (data.phase === 'chair') {
      state.run.chair_thinking = data.text;
    }

    let streamId = null, cardId = null;
    if (data.phase === 'creative') {
      streamId = `stream-R${data.round}-${data.seat_id}`;
      cardId = `card-R${data.round}-${data.seat_id}`;
    } else if (data.phase === 'decision') {
      streamId = `stream-memo-${data.seat_id}`;
      cardId = `memo-card-${data.seat_id}`;
    } else if (data.phase === 'chair') {
      streamId = 'stream-chair';
    }

    const streamEl = streamId ? document.getElementById(streamId) : null;
    if (streamEl) {
      feedTypingStream(streamId, data.text);
    } else if (cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        if (!card.querySelector('.thinking-block-active')) {
          card.classList.add('card-running');
          card.classList.remove('card-failed');
          const title = data.phase === 'decision' ? '完善机制方案思考中...' : '深度思考中 (Thinking)...';
          const headerHtml = `
            <div class="thinking-block-active">
              <div class="thinking-header">
                <div class="thinking-title">
                  <span class="pulse-indicator"></span>
                  <span>${title}</span>
                </div>
                <span class="thinking-timer" data-start="${Date.now()}">已思考 1s</span>
              </div>
              <div class="thinking-stream" id="${streamId}"><span class="thinking-cursor"></span></div>
            </div>
            <div class="seat-body-waiting"><span>⚡ 思考结束后显示正文</span></div>
          `;
          card.querySelectorAll('.seat-body, .seat-body-waiting, details.thinking-completed').forEach(e => e.remove());
          card.insertAdjacentHTML('beforeend', headerHtml);
          feedTypingStream(streamId, data.text);
        }
      } else {
        refresh();
      }
    }
  } else if (data.event === 'thinking_done') {
    let streamId = null;
    if (data.phase === 'creative') streamId = `stream-R${data.round}-${data.seat_id}`;
    else if (data.phase === 'decision') streamId = `stream-memo-${data.seat_id}`;
    else if (data.phase === 'chair') streamId = 'stream-chair';
    if (streamId) {
      feedTypingStream(streamId, data.text, true);
    }
    setTimeout(refresh, 250);
  }
}
async function openRun(id) {
  loading = true;
  typingStreams.clear();
  try {
    state.run = await api(`/api/runs/${id}`);
    state.page = 'workspace';
    state.round = null;
    state.filter = '';
    state.tab = state.run.final ? 'answer' : 'board';
    state.fingerprint = getStructuralFingerprint(state.run);
    location.hash = id;
    render();
    if (state.run.status === 'running') connectEventSource(id);
    else disconnectEventSource();
  }
  finally { loading = false; }
}
function saveDraft() { if (!$('#run-form')) return; for (const key of ['problem', 'constraints', 'experiment']) { const el = $(`#${key}`); if (el) state.draft[key] = el.value; } const seedEl = $('#seed'); if (seedEl) state.draft.seed = Number(seedEl.value); const opEl = $('#use-operators'); if (opEl) state.draft.use_operators = opEl.checked; state.draft.mode = 'live'; }
function newRun() { typingStreams.clear(); disconnectEventSource(); saveDraft(); state.page = 'workspace'; state.run = null; location.hash = ''; render(); }
$('#new-run').addEventListener('click', newRun);
for (const page of ['workspace', 'compare', 'config']) $(`#${page}-nav`).addEventListener('click', () => { saveDraft(); state.page = page; render(); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
document.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('#help-dialog').open) newRun(); });
document.addEventListener('click', async e => {
  try {
    const runButton = e.target.closest('[data-run]'); if (runButton) return await openRun(runButton.dataset.run);
    const proposal = e.target.closest('[data-proposal]');
    if (proposal) {
      const id = proposal.dataset.proposal;
      const target = document.getElementById('prop-' + id) || document.getElementById('rank-' + id);
      if (target) { target.setAttribute('open', ''); target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      return;
    }
    if (e.target.closest('#load-example')) { $('#problem').value = '设计一个轻量的合作玩法：让 2–4 名玩家在有限资源下不断做出有意义的选择，并且每局能够形成不同的策略。'; $('#constraints').value = '单局不超过 10 分钟\n核心机制可以在两周内做成可体验原型\n不依靠大量剧情或美术内容维持重复体验'; saveDraft(); }
    if (e.target.closest('#jump-to-config-btn')) { saveDraft(); state.page = 'config'; render(); return; }
    if (e.target.closest('#cancel-run')) { disconnectEventSource(); await api(`/api/runs/${state.run.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('正在停止，已完成的记录会保留'); }
  } catch (err) { toast(err.message); }
});
document.addEventListener('change', e => { if (e.target.id === 'experiment') { saveDraft(); renderNew(); } });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'run-form') return; e.preventDefault(); saveDraft();
  const button = e.target.querySelector('[type="submit"]'); button.disabled = true; button.textContent = '正在创建…';
  try { const d = state.draft; const run = await api('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...d, mode: 'live', constraints: d.constraints.split('\n').map(c => c.trim()).filter(Boolean) }) }); state.activeId = run.id; await openRun(run.id); await refresh(); }
  catch (err) { toast(err.message); renderNew(); }
});
async function refresh() {
  if (polling || loading) return; polling = true;
  try {
    const list = await api('/api/runs');
    const changed = JSON.stringify(list.runs) !== JSON.stringify(state.runs);
    const priorActive = state.activeId; state.runs = list.runs; state.activeId = list.activeId; if (changed) history();
    if (state.run && state.page === 'workspace') {
      const id = state.run.id, run = await api(`/api/runs/${id}`);
      if (state.run?.id !== id || loading || state.page !== 'workspace') return;
      if (run.status === 'running') connectEventSource(id);
      else disconnectEventSource();
      state.run = run;
      updateHeaderMeta(run);
      const fp = getStructuralFingerprint(run);
      if (fp !== state.fingerprint) {
        const open = [...document.querySelectorAll('details[open][id]')].map(d => d.id), scroll = window.scrollY;
        state.fingerprint = fp;
        renderRun();
        for (const id of open) document.getElementById(id)?.setAttribute('open', '');
        window.scrollTo(0, scroll);
      }
    } else if (state.page === 'compare' && changed) renderCompare();
    else if (state.page === 'workspace' && !state.run && priorActive !== state.activeId) { saveDraft(); renderNew(); }
  } catch (err) { $('#page-title').textContent = '连接中断 · 正在重试'; }
  finally { polling = false; }
}
setInterval(() => {
  if (state.run && state.run.status === 'running') {
    document.querySelectorAll('.thinking-timer[data-start]').forEach(el => {
      const start = Number(el.dataset.start);
      if (start) {
        const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
        el.textContent = `已思考 ${sec}s`;
      }
    });
  }
}, 1000);
try {
  state.config = await api('/api/config'); await refresh();
  if (/^#run-[a-zA-Z0-9-]+$/.test(location.hash)) await openRun(location.hash.slice(1)); else render();
  setInterval(refresh, 1400);
} catch (err) { $('#main').innerHTML = `<div class="error-box">工作台无法加载：${escape(err.message)}。请检查本地服务后刷新页面。</div>`; }
