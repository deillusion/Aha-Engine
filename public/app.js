const $ = s => document.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = n => n == null ? '—' : Number(n).toLocaleString('zh-CN');
const percent = n => n == null ? '—' : `${Math.round(n * 100)}%`;
const statusNames = { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' };
// Keep the retired phase label for existing run archives.
const phaseNames = { creative: '创意发言', extractor: '提取观点（旧版）', dedup: '去重合并', decision: '完善候选方案', chair: '方案排序', direct: '直接回答' };
const state = { page: 'workspace', runs: [], run: null, config: null, activeId: null, tab: 'board', round: null, filter: '', fingerprint: '', historyMode: 'live', compareMode: 'live', draft: { problem: '', constraints: '', mode: 'live', experiment: 'treatment', seed: 20260909, max_mechanisms: 3, use_operators: true, use_domain_operators: false } };
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
  const liveRuns = state.runs.filter(r => r.mode !== 'mock');
  const mockRuns = state.runs.filter(r => r.mode === 'mock');

  if ($('#live-count')) $('#live-count').textContent = liveRuns.length;
  if ($('#mock-count')) $('#mock-count').textContent = mockRuns.length;
  if ($('#all-count')) $('#all-count').textContent = state.runs.length;

  const currentMode = state.historyMode || 'live';
  const targetRuns = currentMode === 'live' ? liveRuns : (currentMode === 'mock' ? mockRuns : state.runs);

  $('#history-count').textContent = targetRuns.length;
  document.querySelectorAll('#history-mode-tabs .history-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });

  const emptyText = currentMode === 'live' ? '暂无真实会议记录' : (currentMode === 'mock' ? '暂无模拟记录' : '会议记录会保存在这里');
  $('#history').innerHTML = targetRuns.length
    ? targetRuns.slice(0, 40).map(r => `<button class="history-item ${state.run?.id === r.id ? 'selected' : ''}" data-run="${escape(r.id)}"><div class="history-title">${escape(r.problem)}</div><div class="history-meta"><span class="status-${r.status}">● ${statusNames[r.status] || r.status}</span><span>${r.mode === 'mock' ? '模拟' : '真实'} · ${new Date(r.started_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></div></button>`).join('')
    : `<div class="small-note" style="padding:10px 12px">${emptyText}</div>`;
}
function heading(eyebrow, title, subtitle, right = '') { return `<div class="heading-row"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${right}</div>`; }
function getNextSeatId(existingSeats) {
  let num = existingSeats.length + 1;
  const ids = new Set(existingSeats.map(s => s.id));
  while (ids.has(`S${num}`)) {
    num++;
  }
  return `S${num}`;
}
function getSessionSeatsAndRoles() {
  const baseCfg = activeConfig() ?? state.config?.mockConfig ?? { seats: [], models: [], roles: {} };
  const hasCustomSeats = Array.isArray(state.draft.customSeats);
  const hasCustomRoles = state.draft.customRoles && typeof state.draft.customRoles === 'object';
  const seats = hasCustomSeats ? structuredClone(state.draft.customSeats) : structuredClone(baseCfg.seats || []);
  const roles = hasCustomRoles ? { ...(baseCfg.roles || {}), ...state.draft.customRoles } : structuredClone(baseCfg.roles || {});
  return {
    seats,
    roles,
    isCustomized: hasCustomSeats || hasCustomRoles,
    models: baseCfg.models || []
  };
}
function seats(config) {
  return `<div class="seat-grid">${(config.seats || []).map(s => `<div class="seat" data-model="${escape(s.modelId)}"><strong>${escape(s.id)}</strong><small>${escape(s.modelId)}</small></div>`).join('')}</div>`;
}
function renderNew() {
  const d = state.draft;
  const { seats: effectiveSeats, roles: effectiveRoles, isCustomized, models } = getSessionSeatsAndRoles();
  const dealerCall = d.use_operators && d.use_domain_operators && ['treatment', 'independent', 'single'].includes(d.experiment) ? 1 : 0;
  const calls = d.experiment === 'direct' ? 1 : d.experiment === 'single' ? effectiveSeats.length + 1 + dealerCall : effectiveSeats.length * 6 + 6 + dealerCall;
  $('#main').innerHTML = `${heading('A LITTLE DIFFERENCE. A BETTER IDEA.', '给好想法，多一点碰撞。', '把一个开放式问题，交给不同视角共同思考。', '<span class="badge"><span class="online-dot"></span> 工作台已就绪</span>')}
    <div class="workspace-grid"><div><form id="run-form" class="card"><div class="card-head"><h2><span class="step">01</span> 定义这次讨论</h2><small>从一个值得探索的问题开始</small></div>
    <div class="form-body"><div class="field"><label class="field-label" for="problem">你想解决什么问题？<button type="button" class="example-button" id="load-example">试试一个玩法设计问题 ↗</button></label><textarea id="problem" name="problem" required maxlength="20000" placeholder="例如：设计一个轻量的合作玩法，让玩家在每一局中都能做出有意义的选择……">${escape(d.problem)}</textarea></div>
    <div class="field"><label class="field-label" for="constraints">必须遵守的约束 <small>选填 · 每行一条</small></label><textarea id="constraints" name="constraints" placeholder="单局不超过 10 分钟&#10;两周内可以验证核心机制">${escape(d.constraints)}</textarea></div>
    <div class="form-row form-row-3"><div><label class="field-label" for="experiment">实验方案</label><select id="experiment" name="experiment">${Object.entries(state.config.experiments).map(([id, e]) => `<option value="${id}" ${id === d.experiment ? 'selected' : ''}>${escape(e.name)}</option>`).join('')}</select></div><div class="seed-field"><label class="field-label" for="seed">随机种子</label><input id="seed" name="seed" type="number" min="0" max="2147483647" value="${d.seed}" required></div><div class="seed-field"><label class="field-label" for="max-mechanisms" title="每个方案装配的核心原子机制上限（防齐德龙东强缝合怪）">机制上限</label><input id="max-mechanisms" name="max_mechanisms" type="number" min="1" max="10" value="${d.max_mechanisms ?? 3}" required></div></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px">
      <label class="check-line"><input type="checkbox" id="use-operators" name="use_operators" ${d.use_operators ? 'checked' : ''}> 使用随机思维刺激 <span class="muted">· 关闭可进行消融对照</span></label>
      <label class="check-line"><input type="checkbox" id="use-domain-operators" name="use_domain_operators" ${d.use_domain_operators ? 'checked' : ''}> 启用行业诊断视角 <span class="muted">· Dealer 按适用范围选择，默认关闭</span></label>
    </div>
    ${!state.config.liveConfig ? `
      <div class="info-box stack-gap" style="background:#fff8e6;border:1px solid #f2da99;color:#7a5a15;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:8px">
        <div>
          <b style="display:block;margin-bottom:2px">⚠️ 尚未配置任何模型 API Key</b>
          <span style="font-size:11.5px">只需配置其中任意 1 个模型，系统即可自适应调度 ${effectiveSeats.length} 席开始会议。</span>
        </div>
        <button type="button" class="button secondary" id="jump-to-config-btn" style="padding:5px 12px;font-size:11.5px;white-space:nowrap">👉 前往配置 (只需填1个)</button>
      </div>` : ''}</div>
    <div class="form-bottom"><p>将问题发送至已配置的模型服务，按服务商计费。<br>本次 ${calls} 次模型调用起 · ${escape(state.config.experiments[d.experiment].description)}</p><button type="submit" class="primary" ${state.activeId || !state.config.liveConfig ? 'disabled' : ''}>${state.activeId ? '已有会议运行中' : '开始会议'} <span>→</span></button></div></form>
    <div class="lower-note"><span>每轮独立发言</span><span>完整过程可追溯</span><span>会议记录保存在本地</span></div></div>
    <aside class="right-rail">
      <section class="card rail-card">
        <div class="rail-card-head">
          <div>
            <span class="eyebrow">THE TABLE · 本次会话席位</span>
            <h3 style="margin-top:4px">${effectiveSeats.length} 个席位 · 多维协同</h3>
          </div>
          ${isCustomized ? `<span class="badge custom-badge" title="当前为本次会话专属配置，下次新建会议将自动恢复默认">本次自定义</span>` : `<span class="badge default-badge" title="当前遵循「模型与规则」全局默认配置">默认配置</span>`}
        </div>
        <p style="margin:6px 0 10px;font-size:10.5px;color:#7c8c76">同一问题独立思考；可为本次会议增删席位或调整裁决角色。</p>
        
        <div class="home-seats-list" id="home-seats-list">
          ${effectiveSeats.map((s, idx) => `
            <div class="home-seat-row">
              <input type="text" class="home-seat-id-input" data-idx="${idx}" value="${escape(s.id)}" maxlength="12" title="席位标识">
              <select class="home-seat-model-select" data-idx="${idx}">
                ${models.map(m => `<option value="${escape(m.id)}" ${s.modelId === m.id ? 'selected' : ''}>${escape(m.id)} ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
              <button type="button" class="home-seat-del-btn" data-idx="${idx}" title="删除该席位" ${effectiveSeats.length <= 1 ? 'disabled style="visibility:hidden"' : ''}>×</button>
            </div>
          `).join('')}
        </div>

        <div class="home-seats-actions">
          <button type="button" class="button secondary mini-btn" id="home-add-seat-btn">➕ 添加席位</button>
          <button type="button" class="button secondary mini-btn" id="home-balance-seats-btn">⚡ 均匀排席</button>
          ${isCustomized ? `<button type="button" class="home-reset-link" id="home-reset-seats-btn" title="放弃本次自定义，恢复为默认配置">↺ 恢复默认</button>` : ''}
        </div>

        <details class="home-roles-details" ${isCustomized && state.draft.customRoles ? 'open' : ''}>
          <summary>
            <span>⚖️ 裁决角色设置</span>
            <span style="font-size:9.5px;color:#7f917a">${escape(effectiveRoles.chair || '')} / ${escape(effectiveRoles.dedup || '')}</span>
          </summary>
          <div class="home-roles-body">
            <div class="home-role-field">
              <label>Chair 排序裁决模型</label>
              <select id="home-role-chair">
                ${models.map(m => `<option value="${escape(m.id)}" ${effectiveRoles.chair === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
            </div>
            <div class="home-role-field">
              <label>Dedup 观点去重模型</label>
              <select id="home-role-dedup">
                ${models.map(m => `<option value="${escape(m.id)}" ${effectiveRoles.dedup === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
            </div>
            <div class="home-role-field">
              <label>Dealer 算子发卡模型</label>
              <select id="home-role-dealer">
                ${models.map(m => `<option value="${escape(m.id)}" ${(effectiveRoles.dealer || effectiveRoles.chair) === m.id ? 'selected' : ''}>${escape(m.id)} (${escape(m.model)}) ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
              </select>
            </div>
          </div>
        </details>

        <div class="home-seats-note">
          💡 <b>会话独有生效</b>：此处增删改席位与角色仅对本次会议生效；下次新建会议自动恢复默认配置。
        </div>
      </section>
      <section class="card rail-card">
        <span class="eyebrow">HOW IT WORKS</span>
        <div class="timeline">
          <div class="timeline-item"><span class="timeline-number">1</span><div><h4>独立思考 · 5 轮</h4><p>原子观点去重，完整方案独立保存并持续修订。</p></div></div>
          <div class="timeline-item"><span class="timeline-number">2</span><div><h4>完善方案 · 第 6 轮</h4><p>各席位读取完整方案，补全机制与验证办法。</p></div></div>
          <div class="timeline-item"><span class="timeline-number">3</span><div><h4>所有方案交给你选择</h4><p>Chair 只做排序，方案正文原样保留。</p></div></div>
        </div>
      </section>
      <div class="principle"><strong>保留分歧，也保留可能性。</strong>不同结论可以同时存在。让因果、约束与可执行性决定最终选择。</div>
    </aside></div>`;

  // Bind Home seat & role interactive events
  document.querySelectorAll('.home-seat-model-select').forEach(sel => {
    sel.addEventListener('change', () => {
      saveDraft();
      const current = getSessionSeatsAndRoles();
      const idx = Number(sel.dataset.idx);
      if (current.seats[idx]) {
        current.seats[idx].modelId = sel.value;
        state.draft.customSeats = current.seats;
        renderNew();
      }
    });
  });

  document.querySelectorAll('.home-seat-id-input').forEach(inp => {
    inp.addEventListener('change', () => {
      saveDraft();
      const current = getSessionSeatsAndRoles();
      const idx = Number(inp.dataset.idx);
      const val = inp.value.trim();
      if (val && /^[A-Za-z0-9_-]+$/.test(val) && current.seats[idx]) {
        const otherExists = current.seats.some((s, i) => i !== idx && s.id === val);
        if (otherExists) {
          toast(`⚠️ 席位标识 "${val}" 已存在，请使用唯一标识`);
          inp.value = current.seats[idx].id;
          return;
        }
        current.seats[idx].id = val;
        state.draft.customSeats = current.seats;
      } else if (val) {
        toast('⚠️ 席位标识仅支持英文字母、数字、下划线和短横线');
        inp.value = current.seats[idx]?.id || `S${idx + 1}`;
        return;
      }
      renderNew();
    });
  });

  document.querySelectorAll('.home-seat-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      saveDraft();
      const current = getSessionSeatsAndRoles();
      if (current.seats.length <= 1) {
        toast('⚠️ 至少保留 1 个席位');
        return;
      }
      const idx = Number(btn.dataset.idx);
      const delId = current.seats[idx]?.id;
      current.seats.splice(idx, 1);
      state.draft.customSeats = current.seats;
      renderNew();
      toast(`已移除席位 ${delId}（本次会话生效）`);
    });
  });

  $('#home-add-seat-btn')?.addEventListener('click', () => {
    saveDraft();
    const current = getSessionSeatsAndRoles();
    if (current.seats.length >= 32) {
      toast('⚠️ 最多支持 32 个席位');
      return;
    }
    const nextId = getNextSeatId(current.seats);
    const activeM = current.models.find(m => m.hasKey) || current.models[0];
    current.seats.push({ id: nextId, modelId: activeM ? activeM.id : 'GLM' });
    state.draft.customSeats = current.seats;
    renderNew();
    toast(`➕ 已添加席位 ${nextId}（本次会话生效）`);
  });

  $('#home-balance-seats-btn')?.addEventListener('click', () => {
    saveDraft();
    const current = getSessionSeatsAndRoles();
    const active = current.models.filter(m => m.hasKey);
    const pool = active.length > 0 ? active : current.models;
    if (pool.length === 0) return;
    const counts = new Map(pool.map(m => [m.id, 0]));
    current.seats.forEach(s => {
      let minCount = Infinity;
      let targetId = pool[0].id;
      for (const m of pool) {
        const c = counts.get(m.id) || 0;
        if (c < minCount) {
          minCount = c;
          targetId = m.id;
        }
      }
      s.modelId = targetId;
      counts.set(targetId, minCount + 1);
    });
    state.draft.customSeats = current.seats;
    renderNew();
    toast(`✅ 已按 ${pool.length} 个模型完成 ${current.seats.length} 席均匀排席（本次会话生效）`);
  });

  $('#home-reset-seats-btn')?.addEventListener('click', () => {
    saveDraft();
    state.draft.customSeats = null;
    state.draft.customRoles = null;
    renderNew();
    toast('↺ 已恢复全局默认席位与裁决角色配置');
  });

  ['chair', 'dedup', 'dealer'].forEach(role => {
    $(`#home-role-${role}`)?.addEventListener('change', e => {
      saveDraft();
      const current = getSessionSeatsAndRoles();
      current.roles[role] = e.target.value;
      state.draft.customRoles = current.roles;
      renderNew();
      toast(`已更新 ${role} 裁决模型为 ${e.target.value}（本次会话生效）`);
    });
  });
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
                <b>📜 方案：${escape(p.title)}</b>
                ${Array.isArray(p.mechanisms) && p.mechanisms.length ? `<div style="font-size:9.5px;color:#3b6546;margin:2px 0 4px">⚙️ ${escape(p.mechanisms.join(' + '))}</div>` : ''}
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
              ${Array.isArray(p?.mechanisms) && p.mechanisms.length ? `
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0 10px">
                  <span class="small-note" style="color:#4a6147;font-weight:600">采用机制：</span>
                  ${p.mechanisms.map(m => `<span class="chip" style="background:#eaf2e8;color:#2b5438;border:1px solid #d0e2ce;font-weight:600">⚙️ ${escape(m)}</span>`).join('')}
                </div>` : ''}
              ${row.summary ? `
                <div class="ranking-summary">
                  <strong style="color:#265c36">📌 核心速览（一句话）：</strong>${escape(row.summary)}
                </div>` : ''}
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
  const currentMode = state.compareMode || 'live';
  const liveCount = state.runs.filter(r => r.mode !== 'mock').length;
  const mockCount = state.runs.filter(r => r.mode === 'mock').length;
  const filteredRuns = currentMode === 'live'
    ? state.runs.filter(r => r.mode !== 'mock')
    : currentMode === 'mock'
      ? state.runs.filter(r => r.mode === 'mock')
      : state.runs;

  $('#main').innerHTML = `${heading('COMPARE THE EVIDENCE', '同一个问题，不同的思考方式。', '比较实际用量与结果，再判断多轮协作是否值得。')}
  <div class="info-box">调用次数相同不代表 token 或费用相同。请比较同一问题、相同模型配置和多个种子的真实运行；模拟数据不能用于质量结论。导出答案后可隐藏实验名称交给独立评审。</div>
  <div class="compare-filter-bar">
    <div class="history-mode-tabs">
      <button type="button" class="history-tab-btn ${currentMode === 'live' ? 'active' : ''}" data-compare-mode="live">真实运行 <span>${liveCount}</span></button>
      <button type="button" class="history-tab-btn ${currentMode === 'mock' ? 'active' : ''}" data-compare-mode="mock">模拟记录 <span>${mockCount}</span></button>
      <button type="button" class="history-tab-btn ${currentMode === 'all' ? 'active' : ''}" data-compare-mode="all">全部 <span>${state.runs.length}</span></button>
    </div>
  </div>
  <section class="card table-wrap"><table><thead><tr><th>问题 / 运行</th><th>实验</th><th>模式 / 状态</th><th>调用</th><th>Tokens</th><th>耗时</th><th>排序覆盖 / 旧版采用</th></tr></thead><tbody>${filteredRuns.map(r => `<tr><td><button class="example-button compare-problem" data-run="${r.id}" title="${escape(r.problem)}">${escape(r.problem)}</button><div class="small-note">Seed ${r.seed}</div></td><td>${escape(state.config.experiments[r.experiment]?.name)}${!r.use_operators ? '<br><span class="small-note">无思维刺激</span>' : ''}</td><td>${r.mode === 'mock' ? '模拟' : '真实'} · ${statusNames[r.status]}</td><td>${r.metrics.attempted_calls}</td><td>${r.metrics.input_tokens == null ? '—' : number(r.metrics.input_tokens + r.metrics.output_tokens)}</td><td>${Math.round((r.metrics.duration_ms ?? 0) / 1000)}s</td><td>${r.workflow_version === 2 ? (r.experiment === 'direct' ? '不适用' : `${r.metrics.ranked_proposals} / ${r.metrics.proposal_count}`) : percent(r.metrics.late_round_value)}</td></tr>`).join('') || `<tr><td colspan="7">${currentMode === 'live' ? '暂无真实会议记录。' : currentMode === 'mock' ? '暂无模拟记录。' : '还没有会议记录。'}先新建一次会议。</td></tr>`}</tbody></table></section>`;
}
const MODEL_PRESETS = [
  {
    label: 'DeepSeek 官方',
    icon: '🐳',
    id: 'DEEPSEEK',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    modelsList: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash']
  },
  {
    label: '智谱清言 GLM',
    icon: '🔮',
    id: 'GLM',
    model: 'GLM-5.3-Flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    reasoningEffortMap: { medium: 'high' },
    modelsList: ['GLM-5.3-Flash', 'glm-5-plus', 'glm-5-turbo']
  },
  {
    label: 'Google Gemini',
    icon: '✨',
    id: 'GEMINI',
    model: 'gemini-3.7-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'chat',
    structuredOutput: 'json_schema',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    maxOutputTokens: 65536,
    maxConcurrent: 1,
    requestIntervalMs: 2500,
    modelsList: ['gemini-3.7-flash', 'gemini-3.0-pro', 'gemini-2.5-flash']
  },
  {
    label: 'Anthropic Claude',
    icon: '🧠',
    id: 'CLAUDE',
    model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    modelsList: ['claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-4-opus']
  },
  {
    label: 'OpenAI 官方',
    icon: '🟢',
    id: 'OPENAI',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_completion_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: true,
    modelsList: ['gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'o4-mini']
  },
  {
    label: '硅基流动 SiliconFlow',
    icon: '⚡',
    id: 'SILICONFLOW',
    model: 'deepseek-ai/DeepSeek-V4',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    modelsList: ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-72B', 'deepseek-ai/DeepSeek-V4-Flash']
  },
  {
    label: '通义千问 DashScope',
    icon: '☁️',
    id: 'QWEN',
    model: 'qwen-3-max',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    modelsList: ['qwen-3-max', 'qwen-3-72b', 'qwen-3-plus']
  },
  {
    label: '月之暗面 Kimi',
    icon: '🌙',
    id: 'MOONSHOT',
    model: 'kimi-k2',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    modelsList: ['kimi-k2', 'moonshot-v1-32k', 'moonshot-v1-128k']
  },
  {
    label: '本地 Ollama / vLLM',
    icon: '🦙',
    id: 'OLLAMA',
    model: 'qwen3:72b',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: false,
    supportsSeed: false,
    isKeyless: true,
    modelsList: ['deepseek-v4', 'qwen3:72b', 'llama4:70b']
  },
  {
    label: '自定义端点',
    icon: '🛠️',
    id: 'CUSTOM',
    model: '',
    baseUrl: 'https://',
    protocol: 'chat',
    structuredOutput: 'json_object',
    tokenParameter: 'max_tokens',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false
  }
];

function openModelModal(modelData = {}, isEdit = false) {
  const dialog = $('#model-dialog');
  if (!dialog) return;

  const m = structuredClone(modelData);
  let targetId = m.id || '';
  const c = state.config.liveConfig ?? state.config.mockConfig;
  if (!isEdit) {
    const existingIds = new Set((c.models || []).map(x => x.id));
    if (existingIds.has(targetId) || !targetId) {
      let candidate = targetId || 'NEW_MODEL';
      let count = 2;
      while (existingIds.has(candidate)) {
        candidate = `${targetId || 'NEW_MODEL'}_${count++}`;
      }
      targetId = candidate;
    }
  }

  const defaultModelsList = m.modelsList || [];

  dialog.innerHTML = `
    <div class="modal-header">
      <h3>${isEdit ? `✏️ 编辑模型 · ${escape(targetId)}` : '➕ 添加大模型配置'}</h3>
      <button type="button" class="dialog-close" id="modal-close-x">×</button>
    </div>
    <div class="modal-body">
      <div class="form-field">
        <label>模型唯一 ID <span class="field-hint">仅限字母、数字、下划线和短横线</span></label>
        <input type="text" id="modal-field-id" value="${escape(targetId)}" ${isEdit ? 'readonly style="background:#f0f4ee;color:#576b54"' : ''} placeholder="如 SILICONFLOW, QWEN_PLUS">
      </div>

      <div class="form-field">
        <label>API 协议与服务商格式</label>
        <select id="modal-field-protocol">
          <option value="chat" ${m.protocol !== 'gemini' ? 'selected' : ''}>chat (OpenAI 兼容 /v1/chat/completions)</option>
          <option value="gemini" ${m.protocol === 'gemini' ? 'selected' : ''}>gemini (Google Gemini 原生 generateContent)</option>
        </select>
      </div>

      <div class="form-field">
        <label>服务端点 Base URL</label>
        <input type="text" id="modal-field-baseUrl" value="${escape(m.baseUrl || 'https://')}" placeholder="https://api.example.com/v1">
      </div>

      <div class="form-field" id="modal-field-group-key">
        <label>API Key 密钥凭据 ${m.isKeyless || (m.baseUrl && (m.baseUrl.includes('localhost') || m.baseUrl.includes('127.0.0.1'))) ? '<span class="field-hint">(本地服务免 Key)</span>' : '<span class="field-hint key-required-hint">(* 探测模型与调用必需)</span>'}</label>
        <div class="input-with-action">
          <input type="password" id="modal-field-apiKey" value="${m.apiKey && !m.apiKey.includes('•••') ? escape(m.apiKey) : ''}" placeholder="${m.hasKey ? (m.maskedKey || '已配置密钥 (留空保持不变)') : '输入 API Key (如 sk-...)'}">
          <button type="button" class="config-icon-btn" id="modal-toggle-key-btn" title="显示/隐藏明文">👁️</button>
        </div>
      </div>

      <div class="form-field">
        <label>模型名称 (Model Identifier)</label>
        <div class="input-with-action">
          <input type="text" id="modal-field-model" value="${escape(m.model || '')}" placeholder="如 deepseek-flash, gpt-5, claude-sonnet-4-5">
          <button type="button" class="button secondary" id="modal-discover-btn" style="padding:7px 11px;font-size:11.5px;white-space:nowrap" title="探测端点模型需先在上方输入 API Key">🔍 探测端点可用模型</button>
        </div>
        <div class="field-hint" style="margin-top:2px">💡 提示：云端服务商需先输入上方 API Key 才能探测模型列表；本地 Ollama 可直接探测。</div>
        <div id="modal-discover-box" class="discover-results hidden"></div>
        ${defaultModelsList.length ? `
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px">
            <span class="field-hint" style="align-self:center">推荐选型：</span>
            ${defaultModelsList.map(name => `<button type="button" class="preset-pill modal-quick-model" data-name="${escape(name)}" style="padding:2px 7px;font-size:10px">${escape(name)}</button>`).join('')}
          </div>
        ` : ''}
      </div>

      <div>
        <button type="button" class="advanced-toggle-btn" id="modal-toggle-adv">
          <span id="modal-adv-icon">▶</span> 高级参数与性能配额 (Token 上限、并发度、输出格式)
        </button>
        <div id="modal-adv-box" class="advanced-box hidden">
          <div class="form-field">
            <label>结构化输出模式</label>
            <select id="modal-field-structuredOutput">
              <option value="json_object" ${m.structuredOutput === 'json_object' ? 'selected' : ''}>json_object (推荐通用)</option>
              <option value="json_schema" ${m.structuredOutput === 'json_schema' ? 'selected' : ''}>json_schema (Gemini / OpenAI 严格模式)</option>
              <option value="prompt" ${m.structuredOutput === 'prompt' ? 'selected' : ''}>prompt (纯 Prompt 约束)</option>
            </select>
          </div>

          <div class="form-field">
            <label>Token 参数字段</label>
            <select id="modal-field-tokenParameter">
              <option value="max_tokens" ${m.tokenParameter !== 'max_completion_tokens' ? 'selected' : ''}>max_tokens</option>
              <option value="max_completion_tokens" ${m.tokenParameter === 'max_completion_tokens' ? 'selected' : ''}>max_completion_tokens</option>
            </select>
          </div>

          <div class="form-field">
            <label>单次最大输出上限 (maxOutputTokens)</label>
            <input type="number" id="modal-field-maxOutputTokens" value="${m.maxOutputTokens || ''}" placeholder="留空默认 131072">
          </div>

          <div class="form-field">
            <label>最大并发数限制 (maxConcurrent)</label>
            <input type="number" id="modal-field-maxConcurrent" value="${m.maxConcurrent || ''}" placeholder="留空无限制 (1–32)">
          </div>

          <div class="form-field">
            <label>请求间隔毫秒 (requestIntervalMs)</label>
            <input type="number" id="modal-field-requestIntervalMs" value="${m.requestIntervalMs || ''}" placeholder="如 2500，留空为 0">
          </div>

          <div style="grid-column:span 2;display:flex;flex-direction:column;gap:6px;margin-top:6px">
            <label class="checkbox-row">
              <input type="checkbox" id="modal-field-supportsReasoning" ${m.supportsReasoning !== false ? 'checked' : ''}>
              <span>支持深度推理与思考过程 (Reasoning / Thinking)</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" id="modal-field-supportsTemperature" ${m.supportsTemperature !== false ? 'checked' : ''}>
              <span>支持 Temperature 采样温度调节</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" id="modal-field-supportsSeed" ${m.supportsSeed ? 'checked' : ''}>
              <span>支持 Seed 确定性随机数种子</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" class="button secondary" id="modal-test-btn" style="padding:6px 12px;font-size:12px">⚡ 测试连通性</button>
        <span id="modal-probe-status" class="probe-status"></span>
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="button secondary" id="modal-cancel-btn">取消</button>
        <button type="button" class="button" id="modal-save-btn">保存模型</button>
      </div>
    </div>
  `;

  dialog.querySelectorAll('.modal-quick-model').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#modal-field-model').value = btn.dataset.name;
    });
  });

  $('#modal-toggle-adv').addEventListener('click', () => {
    const box = $('#modal-adv-box');
    const icon = $('#modal-adv-icon');
    const isHidden = box.classList.toggle('hidden');
    icon.textContent = isHidden ? '▶' : '▼';
  });

  $('#modal-toggle-key-btn').addEventListener('click', () => {
    const inp = $('#modal-field-apiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  const closeModal = () => { dialog.close(); };
  $('#modal-close-x').addEventListener('click', closeModal);
  $('#modal-cancel-btn').addEventListener('click', closeModal);

  $('#modal-discover-btn').addEventListener('click', async () => {
    const btn = $('#modal-discover-btn');
    const baseUrl = $('#modal-field-baseUrl').value.trim();
    const apiKey = $('#modal-field-apiKey').value.trim();
    const protocol = $('#modal-field-protocol').value;
    const box = $('#modal-discover-box');
    box.classList.remove('hidden');

    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      box.innerHTML = `<span style="font-size:11px;color:#a8332a">⚠️ 请先输入有效的服务端点 Base URL（需以 http:// 或 https:// 开头）</span>`;
      $('#modal-field-baseUrl').focus();
      return;
    }

    let isLocalUrl = false;
    try {
      const u = new URL(baseUrl);
      isLocalUrl = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0' || u.hostname === '::1';
    } catch {}

    const hasEffectiveKey = (apiKey && !apiKey.includes('•••')) || (m.hasKey && isEdit);

    if (!isLocalUrl && !hasEffectiveKey) {
      box.innerHTML = `
        <div class="discover-key-warning">
          <div style="font-weight:650;display:flex;align-items:center;gap:6px;margin-bottom:3px;color:#8a4200">
            <span>🔑 需要先填入 API Key 密钥凭据</span>
          </div>
          <div style="font-size:11px;color:#7a440b;line-height:1.4">
            该服务端点属于云端平台，<strong>必须先提供 API Key 身份凭据</strong>才能拉取端点支持的模型列表。<br>
            👉 <strong>请先在上方「API Key 密钥凭据」中输入您的 Key</strong>，然后再次点击此按钮探测。
          </div>
        </div>
      `;
      const keyInput = $('#modal-field-apiKey');
      keyInput.focus();
      keyInput.classList.add('input-highlight-pulse');
      setTimeout(() => keyInput.classList.remove('input-highlight-pulse'), 3000);
      toast('💡 探测云端模型需要 API Key，请先输入 Key');
      return;
    }

    btn.disabled = true;
    const originalBtnText = btn.innerHTML;
    btn.innerHTML = '<span>⏳ 探测中...</span>';
    box.innerHTML = `<span style="font-size:11px;color:#677d64">正在请求服务端点探测可用模型列表...</span>`;

    try {
      const res = await fetch('/api/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          apiKey: apiKey || (m.hasKey ? '__EXISTING__' : undefined),
          protocol,
          modelId: isEdit ? targetId : undefined
        })
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
        box.innerHTML = `
          <div style="font-size:10.5px;color:#35563e;font-weight:600;margin-bottom:4px">找到 ${data.models.length} 个可用模型（点击即选）：</div>
          ${data.models.slice(0, 40).map(mod => `
            <div class="discover-item" data-id="${escape(mod.id)}">
              <b>${escape(mod.id)}</b>
              <small style="color:#71876e">${escape(mod.name !== mod.id ? mod.name : '')}</small>
            </div>
          `).join('')}
        `;
        box.querySelectorAll('.discover-item').forEach(item => {
          item.addEventListener('click', () => {
            $('#modal-field-model').value = item.dataset.id;
            toast(`已选择模型: ${item.dataset.id}`);
          });
        });
      } else {
        if (data.needsKey || data.isAuthError) {
          const keyInput = $('#modal-field-apiKey');
          keyInput.focus();
          keyInput.classList.add('input-highlight-pulse');
          setTimeout(() => keyInput.classList.remove('input-highlight-pulse'), 3000);
        }
        box.innerHTML = `
          <div style="font-size:11px;color:#a8332a;padding:4px 0">
            <strong>⚠️ 探测未能获取模型列表：</strong><br>
            <span>${escape(data.error || '未返回模型或需认证')}</span>
          </div>
        `;
      }
    } catch (err) {
      box.innerHTML = `<span style="font-size:11px;color:#a8332a">⚠️ 探测请求失败: ${escape(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalBtnText;
    }
  });

  $('#modal-test-btn').addEventListener('click', async () => {
    const probe = $('#modal-probe-status');
    const typedKey = $('#modal-field-apiKey').value.trim();
    const baseUrl = $('#modal-field-baseUrl').value.trim();
    let isLocal = false;
    try {
      const u = new URL(baseUrl);
      isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {}

    if (!isLocal && !typedKey && !(m.hasKey && isEdit)) {
      probe.className = 'probe-status failed';
      probe.textContent = '✗ 缺少 API Key';
      const keyInput = $('#modal-field-apiKey');
      keyInput.focus();
      keyInput.classList.add('input-highlight-pulse');
      setTimeout(() => keyInput.classList.remove('input-highlight-pulse'), 3000);
      toast('💡 请先输入 API Key 再进行连通性测试');
      return;
    }

    probe.className = 'probe-status loading';
    probe.textContent = '测试中...';

    const draftConfig = {
      id: $('#modal-field-id').value.trim(),
      baseUrl: $('#modal-field-baseUrl').value.trim(),
      model: $('#modal-field-model').value.trim(),
      protocol: $('#modal-field-protocol').value,
      structuredOutput: $('#modal-field-structuredOutput').value,
      tokenParameter: $('#modal-field-tokenParameter').value,
      supportsTemperature: $('#modal-field-supportsTemperature').checked,
      supportsReasoning: $('#modal-field-supportsReasoning').checked,
      supportsSeed: $('#modal-field-supportsSeed').checked,
      maxOutputTokens: $('#modal-field-maxOutputTokens').value ? Number($('#modal-field-maxOutputTokens').value) : null,
      maxConcurrent: $('#modal-field-maxConcurrent').value ? Number($('#modal-field-maxConcurrent').value) : null,
      requestIntervalMs: $('#modal-field-requestIntervalMs').value ? Number($('#modal-field-requestIntervalMs').value) : null
    };

    try {
      const res = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelConfig: draftConfig,
          apiKey: typedKey || (m.hasKey ? undefined : '')
        })
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

  $('#modal-save-btn').addEventListener('click', () => {
    const id = $('#modal-field-id').value.trim();
    const baseUrl = $('#modal-field-baseUrl').value.trim();
    const model = $('#modal-field-model').value.trim();
    const protocol = $('#modal-field-protocol').value;
    const apiKey = $('#modal-field-apiKey').value.trim();

    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      alert('请输入合法的模型 ID（仅支持字母、数字、下划线和短横线）');
      return;
    }
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      alert('请输入有效的 HTTP(S) Base URL');
      return;
    }
    if (!model) {
      alert('请输入模型名称');
      return;
    }

    const c = state.config.liveConfig ?? state.config.mockConfig;
    const existingIndex = c.models.findIndex(x => x.id === (isEdit ? targetId : id));
    if (!isEdit && existingIndex >= 0) {
      alert(`模型 ID "${id}" 已存在，请更换 ID`);
      return;
    }

    const updatedModel = {
      ...(existingIndex >= 0 ? c.models[existingIndex] : {}),
      id,
      model,
      baseUrl,
      protocol,
      structuredOutput: $('#modal-field-structuredOutput').value,
      tokenParameter: $('#modal-field-tokenParameter').value,
      supportsTemperature: $('#modal-field-supportsTemperature').checked,
      supportsReasoning: $('#modal-field-supportsReasoning').checked,
      supportsSeed: $('#modal-field-supportsSeed').checked,
      maxOutputTokens: $('#modal-field-maxOutputTokens').value ? Number($('#modal-field-maxOutputTokens').value) : null,
      maxConcurrent: $('#modal-field-maxConcurrent').value ? Number($('#modal-field-maxConcurrent').value) : null,
      requestIntervalMs: $('#modal-field-requestIntervalMs').value ? Number($('#modal-field-requestIntervalMs').value) : null
    };

    if (apiKey) {
      updatedModel.apiKey = apiKey;
      updatedModel.hasKey = true;
      updatedModel.maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` : '••••••••';
    } else if (!isEdit) {
      const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
      if (isLocal) {
        updatedModel.isKeyless = true;
        updatedModel.hasKey = true;
      }
    }

    if (existingIndex >= 0) {
      c.models[existingIndex] = updatedModel;
    } else {
      c.models.push(updatedModel);
    }

    closeModal();
    renderConfig();
    toast(`已更新模型 "${id}" 到待保存列表。点击下方“💾 保存配置并即时生效”即可永久保存。`);
  });

  dialog.showModal();
}

