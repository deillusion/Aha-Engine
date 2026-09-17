import { renderMarkdown } from './markdown.js';

const $ = selector => document.querySelector(selector);
const state = {
  sessions: [], sessionCounts: { live: 0, mock: 0 }, activeMode: 'live',
  session: null, source: null, config: null, polling: false,
  activities: [], ahaTabs: {}, folder: null, pendingMessage: '',
  ahaEnabled: localStorage.getItem('aha_enabled') !== 'false',
  editingConfig: null
};

function getModelIcon(modelId = '') {
  const upper = String(modelId).toUpperCase();
  if (upper.includes('DEEPSEEK')) return '🐳';
  if (upper.includes('GEMINI')) return '✨';
  if (upper.includes('GLM')) return '🔮';
  if (upper.includes('CLAUDE') || upper.includes('ANTHROPIC')) return '🧠';
  if (upper.includes('OPENAI') || upper.includes('GPT')) return '🟢';
  if (upper.includes('SILICON')) return '⚡';
  if (upper.includes('QWEN')) return '🌐';
  if (upper.includes('OLLAMA') || upper.includes('LOCAL') || upper.includes('LLAMA')) return '🦙';
  return '🤖';
}

function updateAhaToggle() {
  const btn = $('#aha-toggle');
  const status = $('#aha-toggle-status');
  if (!btn) return;
  if (state.ahaEnabled) {
    btn.className = 'aha-toggle-pill active';
    btn.title = 'Aha 深度探索已开启：遇到机制难题时自动展开 8 席位推演（点击可关闭）';
    if (status) status.textContent = '开启';
  } else {
    btn.className = 'aha-toggle-pill inactive';
    btn.title = 'Aha 深度探索已关闭：仅作为日常 Agent 对话与代码/文件操作（点击可开启）';
    if (status) status.textContent = '关闭';
  }
}

function updateComposerModel() {
  const labelEl = $('#composer-model-label');
  if (!labelEl) return;
  const cfg = state.config?.liveConfig ?? state.config?.mockConfig;
  if (!cfg) {
    labelEl.textContent = '配置模型…';
    return;
  }
  const mainRoleModelId = cfg.roles?.main ?? cfg.roles?.chair;
  const modelObj = cfg.models?.find(m => m.id === mainRoleModelId) || cfg.models?.[0];
  if (modelObj) {
    const icon = getModelIcon(modelObj.id);
    labelEl.textContent = `${icon} ${modelObj.id} · ${modelObj.model || ''}`.trim();
    labelEl.title = `主对话模型: ${modelObj.id} (${modelObj.model || ''}) - 点击配置大模型与规则`;
  } else {
    labelEl.textContent = '⚙️ 配置模型';
  }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const value = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value.error || value || `HTTP ${response.status}`);
  return value;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 3200);
}

function setRunning(running, label = '就绪') {
  $('#run-state').textContent = label;
  $('#run-state').classList.toggle('running', running);
  $('#send-message').disabled = running;
  $('#cancel-turn').hidden = !running;
  $('#message-input').disabled = running;
}

function renderSessions() {
  const filtered = state.sessions.filter(s => (s.mode || 'live') === state.activeMode);

  const tabLive = $('#tab-live');
  const tabMock = $('#tab-mock');
  if (tabLive) tabLive.classList.toggle('active', state.activeMode === 'live');
  if (tabMock) tabMock.classList.toggle('active', state.activeMode === 'mock');

  const countLive = $('#count-live');
  const countMock = $('#count-mock');
  if (countLive) countLive.textContent = state.sessionCounts.live ?? 0;
  if (countMock) countMock.textContent = state.sessionCounts.mock ?? 0;

  const subbarTitle = $('#session-subbar-title');
  if (subbarTitle) subbarTitle.textContent = state.activeMode === 'live' ? '真实会话' : '模拟记录';

  const clearMockBtn = $('#clear-mock-btn');
  if (clearMockBtn) clearMockBtn.hidden = state.activeMode !== 'mock' || !state.sessionCounts.mock;

  if (!filtered.length) {
    const emptyNotice = state.activeMode === 'live'
      ? '<div class="quiet-empty">暂无真实会话记录<br><small style="margin-top:6px;display:inline-block;color:var(--quiet)">点击上方「＋ 新会话」开始真实创作</small></div>'
      : '<div class="quiet-empty">暂无模拟推演记录<br><small style="margin-top:6px;display:inline-block;color:var(--quiet)">创建新会话时选择「离线模拟」可进行演练测试</small></div>';
    $('#session-list').innerHTML = emptyNotice;
    return;
  }

  $('#session-list').innerHTML = filtered.map(session => `
    <div class="session-item-row ${state.session?.session_id === session.session_id ? 'active' : ''}">
      <button class="session-item" data-session="${escapeHtml(session.session_id)}" title="${escapeHtml(session.title)}">
        <strong>${escapeHtml(session.title)}</strong>
        <small>${session.current_turn} 轮 · ${session.aha_runs} 次 Aha · ${session.mode === 'mock' ? '<span class="mode-tag mock">模拟</span>' : '<span class="mode-tag live">真实</span>'}</small>
      </button>
      <button class="session-delete-btn" data-delete-session="${escapeHtml(session.session_id)}" title="删除此会话" aria-label="删除此会话">×</button>
    </div>`).join('');
}

function emptyState() {
  return `<div class="empty-state">
    <div class="orb">✦</div>
    <h2>今天想创造什么？</h2>
    <p>先选择一个工作目录。Aha 会在同一段对话里阅读资料、使用工具，并在需要时展开完整的多视角探索。</p>
    <button class="workspace-cta" data-open-workspace>⌁&nbsp; 选择工作目录</button>
    <div class="suggestions">
      <button data-suggestion="先读一下工作区中的设计文档，告诉我目前最核心的机制约束。">梳理已有设定与约束</button>
      <button data-suggestion="设计一个十分钟内能形成明确取舍的轻量合作机制。">探索一个开放式机制难题</button>
      <button data-suggestion="找出当前设计里互相冲突的规则，但先不要修改文件。">排查规则冲突</button>
      <button data-suggestion="把我们已经讨论出的方向整理成可落盘的文档结构，先给我看草案。">先讨论，再决定是否落盘</button>
    </div>
  </div>`;
}

function pointById(run, id) {
  return run.board?.points?.find(point => point.id === id);
}

function viewRun(record, runtime = null) {
  const source = runtime ?? record ?? {};
  const handoff = source.handoff ?? {};
  return {
    id: source.run_id ?? record?.run_id ?? 'aha-live',
    problem: source.problem ?? record?.problem ?? '',
    state: handoff.state ?? source.state ?? source.status ?? record?.state ?? 'active',
    stopReason: handoff.stop_reason ?? source.stop_reason ?? record?.stop_reason,
    rounds: handoff.rounds_executed ?? source.rounds_executed ?? source.round_records?.length ?? record?.rounds_executed ?? 0,
    currentRound: source.current_round ?? handoff.rounds_executed ?? record?.rounds_executed ?? 0,
    maxRounds: source.max_rounds ?? 5,
    board: handoff.meeting_board ?? source.final_meeting_board ?? source.meeting_board ?? source.current_board ?? record?.final_meeting_board ?? { points: [] },
    facts: handoff.fact_ledger ?? source.final_fact_ledger ?? source.fact_ledger ?? record?.final_fact_ledger ?? [],
    solutions: handoff.solutions ?? source.solutions ?? record?.solutions ?? [],
    unresolved: handoff.unresolved_questions ?? source.unresolved_questions ?? record?.unresolved_questions ?? [],
    rejected: handoff.rejected_directions ?? source.rejected_directions ?? record?.rejected_directions ?? [],
    degradations: handoff.degradations ?? source.degradations ?? record?.degradations ?? [],
    roundRecords: handoff.round_records ?? source.round_records ?? record?.round_records ?? [],
    seatResponses: handoff.seat_responses ?? source.seat_responses ?? record?.seat_responses ?? []
  };
}

function tags(ids, run) {
  return (ids ?? []).map(id => `<span class="tag" title="${escapeHtml(pointById(run, id)?.text ?? '')}">${escapeHtml(id)}</span>`).join('');
}

function renderOverview(run) {
  const solutions = run.solutions.length ? `<div class="solution-grid">${run.solutions.map(solution => `
    <article class="solution-card">
      <div class="solution-kicker">${escapeHtml(solution.solution_id)}</div><h4>${escapeHtml(solution.name)}</h4>
      <div class="card-label">核心机制</div><div>${tags(solution.core_mechanism_ids, run)}</div>
      ${(solution.defensive_patch_ids ?? []).length ? `<div class="card-label">防守补丁</div><div>${tags(solution.defensive_patch_ids, run)}</div>` : ''}
      <div class="card-label">固有代价</div><ul>${(solution.inherent_costs ?? []).map(cost => `<li>${escapeHtml(cost)}</li>`).join('')}</ul>
    </article>`).join('')}</div>` : '<div class="workbench-empty">探索还在进行，方案会在观点收敛后装配。</div>';
  const notes = [
    run.unresolved.length ? `<section class="note-block"><h4>仍待回答</h4><ul>${run.unresolved.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : '',
    run.degradations.length ? `<section class="note-block warning"><h4>降级与限制</h4><ul>${run.degradations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : '',
    (state.session?.loaded_files_manifest ?? []).length ? `<section class="note-block"><h4>已锚定资料</h4><div class="file-chips">${state.session.loaded_files_manifest.map(file => `<span title="${escapeHtml(file.file_path)}">${escapeHtml(file.file_path.split(/[\\/]/).pop())}</span>`).join('')}</div></section>` : ''
  ].join('');
  return `${solutions}${notes}`;
}

function renderBoard(run) {
  const points = (run.board?.points ?? []).filter(point => point.status === 'active');
  return points.length ? `<div class="card-grid">${points.map(point => `<article class="data-card point-card"><header><span>${escapeHtml(point.id)}</span><span>rev ${point.revision}</span></header><span class="type-chip">${escapeHtml(point.type)}</span><p>${escapeHtml(point.text)}</p><footer><strong>失效边界</strong>${escapeHtml(point.failure_condition)}</footer></article>`).join('')}</div>` : '<div class="workbench-empty">观点板尚未产生原子观点。</div>';
}

function renderFacts(run) {
  return run.facts.length ? `<div class="card-grid">${run.facts.map(fact => `<article class="data-card fact-card ${escapeHtml(fact.status)}"><header><span>${escapeHtml(fact.fact_id ?? fact.fact_ref)}</span><span>${escapeHtml(fact.status)}</span></header><p>${escapeHtml(fact.semantic_summary ?? fact.claim)}</p>${fact.correction ? `<footer><strong>校正</strong>${escapeHtml(fact.correction)}</footer>` : ''}${(fact.evidence ?? []).length ? `<div class="evidence-list">${fact.evidence.map(evidence => `<span>${escapeHtml(evidence.filePath)}:${escapeHtml((evidence.lineRange ?? []).join('-'))}</span>`).join('')}</div>` : ''}</article>`).join('')}</div>` : '<div class="workbench-empty">本次探索没有提出需要核验的实现事实。</div>';
}

function renderRounds(run, live = false) {
  const maxRound = Math.max(run.currentRound || 0, run.rounds || 0, run.roundRecords.length, 1);
  const configSeats = state.config?.liveConfig?.seats || [
    { id: 'seat-1', modelId: 'gpt-4o' },
    { id: 'seat-2', modelId: 'claude-3-5-sonnet' },
    { id: 'seat-3', modelId: 'gemini-1.5-pro' },
    { id: 'seat-4', modelId: 'deepseek-chat' },
    { id: 'seat-5', modelId: 'qwen-plus' },
    { id: 'seat-6', modelId: 'glm-4' },
    { id: 'seat-7', modelId: 'yi-large' },
    { id: 'seat-8', modelId: 'moonshot-v1' }
  ];

  const flowStepsHtml = [];

  for (let rnd = 1; rnd <= maxRound; rnd++) {
    const record = run.roundRecords.find(r => r.round_index === rnd);
    const roundSeatsData = run.seatResponses.find(r => r.round === rnd)?.responses || [];
    const isCurrentRound = (live || run.state === 'active') && (run.currentRound === rnd || (!run.currentRound && rnd === maxRound));

    const seatCardsHtml = [];
    for (let i = 0; i < 8; i++) {
      const defaultId = `seat-${i + 1}`;
      const cfgSeat = configSeats[i] || { id: defaultId, modelId: 'auto' };
      const resp = roundSeatsData.find(s => s.seat_id === cfgSeat.id || s.seat_id === defaultId || s.seat_id === `Seat ${i + 1}`)
                || (roundSeatsData[i] && (roundSeatsData.length <= 8) ? roundSeatsData[i] : null);

      const seatId = resp?.seat_id || cfgSeat.id;
      const modelId = resp?.modelId || cfgSeat.modelId || 'auto';
      const operators = resp?.operators || [];
      const isCardRunning = isCurrentRound && !resp;

      let bodyHtml = '';
      if (isCardRunning) {
        bodyHtml = `
          <div class="thinking-block-active">
            <div class="thinking-header">
              <div class="thinking-title">
                <span class="pulse-indicator"></span>
                <span>深度思考推演中...</span>
              </div>
              <span class="thinking-timer">发散中</span>
            </div>
            <div class="thinking-stream">&gt; 结合算子寻找破局点，从独立视角推演机制假设与失效边界… <span class="thinking-cursor"></span></div>
          </div>
          <div class="seat-body-waiting"><span>⏳ 思考完成后提炼原子观点</span></div>
        `;
      } else if (resp) {
        bodyHtml = `
          <details class="thinking-completed" open>
            <summary>
              <span>🧠 席位分析 · 机制推演</span>
              <span>展开 / 收起</span>
            </summary>
            <div class="thinking-content">${escapeHtml(resp.analysis_summary || '本轮机制推演完成。')}</div>
          </details>
          <div class="seat-body">
            ${(resp.contributions || []).map(c => `
              <div class="contrib-card">
                <div class="contrib-card-header">
                  <span class="contrib-type-pill">${escapeHtml(c.local_id || 'C')} · ${escapeHtml(c.type || '观点')}</span>
                </div>
                <div>${escapeHtml(c.text)}</div>
                ${c.failure_condition ? `<div class="contrib-failure">⚠️ 失效边界：${escapeHtml(c.failure_condition)}</div>` : ''}
              </div>
            `).join('') || '<div class="quiet-empty" style="padding:10px">本轮未产生有效原子观点</div>'}
          </div>
        `;
      } else {
        bodyHtml = `<div class="seat-body-waiting"><span>等待进入本轮推演</span></div>`;
      }

      seatCardsHtml.push(`
        <article class="seat-card ${isCardRunning ? 'card-running' : ''}" id="card-R${rnd}-${escapeHtml(seatId)}">
          <div class="seat-card-top">
            <span class="seat-badge">席位 #${i + 1}</span>
            <span class="seat-model">${escapeHtml(modelId)}</span>
          </div>
          ${operators.length ? `
            <div class="seat-operators">
              ${operators.map(op => `<span class="op-pill" title="${escapeHtml(op.prompt || '')}">${escapeHtml(op.name || op.id || '')}</span>`).join('')}
            </div>` : ''}
          ${bodyHtml}
        </article>
      `);
    }

    let convergenceHtml = '';
    if (record) {
      convergenceHtml = `
        <div class="convergence-box">
          <div class="convergence-stats">
            <span class="stat-tag add">+ 新增 ${record.new_points_added} 个</span>
            <span class="stat-tag merge">合并 ${record.points_merged} 个</span>
            <span class="stat-tag drop">淘汰 ${record.points_dropped} 个</span>
            <span class="stat-tag total">观点板 v${record.round_index}</span>
            ${record.claims_verified ? `<span class="stat-tag total" style="background:#eaf1e5;color:#274033">✓ 核验 ${record.claims_verified} 条代码事实</span>` : ''}
          </div>
        </div>
      `;
    } else if (isCurrentRound) {
      convergenceHtml = `
        <div class="convergence-box">
          <div class="convergence-stats">
            <span class="stat-tag add"><span class="pulse-indicator"></span> 正在去重合并与观点结晶…</span>
          </div>
        </div>
      `;
    }

    flowStepsHtml.push(`
      <section class="flow-step ${isCurrentRound ? 'step-running' : ''}" id="step-r${rnd}">
        <div class="step-header">
          <div class="step-header-left">
            <span class="step-tag">R${rnd} 探索</span>
            <div class="step-title-area">
              <h3>第 ${rnd} 轮 · 8 席位多视角思维碰撞</h3>
              <p>各席位读取冻结包与工作区事实，结合思维算子推演原子机制</p>
            </div>
          </div>
          ${isCurrentRound ? '<span class="state-pill running"><span class="pulse-indicator"></span> 席位推演中</span>' : '<span class="state-pill">✓ 轮次完成</span>'}
        </div>
        <div class="seats-grid-4x2">
          ${seatCardsHtml.join('')}
        </div>
        ${convergenceHtml}
      </section>
    `);
  }

  return `<div class="flow-container">${flowStepsHtml.join('')}</div>`;
}

function renderRejected(run) {
  return run.rejected.length ? `<div class="card-grid">${run.rejected.map(item => `<article class="data-card rejected-card"><header><span>${escapeHtml(item.rejection_id)}</span><span>R${item.round}</span></header><p>${escapeHtml((item.texts ?? []).join(' / '))}</p><footer><strong>淘汰原因</strong>${escapeHtml(item.reason)}</footer></article>`).join('')}</div>` : '<div class="workbench-empty">还没有被淘汰的重复或无效方向。</div>';
}

function renderAhaWorkspace(input, live = false) {
  const run = input.board ? input : viewRun(input);
  const defaultTab = 'rounds';
  const activeTab = state.ahaTabs[run.id] ?? defaultTab;
  const tabs = [
    ['rounds', `4×2 席位推演 (${run.roundRecords?.length || run.currentRound || 0}轮)`],
    ['overview', `装配方案 (${run.solutions?.length ?? 0})`],
    ['facts', `事实账本 (${run.facts?.length ?? 0})`],
    ['board', `观点板 (${run.board?.points?.filter(p => p.status === 'active').length ?? 0})`],
    ['rejected', `淘汰方向 (${run.rejected?.length ?? 0})`]
  ];
  const content = activeTab === 'overview' ? renderOverview(run)
    : activeTab === 'facts' ? renderFacts(run)
    : activeTab === 'board' ? renderBoard(run)
    : activeTab === 'rejected' ? renderRejected(run)
    : renderRounds(run, live);
  const progress = run.state === 'complete' && !live ? 100 : Math.min(100, Math.max(8, ((run.currentRound || run.rounds || 1) / run.maxRounds) * 100));
  const stateLabel = live || run.state === 'active' ? '推演探索中' : run.state === 'complete' ? '推演已结晶' : run.state === 'cancelled' ? '已停止' : run.state === 'failed' ? '未完成' : run.state;
  return `<section class="aha-workbench ${live ? 'live' : ''}" data-aha-workbench="${escapeHtml(run.id)}">
    <div class="aha-hero">
      <div>
        <div class="aha-eyebrow"><span class="aha-glyph">✦</span>Aha 深度多视角探索 · ${escapeHtml(stateLabel)}</div>
        <h3>${escapeHtml(run.problem || '正在推演机制难题')}</h3>
        <p>${run.currentRound || run.rounds || 1} / ${run.maxRounds} 轮 · ${run.board?.points?.filter(point => point.status === 'active').length ?? 0} 个有效观点 · ${run.facts.length} 条事实 · 8 个创意席位并发</p>
      </div>
      <div class="aha-round-badge">
        <strong>${run.currentRound || run.rounds || 1}</strong>
        <span>ROUND</span>
      </div>
    </div>
    <div class="aha-progress"><i style="width:${progress}%"></i></div>
    <nav class="aha-tabs">${tabs.map(([id, label]) => `<button class="${activeTab === id ? 'active' : ''}" data-aha-tab="${id}" data-run-id="${escapeHtml(run.id)}">${label}</button>`).join('')}</nav>
    <div class="aha-content">${content}</div>
  </section>`;
}

function getToolBadge(toolName = '') {
  const lower = toolName.toLowerCase();
  if (lower === 'read') return { badgeClass: 'tool-badge-read', badgeText: 'READ' };
  if (lower === 'edit') return { badgeClass: 'tool-badge-edit', badgeText: 'EDIT' };
  if (lower === 'write') return { badgeClass: 'tool-badge-write', badgeText: 'WRITE' };
  if (lower === 'grep' || lower === 'glob') return { badgeClass: 'tool-badge-search', badgeText: 'SEARCH' };
  if (lower === 'exploredesign') return { badgeClass: 'tool-badge-explore', badgeText: 'AHA EXPLORE' };
  if (lower.includes('backup')) return { badgeClass: 'tool-badge-backup', badgeText: 'BACKUP' };
  return { badgeClass: 'tool-badge-generic', badgeText: 'TOOL' };
}

function renderThinkingStep(step) {
  const isRunning = step.status === 'running';
  const content = step.content || (isRunning ? '正在分析上下文，规划后续操作…' : '思考已完成');
  let durationLabel = '已深度思考';
  if (isRunning) {
    durationLabel = '思考中…';
  } else if (step.duration_ms) {
    const sec = Math.max(1, Math.round(step.duration_ms / 1000));
    durationLabel = `用时 ${sec} 秒`;
  }
  return `
    <details class="thinking-block ${isRunning ? 'running' : 'completed'}" ${isRunning ? 'open' : ''}>
      <summary class="thinking-summary" title="${isRunning ? '正在思考中' : '点击展开/折叠思考过程'}">
        <div class="thinking-title">
          ${isRunning ? '<span class="thinking-pulse-dot"></span>' : '<span class="thinking-icon">💭</span>'}
          <span class="thinking-label">${escapeHtml(durationLabel)}</span>
        </div>
        <span class="thinking-chevron">${isRunning ? '▾' : '›'}</span>
      </summary>
      <div class="thinking-body">${escapeHtml(content)}</div>
    </details>
  `;
}

function renderToolStep(step) {
  const toolName = step.name || 'Tool';
  const { badgeClass, badgeText } = getToolBadge(toolName);
  const isRunning = step.status === 'running';
  const isFailed = step.status === 'failed' || step.ok === false;
  const statusMarkup = isRunning
    ? '<span class="tool-status running"><span class="activity-pulse"></span>执行中…</span>'
    : isFailed
    ? '<span class="tool-status failed">❌ 失败</span>'
    : '<span class="tool-status success">✓ 完成</span>';

  let titleDetail = '';
  const input = step.input || {};
  if (toolName === 'Read') titleDetail = input.file_path || '';
  else if (toolName === 'Edit') titleDetail = input.file_path || '';
  else if (toolName === 'Write') titleDetail = input.file_path || '';
  else if (toolName === 'Grep') titleDetail = input.query ? `"${input.query}"` : '';
  else if (toolName === 'Glob') titleDetail = input.pattern || '';
  else if (toolName === 'ExploreDesign') titleDetail = input.problem?.slice(0, 36) || '';
  else if (toolName === 'RestoreBackup') titleDetail = input.backup_id || '';
  else if (toolName === 'ListBackups') titleDetail = input.file_path || '工作区';

  let bodyContent = '';
  if (toolName === 'Edit' && (input.old_string !== undefined || input.new_string !== undefined)) {
    bodyContent = `
      <div class="diff-container">
        <div class="diff-header">目标文件：<code>${escapeHtml(input.file_path || '')}</code></div>
        <div class="diff-line diff-del"><span class="diff-sign">-</span><pre>${escapeHtml(input.old_string ?? '')}</pre></div>
        <div class="diff-line diff-add"><span class="diff-sign">+</span><pre>${escapeHtml(input.new_string ?? '')}</pre></div>
      </div>
    `;
  } else if (toolName === 'Read') {
    const range = input.start_line ? ` (第 ${input.start_line} - ${input.end_line ?? '末尾'} 行)` : '';
    const text = step.result?.content;
    const lineCount = step.result?.linesCount || (text ? (text.match(/\n/g) || []).length + 1 : null);
    bodyContent = `
      <div class="tool-detail-row">读取文件：<code>${escapeHtml(input.file_path || '')}</code>${escapeHtml(range)}</div>
      ${text ? `
        <details class="tool-expand-details">
          <summary>查看读取内容 ${lineCount ? `(${lineCount} 行)` : ''}</summary>
          <pre class="tool-content-pre">${escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? '\n\n⋯ (超出 3000 字符部分已截断)' : ''}</pre>
        </details>
      ` : ''}
    `;
  } else if (toolName === 'Write') {
    const content = input.content ?? '';
    bodyContent = `
      <div class="tool-detail-row">写入文件：<code>${escapeHtml(input.file_path || '')}</code> (${content.length} 字符)</div>
      ${content ? `
        <details class="tool-expand-details">
          <summary>查看写入内容预览</summary>
          <pre class="tool-content-pre">${escapeHtml(content.slice(0, 3000))}${content.length > 3000 ? '\n\n⋯ (超出 3000 字符部分已截断)' : ''}</pre>
        </details>
      ` : ''}
    `;
  } else if (toolName === 'Grep') {
    const matches = step.result?.matches ?? [];
    bodyContent = `
      <div class="tool-detail-row">检索词：<code>${escapeHtml(input.query || '')}</code> · 过滤：<code>${escapeHtml(input.path_filter || '**/*')}</code> ${input.is_regex ? '(正则)' : ''}</div>
      ${step.status === 'completed' ? `<div class="tool-result-meta">命中 ${matches.length} 处结果</div>` : ''}
    `;
  } else if (toolName === 'Glob') {
    const files = step.result?.files ?? [];
    bodyContent = `
      <div class="tool-detail-row">文件模式：<code>${escapeHtml(input.pattern || '**/*')}</code></div>
      ${step.status === 'completed' ? `<div class="tool-result-meta">匹配到 ${files.length} 个文件</div>` : ''}
    `;
  } else if (toolName === 'ExploreDesign') {
    bodyContent = `
      <div class="tool-detail-row"><strong>设计困境：</strong>${escapeHtml(input.problem || '')}</div>
      ${(input.constraints || []).length ? `<div class="tool-constraints"><strong>约束：</strong>${input.constraints.map(c => `<code>${escapeHtml(c)}</code>`).join(' ')}</div>` : ''}
      ${step.result ? `<div class="tool-result-meta">推演完成：${step.result.rounds_executed || 0} 轮 · ${step.result.meeting_board?.points?.length ?? 0} 个观点 · ${step.result.solutions?.length ?? 0} 套装配</div>` : ''}
    `;
  } else {
    bodyContent = `<pre class="tool-content-pre">${escapeHtml(JSON.stringify(input, null, 2))}</pre>`;
  }

  if (isFailed) {
    const errMsg = step.error?.message || (typeof step.error === 'string' ? step.error : JSON.stringify(step.error || '执行出错'));
    bodyContent += `<div class="tool-error-msg">❌ 错误：${escapeHtml(errMsg)}</div>`;
  }

  return `
    <article class="tool-card ${isRunning ? 'running' : ''} ${isFailed ? 'failed' : ''}">
      <header class="tool-card-header">
        <div class="tool-card-title">
          <span class="tool-badge ${badgeClass}">${badgeText}</span>
          <strong>${escapeHtml(toolName)}</strong>
          ${titleDetail ? `<span class="tool-target">${escapeHtml(titleDetail)}</span>` : ''}
        </div>
        ${statusMarkup}
      </header>
      <div class="tool-card-body">${bodyContent}</div>
    </article>
  `;
}

function renderMessages() {
  const target = $('#messages');
  const wasNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
  const messages = state.session?.messages ?? [];
  const runs = state.session?.aha_runs ?? [];
  const runMap = new Map(runs.map(run => [run.run_id, run]));
  const linked = new Set();
  let markup = messages.map((message, index) => {
    if (message.role === 'user') {
      const isExplicitAha = message.content.trim().startsWith('/aha');
      const clean = isExplicitAha ? message.content.trim().replace(/^\/aha\s*/i, '') : message.content;
      return `
        <article class="message user">
          <div class="message-body">${escapeHtml(clean || message.content)}${isExplicitAha ? '<span class="aha-user-tag">✦ Aha 探索</span>' : ''}</div>
        </article>
      `;
    }
    const run = message.aha_run_id ? runMap.get(message.aha_run_id) : null;
    if (run) linked.add(run.run_id);
    let stepsMarkup = '';
    if (Array.isArray(message.steps)) {
      stepsMarkup = message.steps.map(step => {
        if (step.type === 'thinking') return renderThinkingStep(step);
        if (step.type === 'tool') return renderToolStep(step);
        return '';
      }).join('');
    }
    const ahaMarkup = run ? renderAhaWorkspace(viewRun(run)) : '';
    const bodyMarkup = message.content ? `
      <article class="message assistant ${message.partial ? 'partial' : ''}">
        <div class="message-body markdown-body">${renderMarkdown(message.content)}</div>
        ${message.confirmation ? `<div class="confirm-card"><p>${escapeHtml(message.confirmation.question)}</p><button class="primary" data-confirm="${index}">启动全新 Aha</button></div>` : ''}
      </article>
    ` : '';
    return `${stepsMarkup}${ahaMarkup}${bodyMarkup}`;
  }).join('');

  for (const run of runs.filter(item => !linked.has(item.run_id) && item.state !== 'active')) {
    markup += renderAhaWorkspace(viewRun(run));
  }

  // Active turn steps (streaming live before final assistant message is created)
  if (state.session?.status === 'running' && state.session?.active_turn?.steps?.length) {
    markup += state.session.active_turn.steps.map(step => {
      if (step.type === 'thinking') return renderThinkingStep(step);
      if (step.type === 'tool') return renderToolStep(step);
      return '';
    }).join('');
  }

  if (state.session?.active_aha_runtime) {
    markup += renderAhaWorkspace(viewRun(runMap.get(state.session.active_aha_runtime.run_id), state.session.active_aha_runtime), true);
  }

  target.innerHTML = messages.length || markup ? markup : emptyState();
  updateScrollBottomBtn();
  if (wasNearBottom || state.session?.status === 'running') requestAnimationFrame(() => { target.scrollTop = target.scrollHeight; });
}

function renderActivity() {
  const activity = $('#activity');
  // Activity is now integrated into vertical items; keep bottom bar hidden
  activity.hidden = true;
}

function updateScrollBottomBtn() {
  const target = $('#messages');
  const btn = $('#scroll-bottom-btn');
  if (!target || !btn) return;
  const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
  btn.hidden = distance < 180;
}

function render() {
  renderSessions();
  $('#session-title').textContent = state.session?.title ?? '开始创作';
  const workspace = state.session?.workspace_root;
  $('#workspace-button').textContent = workspace ? `⌁ ${workspace}` : '⌁ 选择工作目录';
  $('#workspace-button').title = workspace ?? '选择工作目录';
  renderMessages();
  renderActivity();
  updateAhaToggle();
  updateComposerModel();
  setRunning(state.session?.status === 'running', state.session?.status === 'running' ? '处理中' : state.session?.status === 'failed' ? '上轮失败' : '就绪');
}

async function loadSessions() {
  const data = await api('/api/agent/sessions');
  state.sessions = data.sessions || [];
  state.sessionCounts = data.counts || {
    live: state.sessions.filter(s => s.mode !== 'mock').length,
    mock: state.sessions.filter(s => s.mode === 'mock').length
  };
  renderSessions();
}

function connectEvents(sessionId) {
  state.source?.close();
  const source = new EventSource(`/api/agent/sessions/${sessionId}/stream`);
  source.onmessage = event => {
    const data = JSON.parse(event.data);
    if (!state.session || state.session.session_id !== sessionId) return;
    if (!state.session.active_turn) {
      state.session.active_turn = { turn: state.session.current_turn, steps: [] };
    }
    const steps = state.session.active_turn.steps;

    if (data.event === 'agent_thinking') {
      let step = steps.find(s => s.id === data.step_id || (s.type === 'thinking' && s.iteration === data.iteration));
      if (!step) {
        step = { id: data.step_id || `step-think-${data.iteration}`, type: 'thinking', iteration: data.iteration, status: data.status || 'running', content: data.content || '', started_at: Date.now(), duration_ms: data.duration_ms };
        steps.push(step);
      } else {
        if (data.status) {
          step.status = data.status;
          if (data.status === 'completed' && !step.duration_ms && step.started_at) {
            step.duration_ms = Date.now() - step.started_at;
          }
        }
        if (data.duration_ms) step.duration_ms = data.duration_ms;
        if (data.content !== undefined) step.content = data.content;
      }
      renderMessages();
    } else if (data.event === 'tool_call') {
      let step = steps.find(s => s.id === data.tool_call_id);
      if (!step) {
        step = { id: data.tool_call_id, type: 'tool', name: data.name, input: data.input, arguments_json: data.arguments_json, status: 'running', iteration: data.turn };
        steps.push(step);
      } else {
        step.name = data.name;
        if (data.input !== undefined) step.input = data.input;
        step.status = 'running';
      }
      renderMessages();
    } else if (data.event === 'tool_result') {
      let step = steps.find(s => s.id === data.tool_call_id);
      if (!step) {
        step = { id: data.tool_call_id, type: 'tool', name: data.name, ok: data.ok, result: data.result, error: data.error, status: data.status || (data.ok ? 'completed' : 'failed') };
        steps.push(step);
      } else {
        step.ok = data.ok;
        step.status = data.status || (data.ok ? 'completed' : 'failed');
        if (data.result !== undefined) step.result = data.result;
        if (data.error !== undefined) step.error = data.error;
      }
      renderMessages();
    } else if (data.event === 'agent_done') {
      delete state.session.active_turn;
      void refreshSession(sessionId);
    } else if (data.phase?.startsWith('aha_')) {
      void refreshSession(sessionId);
    }
  };
  state.source = source;
}

async function openSession(sessionId) {
  state.session = await api(`/api/agent/sessions/${sessionId}`);
  if (state.session?.mode) {
    state.activeMode = state.session.mode;
  }
  state.activities = [];
  connectEvents(sessionId);
  render();
  history.replaceState(null, '', `#${sessionId}`);
}

async function deleteSession(sessionId) {
  const session = state.sessions.find(s => s.session_id === sessionId);
  const title = session?.title || '此会话';
  if (!confirm(`确定删除会话「${title}」吗？此操作不可恢复。`)) return;
  try {
    await api(`/api/agent/sessions/${sessionId}`, { method: 'DELETE' });
    toast('会话已删除');
    await loadSessions();
    if (state.session?.session_id === sessionId) {
      state.session = null;
      state.source?.close();
      history.replaceState(null, '', location.pathname);
      const remaining = state.sessions.filter(s => (s.mode || 'live') === state.activeMode);
      if (remaining[0]) {
        await openSession(remaining[0].session_id);
      } else {
        render();
      }
    }
  } catch (error) {
    toast(error.message);
  }
}

async function clearMockSessions() {
  if (!confirm(`确定清空所有离线模拟记录（共 ${state.sessionCounts.mock || 0} 条）吗？\n（真实会话记录不受影响）`)) return;
  try {
    const res = await api('/api/agent/sessions/clear-mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(`已清空 ${res.count || 0} 条模拟记录`);
    await loadSessions();
    if (state.session?.mode === 'mock') {
      state.session = null;
      state.source?.close();
      history.replaceState(null, '', location.pathname);
      const remainingLive = state.sessions.filter(s => s.mode !== 'mock');
      if (remainingLive[0]) {
        state.activeMode = 'live';
        await openSession(remainingLive[0].session_id);
      } else {
        render();
      }
    }
  } catch (error) {
    toast(error.message);
  }
}

async function loadDirectories(folderPath = null) {
  $('#folder-list').innerHTML = '<div class="folder-loading">正在读取目录…</div>';
  const data = await api(`/api/agent/directories${folderPath ? `?path=${encodeURIComponent(folderPath)}` : ''}`);
  state.folder = data;
  $('#folder-path').value = data.current;
  $('#folder-root').textContent = `可选范围：${data.root}`;
  $('#selected-folder').textContent = data.current;
  $('#folder-up').disabled = !data.parent;
  $('#folder-list').innerHTML = data.directories.length ? data.directories.map(folder => `<button class="folder-row ${folder.hidden ? 'hidden-folder' : ''}" data-folder="${escapeHtml(folder.path)}"><span class="folder-icon">⌑</span><span><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.path)}</small></span><i>›</i></button>`).join('') : '<div class="folder-loading">这个目录里没有子目录。你可以直接选择当前目录。</div>';
}

async function openFolderDialog(startPath = null) {
  const dialog = $('#new-session-dialog');
  if (!dialog.open) dialog.showModal();
  try { await loadDirectories(startPath ?? state.session?.workspace_root ?? null); }
  catch (error) { toast(error.message); if (!state.folder) dialog.close(); }
}

async function createSession() {
  if (!state.folder?.current) throw new Error('请先选择工作目录');
  const mode = $('#session-mode').value;
  const session = await api('/api/agent/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_root: state.folder.current, mode })
  });
  $('#new-session-dialog').close();
  state.activeMode = mode;
  await loadSessions();
  await openSession(session.session_id);
  const pending = state.pendingMessage;
  state.pendingMessage = '';
  if (pending) await sendMessage(pending);
  else $('#message-input').focus();
}

async function refreshSession(sessionId) {
  if (state.polling) return;
  state.polling = true;
  try {
    const session = await api(`/api/agent/sessions/${sessionId}`);
    if (state.session?.session_id === sessionId) { state.session = session; render(); }
    await loadSessions();
  } finally { state.polling = false; }
}

async function sendMessage(message) {
  if (!message.trim()) return;
  if (!state.session) {
    state.pendingMessage = message.trim();
    await openFolderDialog();
    return;
  }
  const sessionId = state.session.session_id;
  const before = state.session.messages.length;
  $('#message-input').value = '';
  state.activities = ['正在理解你的请求…'];
  state.session.messages.push({ role: 'user', content: message, created_at: new Date().toISOString() });
  state.session.status = 'running';
  state.session.active_turn = { turn: (state.session.current_turn || 0) + 1, steps: [] };
  render();
  await api(`/api/agent/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, enable_aha: state.ahaEnabled })
  });
  for (let attempt = 0; attempt < 1800; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 700));
    const fresh = await api(`/api/agent/sessions/${sessionId}`);
    if (state.session?.session_id !== sessionId) return;
    state.session = fresh;
    render();
    if (fresh.messages.length >= before + 2 && fresh.messages.at(-1)?.role === 'assistant' && fresh.status !== 'running') break;
  }
  delete state.session.active_turn;
  state.activities = [];
  renderActivity();
  await loadSessions();
}

const MODEL_PRESETS = [
  {
    label: 'DeepSeek 官方', icon: '🐳', id: 'DEEPSEEK', model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']
  },
  {
    label: 'Google Gemini', icon: '✨', id: 'GEMINI', model: 'gemini-3.7-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_schema',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    maxOutputTokens: 65536, maxConcurrent: 1, requestIntervalMs: 2500,
    modelsList: ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']
  },
  {
    label: '智谱清言 GLM', icon: '🔮', id: 'GLM', model: 'GLM-5.3-Flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    reasoningEffortMap: { medium: 'high', none: 'low' },
    modelsList: ['GLM-5.3-Flash', 'glm-4-plus', 'glm-4-flash']
  },
  {
    label: 'Anthropic Claude', icon: '🧠', id: 'CLAUDE', model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-3-5-haiku']
  },
  {
    label: 'OpenAI 官方', icon: '🟢', id: 'OPENAI', model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1', protocol: 'chat',
    tokenParameter: 'max_completion_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: true,
    modelsList: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini']
  },
  {
    label: '硅基流动 SiliconFlow', icon: '⚡', id: 'SILICONFLOW', model: 'deepseek-ai/DeepSeek-V3',
    baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct']
  },
  {
    label: '通义千问 DashScope', icon: '🌐', id: 'QWEN', model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['qwen-plus', 'qwen-max', 'qwen-turbo']
  },
  {
    label: '本地 Ollama / vLLM', icon: '🦙', id: 'LOCAL_OLLAMA', model: 'llama3:latest',
    baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat', isKeyless: true,
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: false, supportsSeed: true,
    modelsList: ['llama3:latest', 'qwen2.5:latest', 'deepseek-r1:latest']
  }
];

function syncFieldsToState() {
  if (!state.editingConfig) return;
  const mainSelect = $('#cfg-role-main');
  if (mainSelect) state.editingConfig.roles.main = mainSelect.value;

  const modelCards = document.querySelectorAll('.model-card-item[data-model-id]');
  modelCards.forEach(card => {
    const origId = card.dataset.modelId;
    const model = state.editingConfig.models.find(m => m.id === origId);
    if (!model) return;
    const idInput = card.querySelector('[data-cfg-field="id"]');
    const modelInput = card.querySelector('[data-cfg-field="model"]');
    const baseUrlInput = card.querySelector('[data-cfg-field="baseUrl"]');
    const protocolSelect = card.querySelector('[data-cfg-field="protocol"]');
    const keyInput = card.querySelector('[data-cfg-field="apiKey"]');

    if (idInput && idInput.value.trim()) model.id = idInput.value.trim();
    if (modelInput) model.model = modelInput.value.trim();
    if (baseUrlInput) model.baseUrl = baseUrlInput.value.trim();
    if (protocolSelect) model.protocol = protocolSelect.value;
    if (keyInput && keyInput.value.trim()) {
      model.apiKey = keyInput.value.trim();
      model.hasKey = true;
    }
  });

  document.querySelectorAll('[data-cfg-role]').forEach(select => {
    state.editingConfig.roles[select.dataset.cfgRole] = select.value;
  });
  document.querySelectorAll('[data-cfg-seat]').forEach(select => {
    const seatId = select.dataset.cfgSeat;
    const seat = (state.editingConfig.seats || []).find(s => s.id === seatId);
    if (seat) seat.modelId = select.value;
  });
}

function renderSettingsModalContent() {
  const container = $('#model-settings');
  if (!container || !state.editingConfig) return;

  const c = state.editingConfig;
  const models = c.models || [];
  const currentMain = c.roles?.main || c.roles?.chair || models[0]?.id || '';

  const modelOptionsHtml = models.map(m => `
    <option value="${escapeHtml(m.id)}" ${m.id === currentMain ? 'selected' : ''}>
      ${getModelIcon(m.id)} ${escapeHtml(m.id)} (${escapeHtml(m.model || '未设定')})
    </option>
  `).join('');

  const modelCardsHtml = models.map(m => {
    const isLocal = m.isKeyless || (m.baseUrl && (m.baseUrl.includes('localhost') || m.baseUrl.includes('127.0.0.1')));
    const statusClass = m.hasKey || isLocal ? 'ready' : 'unconfigured';
    const statusText = m.hasKey
      ? (m.keySource === 'env' ? '🟢 环境变量生效' : '🟢 密钥已配置')
      : (isLocal ? '🟢 本地免密钥' : '⚪ 未配置密钥');

    return `
      <div class="model-card-item" data-model-id="${escapeHtml(m.id)}">
        <div class="model-card-header">
          <div class="model-card-title-group">
            <span class="model-card-id">${getModelIcon(m.id)} ${escapeHtml(m.id)}</span>
            <span class="muted">· ${escapeHtml(m.model || '未选型')}</span>
            <span class="model-protocol-chip">${m.protocol === 'gemini' ? 'Gemini 原生' : 'OpenAI 兼容'}</span>
            <span class="model-status-chip ${statusClass}">${statusText}</span>
          </div>
          <div class="model-card-actions">
            <button type="button" class="model-action-btn" data-test-model="${escapeHtml(m.id)}">⚡ 测试连通性</button>
            <button type="button" class="model-action-btn" data-discover-model="${escapeHtml(m.id)}">🔍 探测模型</button>
            ${models.length > 1 ? `<button type="button" class="model-action-btn delete" data-delete-model="${escapeHtml(m.id)}">🗑️ 删除</button>` : ''}
          </div>
        </div>

        <div class="model-fields-grid">
          <label>
            <span>模型标识 ID (唯一)</span>
            <input type="text" data-cfg-field="id" data-model="${escapeHtml(m.id)}" value="${escapeHtml(m.id)}" placeholder="如 DEEPSEEK, GEMINI">
          </label>
          <label>
            <span>模型名称 (Model Name)</span>
            <input type="text" data-cfg-field="model" data-model="${escapeHtml(m.id)}" value="${escapeHtml(m.model || '')}" placeholder="如 deepseek-flash, gpt-4o">
          </label>
          <label>
            <span>服务端点 (Base URL)</span>
            <input type="text" data-cfg-field="baseUrl" data-model="${escapeHtml(m.id)}" value="${escapeHtml(m.baseUrl || '')}" placeholder="https://api.example.com/v1">
          </label>
          <label>
            <span>协议规范</span>
            <select data-cfg-field="protocol" data-model="${escapeHtml(m.id)}">
              <option value="chat" ${m.protocol !== 'gemini' ? 'selected' : ''}>chat (OpenAI 兼容)</option>
              <option value="gemini" ${m.protocol === 'gemini' ? 'selected' : ''}>gemini (Google 原生)</option>
            </select>
          </label>
          <label style="grid-column: span 2;">
            <span>API Key ${isLocal ? '<small>(本地服务无需填写)</small>' : '<small>(留空保持原配置)</small>'}</span>
            <div class="input-with-action">
              <input type="password" data-cfg-field="apiKey" data-model="${escapeHtml(m.id)}" placeholder="${m.hasKey ? (m.maskedKey || '已配置密钥') : '输入 API Key (如 sk-…)'}">
              <button type="button" class="model-action-btn" data-toggle-key="${escapeHtml(m.id)}" title="切换明文显示">👁️</button>
            </div>
          </label>
        </div>

        <div id="discover-box-${escapeHtml(m.id)}" class="discovered-models-box" hidden></div>
        <div id="test-box-${escapeHtml(m.id)}" class="test-result-indicator" hidden></div>
      </div>
    `;
  }).join('');

  const roleNames = [
    ['chair', '主席整理 (Chair)', '负责每轮发言汇总与核心架构决策'],
    ['dedup', '观点结晶 (Dedup)', '负责跨席位观点去重、合并与结晶'],
    ['dealer', '荷官发牌 (Dealer)', '负责认知算子抽取与多视角发牌刺激'],
    ['grounder', '事实核验 (Grounder)', '负责结合工作区代码与资料进行真实性校验'],
    ['assembly', '机制装配 (Assembly)', '负责从原子观点中装配正交机制方案']
  ];

  const roleAssignHtml = roleNames.map(([key, label, desc]) => {
    const val = c.roles?.[key] || currentMain;
    return `
      <div class="role-assign-item">
        <label title="${escapeHtml(desc)}">${escapeHtml(label)}</label>
        <select data-cfg-role="${key}">
          ${models.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === val ? 'selected' : ''}>${getModelIcon(m.id)} ${escapeHtml(m.id)}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  const seatsHtml = (c.seats || []).map((seat, idx) => {
    return `
      <div class="role-assign-item">
        <label>席位 #${idx + 1} (${escapeHtml(seat.id)})</label>
        <select data-cfg-seat="${escapeHtml(seat.id)}">
          ${models.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === seat.modelId ? 'selected' : ''}>${getModelIcon(m.id)} ${escapeHtml(m.id)}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="active-model-box">
      <div class="active-model-box-left">
        <h4>🎯 当前对话主模型 (Main Agent Model)</h4>
        <p>控制日常多轮对话、调用工作区文件工具以及推演调度的默认模型。</p>
      </div>
      <select id="cfg-role-main" class="active-model-select">
        ${modelOptionsHtml}
      </select>
    </div>

    <div class="presets-section">
      <span class="presets-title">✨ 常用服务商模版一键填入 / 添加：</span>
      <div class="presets-grid">
        ${MODEL_PRESETS.map(p => `
          <button type="button" class="preset-btn" data-preset="${escapeHtml(p.id)}">
            <span>${p.icon}</span> ${escapeHtml(p.label)}
          </button>
        `).join('')}
      </div>
    </div>

    <div class="models-list-section">
      <div class="models-list-header">
        <h3>已配置服务商与模型 (${models.length})</h3>
        <button type="button" class="add-model-btn" id="cfg-add-model-btn">➕ 添加自定义模型</button>
      </div>
      <div class="models-cards-wrap" style="display:flex;flex-direction:column;gap:12px">
        ${modelCardsHtml}
      </div>
    </div>

    <details class="advanced-roles-details">
      <summary class="advanced-roles-summary">
        <span>⚙️ 高级角色与 8 席位推演调度规则 (点击展开)</span>
        <span>▼</span>
      </summary>
      <div class="advanced-roles-body">
        <h4 style="margin:0;font-size:12px;color:var(--ink)">核心功能角色模型分配</h4>
        <div class="role-assign-grid">
          ${roleAssignHtml}
        </div>
        <h4 style="margin:10px 0 0;font-size:12px;color:var(--ink)">Aha 8 席位推演分配</h4>
        <div class="role-assign-grid">
          ${seatsHtml}
        </div>
      </div>
    </details>
  `;
}

async function openSettingsModal() {
  const dialog = $('#settings-dialog');
  if (!dialog) return;
  try {
    state.config = await api('/api/config');
    const live = state.config.liveConfig || state.config.mockConfig || { models: [], seats: [], roles: {} };
    state.editingConfig = structuredClone(live);
    if (!state.editingConfig.roles) state.editingConfig.roles = {};
    if (!state.editingConfig.roles.main) {
      state.editingConfig.roles.main = state.editingConfig.roles.chair || state.editingConfig.models?.[0]?.id || '';
    }
    renderSettingsModalContent();
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    toast(`加载配置失败: ${error.message}`);
  }
}

function applyPreset(presetId) {
  syncFieldsToState();
  const preset = MODEL_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  const existing = state.editingConfig.models.find(m => m.id === preset.id);
  if (existing) {
    existing.baseUrl = preset.baseUrl;
    existing.protocol = preset.protocol;
    existing.model = preset.model;
    existing.tokenParameter = preset.tokenParameter || 'max_tokens';
    existing.structuredOutput = preset.structuredOutput || 'json_object';
    toast(`已用「${preset.label}」最新端点更新 ${preset.id}`);
  } else {
    state.editingConfig.models.push({
      id: preset.id,
      model: preset.model,
      baseUrl: preset.baseUrl,
      protocol: preset.protocol,
      tokenParameter: preset.tokenParameter || 'max_tokens',
      structuredOutput: preset.structuredOutput || 'json_object',
      supportsTemperature: preset.supportsTemperature ?? true,
      supportsReasoning: preset.supportsReasoning ?? true,
      supportsSeed: preset.supportsSeed ?? false,
      hasKey: false
    });
    toast(`已添加「${preset.label}」，请在下方填写 API Key 并保存`);
  }
  renderSettingsModalContent();
}

function addCustomModel() {
  syncFieldsToState();
  let nextId = `MODEL_${state.editingConfig.models.length + 1}`;
  let count = 2;
  while (state.editingConfig.models.some(m => m.id === nextId)) {
    nextId = `MODEL_${count++}`;
  }
  state.editingConfig.models.push({
    id: nextId,
    model: '',
    baseUrl: 'https://',
    protocol: 'chat',
    tokenParameter: 'max_tokens',
    structuredOutput: 'json_object',
    supportsTemperature: true,
    supportsReasoning: true,
    supportsSeed: false,
    hasKey: false
  });
  renderSettingsModalContent();
  toast('已添加新模型卡片，请配置端点与模型名称');
}

function deleteModel(modelId) {
  syncFieldsToState();
  if (state.editingConfig.models.length <= 1) {
    toast('至少保留一个模型配置');
    return;
  }
  state.editingConfig.models = state.editingConfig.models.filter(m => m.id !== modelId);
  if (state.editingConfig.roles.main === modelId) {
    state.editingConfig.roles.main = state.editingConfig.models[0].id;
  }
  for (const [r, id] of Object.entries(state.editingConfig.roles)) {
    if (id === modelId) state.editingConfig.roles[r] = state.editingConfig.models[0].id;
  }
  (state.editingConfig.seats || []).forEach(seat => {
    if (seat.modelId === modelId) seat.modelId = state.editingConfig.models[0].id;
  });
  renderSettingsModalContent();
  toast(`已删除模型 ${modelId}`);
}

async function testModel(modelId) {
  syncFieldsToState();
  const testBox = document.getElementById(`test-box-${modelId}`);
  if (!testBox) return;
  testBox.hidden = false;
  testBox.className = 'test-result-indicator running';
  testBox.innerHTML = '<span class="activity-pulse"></span> 正在测试网络与 API 连通性…';

  const m = state.editingConfig.models.find(item => item.id === modelId);
  if (!m) return;

  try {
    const res = await api('/api/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelConfig: m, apiKey: m.apiKey })
    });
    if (res.ok) {
      testBox.className = 'test-result-indicator success';
      testBox.innerHTML = `✓ 测试通过！延迟 <b>${res.latencyMs}ms</b> · 模型: <code>${escapeHtml(res.model || m.model)}</code> · 响应: ${escapeHtml(res.response || 'OK')}`;
    } else {
      testBox.className = 'test-result-indicator fail';
      testBox.innerHTML = `❌ 连通失败 (${res.latencyMs ? res.latencyMs + 'ms' : '错误'}): ${escapeHtml(res.error || '未能连接到端点')}`;
    }
  } catch (err) {
    testBox.className = 'test-result-indicator fail';
    testBox.innerHTML = `❌ 请求错误: ${escapeHtml(err.message)}`;
  }
}

async function discoverModels(modelId) {
  syncFieldsToState();
  const box = document.getElementById(`discover-box-${modelId}`);
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div style="font-size:10.5px;color:var(--muted)">🔍 正在探测端点可用模型…</div>';

  const m = state.editingConfig.models.find(item => item.id === modelId);
  if (!m) return;

  try {
    const res = await api('/api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: m.baseUrl, apiKey: m.apiKey, protocol: m.protocol, modelId })
    });
    if (res.ok && res.models?.length) {
      box.innerHTML = `
        <div style="font-size:10.5px;font-weight:600;color:var(--accent);width:100%;margin-bottom:4px">
          命中 ${res.models.length} 个可用模型 (点击直接填入)：
        </div>
        ${res.models.slice(0, 24).map(mod => `
          <button type="button" class="discovered-model-pill" data-fill-model="${escapeHtml(mod.id)}" data-target-id="${escapeHtml(modelId)}">
            ${escapeHtml(mod.id)}
          </button>
        `).join('')}
      `;
    } else {
      box.innerHTML = `<div style="font-size:10.5px;color:#a83832">❌ ${escapeHtml(res.error || '未能在该端点发现模型列表')}</div>`;
    }
  } catch (err) {
    box.innerHTML = `<div style="font-size:10.5px;color:#a83832">❌ 探测出错: ${escapeHtml(err.message)}</div>`;
  }
}

async function saveSettingsModal() {
  syncFieldsToState();
  if (!state.editingConfig) return;

  const config = structuredClone(state.editingConfig);
  config.models = config.models.map(model => {
    const { hasKey, maskedKey, keySource, ...clean } = model;
    if (clean.apiKey && clean.apiKey.includes('•••')) delete clean.apiKey;
    return clean;
  });

  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    state.config = await api('/api/config');
    updateComposerModel();
    $('#settings-dialog').close();
    toast('大模型选型与配置已成功保存并即时生效！');
  } catch (error) {
    toast(`保存失败: ${error.message}`);
  }
}

$('#new-session').addEventListener('click', () => openFolderDialog().catch(error => toast(error.message)));
$('#workspace-button').addEventListener('click', () => openFolderDialog().catch(error => toast(error.message)));
$('#create-session').addEventListener('click', () => createSession().catch(error => toast(error.message)));
$('#folder-up').addEventListener('click', () => state.folder?.parent && loadDirectories(state.folder.parent).catch(error => toast(error.message)));
$('#folder-go').addEventListener('click', () => loadDirectories($('#folder-path').value.trim()).catch(error => toast(error.message)));
$('#folder-path').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('#folder-go').click(); } });
$('#folder-list').addEventListener('click', event => { const row = event.target.closest('[data-folder]'); if (row) loadDirectories(row.dataset.folder).catch(error => toast(error.message)); });
$('#tab-live')?.addEventListener('click', () => { state.activeMode = 'live'; renderSessions(); });
$('#tab-mock')?.addEventListener('click', () => { state.activeMode = 'mock'; renderSessions(); });
$('#clear-mock-btn')?.addEventListener('click', () => { clearMockSessions().catch(error => toast(error.message)); });
$('#composer').addEventListener('submit', event => { event.preventDefault(); sendMessage($('#message-input').value).catch(error => { setRunning(false); toast(error.message); }); });
$('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#message-input').addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(210, event.target.scrollHeight)}px`; });
$('#session-list').addEventListener('click', event => {
  const deleteBtn = event.target.closest('[data-delete-session]');
  if (deleteBtn) {
    event.stopPropagation();
    deleteSession(deleteBtn.dataset.deleteSession).catch(error => toast(error.message));
    return;
  }
  const button = event.target.closest('[data-session]');
  if (button) openSession(button.dataset.session).catch(error => toast(error.message));
});
$('#messages').addEventListener('click', event => {
  const suggestion = event.target.closest('[data-suggestion]');
  if (suggestion) { $('#message-input').value = suggestion.dataset.suggestion; $('#message-input').focus(); }
  if (event.target.closest('[data-open-workspace]')) openFolderDialog().catch(error => toast(error.message));
  const confirmation = event.target.closest('[data-confirm]');
  if (confirmation) { const message = state.session.messages[Number(confirmation.dataset.confirm)]; sendMessage(`/aha ${message.confirmation.original_problem}`).catch(error => toast(error.message)); }
  const tab = event.target.closest('[data-aha-tab]');
  if (tab) { state.ahaTabs[tab.dataset.runId] = tab.dataset.ahaTab; renderMessages(); }
});
$('#messages')?.addEventListener('scroll', updateScrollBottomBtn, { passive: true });
$('#scroll-bottom-btn')?.addEventListener('click', () => {
  const target = $('#messages');
  if (target) target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
});
$('#cancel-turn').addEventListener('click', async () => {
  if (!state.session) return;
  try { await api(`/api/agent/sessions/${state.session.session_id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('正在停止，已完成的中间结果会保留'); }
  catch (error) { toast(error.message); }
});