function openDeleteConfirmDialog(modelId) {
  const dialog = $('#delete-confirm-dialog');
  if (!dialog) return;
  const c = state.config.liveConfig ?? state.config.mockConfig;
  if (c.models.length <= 1) {
    alert('至少需要保留 1 个模型，无法删除全部模型。');
    return;
  }

  const affectedSeats = (c.seats || []).filter(s => s.modelId === modelId).map(s => s.id);
  const affectedRoles = Object.entries(c.roles || {}).filter(([r, m]) => m === modelId).map(([r]) => r);

  dialog.innerHTML = `
    <div class="modal-header">
      <h3 style="color:#a8332a">🗑️ 确认删除模型 · ${escape(modelId)}</h3>
      <button type="button" class="dialog-close" id="del-close-x">×</button>
    </div>
    <div class="modal-body">
      <p style="font-size:13px;line-height:1.6;color:var(--ink)">
        确定要从模型列表中移除 <b>${escape(modelId)}</b> 吗？
      </p>
      ${affectedSeats.length || affectedRoles.length ? `
        <div class="error-box" style="margin-bottom:0;padding:10px 14px">
          ⚠️ <b>席位与角色关联提示</b>：<br>
          ${affectedSeats.length ? `席位 [${affectedSeats.join(', ')}] ` : ''}
          ${affectedRoles.length ? `角色 [${affectedRoles.join(', ')}] ` : ''}
          当前使用了该模型。<br>
          删除后系统将自动将其重映射至首个可用模型。
        </div>
      ` : ''}
    </div>
    <div class="modal-footer">
      <button type="button" class="button secondary" id="del-cancel-btn">取消</button>
      <button type="button" class="button danger-button" id="del-confirm-btn">确认删除</button>
    </div>
  `;

  const closeDialog = () => { dialog.close(); };
  $('#del-close-x').addEventListener('click', closeDialog);
  $('#del-cancel-btn').addEventListener('click', closeDialog);

  $('#del-confirm-btn').addEventListener('click', () => {
    c.models = c.models.filter(m => m.id !== modelId);
    const fallbackId = c.models[0].id;
    if (c.seats) {
      for (const s of c.seats) {
        if (s.modelId === modelId) s.modelId = fallbackId;
      }
    }
    if (c.roles) {
      for (const r of ['chair', 'dedup', 'dealer']) {
        if (c.roles[r] === modelId) c.roles[r] = fallbackId;
      }
    }
    closeDialog();
    renderConfig();
    toast(`已删除模型 "${modelId}"。请点击下方“💾 保存配置并即时生效”以持久化生效。`);
  });

  dialog.showModal();
}