$('#open-settings')?.addEventListener('click', () => openSettingsModal());
$('#composer-model-btn')?.addEventListener('click', () => openSettingsModal());
$('#close-settings-dialog')?.addEventListener('click', () => $('#settings-dialog').close());
$('#close-settings-btn')?.addEventListener('click', () => $('#settings-dialog').close());
$('#save-settings')?.addEventListener('click', event => { event.preventDefault(); saveSettingsModal(); });

$('#settings-dialog')?.addEventListener('click', event => {
  const rect = $('#settings-dialog').getBoundingClientRect();
  const isInDialog = (rect.top <= event.clientY && event.clientY <= rect.top + rect.height &&
    rect.left <= event.clientX && event.clientX <= rect.left + rect.width);
  if (!isInDialog) {
    $('#settings-dialog').close();
  }
});

$('#new-session-dialog')?.addEventListener('click', event => {
  const rect = $('#new-session-dialog').getBoundingClientRect();
  const isInDialog = (rect.top <= event.clientY && event.clientY <= rect.top + rect.height &&
    rect.left <= event.clientX && event.clientX <= rect.left + rect.width);
  if (!isInDialog) {
    $('#new-session-dialog').close();
  }
});

$('#aha-toggle')?.addEventListener('click', () => {
  state.ahaEnabled = !state.ahaEnabled;
  localStorage.setItem('aha_enabled', String(state.ahaEnabled));
  updateAhaToggle();
  toast(`Aha 深度探索已${state.ahaEnabled ? '开启 (遇到机制问题将自动展开推演)' : '关闭 (纯对话与文件读写，不启动推演)'}`);
});

$('#settings-body')?.addEventListener('click', event => {
  const testBtn = event.target.closest('[data-test-model]');
  if (testBtn) {
    testModel(testBtn.dataset.testModel);
    return;
  }
  const discoverBtn = event.target.closest('[data-discover-model]');
  if (discoverBtn) {
    discoverModels(discoverBtn.dataset.discoverModel);
    return;
  }
  const deleteBtn = event.target.closest('[data-delete-model]');
  if (deleteBtn) {
    deleteModel(deleteBtn.dataset.deleteModel);
    return;
  }
  const presetBtn = event.target.closest('[data-preset]');
  if (presetBtn) {
    applyPreset(presetBtn.dataset.preset);
    return;
  }
  if (event.target.closest('#cfg-add-model-btn')) {
    addCustomModel();
    return;
  }
  const toggleKeyBtn = event.target.closest('[data-toggle-key]');
  if (toggleKeyBtn) {
    const modelId = toggleKeyBtn.dataset.toggleKey;
    const input = document.querySelector(`input[data-cfg-field="apiKey"][data-model="${CSS.escape(modelId)}"]`);
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }
  const fillPill = event.target.closest('[data-fill-model]');
  if (fillPill) {
    const targetId = fillPill.dataset.targetId;
    const modelVal = fillPill.dataset.fillModel;
    const input = document.querySelector(`input[data-cfg-field="model"][data-model="${CSS.escape(targetId)}"]`);
    if (input) {
      input.value = modelVal;
      const model = state.editingConfig?.models.find(m => m.id === targetId);
      if (model) model.model = modelVal;
      toast(`已填入模型: ${modelVal}`);
    }
    return;
  }
});

try {
  try { state.config = await api('/api/config'); } catch {}
  updateComposerModel();
  updateAhaToggle();
  await loadSessions();
  const fromHash = location.hash.match(/^#(session-[A-Za-z0-9-]+)$/)?.[1];
  if (fromHash && state.sessions.some(session => session.session_id === fromHash)) {
    await openSession(fromHash);
  } else {
    const liveSessions = state.sessions.filter(s => s.mode !== 'mock');
    const mockSessions = state.sessions.filter(s => s.mode === 'mock');
    if (liveSessions.length) {
      state.activeMode = 'live';
      await openSession(liveSessions[0].session_id);
    } else if (mockSessions.length) {
      state.activeMode = 'mock';
      await openSession(mockSessions[0].session_id);
    } else {
      render();
    }
  }
} catch (error) {
  $('#messages').innerHTML = `<div class="empty-state"><h2>工作台无法连接</h2><p>${escapeHtml(error.message)}</p></div>`;
}