function renderConfig() {
  const c = state.config.liveConfig ?? state.config.mockConfig;
  const rp = state.config.routingPreview;
  const activeCount = rp?.activeModels?.length ?? c.models.filter(m => m.hasKey).length;
  const totalCount = rp?.totalModels ?? c.models.length;
  const activeNames = rp?.activeModels?.join(', ') || c.models.filter(m => m.hasKey).map(m => m.id).join(', ');

  let bannerHtml = '';
  if (activeCount === 0) {
    bannerHtml = `<div class="config-adaptive-banner warn">⚠️ <b>尚未配置任何可用模型的 API Key</b><br><span style="font-size:11px">请在下方至少为一个模型填入 API Key 并点击保存。即使只配 1 个模型，系统也将自动调度 ${c.seats.length} 席正常运行。</span></div>`;
  } else if (activeCount === 1) {
    bannerHtml = `<div class="config-adaptive-banner">💡 <b>单模型自适应模式已就绪 (已激活: ${escape(activeNames)})</b><br><span style="font-size:11px">您无需填写其他模型！系统已自动将 ${c.seats.length} 个推演席位及裁决角色调度至该模型。各席位依旧获得不同的专业认知算子激发与独立种子多维推演，推演多样性完全保留。</span></div>`;
  } else if (activeCount < totalCount) {
    bannerHtml = `<div class="config-adaptive-banner">💡 <b>多模型均衡协同模式已就绪 (已激活: ${activeCount}/${totalCount} 个模型 [${escape(activeNames)}])</b><br><span style="font-size:11px">通用 K-of-M 自适应机制已生效：未配置 Key 的模型席位将自动按最大多样性均衡平摊至已激活模型中，无任何席位浪费。</span></div>`;
  } else {
    bannerHtml = `<div class="config-adaptive-banner">🟢 <b>全异构多模型协作模式就绪 (所有 ${totalCount} 个模型均已配置)</b><br><span style="font-size:11px">${c.seats.length} 席推演将完全按照原始异构配置分工运转。</span></div>`;
  }

  $('#main').innerHTML = `
    ${heading('MODELS & API KEYS', '配置大模型选型与席位规则', '自由添加任何 OpenAI 兼容或 Gemini 原生模型；本地持久化保存，支持任意 K 个模型自适应排席。')}
    ${bannerHtml}
    
    <div class="config-grid">
      <section class="card">
        <div class="card-head">
          <h2>大模型选型与服务商配置</h2>
          <div style="display:flex;align-items:center;gap:10px">
            <small>${activeCount} / ${totalCount} 已就绪</small>
            <button type="button" class="button" id="top-add-model-btn" style="padding:4px 12px;font-size:11.5px">➕ 添加模型</button>
          </div>
        </div>

        <div class="model-presets-wrap">
          <div class="model-presets-title">
            <span>✨ 常用服务商模版一键填入：</span>
          </div>
          <div class="model-presets-bar">
            ${MODEL_PRESETS.map(p => `
              <button type="button" class="preset-pill preset-pill-btn" data-preset="${escape(p.id)}">
                <span>${p.icon}</span> ${escape(p.label)}
              </button>
            `).join('')}
          </div>
        </div>

        <div class="config-models-container">
          ${c.models.map(m => `
            <div class="config-model-card" data-model-id="${escape(m.id)}">
              <div class="config-model-card-top">
                <div class="config-model-title">
                  <b>${escape(m.id)}</b> <span class="muted">· ${escape(m.model)}</span>
                  <span class="model-badge">${m.protocol === 'gemini' ? 'Gemini 原生' : 'OpenAI 兼容'}</span>
                  <span class="chip ${m.hasKey ? '' : 'failed'}" style="font-size:10px">
                    ${m.hasKey ? '🟢 已就绪' + (m.keySource === 'env' ? ' (环境变量)' : (m.isKeyless || (m.baseUrl && (m.baseUrl.includes('localhost') || m.baseUrl.includes('127.0.0.1'))) ? ' (免密钥)' : '')) : '⚪ 未配置'}
                  </span>
                </div>
                <div class="model-card-actions">
                  <span id="probe-${escape(m.id)}" class="probe-status"></span>
                  <button type="button" class="button secondary test-model-btn" data-model="${escape(m.id)}" style="padding:4px 9px;font-size:11px">⚡ 测试连通性</button>
                  <button type="button" class="button secondary edit-model-btn" data-model="${escape(m.id)}" style="padding:4px 9px;font-size:11px">✏️ 编辑</button>
                  ${c.models.length > 1 ? `<button type="button" class="button secondary danger-button delete-model-btn" data-model="${escape(m.id)}" style="padding:4px 9px;font-size:11px">🗑️ 删除</button>` : ''}
                </div>
              </div>
              <div class="config-model-desc">
                <span>${escape(m.baseUrl)}</span>
                <span class="muted">|</span>
                <span>${escape(m.structuredOutput || 'json_object')}</span>
                <span>${escape(m.tokenParameter || 'max_tokens')}</span>
                ${m.maxConcurrent ? `<span>并发:${m.maxConcurrent}</span>` : ''}
                ${m.requestIntervalMs ? `<span>间隔:${m.requestIntervalMs}ms</span>` : ''}
                ${m.supportsReasoning ? '<span class="model-badge">支持推理思考</span>' : ''}
              </div>
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
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div class="small-note" style="font-weight:600;color:var(--ink)">${c.seats.length} 个创意推演席位模型分配 (全局默认)：</div>
            <button type="button" class="button secondary" id="config-add-seat-btn" style="padding:3px 9px;font-size:11px">➕ 添加席位</button>
          </div>
          <div class="config-seats-grid">
            ${c.seats.map((s, idx) => `
              <div class="config-seat-cell">
                <input type="text" class="config-seat-id-input" data-idx="${idx}" value="${escape(s.id)}" maxlength="12" title="席位标识">
                <select class="config-select seat-config-select" data-idx="${idx}">
                  ${c.models.map(m => `<option value="${escape(m.id)}" ${s.modelId === m.id ? 'selected' : ''}>${escape(m.id)} ${m.hasKey ? '🟢' : '⚪'}</option>`).join('')}
                </select>
                <button type="button" class="config-seat-del-btn" data-idx="${idx}" title="删除该席位" ${c.seats.length <= 1 ? 'disabled style="visibility:hidden"' : ''}>×</button>
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

  // Bind Presets Buttons
  document.querySelectorAll('.preset-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.preset;
      const preset = MODEL_PRESETS.find(p => p.id === pid);
      if (preset) openModelModal(preset, false);
    });
  });

  // Top Add Model Button
  $('#top-add-model-btn')?.addEventListener('click', () => {
    openModelModal(MODEL_PRESETS[0], false);
  });

  // Edit Model Buttons
  document.querySelectorAll('.edit-model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mid = btn.dataset.model;
      const target = c.models.find(m => m.id === mid);
      if (target) openModelModal(target, true);
    });
  });

  // Delete Model Buttons
  document.querySelectorAll('.delete-model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openDeleteConfirmDialog(btn.dataset.model);
    });
  });

  // Toggle password eye
  document.querySelectorAll('.toggle-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mid = btn.dataset.model;
      const inp = document.getElementById(`cfg-key-${mid}`);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });

  // Test model button
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

  const syncConfigSeatsFromDom = () => {
    document.querySelectorAll('.config-seat-cell').forEach(cell => {
      const idInp = cell.querySelector('.config-seat-id-input');
      const modelSel = cell.querySelector('.seat-config-select');
      const idx = Number(modelSel?.dataset.idx);
      if (c.seats[idx] && idInp && modelSel) {
        const val = idInp.value.trim();
        if (val) c.seats[idx].id = val;
        c.seats[idx].modelId = modelSel.value;
      }
    });
  };

  // Add seat in config
  $('#config-add-seat-btn')?.addEventListener('click', () => {
    syncConfigSeatsFromDom();
    if (c.seats.length >= 32) {
      toast('⚠️ 最多支持 32 个席位');
      return;
    }
    const nextId = getNextSeatId(c.seats);
    c.seats.push({ id: nextId, modelId: c.models[0]?.id || 'GLM' });
    renderConfig();
    toast(`➕ 已添加席位 ${nextId}，点击下方保存即可生效`);
  });

  // Delete seat in config
  document.querySelectorAll('.config-seat-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncConfigSeatsFromDom();
      if (c.seats.length <= 1) {
        toast('⚠️ 至少保留 1 个席位');
        return;
      }
      const idx = Number(btn.dataset.idx);
      const delId = c.seats[idx]?.id;
      c.seats.splice(idx, 1);
      renderConfig();
      toast(`已移除席位 ${delId}，点击下方保存即可生效`);
    });
  });

  // Auto balance seats
  $('#auto-balance-seats-btn')?.addEventListener('click', () => {
    syncConfigSeatsFromDom();
    const active = c.models.filter(m => {
      const inp = document.getElementById(`cfg-key-${m.id}`);
      return m.hasKey || (inp && inp.value.trim());
    });
    if (active.length === 0) {
      toast('⚠️ 请先至少输入一个模型的 API Key');
      return;
    }
    const counts = new Map(active.map(m => [m.id, 0]));
    c.seats.forEach(s => {
      let minCount = Infinity;
      let targetId = active[0].id;
      for (const m of active) {
        const cnt = counts.get(m.id) || 0;
        if (cnt < minCount) {
          minCount = cnt;
          targetId = m.id;
        }
      }
      s.modelId = targetId;
      counts.set(targetId, minCount + 1);
    });
    renderConfig();
    toast(`✅ 已按 ${active.length} 个可用模型完成 ${c.seats.length} 席均衡分配！请点击保存生效。`);
  });

  // Save config
  $('#save-config-btn')?.addEventListener('click', async () => {
    syncConfigSeatsFromDom();
    const seatIds = c.seats.map(s => s.id.trim());
    if (seatIds.some(id => !id || !/^[A-Za-z0-9_-]+$/.test(id))) {
      toast('⚠️ 席位标识不能为空，且仅支持英文字母、数字、下划线和短横线');
      return;
    }
    if (new Set(seatIds).size !== seatIds.length) {
      toast('⚠️ 存在重复的席位标识，请确保每个席位 ID 唯一');
      return;
    }

    const base = state.config.liveConfig || state.config.mockConfig;
    const updated = structuredClone(base);
    updated.roles.chair = $('#cfg-role-chair').value;
    updated.roles.dedup = $('#cfg-role-dedup').value;
    updated.roles.dealer = $('#cfg-role-dealer').value;
    updated.seats = structuredClone(c.seats);

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
        toast('✅ 配置与模型选型已持久化保存为全局默认配置！');
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
    if (state.run?.mode && state.historyMode !== 'all' && state.historyMode !== state.run.mode) {
      state.historyMode = state.run.mode;
    }
    state.page = 'workspace';
    state.round = null;
    state.filter = '';
    state.tab = state.run.final ? 'answer' : 'board';
    state.fingerprint = getStructuralFingerprint(state.run);
    location.hash = id;
    render();
    history();
    if (state.run.status === 'running') connectEventSource(id);
    else disconnectEventSource();
  }
  finally { loading = false; }
}
function saveDraft() { if (!$('#run-form')) return; for (const key of ['problem', 'constraints', 'experiment']) { const el = $(`#${key}`); if (el) state.draft[key] = el.value; } const seedEl = $('#seed'); if (seedEl) state.draft.seed = Number(seedEl.value); const mechEl = $('#max-mechanisms'); if (mechEl) state.draft.max_mechanisms = Number(mechEl.value) || 3; const opEl = $('#use-operators'); if (opEl) state.draft.use_operators = opEl.checked; const domainOpEl = $('#use-domain-operators'); if (domainOpEl) state.draft.use_domain_operators = domainOpEl.checked; state.draft.mode = 'live'; }
function newRun() { typingStreams.clear(); disconnectEventSource(); saveDraft(); state.draft.customSeats = null; state.draft.customRoles = null; state.page = 'workspace'; state.run = null; location.hash = ''; render(); }
$('#new-run').addEventListener('click', newRun);
for (const page of ['workspace', 'compare', 'config']) $(`#${page}-nav`).addEventListener('click', () => { saveDraft(); state.page = page; render(); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
document.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('#help-dialog').open) newRun(); });
document.addEventListener('click', async e => {
  try {
    const tabBtn = e.target.closest('.history-tab-btn');
    if (tabBtn) {
      if (tabBtn.dataset.mode) {
        state.historyMode = tabBtn.dataset.mode;
        history();
      } else if (tabBtn.dataset.compareMode) {
        state.compareMode = tabBtn.dataset.compareMode;
        renderCompare();
      }
      return;
    }
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
document.addEventListener('change', e => { if (['experiment', 'use-operators', 'use-domain-operators'].includes(e.target.id)) { saveDraft(); renderNew(); } });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'run-form') return; e.preventDefault(); saveDraft();
  const button = e.target.querySelector('[type="submit"]'); button.disabled = true; button.textContent = '正在创建…';
  try {
    const d = state.draft;
    const { seats: sessionSeats, roles: sessionRoles } = getSessionSeatsAndRoles();
    const run = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...d,
        max_mechanisms: Number(d.max_mechanisms) || 3,
        seats: sessionSeats,
        roles: sessionRoles,
        mode: 'live',
        constraints: d.constraints.split('\n').map(c => c.trim()).filter(Boolean)
      })
    });
    state.activeId = run.id;
    await openRun(run.id);
    await refresh();
  }
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
