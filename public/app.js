import { renderMarkdown } from './markdown.js';

const $ = selector => document.querySelector(selector);

function loadCollapsedFolders() {
  try {
    return new Set(JSON.parse((localStorage.getItem('varina_collapsed_folders') || localStorage.getItem('aha_collapsed_folders')) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders(set) {
  try {
    localStorage.setItem('varina_collapsed_folders', JSON.stringify([...set]));
  } catch {}
}

function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

function getFolderName(normalizedPath) {
  if (!normalizedPath) return '未命名工作区';
  const parts = normalizedPath.split(/[\\/]/).filter(Boolean);
  return parts.pop() || normalizedPath;
}

const state = {
  sessions: [], sessionCounts: { live: 0, mock: 0 }, activeMode: 'live',
  session: null, source: null, config: null, polling: false,
  activities: [], ahaTabs: {}, subproblemSelections: {}, folder: null, pendingMessage: '',
  ahaEnabled: (localStorage.getItem('varina_enabled') ?? localStorage.getItem('aha_enabled')) !== 'false',
  editingConfig: null,
  activeSettingsTab: 'general',
  userScrolledUp: false,
  forceScrollToBottom: false,
  collapsedFolders: loadCollapsedFolders(),
  scrollCache: new Map()
};

function getPreferences() {
  return {
    varyTriggerMode: localStorage.getItem('vary_trigger_mode') || 'smart',
    sendShortcut: localStorage.getItem('send_shortcut') || 'enter',
    toolStepsDisplay: localStorage.getItem('tool_steps_display') || 'compact',
    messageFontSize: localStorage.getItem('message_font_size') || 'medium'
  };
}

function savePreference(key, value) {
  localStorage.setItem(key, value);
  applyPreferences();
}

function applyPreferences() {
  const prefs = getPreferences();
  const sizeMap = { small: '13px', medium: '14.5px', large: '16px' };
  document.documentElement.style.setProperty('--message-font-size', sizeMap[prefs.messageFontSize] || '14.5px');

  if (prefs.toolStepsDisplay === 'compact') {
    document.body.classList.add('tool-steps-compact');
  } else {
    document.body.classList.remove('tool-steps-compact');
  }

  updateVarinaToggle();
}

function getModelIcon(modelId = '') {
  return '';
}

function updateVarinaToggle() {
  const btn = $('#aha-toggle');
  const status = $('#aha-toggle-status');
  const label = btn?.querySelector('.aha-toggle-label') || btn?.querySelector('.varina-toggle-label');
  if (!btn) return;
  const prefs = getPreferences();
  const mode = prefs.varyTriggerMode;

  if (label) label.textContent = 'Vary 探索';

  if (mode === 'never') {
    btn.className = 'aha-toggle-pill inactive';
    btn.title = 'Vary 探索策略：总是关闭（点击切换模式）';
    if (status) status.textContent = '关闭';
  } else if (mode === 'always') {
    btn.className = 'aha-toggle-pill active';
    btn.title = 'Vary 探索策略：总是开启（点击切换模式）';
    if (status) status.textContent = '常开';
  } else if (mode === 'ask') {
    btn.className = 'aha-toggle-pill active';
    btn.title = 'Vary 探索策略：每次询问（点击切换模式）';
    if (status) status.textContent = '询问';
  } else {
    // smart
    btn.className = 'aha-toggle-pill active';
    btn.title = 'Vary 探索策略：智能判定（推荐，遇到机制分歧自动推演，点击切换模式）';
    if (status) status.textContent = '智能';
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
    const pName = modelObj.providerName || modelObj.id.split('_')[0];
    const mName = modelObj.displayName || modelObj.model || modelObj.id;
    labelEl.textContent = `${pName} · ${mName}`.trim();
    labelEl.title = `主对话模型: ${pName} · ${mName} - 点击配置大模型与规则`;
  } else {
    labelEl.textContent = '配置模型';
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
  $('#send-message').hidden = running;
  $('#send-message').disabled = running;
  $('#cancel-turn').hidden = !running;
  $('#message-input').disabled = running;
}

function renderSessionItem(session) {
  const isActive = state.session?.session_id === session.session_id;
  return `
    <div class="session-item-row ${isActive ? 'active' : ''}">
      <button class="session-item" data-session="${escapeHtml(session.session_id)}" title="${escapeHtml(session.title)}">
        <strong>${escapeHtml(session.title)}</strong>
        <small>${session.current_turn} 轮 · ${session.varina_runs ?? session.aha_runs} 次 Varina · ${session.mode === 'mock' ? '<span class="mode-tag mock">模拟</span>' : '<span class="mode-tag live">真实</span>'}</small>
      </button>
      <button class="session-delete-btn" data-delete-session="${escapeHtml(session.session_id)}" title="删除此会话" aria-label="删除此会话">×</button>
    </div>`;
}

function renderFolderGroup(folder) {
  const isCollapsed = state.collapsedFolders.has(folder.key);
  const sessionRowsHtml = folder.sessions.map(renderSessionItem).join('');

  return `
    <div class="folder-group ${isCollapsed ? 'collapsed' : ''}" data-folder-key="${escapeHtml(folder.key)}">
      <div class="folder-header" data-toggle-folder="${escapeHtml(folder.key)}" title="工作区目录: ${escapeHtml(folder.path)}">
        <span class="folder-chevron">${isCollapsed ? '▸' : '▾'}</span>
        <span class="folder-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </span>
        <span class="folder-title">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${folder.sessions.length}</span>
        <div class="folder-actions">
          <button class="folder-action-btn" data-create-in-folder="${escapeHtml(folder.path)}" title="基于此目录新建${state.activeMode === 'mock' ? '模拟' : '真实'}会话" aria-label="基于此目录新建会话">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="folder-sessions" ${isCollapsed ? 'hidden' : ''}>
        ${sessionRowsHtml}
      </div>
    </div>`;
}

function toggleFolderCollapse(folderKey) {
  if (!folderKey) return;
  const key = normalizePath(folderKey).toLowerCase();
  const isNowCollapsed = !state.collapsedFolders.has(key);
  if (isNowCollapsed) {
    state.collapsedFolders.add(key);
  } else {
    state.collapsedFolders.delete(key);
  }
  saveCollapsedFolders(state.collapsedFolders);

  const groupEl = document.querySelector(`.folder-group[data-folder-key="${CSS.escape(key)}"]`);
  if (groupEl) {
    groupEl.classList.toggle('collapsed', isNowCollapsed);
    const chevron = groupEl.querySelector('.folder-chevron');
    if (chevron) chevron.textContent = isNowCollapsed ? '▸' : '▾';
    const sessionsEl = groupEl.querySelector('.folder-sessions');
    if (sessionsEl) sessionsEl.hidden = isNowCollapsed;
  } else {
    renderSessions();
  }
}

async function createSessionInFolder(folderPath) {
  if (!folderPath) return;
  const mode = state.activeMode || 'live';
  const folderName = getFolderName(normalizePath(folderPath));
  try {
    toast(`正在「${folderName}」中创建新会话…`);
    const session = await api('/api/agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_root: folderPath, mode })
    });
    state.activeMode = mode;
    const folderKey = normalizePath(folderPath).toLowerCase();
    state.collapsedFolders.delete(folderKey);
    saveCollapsedFolders(state.collapsedFolders);
    await loadSessions();
    await openSession(session.session_id);
    const pending = state.pendingMessage;
    state.pendingMessage = '';
    if (pending) await sendMessage(pending);
    else $('#message-input')?.focus();
    toast(`已在「${folderName}」创建${mode === 'mock' ? '模拟' : '真实'}会话`);
  } catch (error) {
    toast(error.message);
  }
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

  // 先按工作区聚合当前模式下的会话
  const folderMap = new Map();
  const unfiledSessions = [];

  for (const session of filtered) {
    const ws = normalizePath(session.workspace_root);
    if (!ws) {
      unfiledSessions.push(session);
    } else {
      const folderKey = ws.toLowerCase();
      if (!folderMap.has(folderKey)) {
        folderMap.set(folderKey, {
          path: session.workspace_root,
          key: folderKey,
          name: getFolderName(ws),
          sessions: [],
          latestUpdate: 0
        });
      }
      const group = folderMap.get(folderKey);
      group.sessions.push(session);
      const ts = new Date(session.updated_at || session.created_at || 0).getTime();
      if (ts > group.latestUpdate) group.latestUpdate = ts;
    }
  }

  // 文件夹按最新会话活跃时间排序
  const sortedFolders = Array.from(folderMap.values()).sort((a, b) => b.latestUpdate - a.latestUpdate);

  for (const folder of sortedFolders) {
    folder.sessions.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  }

  unfiledSessions.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));

  let html = sortedFolders.map(folder => renderFolderGroup(folder)).join('');
  if (unfiledSessions.length) {
    html += `
      <div class="recent-section">
        <div class="recent-header">
          <span class="section-label">最近</span>
          <span class="recent-count">${unfiledSessions.length}</span>
        </div>
        <div class="recent-sessions">
          ${unfiledSessions.map(renderSessionItem).join('')}
        </div>
      </div>`;
  }

  $('#session-list').innerHTML = html;
}

function emptyState() {
  return `<div class="empty-state">
    <div class="orb">✦</div>
    <h2>今天想创造什么？</h2>
    <p>先选择一个工作目录。Varina 会在同一段对话里阅读资料、使用工具，并在需要时展开完整的多视角探索。</p>
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

const CREATIVE_SEAT_SYSTEM_PROMPT = `目标：解构当前工程问题与底层死锁，提出有信息增量的原子观点、反例、修正或可落地的独立原子机制。

【贡献类型与产出纪律（contributions.type 选择清单）】
并非所有有效思考都直接发现新机制。根据思考动作选择匹配的 type：
- proposal（方案）：可直接落地的完整规则构想或整体设计方案。
- mechanism（机制）：单一、可复用的计算或因果规则（可在 15 行代码内写完，不可拆分，严禁多阶段流水线）。
- counterexample（反例）：指出已有观点或常规做法在何种极端边界下必然崩溃、失效或引发反弹。
- reframing（问题重构）：改变审视问题的参照点或表述框架（如损失换为收益、个体换为系统等）。
- connection（新联系）：顺着推演两个机制之间的联动、二阶效应或隐蔽耦合关系。
- modification（改造）：对已有观点提出打补丁式的条件修正，收窄其适用边界或适配新场景。
- assumption（隐藏假设）：指出大家默认成立、但现实中可能脆弱甚至相反的隐含前提。
【方案（proposal）硬性装配与写作约束】
方案不是自创世界，方案的本质是机制的装配组合，严禁无上限堆叠：
1. 机制配额与单点取舍：每个方案仅用于装配 1 到 3 个核心原子机制。严禁兼顾所有方向的大全集缝合，必须做单点取舍，并明确指出本方案主动放弃了什么、承受了什么代价。
2. 写作规范：面向提出问题的真实从业者写作。标题用不超过 32 个字的大白话，不加英文副标题，不创造听起来高级的新术语；阐明这 1~3 个核心机制如何配合，给出一个具体使用过程或数字例子，并诚实说明主要代价、失效条件和最低成本验证方法。严禁使用【方案目标】【完整机制】【组件配合】等公文模板标题水字数。
3. 宁缺毋滥：若当前尚未有成熟正交组合，切勿强行凑写方案。

【表达与思维纪律】
1. 讲人话：必须使用提问者听得懂的日常语言或业务领域语言。严禁生造晦涩抽象词，严禁使用“双账本、回路、质押、槽位化、归因迁移、凭证、协议”等虚浮的伪系统工程与学术包装名词。
2. 禁生搬硬套：分配的思维刺激仅用于在内部改变你检查问题的角度。严禁在交付文字中提及算子名称，尤其严禁把刺激中的物理隐喻、剧情装置或数学术语生搬硬套进不使用这些词的行业。
3. 杜绝缝合：严禁为了兼顾所有方面搞大而全的折中方案，坚持单点因果与清晰取舍。

【硬性执行规则】
1. 以 original_user_request 为唯一最高权威任务。Project context 仅供语义对齐，不得改写用户原意。Agent 任务界定与假说仅供参考，可挑战。
2. 不得访问工作区，不得虚构文件或实现细节。依赖实际代码实现的主张，须写入 verification_requests（最多 2 条，claim_id 为 "V1", "V2"），其 affected_local_ids 必须严格对应本次提出的 local_id。
3. 严格仅返回符合 Schema 的 JSON。
4. 产出 0–3 条真正具有信息增量的原子贡献（local_id 格式为 "C1", "C2", "C3"）。可以是全新机制，也可以是高质量反例、框架重构或顺承衍生；对已有观点板做同义改写不属于增量。
5. 必须精确原样回传 seat_id 与 packet_token。`;

function findExploreStepForRun(runId) {
  if (!state.session) return null;
  const messages = state.session.messages ?? [];
  for (const msg of messages) {
    if (msg.varina_run_id === runId || msg.aha_run_id === runId) {
      const step = msg.steps?.find(s => s.name === 'ExploreDesign');
      if (step) return step;
    }
    const step = msg.steps?.find(s => s.name === 'ExploreDesign' && (s.result?.run_id === runId || s.id === runId));
    if (step) return step;
  }
  const activeSteps = state.session.active_turn?.steps ?? [];
  const activeStep = activeSteps.find(s => s.name === 'ExploreDesign' && (s.id === runId || s.result?.run_id === runId));
  if (activeStep) return activeStep;
  return null;
}

function getFrozenPacketJson(run) {
  if (run.commonPrefix) {
    try {
      const parsed = typeof run.commonPrefix === 'string' ? JSON.parse(run.commonPrefix) : run.commonPrefix;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return run.commonPrefix;
    }
  }
  if (run.frozenPacket) {
    return JSON.stringify(run.frozenPacket, null, 2);
  }
  const obj = {
    frozen_shared_input_packet: {
      original_user_request: run.originalUserRequest || run.problem || '',
      task_framing: run.taskFraming || run.problem || '',
      project_context: run.projectContext || (state.session?.project_context ?? ''),
      user_constraints: run.userConstraints || [],
      verified_investigation_context: run.codeContext || (run.sourceExcerpts?.length ? JSON.stringify(run.sourceExcerpts, null, 2) : ''),
      agent_hypotheses: run.agentHypotheses || [],
      verified_facts: (run.facts || []).filter(f => !['unknown', 'stale'].includes(f.status)).map(f => ({
        fact_id: f.fact_id ?? f.fact_ref,
        fact_ref: f.fact_ref,
        status: f.status,
        semantic_summary: f.semantic_summary ?? f.claim,
        correction: f.correction ?? null
      })),
      current_board: run.board || { points: [] },
      repository_snapshot_id: run.repositorySnapshotId || '',
      packet_token: run.packetToken || ''
    },
    output_contract: 'Return the required CreativeSeatResponse JSON. The packet above is frozen and identical for all seats.'
  };
  return JSON.stringify(obj, null, 2);
}

function formatExplorePrompt(run) {
  const frozenJson = getFrozenPacketJson(run);
  let operatorsSuffix = '';
  if (run.currentAssignments?.length) {
    operatorsSuffix = run.currentAssignments.map(a => {
      const ops = (a.operators || []).map(op => `- ${op.id || op.operator_id} ${op.name}: ${op.prompt}`).join('\n');
      return `Seat ID: ${a.seat_id}\nAssigned operators:\n${ops}`;
    }).join('\n\n');
  } else {
    operatorsSuffix = `Seat ID: seat-1\nAssigned operators:\n- (席位思维算子将在各轮并发推演时动态抽取并拼接)`;
  }

  return `================================================================================
[1] SYSTEM PROMPT (CREATIVE_SEAT_SYSTEM_PROMPT)
================================================================================
${CREATIVE_SEAT_SYSTEM_PROMPT}

================================================================================
[2] USER MESSAGE 1: FROZEN COMMON PREFIX (JSON)
================================================================================
${frozenJson}

================================================================================
[3] USER MESSAGE 2: SEAT-SPECIFIC SUFFIX (Sample Seat)
================================================================================
Seat-specific suffix:
${operatorsSuffix}`;
}

async function copyHeroPrompt(runId) {
  const runs = state.session?.varina_runs ?? state.session?.aha_runs ?? [];
  const activeRuntime = state.session?.active_varina_runtime || state.session?.active_aha_runtime;
  const rawRun = runs.find(r => r.run_id === runId) || (activeRuntime?.run_id === runId ? activeRuntime : null);
  const run = rawRun ? viewRun(rawRun, activeRuntime?.run_id === runId ? activeRuntime : null) : null;
  if (!run) {
    toast('未找到该推演的完整信息');
    return;
  }
  const promptText = formatExplorePrompt(run);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(promptText);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = promptText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    toast('已复制完整推演 Prompt 到剪贴板');
  } catch (err) {
    toast(`复制失败: ${err.message}`);
  }
}

function viewRun(record, runtime = null) {
  const source = runtime ?? record ?? {};
  const handoff = source.handoff ?? {};
  const runId = source.run_id ?? record?.run_id ?? 'aha-live';
  const step = findExploreStepForRun(runId);
  const stepInput = step?.input ?? {};

  return {
    id: runId,
    problem: source.problem ?? record?.problem ?? stepInput.problem ?? '',
    originalUserRequest: source.original_user_request ?? record?.original_user_request ?? handoff.original_user_request ?? source.problem ?? record?.problem ?? stepInput.problem ?? '',
    taskFraming: source.task_framing ?? record?.task_framing ?? handoff.task_framing ?? stepInput.problem ?? '',
    userConstraints: source.user_constraints ?? record?.user_constraints ?? handoff.user_constraints ?? source.hard_constraints ?? record?.hard_constraints ?? stepInput.user_constraints ?? stepInput.constraints ?? [],
    agentHypotheses: source.agent_hypotheses ?? record?.agent_hypotheses ?? handoff.agent_hypotheses ?? stepInput.agent_hypotheses ?? [],
    codeContext: source.code_context ?? record?.code_context ?? handoff.code_context ?? '',
    sourceExcerpts: source.source_excerpts ?? record?.source_excerpts ?? handoff.source_excerpts ?? stepInput.source_excerpts ?? [],
    relevantFiles: source.relevant_files ?? record?.relevant_files ?? handoff.relevant_files ?? stepInput.relevant_files ?? [],
    projectContext: source.project_context ?? record?.project_context ?? handoff.project_context ?? '',
    commonPrefix: source.common_prefix ?? record?.common_prefix ?? handoff.common_prefix ?? null,
    frozenPacket: source.frozen_packet ?? record?.frozen_packet ?? handoff.frozen_packet ?? null,
    repositorySnapshotId: source.repository_snapshot_id ?? record?.repository_snapshot_id ?? handoff.repository_snapshot_id ?? '',
    packetToken: source.current_packet_token ?? record?.current_packet_token ?? '',
    state: handoff.state ?? source.state ?? source.status ?? record?.state ?? 'active',
    stopReason: handoff.stop_reason ?? source.stop_reason ?? record?.stop_reason,
    rounds: handoff.rounds_executed ?? source.rounds_executed ?? source.round_records?.length ?? record?.rounds_executed ?? 0,
    currentRound: source.current_round ?? handoff.rounds_executed ?? record?.rounds_executed ?? (source.status === 'active' || record?.state === 'active' ? 1 : 0),
    maxRounds: source.max_rounds ?? record?.max_rounds ?? handoff.max_rounds ?? 5,
    board: handoff.meeting_board ?? source.final_meeting_board ?? source.meeting_board ?? source.current_board ?? record?.final_meeting_board ?? { points: [] },
    facts: handoff.fact_ledger ?? source.final_fact_ledger ?? source.fact_ledger ?? record?.final_fact_ledger ?? [],
    solutions: handoff.solutions ?? source.solutions ?? record?.solutions ?? [],
    unresolved: handoff.unresolved_questions ?? source.unresolved_questions ?? record?.unresolved_questions ?? [],
    rejected: handoff.rejected_directions ?? source.rejected_directions ?? record?.rejected_directions ?? [],
    degradations: handoff.degradations ?? source.degradations ?? record?.degradations ?? [],
    decomposition: handoff.decomposition ?? source.decomposition ?? record?.decomposition ?? null,
    react: handoff.react ?? source.react ?? record?.react ?? null,
    subproblemExpansion: handoff.subproblem_expansion ?? source.subproblem_expansion ?? record?.subproblem_expansion ?? null,
    roundRecords: handoff.round_records ?? source.round_records ?? record?.round_records ?? [],
    seatResponses: handoff.seat_responses ?? source.seat_responses ?? record?.seat_responses ?? [],
    partialSeatResponses: source.partial_seat_responses ?? [],
    currentAssignments: source.current_assignments ?? []
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
  return points.length ? `<div class="card-grid">${points.map(point => {
    const isSubproblem = point.type === 'subproblem';
    const footer = isSubproblem
      ? '<footer><strong>用途</strong>供后续席位分别发散并重新组合</footer>'
      : `<footer>${point.parent_subproblem_id ? `<strong>来源子问题</strong>${escapeHtml(point.parent_subproblem_id)}<br>` : ''}<strong>失效边界</strong>${escapeHtml(point.failure_condition)}</footer>`;
    return `<article class="data-card point-card ${isSubproblem ? 'subproblem-card' : ''}"><header><span>${escapeHtml(point.id)}</span><span>rev ${point.revision}</span></header><span class="type-chip">${isSubproblem ? '子问题' : escapeHtml(point.type)}</span><p>${escapeHtml(point.text)}</p>${footer}</article>`;
  }).join('')}</div>` : '<div class="workbench-empty">观点板尚未产生原子观点。</div>';
}

function renderSubproblemExpansion(run) {
  const expansion = run.subproblemExpansion;
  const subproblems = (run.board?.points ?? []).filter(point => point.status === 'active' && point.type === 'subproblem');
  if (!subproblems.length) {
    if (run.decomposition?.status === 'active') {
      return '<div class="workbench-empty"><span class="activity-pulse"></span> 正在拆解问题，识别可独立回答的子问题…</div>';
    }
    if (expansion?.status === 'active') {
      return '<div class="workbench-empty"><span class="activity-pulse"></span> 子问题拆解完成，正在准备逐题回答…</div>';
    }
    return '<div class="workbench-empty">问题拆解尚未产生可发散的子问题。</div>';
  }

  const recordById = new Map((expansion?.records ?? []).map(record => [record.subproblem_id, record]));
  const configuredN2 = expansion?.answers_per_subproblem
    ?? state.config?.liveConfig?.subproblemExpansion?.answersPerSubproblem
    ?? state.config?.mockConfig?.subproblemExpansion?.answersPerSubproblem
    ?? 2;
  const remembered = state.subproblemSelections[run.id];
  const selected = subproblems.some(point => point.id === remembered) ? remembered : subproblems[0].id;
  state.subproblemSelections[run.id] = selected;
  const selectedPoint = subproblems.find(point => point.id === selected);
  const selectedRecord = recordById.get(selected);
  const linkedPoints = (run.board?.points ?? []).filter(point =>
    point.status === 'active' && point.parent_subproblem_id === selected
  );

  const subproblemCards = subproblems.map((point, index) => {
    const record = recordById.get(point.id);
    const answers = record?.answers ?? [];
    const completed = answers.filter(answer => answer.status === 'completed').length;
    const failed = answers.filter(answer => answer.status === 'failed').length;
    const running = answers.filter(answer => answer.status === 'running').length;
    const expected = answers.length || configuredN2;
    const extracted = (run.board?.points ?? []).filter(item => item.status === 'active' && item.parent_subproblem_id === point.id).length;
    const statusText = running
      ? `${completed}/${expected} 已完成`
      : record
        ? `${completed} 完成${failed ? ` · ${failed} 失败` : ''}`
        : '等待回答';
    return `
      <button type="button" class="subproblem-choice-card ${point.id === selected ? 'selected' : ''} ${running ? 'running' : ''}" data-subproblem-select="${escapeHtml(point.id)}" data-run-id="${escapeHtml(run.id)}">
        <span class="subproblem-choice-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="subproblem-choice-id">${escapeHtml(point.id)}</span>
        <strong>${escapeHtml(point.text)}</strong>
        <span class="subproblem-choice-meta">
          <span>${escapeHtml(statusText)}</span>
          <span>${extracted} 个入板观点</span>
        </span>
      </button>`;
  }).join('');

  const answerSlots = selectedRecord?.answers ?? Array.from({ length: configuredN2 }, (_, index) => ({
    answer_index: index + 1,
    seat_id: '待分配',
    model_id: 'auto',
    status: 'waiting',
    candidate_ids: []
  }));
  const answerCards = answerSlots.map(answer => {
    const transientElements = Array.isArray(answer.elements) ? answer.elements : [];
    const persistedElements = linkedPoints.filter(point =>
      (point.source_candidate_ids ?? []).some(id => (answer.candidate_ids ?? []).includes(id))
    );
    const elements = persistedElements.length ? persistedElements : transientElements;
    const status = answer.status ?? 'waiting';
    const statusLabel = status === 'completed' ? '已完成' : status === 'failed' ? '失败' : status === 'running' ? '回答中' : '等待启动';
    let body;
    if (status === 'running') {
      body = `<div class="subanswer-running"><span class="activity-pulse"></span>正在独立回答当前子问题并提取原子元素…</div>`;
    } else if (status === 'failed') {
      body = `<div class="subanswer-error"><strong>该席位未完成</strong><span>${escapeHtml(answer.error || '模型调用失败')}</span></div>`;
    } else if (status === 'completed') {
      body = elements.length ? `<div class="subanswer-elements">${elements.map(element => `
        <article class="subanswer-element-card">
          <header><span>${escapeHtml(element.id ?? element.candidate_id ?? '候选')}</span><span>${escapeHtml(element.type ?? '观点')}</span></header>
          <p>${escapeHtml(element.text)}</p>
          <footer><strong>失效边界</strong>${escapeHtml(element.failure_condition)}</footer>
        </article>`).join('')}</div>` : '<div class="subanswer-empty">回答完成，但没有产生新的入板元素，或内容与已有观点完全相同。</div>';
    } else {
      body = '<div class="subanswer-empty">等待该子问题进入回答阶段。</div>';
    }
    return `
      <article class="subanswer-seat-card ${escapeHtml(status)}">
        <div class="subanswer-seat-head">
          <div><span class="subanswer-seat-number">回答席位 ${answer.answer_index}</span><strong>${getModelIcon(answer.model_id)} ${escapeHtml(answer.model_id)}</strong></div>
          <span class="subanswer-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="subanswer-seat-source">调度席位：${escapeHtml(answer.seat_id)}</div>
        ${body}
      </article>`;
  }).join('');

  const success = expansion?.successful_answers ?? 0;
  const failed = expansion?.failed_answers ?? 0;
  const total = expansion?.total_requests ?? subproblems.length * configuredN2;
  return `
    <div class="subproblem-expansion-view">
      <section class="subproblem-stage-head">
        <div>
          <span class="step-tag">D2 发散</span>
          <h3>逐个子问题独立回答</h3>
          <p>先选择一个子问题，再查看为它并行启动的回答席位及入板元素。</p>
        </div>
        <div class="subproblem-stage-stats">
          <span>${subproblems.length} 个子问题</span><span>n2 = ${configuredN2}</span><span>${success}/${total} 完成${failed ? ` · ${failed} 失败` : ''}</span>
        </div>
      </section>

      <section class="subproblem-scroll-section">
        <div class="scroll-section-title"><strong>子问题</strong><span>横向滑动 · 点击切换</span></div>
        <div class="subproblem-horizontal-scroll" data-scroll-id="scroll-subproblems-${escapeHtml(run.id)}">
          ${subproblemCards}
        </div>
      </section>

      <section class="subproblem-scroll-section answers">
        <div class="scroll-section-title">
          <div><strong>${escapeHtml(selectedPoint.id)} 的回答席位</strong><p>${escapeHtml(selectedPoint.text)}</p></div>
          <span>${answerSlots.length} 个席位 · ${linkedPoints.length} 个入板观点</span>
        </div>
        <div class="subanswer-horizontal-scroll" data-scroll-id="scroll-subanswers-${escapeHtml(run.id)}-${escapeHtml(selected)}">
          ${answerCards}
        </div>
      </section>
    </div>`;
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
    const roundSeatsData = run.seatResponses.find(r => r.round === rnd)?.responses
      || (rnd === run.currentRound && run.partialSeatResponses?.length ? run.partialSeatResponses : []);
    const isCurrentRound = (live || run.state === 'active') && (run.currentRound === rnd || (!run.currentRound && rnd === maxRound));

    const seatCardsHtml = [];
    for (let i = 0; i < 8; i++) {
      const defaultId = `seat-${i + 1}`;
      const cfgSeat = configSeats[i] || { id: defaultId, modelId: 'auto' };
      const resp = roundSeatsData.find(s => s.seat_id === cfgSeat.id || s.seat_id === defaultId || s.seat_id === `Seat ${i + 1}`)
                || (roundSeatsData[i] && (roundSeatsData.length <= 8) ? roundSeatsData[i] : null);

      const assignment = rnd === run.currentRound ? run.currentAssignments?.find(a => a.seat_id === cfgSeat.id || a.seat_id === defaultId) : null;
      const seatId = resp?.seat_id || assignment?.seat_id || cfgSeat.id;
      const modelId = resp?.modelId || assignment?.modelId || cfgSeat.modelId || 'auto';
      const operators = (resp?.operators?.length) ? resp.operators : (assignment?.operators || []);
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
            <div class="thinking-content" data-scroll-id="scroll-seat-think-R${rnd}-${escapeHtml(seatId)}">${escapeHtml(resp.analysis_summary || '本轮机制推演完成。')}</div>
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

function renderExplorePromptTab(run) {
  const fullPromptText = formatExplorePrompt(run);
  const constraints = run.userConstraints || [];
  const hypotheses = run.agentHypotheses || [];

  return `
    <div class="explore-prompt-tab">
      <div class="explore-prompt-header">
        <div class="explore-prompt-meta">
          <h4>席位输入基准 Prompt 构成</h4>
          <p>Varina 采用统一冻结上下文（Frozen Shared Packet），所有创意席位在同一轮次读取完全一致的 System Prompt、原始请求、任务定义、硬约束与代码上下文。</p>
        </div>
        <button type="button" class="varina-copy-prompt-btn tab-copy-btn" data-copy-hero-prompt="${escapeHtml(run.id)}">
          <span>📋</span> 复制完整 Prompt
        </button>
      </div>

      <div class="explore-prompt-cards-grid">
        <article class="data-card prompt-section-card">
          <header><span>01 · SYSTEM PROMPT</span><span>硬约束规则</span></header>
          <p>CreativeSeat 席位专家设定，强制 6 项硬规则（禁止擅自读写工作区、严格引用验证事实、限定 0–3 条新机制观点等）。</p>
          <pre class="prompt-code-snippet">${escapeHtml(CREATIVE_SEAT_SYSTEM_PROMPT)}</pre>
        </article>

        <article class="data-card prompt-section-card">
          <header><span>02 · 任务与原始请求</span><span>Level-0 意图</span></header>
          <div class="prompt-field-group">
            <div class="prompt-field-label">原始用户问题 (original_user_request):</div>
            <div class="prompt-field-val">${escapeHtml(run.originalUserRequest || run.problem || '')}</div>
          </div>
          ${run.taskFraming && run.taskFraming !== (run.originalUserRequest || run.problem) ? `
          <div class="prompt-field-group">
            <div class="prompt-field-label">Agent 任务定义 (task_framing):</div>
            <div class="prompt-field-val">${escapeHtml(run.taskFraming)}</div>
          </div>` : ''}
          ${constraints.length ? `
          <div class="prompt-field-group">
            <div class="prompt-field-label">显式约束溯源 (user_constraints):</div>
            <ul class="prompt-constraints-list">
              ${constraints.map(c => {
                const text = typeof c === 'string' ? c : (c.constraint || JSON.stringify(c));
                const quote = typeof c === 'object' && c.source_quote ? ` (原文溯源: "${c.source_quote}")` : '';
                return `<li><code>${escapeHtml(text)}</code>${escapeHtml(quote)}</li>`;
              }).join('')}
            </ul>
          </div>` : ''}
          ${hypotheses.length ? `
          <div class="prompt-field-group">
            <div class="prompt-field-label">Agent 初始假设 (agent_hypotheses，席位可质疑):</div>
            <ul class="prompt-constraints-list">
              ${hypotheses.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
            </ul>
          </div>` : ''}
        </article>
      </div>

      <div class="explore-prompt-raw-wrapper">
        <div class="explore-prompt-raw-title">
          <span>完整拼接 Prompt 全文 (Full Spliced Prompt)</span>
          <span class="char-count">${fullPromptText.length} 字符</span>
        </div>
        <pre class="explore-prompt-raw-pre" data-scroll-id="scroll-raw-prompt-${escapeHtml(run.id)}">${escapeHtml(fullPromptText)}</pre>
      </div>
    </div>
  `;
}

function renderExplorationReact(run, openDetails) {
  const steps = run.react?.steps ?? [];
  if (!steps.length) return '<div class="workbench-empty">正在准备探索 Agent 的初始上下文…</div>';
  return `<div class="agent-steps">${steps.map((step, index) => {
    const view = { ...step, id: `explore-${run.id}-${index}` };
    return step.type === 'tool' ? renderToolStep(view, openDetails) : renderThinkingStep(view, openDetails);
  }).join('')}</div>`;
}

function renderAhaWorkspace(input, live = false, openDetails = new Set()) {
  const run = input.board ? input : viewRun(input);
  const defaultTab = run.react ? 'react' : run.subproblemExpansion || run.decomposition ? 'subproblems' : 'rounds';
  const activeTab = state.ahaTabs[run.id] ?? defaultTab;
  const subproblemCount = run.board?.points?.filter(point => point.status === 'active' && point.type === 'subproblem').length ?? 0;
  const tabs = [
    ...(run.react ? [['react', `探索过程 (${run.react.iteration ?? 0}步)`]] : []),
    ['subproblems', `子问题发散 (${subproblemCount})`],
    ['rounds', `4×2 席位推演 (${run.roundRecords?.length || run.currentRound || 0}轮)`],
    ['overview', `装配方案 (${run.solutions?.length ?? 0})`],
    ['facts', `事实账本 (${run.facts?.length ?? 0})`],
    ['board', `观点板 (${run.board?.points?.filter(p => p.status === 'active').length ?? 0})`],
    ['rejected', `淘汰方向 (${run.rejected?.length ?? 0})`],
    ['prompt', `推演 Prompt`]
  ];
  const content = activeTab === 'overview' ? renderOverview(run)
    : activeTab === 'react' ? renderExplorationReact(run, openDetails)
    : activeTab === 'facts' ? renderFacts(run)
    : activeTab === 'board' ? renderBoard(run)
    : activeTab === 'subproblems' ? renderSubproblemExpansion(run)
    : activeTab === 'rejected' ? renderRejected(run)
    : activeTab === 'prompt' ? renderExplorePromptTab(run)
    : renderRounds(run, live);
  const progress = run.state === 'complete' && !live ? 100 : Math.min(100, Math.max(8, ((run.currentRound || run.rounds || 1) / run.maxRounds) * 100));
  const stateLabel = live || run.state === 'active' ? '推演探索中' : run.state === 'complete' ? '推演已结晶' : run.state === 'cancelled' ? '已停止' : run.state === 'failed' ? '未完成' : run.state;
  const heroDetailsId = `hero-prompt-${run.id}`;
  const isHeroPromptOpen = openDetails.has(heroDetailsId);
  const fullPromptText = formatExplorePrompt(run);
  const promptChars = fullPromptText.length;
  const promptSizeLabel = promptChars > 1000 ? `约 ${(promptChars / 1000).toFixed(1)}k 字符` : `${promptChars} 字符`;

  return `<section class="varina-workbench aha-workbench ${live ? 'live' : ''}" data-aha-workbench="${escapeHtml(run.id)}">
    <div class="varina-hero aha-hero">
      <div class="varina-hero-header">
        <div>
          <div class="varina-eyebrow aha-eyebrow"><span class="varina-glyph aha-glyph">✦</span>Varina 深度多视角探索 · ${escapeHtml(stateLabel)}</div>
          <h3>${escapeHtml(run.problem || '正在推演机制难题')}</h3>
          <p>${run.currentRound || run.rounds || 1} / ${run.maxRounds} 轮 · ${run.board?.points?.filter(point => point.status === 'active').length ?? 0} 个有效观点 · ${run.facts.length} 条事实 · 8 个创意席位并发</p>
        </div>
        <div class="varina-round-badge aha-round-badge">
          <strong>${run.currentRound || run.rounds || 1}</strong>
          <span>ROUND</span>
        </div>
      </div>
      <details class="varina-hero-prompt-details" data-details-id="${escapeHtml(heroDetailsId)}" ${isHeroPromptOpen ? 'open' : ''}>
        <summary class="varina-hero-prompt-summary" title="点击展开/折叠完整拼接推演 Prompt">
          <div class="varina-hero-prompt-title">
            <span class="varina-hero-prompt-icon">📜</span>
            <span class="varina-hero-prompt-title-text">完整推演 Prompt (拼接 System Prompt / 约束 / 冻结数据包)</span>
            <span class="varina-hero-prompt-badge">${promptSizeLabel}</span>
          </div>
          <span class="varina-hero-prompt-arrow">▾</span>
        </summary>
        <div class="varina-hero-prompt-body">
          <div class="varina-hero-prompt-toolbar">
            <span class="varina-hero-prompt-hint">所有席位推演时读取此一致冻结包，确保 8 席位公平发散</span>
            <button type="button" class="varina-copy-prompt-btn" data-copy-hero-prompt="${escapeHtml(run.id)}" title="复制完整 Prompt 到剪贴板">
              <span>📋</span> 复制完整 Prompt
            </button>
          </div>
          <pre class="varina-hero-prompt-pre" data-scroll-id="scroll-hero-prompt-${escapeHtml(run.id)}">${escapeHtml(fullPromptText)}</pre>
        </div>
      </details>
    </div>
    <div class="varina-progress aha-progress"><i style="width:${progress}%"></i></div>
    <nav class="varina-tabs aha-tabs">${tabs.map(([id, label]) => `<button class="${activeTab === id ? 'active' : ''}" data-aha-tab="${id}" data-run-id="${escapeHtml(run.id)}">${label}</button>`).join('')}</nav>
    <div class="varina-content aha-content">${content}</div>
  </section>`;
}

function getToolBadge(toolName = '') {
  const lower = toolName.toLowerCase();
  if (lower === 'read') return { badgeClass: 'tool-badge-read', badgeText: 'READ' };
  if (lower === 'edit') return { badgeClass: 'tool-badge-edit', badgeText: 'EDIT' };
  if (lower === 'write') return { badgeClass: 'tool-badge-write', badgeText: 'WRITE' };
  if (lower === 'initproject') return { badgeClass: 'tool-badge-write', badgeText: 'VARINA INIT' };
  if (lower === 'grep' || lower === 'glob') return { badgeClass: 'tool-badge-search', badgeText: 'SEARCH' };
  if (lower === 'exploredesign') return { badgeClass: 'tool-badge-explore', badgeText: 'VARINA EXPLORE' };
  if (lower.includes('backup')) return { badgeClass: 'tool-badge-backup', badgeText: 'BACKUP' };
  return { badgeClass: 'tool-badge-generic', badgeText: 'TOOL' };
}

function saveChildScrollPositions(target) {
  if (!target || !state.scrollCache) return;
  const elements = target.querySelectorAll('[data-scroll-id]');
  for (const el of elements) {
    const id = el.dataset.scrollId;
    if (id) {
      if (el.scrollTop > 0 || el.scrollLeft > 0) {
        state.scrollCache.set(id, { top: el.scrollTop, left: el.scrollLeft });
      }
    }
  }
}

function restoreChildScrollPositions(target) {
  if (!target || !state.scrollCache || state.scrollCache.size === 0) return;
  const elements = target.querySelectorAll('[data-scroll-id]');
  for (const el of elements) {
    const id = el.dataset.scrollId;
    if (id && state.scrollCache.has(id)) {
      const pos = state.scrollCache.get(id);
      if (typeof pos?.top === 'number') el.scrollTop = pos.top;
      if (typeof pos?.left === 'number') el.scrollLeft = pos.left;
    }
  }
}

function updateThinkingStepInPlace(thinkEl, step) {
  const isRunning = step.status === 'running';
  thinkEl.className = `thinking-block ${isRunning ? 'running' : 'completed'}`;

  const titleEl = thinkEl.querySelector('.thinking-title');
  if (titleEl) {
    let durationLabel = '已深度思考';
    if (isRunning) durationLabel = '思考中…';
    else if (step.duration_ms) durationLabel = `用时 ${Math.max(1, Math.round(step.duration_ms / 1000))} 秒`;

    titleEl.innerHTML = `
      ${isRunning ? '<span class="thinking-pulse-dot"></span>' : '<span class="thinking-icon">💭</span>'}
      <span class="thinking-label">${escapeHtml(durationLabel)}</span>
    `;
  }

  const chevronEl = thinkEl.querySelector('.thinking-chevron');
  if (chevronEl) {
    chevronEl.textContent = thinkEl.open ? '▾' : '›';
  }

  const bodyEl = thinkEl.querySelector('.thinking-body');
  if (bodyEl) {
    const isAtBottom = (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) < 25;
    const prevScrollTop = bodyEl.scrollTop;
    bodyEl.textContent = step.content || (isRunning ? '正在分析上下文，规划后续操作…' : '思考已完成');
    if (isAtBottom && isRunning) {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    } else {
      bodyEl.scrollTop = prevScrollTop;
    }
    if (bodyEl.dataset.scrollId) {
      if (bodyEl.scrollTop > 0) state.scrollCache.set(bodyEl.dataset.scrollId, { top: bodyEl.scrollTop, left: 0 });
      else state.scrollCache.delete(bodyEl.dataset.scrollId);
    }
  }

  const target = $('#messages');
  if (target) {
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (!state.userScrolledUp && distance < 80) {
      target.scrollTop = target.scrollHeight;
    }
    updateScrollBottomBtn();
  }
}

function renderThinkingStep(step, openDetails = new Set()) {
  const isRunning = step.status === 'running';
  const stepId = step.id || `step-think-${step.iteration ?? 0}`;
  const isOpen = isRunning || openDetails.has(stepId);
  const content = step.content || (isRunning ? '正在分析上下文，规划后续操作…' : '思考已完成');
  let durationLabel = '已深度思考';
  if (isRunning) {
    durationLabel = '思考中…';
  } else if (step.duration_ms) {
    const sec = Math.max(1, Math.round(step.duration_ms / 1000));
    durationLabel = `用时 ${sec} 秒`;
  }
  return `
    <details class="thinking-block ${isRunning ? 'running' : 'completed'}" data-details-id="${escapeHtml(stepId)}" ${isOpen ? 'open' : ''}>
      <summary class="thinking-summary" title="${isRunning ? '正在思考中' : '点击展开/折叠思考过程'}">
        <div class="thinking-title">
          ${isRunning ? '<span class="thinking-pulse-dot"></span>' : '<span class="thinking-icon">💭</span>'}
          <span class="thinking-label">${escapeHtml(durationLabel)}</span>
        </div>
        <span class="thinking-chevron">${isOpen ? '▾' : '›'}</span>
      </summary>
      <div class="thinking-body" data-scroll-id="scroll-think-${escapeHtml(stepId)}">${escapeHtml(content)}</div>
    </details>
  `;
}

function renderToolStep(step, openDetails = new Set()) {
  const toolName = step.name || 'Tool';
  const stepId = step.id || `step-tool-${step.iteration ?? 0}`;
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
      <div class="diff-container" data-scroll-id="scroll-diff-${escapeHtml(stepId)}">
        <div class="diff-header">目标文件：<code>${escapeHtml(input.file_path || '')}</code></div>
        <div class="diff-line diff-del"><span class="diff-sign">-</span><pre>${escapeHtml(input.old_string ?? '')}</pre></div>
        <div class="diff-line diff-add"><span class="diff-sign">+</span><pre>${escapeHtml(input.new_string ?? '')}</pre></div>
      </div>
    `;
  } else if (toolName === 'Read') {
    const range = input.start_line ? ` (第 ${input.start_line} - ${input.end_line ?? '末尾'} 行)` : '';
    const text = step.result?.content;
    const lineCount = step.result?.linesCount || (text ? (text.match(/\n/g) || []).length + 1 : null);
    const readDetailsId = `${stepId}-read`;
    bodyContent = `
      <div class="tool-detail-row">读取文件：<code>${escapeHtml(input.file_path || '')}</code>${escapeHtml(range)}</div>
      ${text ? `
        <details class="tool-expand-details" data-details-id="${escapeHtml(readDetailsId)}" ${openDetails.has(readDetailsId) ? 'open' : ''}>
          <summary>查看读取内容 ${lineCount ? `(${lineCount} 行)` : ''}</summary>
          <pre class="tool-content-pre" data-scroll-id="scroll-read-${escapeHtml(readDetailsId)}">${escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? '\n\n⋯ (超出 3000 字符部分已截断)' : ''}</pre>
        </details>
      ` : ''}
    `;
  } else if (toolName === 'Write') {
    const content = input.content ?? '';
    const writeDetailsId = `${stepId}-write`;
    bodyContent = `
      <div class="tool-detail-row">写入文件：<code>${escapeHtml(input.file_path || '')}</code> (${content.length} 字符)</div>
      ${content ? `
        <details class="tool-expand-details" data-details-id="${escapeHtml(writeDetailsId)}" ${openDetails.has(writeDetailsId) ? 'open' : ''}>
          <summary>查看写入内容预览</summary>
          <pre class="tool-content-pre" data-scroll-id="scroll-write-${escapeHtml(writeDetailsId)}">${escapeHtml(content.slice(0, 3000))}${content.length > 3000 ? '\n\n⋯ (超出 3000 字符部分已截断)' : ''}</pre>
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

function renderVarinaProgress(progress) {
  if (!progress) return '';
  const isGate = progress.stage === 'gate';
  const title = isGate ? '正在判断是否需要启动 Varina' : '正在准备 ExploreDesign';
  const detail = isGate
    ? '常规回答已完成，正在评估是否需要继续展开多视角推演。'
    : '正在整理常规回答，随后进入子问题拆解与逐题回答。';
  return `<section class="varina-progress-notice" role="status">
    <span class="activity-pulse"></span>
    <div><strong>${title}</strong><p>${detail}</p></div>
  </section>`;
}

function renderMessages() {
  const target = $('#messages');
  if (!target) return;
  const prevScrollTop = target.scrollTop;
  const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
  const shouldAutoScroll = state.forceScrollToBottom || (!state.userScrolledUp && distance < 80);
  state.forceScrollToBottom = false;

  const openDetails = new Set(
    [...target.querySelectorAll('details[open]')].map(el => el.dataset.detailsId).filter(Boolean)
  );

  saveChildScrollPositions(target);

  const messages = state.session?.messages ?? [];
  const runs = state.session?.varina_runs ?? state.session?.aha_runs ?? [];
  const runMap = new Map(runs.map(run => [run.run_id, run]));
  const linked = new Set();
  const compaction = state.session?.compaction;
  let compactionDividerRendered = false;

  let markup = messages.map((message, index) => {
    let prefix = '';
    if (compaction?.summary && !compactionDividerRendered && (message.turn > compaction.last_compacted_turn)) {
      compactionDividerRendered = true;
      prefix = `
        <div class="compaction-divider">
          <div class="compaction-badge">
            <span class="compaction-icon">⚡</span>
            <span>历史上下文已自动压缩归档（第 1 ~ ${compaction.last_compacted_turn} 轮）</span>
            ${compaction.chars_before ? `<span class="compaction-stats">${compaction.tokens_before ? `约 ${(compaction.tokens_before / 1000).toFixed(0)}k tokens ➔ ${(compaction.tokens_after / 1000).toFixed(1)}k tokens` : `${compaction.chars_before} 字符 ➔ ${compaction.chars_after} 字符`}</span>` : ''}
          </div>
          <details class="compaction-details" data-details-id="compaction-summary" ${openDetails.has('compaction-summary') ? 'open' : ''}>
            <summary>展开查看交接摘要 (Handoff Summary)</summary>
            <div class="compaction-summary-body markdown-body" data-scroll-id="scroll-compaction-summary">${renderMarkdown(compaction.summary)}</div>
          </details>
        </div>
      `;
    }

    if (message.role === 'user') {
      const isExplicitAha = message.content.trim().startsWith('/varina') || message.content.trim().startsWith('/aha');
      const clean = isExplicitAha ? message.content.trim().replace(/^\/aha\s*/i, '') : message.content;
      return `${prefix}
        <article class="message user">
          <div class="message-body">${escapeHtml(clean || message.content)}${isExplicitAha ? '<span class="varina-user-tag aha-user-tag">✦ Varina 探索</span>' : ''}</div>
        </article>
      `;
    }
    const run = (message.varina_run_id || message.aha_run_id) ? runMap.get((message.varina_run_id || message.aha_run_id)) : null;
    if (run) linked.add(run.run_id);
    let stepsMarkup = '';
    if (Array.isArray(message.steps)) {
      stepsMarkup = message.steps.map(step => {
        if (step.type === 'thinking') return renderThinkingStep(step, openDetails);
        if (step.type === 'tool') return renderToolStep(step, openDetails);
        return '';
      }).join('');
    }
    const ahaMarkup = run ? renderAhaWorkspace(viewRun(run), false, openDetails) : '';
    const bodyMarkup = message.content ? `
      <article class="message assistant ${message.partial ? 'partial' : ''}">
        <div class="message-body markdown-body">${renderMarkdown(message.content)}</div>
        ${message.confirmation ? `<div class="confirm-card"><p>${escapeHtml(message.confirmation.question)}</p><button data-varina-confirm="${index}" data-accepted="false">不启动</button><button class="primary" data-varina-confirm="${index}" data-accepted="true">仍然启动 Varina</button></div>` : ''}
      </article>
    ` : '';
    return `${prefix}${stepsMarkup}${ahaMarkup}${bodyMarkup}`;
  }).join('');

  if (compaction?.summary && !compactionDividerRendered && messages.length > 0) {
    markup += `
      <div class="compaction-divider">
        <div class="compaction-badge">
          <span class="compaction-icon">⚡</span>
          <span>历史上下文已自动压缩归档（第 1 ~ ${compaction.last_compacted_turn} 轮）</span>
          ${compaction.chars_before ? `<span class="compaction-stats">${compaction.tokens_before ? `约 ${(compaction.tokens_before / 1000).toFixed(0)}k tokens ➔ ${(compaction.tokens_after / 1000).toFixed(1)}k tokens` : `${compaction.chars_before} 字符 ➔ ${compaction.chars_after} 字符`}</span>` : ''}
        </div>
        <details class="compaction-details" data-details-id="compaction-summary" ${openDetails.has('compaction-summary') ? 'open' : ''}>
          <summary>展开查看交接摘要 (Handoff Summary)</summary>
          <div class="compaction-summary-body markdown-body" data-scroll-id="scroll-compaction-summary">${renderMarkdown(compaction.summary)}</div>
        </details>
      </div>
    `;
  }

  for (const run of runs.filter(item => !linked.has(item.run_id) && item.state !== 'active')) {
    markup += renderAhaWorkspace(viewRun(run), false, openDetails);
  }

  // Active turn steps (streaming live before final assistant message is created)
  if (state.session?.status === 'running' && state.session?.active_turn?.steps?.length) {
    markup += state.session.active_turn.steps.map(step => {
      if (step.type === 'thinking') return renderThinkingStep(step, openDetails);
      if (step.type === 'tool') return renderToolStep(step, openDetails);
      return '';
    }).join('');
  }

  if ((state.session?.active_varina_runtime || state.session?.active_aha_runtime)) {
    markup += renderAhaWorkspace(viewRun(runMap.get((state.session.active_varina_runtime || state.session.active_aha_runtime).run_id), (state.session.active_varina_runtime || state.session.active_aha_runtime)), true, openDetails);
  } else if (state.session?.active_varina_progress) {
    markup += renderVarinaProgress(state.session.active_varina_progress);
  }

  target.innerHTML = messages.length || markup ? markup : emptyState();
  restoreChildScrollPositions(target);
  if (shouldAutoScroll) {
    target.scrollTop = target.scrollHeight;
  } else if (target.scrollTop !== prevScrollTop) {
    target.scrollTop = prevScrollTop;
  }
  updateScrollBottomBtn();
}

function renderActivity() {
  const activity = $('#activity');
  // Activity is now integrated into vertical items; keep bottom bar hidden
  activity.hidden = true;
}

function updateScrollBottomBtn() {
  const target = $('#messages');
  const btn = $('#scroll-bottom-btn');
  if (!target) return;
  const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (btn) btn.hidden = distance < 120;
  if (distance > 60) {
    state.userScrolledUp = true;
  } else if (distance < 20) {
    state.userScrolledUp = false;
  }
}

function render() {
  renderSessions();
  $('#session-title').textContent = state.session?.title ?? '开始创作';
  const workspace = state.session?.workspace_root;
  $('#workspace-button').textContent = workspace ? `⌁ ${workspace}` : '⌁ 选择工作目录';
  $('#workspace-button').title = workspace ?? '选择工作目录';
  renderMessages();
  renderActivity();
  updateVarinaToggle();
  updateComposerModel();
  const busy = ['running', 'baseline_complete', 'evaluating_varina', 'running_varina'].includes(state.session?.status);
  setRunning(busy, busy ? (state.session?.status === 'running' ? '处理中' : 'Varina 探索中') : state.session?.status === 'failed' ? '上轮失败' : '就绪');
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
      const stepId = step.id || `step-think-${step.iteration ?? 0}`;
      const target = $('#messages');
      const thinkEl = target?.querySelector(`details.thinking-block[data-details-id="${stepId}"]`);
      if (thinkEl) {
        updateThinkingStepInPlace(thinkEl, step);
      } else {
        renderMessages();
      }
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
      if (data.name === 'ExploreDesign' && !(state.session.active_varina_runtime || state.session.active_aha_runtime)) {
        const runtime = {
          run_id: data.tool_call_id || `varina-${Date.now()}`,
          problem: data.input?.problem || '正在启动 Varina 深度多视角探索…',
          hard_constraints: data.input?.constraints || [],
          status: 'active',
          current_round: 1,
          max_rounds: 5,
          current_board: { points: [] },
          fact_ledger: [],
          round_records: [],
          seat_responses: []
        };
        state.session.active_varina_runtime = runtime;
        state.session.active_aha_runtime = runtime;
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
    } else if (data.event === 'context_compacted') {
      if (data.phase === 'pre_turn') {
        state.session.compaction = {
          last_compacted_turn: data.last_compacted_turn,
          summary: data.summary,
          chars_before: data.chars_before,
          chars_after: data.chars_after
        };
        renderMessages();
      }
    } else if (data.event === 'agent_baseline_done') {
      void refreshSession(sessionId);
    } else if (data.event === 'varina_progress') {
      void refreshSession(sessionId);
    } else if (data.event === 'agent_done') {
      delete state.session.active_turn;
      void refreshSession(sessionId);
    } else if (data.phase?.startsWith('varina_') || data.phase?.startsWith('aha_')) {
      void refreshSession(sessionId);
    }
  };
  state.source = source;
}

async function openSession(sessionId) {
  state.userScrolledUp = false;
  state.forceScrollToBottom = true;
  state.session = await api(`/api/agent/sessions/${sessionId}`);
  if (state.session?.mode) {
    state.activeMode = state.session.mode;
  }
  if (state.session?.workspace_root) {
    const key = normalizePath(state.session.workspace_root).toLowerCase();
    if (state.collapsedFolders.has(key)) {
      state.collapsedFolders.delete(key);
      saveCollapsedFolders(state.collapsedFolders);
    }
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
  if (state.polling) {
    state.pendingRefresh = true;
    return;
  }
  state.polling = true;
  try {
    const session = await api(`/api/agent/sessions/${sessionId}`);
    if (state.session?.session_id === sessionId) { state.session = session; render(); }
    await loadSessions();
  } finally {
    state.polling = false;
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      void refreshSession(sessionId);
    }
  }
}

async function sendMessage(message) {
  const trimmed = message.trim();
  if (!trimmed) return;
  if (!state.session) {
    state.pendingMessage = trimmed;
    await openFolderDialog();
    return;
  }
  const sessionId = state.session.session_id;
  const before = state.session.messages.length;
  $('#message-input').value = '';
  state.activities = ['正在理解你的请求…'];
  // The toggle is transport metadata. It must never rewrite the ordinary ReAct input.
  const outboundMessage = trimmed;
  state.session.messages.push({ role: 'user', content: outboundMessage, created_at: new Date().toISOString() });
  state.session.status = 'running';
  state.session.active_turn = { turn: (state.session.current_turn || 0) + 1, steps: [] };
  state.userScrolledUp = false;
  state.forceScrollToBottom = true;
  render();
  await api(`/api/agent/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: outboundMessage, enable_varina: state.ahaEnabled, enable_aha: state.ahaEnabled })
  });
  for (let attempt = 0; attempt < 1800; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 700));
    const fresh = await api(`/api/agent/sessions/${sessionId}`);
    if (state.session?.session_id !== sessionId) return;
    state.session = fresh;
    render();
    if (fresh.messages.length >= before + 2
      && fresh.messages.at(-1)?.role === 'assistant'
      && ['idle', 'failed', 'cancelled', 'awaiting_varina_confirmation'].includes(fresh.status)) break;
  }
  delete state.session.active_turn;
  state.activities = [];
  renderActivity();
  await loadSessions();
}

const MODEL_PRESETS = [
  {
    label: 'DeepSeek 官方', id: 'DEEPSEEK', model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']
  },
  {
    label: 'Google Gemini', id: 'GEMINI', model: 'gemini-3.7-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_schema',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    maxOutputTokens: 65536, maxConcurrent: 1, requestIntervalMs: 2500,
    modelsList: ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']
  },
  {
    label: '智谱清言 GLM', id: 'GLM', model: 'GLM-5.3-Flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    reasoningEffortMap: { medium: 'high', none: 'low' },
    modelsList: ['GLM-5.3-Flash', 'glm-4-plus', 'glm-4-flash']
  },
  {
    label: 'Anthropic Claude', id: 'CLAUDE', model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-3-5-haiku']
  },
  {
    label: 'OpenAI 官方', id: 'OPENAI', model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1', protocol: 'chat',
    tokenParameter: 'max_completion_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: true,
    modelsList: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini']
  },
  {
    label: '硅基流动 SiliconFlow', id: 'SILICONFLOW', model: 'deepseek-ai/DeepSeek-V3',
    baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct']
  },
  {
    label: '通义千问 DashScope', id: 'QWEN', model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat',
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: true, supportsSeed: false,
    modelsList: ['qwen-plus', 'qwen-max', 'qwen-turbo']
  },
  {
    label: '本地 Ollama / vLLM', id: 'LOCAL_OLLAMA', model: 'llama3:latest',
    baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat', isKeyless: true,
    tokenParameter: 'max_tokens', structuredOutput: 'json_object',
    supportsTemperature: true, supportsReasoning: false, supportsSeed: true,
    modelsList: ['llama3:latest', 'qwen2.5:latest', 'deepseek-r1:latest']
  }
];

function syncProviderFieldsToState(providerId) {
  if (!state.editingConfig || !providerId) return;
  const keyInput = document.getElementById(`dsh-key-${providerId}`);
  const urlInput = document.getElementById(`dsh-url-${providerId}`);
  const protoSelect = document.getElementById(`dsh-proto-${providerId}`);
  const catalogRows = document.querySelectorAll(`.dsh-catalog-row[data-provider-id="${providerId}"]`);

  const pKey = keyInput?.value?.trim() || '';
  const pUrl = urlInput?.value?.trim() || '';
  const pProto = protoSelect?.value || 'chat';

  const newCatalog = [];
  catalogRows.forEach(row => {
    const origId = row.dataset.catalogId;
    const model = row.querySelector('[data-catalog-field="model"]')?.value?.trim() || '';
    const displayName = row.querySelector('[data-catalog-field="displayName"]')?.value?.trim() || model;
    if (model) {
      newCatalog.push({ id: origId, model, displayName });
    }
  });

  if (newCatalog.length === 0) return;

  const isMatch = m => m.providerId === providerId || (!m.providerId && (m.id === providerId || m.id.startsWith(`${providerId}_`)));
  const existingProviderModels = state.editingConfig.models.filter(isMatch);
  const baseModel = existingProviderModels[0] || MODEL_PRESETS.find(p => p.id === providerId) || {};
  const providerName = baseModel.providerName || MODEL_PRESETS.find(p => p.id === providerId)?.label?.split(' ')[0] || providerId;

  const keptIds = new Set(newCatalog.map(item => item.id).filter(Boolean));
  state.editingConfig.models = state.editingConfig.models.filter(m => {
    if (!isMatch(m)) return true;
    return keptIds.has(m.id);
  });

  newCatalog.forEach((item, idx) => {
    let existing = state.editingConfig.models.find(m => m.id === item.id);
    if (!existing) {
      let baseSafe = `${providerId}_${item.model.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      if (idx === 0 && !state.editingConfig.models.some(m => m.id === providerId)) {
        baseSafe = providerId;
      }
      let finalId = baseSafe;
      let counter = 2;
      while (state.editingConfig.models.some(m => m.id === finalId)) {
        finalId = `${baseSafe}_${counter++}`;
      }

      existing = {
        id: finalId,
        model: item.model,
        displayName: item.displayName,
        baseUrl: pUrl || baseModel.baseUrl || '',
        protocol: pProto,
        tokenParameter: baseModel.tokenParameter || 'max_tokens',
        structuredOutput: baseModel.structuredOutput || 'json_object',
        supportsTemperature: baseModel.supportsTemperature ?? true,
        supportsReasoning: baseModel.supportsReasoning ?? true,
        supportsSeed: baseModel.supportsSeed ?? false,
        providerId,
        providerName,
        hasKey: baseModel.hasKey ?? false,
        maskedKey: baseModel.maskedKey || ''
      };
      state.editingConfig.models.push(existing);
    } else {
      existing.model = item.model;
      existing.displayName = item.displayName;
      if (pUrl) existing.baseUrl = pUrl;
      existing.protocol = pProto;
      existing.providerId = providerId;
      existing.providerName = providerName;
    }

    if (pKey) {
      existing.apiKey = pKey;
      existing.hasKey = true;
    }
  });
}

function syncFieldsToState() {
  if (!state.editingConfig) return;
  const mainSelect = $('#cfg-role-main');
  if (mainSelect) state.editingConfig.roles.main = mainSelect.value;

  if (state.editingProviderId) {
    syncProviderFieldsToState(state.editingProviderId);
  }

  document.querySelectorAll('[data-cfg-role]').forEach(select => {
    state.editingConfig.roles[select.dataset.cfgRole] = select.value;
  });
  document.querySelectorAll('[data-cfg-seat]').forEach(select => {
    const seatId = select.dataset.cfgSeat;
    const seat = (state.editingConfig.seats || []).find(s => s.id === seatId);
    if (seat) seat.modelId = select.value;
  });
  const answersPerSubproblem = document.querySelector('#cfg-answers-per-subproblem');
  if (answersPerSubproblem) {
    state.editingConfig.subproblemExpansion ??= {};
    state.editingConfig.subproblemExpansion.answersPerSubproblem = Number(answersPerSubproblem.value);
  }
}

function getDshProviders(models = []) {
  const map = new Map();
  for (const m of models) {
    let pId = m.providerId;
    let pName = m.providerName;
    let officialId = '';

    if (!pId) {
      const preset = MODEL_PRESETS.find(p =>
        m.id === p.id ||
        m.id.toUpperCase().startsWith(`${p.id}_`) ||
        (m.baseUrl && p.baseUrl && m.baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, '')) ||
        (p.id === 'DEEPSEEK' && m.baseUrl?.includes('deepseek.com')) ||
        (p.id === 'OPENAI' && m.baseUrl?.includes('openai.com')) ||
        (p.id === 'GEMINI' && m.baseUrl?.includes('googleapis.com')) ||
        (p.id === 'CLAUDE' && m.baseUrl?.includes('anthropic.com')) ||
        (p.id === 'GLM' && m.baseUrl?.includes('bigmodel.cn')) ||
        (p.id === 'SILICONFLOW' && m.baseUrl?.includes('siliconflow.cn')) ||
        (p.id === 'QWEN' && m.baseUrl?.includes('dashscope.aliyuncs.com')) ||
        (p.id === 'LOCAL_OLLAMA' && (m.baseUrl?.includes('11434') || m.isKeyless))
      );

      if (preset) {
        pId = preset.id;
        pName = preset.label.split(' ')[0];
        officialId = preset.id.toLowerCase();
      } else {
        pId = m.id.split('_')[0] || m.id;
        pName = m.name || pId;
        officialId = pId.toLowerCase();
      }
    } else {
      officialId = (m.officialId || pId).toLowerCase();
    }

    if (!map.has(pId)) {
      const isLocal = Boolean(m.isKeyless || (m.baseUrl && (m.baseUrl.includes('localhost') || m.baseUrl.includes('127.0.0.1'))));
      map.set(pId, {
        id: pId,
        name: pName || pId,
        officialId: officialId || pId.toLowerCase(),
        baseUrl: m.baseUrl || '',
        protocol: m.protocol || 'chat',
        apiKey: m.apiKey || '',
        hasKey: Boolean(m.hasKey || m.apiKey),
        maskedKey: m.maskedKey || (m.apiKey ? '••••••••' : ''),
        keySource: m.keySource || (m.apiKey ? 'config' : 'none'),
        isLocal,
        isKeyless: Boolean(m.isKeyless || isLocal),
        tokenParameter: m.tokenParameter || 'max_tokens',
        structuredOutput: m.structuredOutput || 'json_object',
        supportsTemperature: m.supportsTemperature ?? true,
        supportsReasoning: m.supportsReasoning ?? true,
        supportsSeed: m.supportsSeed ?? false,
        catalog: []
      });
    }

    const provider = map.get(pId);
    if (m.hasKey || m.apiKey) {
      provider.hasKey = true;
      if (m.maskedKey) provider.maskedKey = m.maskedKey;
      if (m.apiKey) provider.apiKey = m.apiKey;
    }
    provider.catalog.push({
      id: m.id,
      model: m.model || '',
      displayName: m.displayName || m.name || m.model || m.id
    });
  }

  return Array.from(map.values());
}

function renderGeneralTabContent() {
  const prefs = getPreferences();
  return `
    <div class="settings-section">
      <div class="settings-section-title">会话与推演偏好</div>
      
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-title">Vary 深度探索触发策略</div>
          <div class="settings-row-desc">控制何时启动 8 席位多视角发散推演；也可在发送框旁随时临时切换。</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-pref="vary_trigger_mode">
            <option value="smart" ${prefs.varyTriggerMode === 'smart' ? 'selected' : ''}>智能判定 (推荐)</option>
            <option value="ask" ${prefs.varyTriggerMode === 'ask' ? 'selected' : ''}>每次询问</option>
            <option value="always" ${prefs.varyTriggerMode === 'always' ? 'selected' : ''}>总是开启</option>
            <option value="never" ${prefs.varyTriggerMode === 'never' ? 'selected' : ''}>总是关闭</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-title">消息发送快捷键</div>
          <div class="settings-row-desc">选择输入框的回车发送习惯；长文本机制方案建议使用 Cmd/Ctrl+Enter 防误触。</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-pref="send_shortcut">
            <option value="enter" ${prefs.sendShortcut === 'enter' ? 'selected' : ''}>Enter 发送 (Shift+Enter 换行)</option>
            <option value="ctrl_enter" ${prefs.sendShortcut === 'ctrl_enter' ? 'selected' : ''}>Cmd/Ctrl+Enter 发送 (Enter 换行)</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-title">工作步骤展示</div>
          <div class="settings-row-desc">工具调用细节（文件读取、终端执行等）的展示程度。</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-pref="tool_steps_display">
            <option value="compact" ${prefs.toolStepsDisplay === 'compact' ? 'selected' : ''}>精简收起 (默认)</option>
            <option value="expanded" ${prefs.toolStepsDisplay === 'expanded' ? 'selected' : ''}>详细展开</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-title">会话内容字号</div>
          <div class="settings-row-desc">控制消息正文、代码和机制推演的文本展示字号。</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-pref="message_font_size">
            <option value="small" ${prefs.messageFontSize === 'small' ? 'selected' : ''}>紧凑 (13px)</option>
            <option value="medium" ${prefs.messageFontSize === 'medium' ? 'selected' : ''}>标准 (14.5px)</option>
            <option value="large" ${prefs.messageFontSize === 'large' ? 'selected' : ''}>舒适 (16px)</option>
          </select>
        </div>
      </div>
    </div>
    <div class="settings-footer-note">当前版本：0.2.0-prototype · Aha Engine & Vary</div>
  `;
}

function renderModelsTabContent(c, models, currentMain) {
  const providers = getDshProviders(models);
  const isAdding = state.isAddingProvider === true;
  const editingPId = state.editingProviderId;

  const mainModelOptionsHtml = models.map(m => {
    const pName = m.providerName || m.id.split('_')[0];
    const mName = m.displayName || m.model || m.id;
    return `<option value="${escapeHtml(m.id)}" ${m.id === currentMain ? 'selected' : ''}>${escapeHtml(pName)} · ${escapeHtml(mName)}</option>`;
  }).join('');

  const providerCardsHtml = providers.map(p => {
    const isEditing = editingPId === p.id;
    const isConfigured = p.hasKey || p.isLocal;

    if (!isEditing) {
      return `
        <div class="dsh-provider-card" data-provider-id="${escapeHtml(p.id)}">
          <div class="dsh-provider-row">
            <div class="dsh-provider-title-wrap">
              <span class="dsh-provider-name">${escapeHtml(p.name)}</span>
              <span class="dsh-status-dot ${isConfigured ? 'online' : 'offline'}" title="${isConfigured ? '已配置密钥或本地可用' : '未配置密钥'}"></span>
              <span class="dsh-provider-meta">${p.catalog.length} 个模型</span>
            </div>
            <div class="dsh-provider-actions">
              <button type="button" class="dsh-btn" data-test-provider="${escapeHtml(p.id)}">测试</button>
              <button type="button" class="dsh-btn" data-edit-provider="${escapeHtml(p.id)}">编辑</button>
            </div>
          </div>
          <div id="dsh-test-result-${escapeHtml(p.id)}" class="test-result-indicator" hidden style="margin: 0 18px 12px"></div>
        </div>
      `;
    }

    const catalogRowsHtml = p.catalog.map(item => `
      <div class="dsh-catalog-row" data-catalog-id="${escapeHtml(item.id)}" data-provider-id="${escapeHtml(p.id)}">
        <input type="text" class="dsh-input" data-catalog-field="model" value="${escapeHtml(item.model)}" placeholder="模型标识 (如 gpt-6.1-sol)">
        <input type="text" class="dsh-input" data-catalog-field="displayName" value="${escapeHtml(item.displayName)}" placeholder="显示名称 (如 GPT 6.1 Sol)">
        <button type="button" class="dsh-btn dsh-btn-danger" data-remove-catalog-row="${escapeHtml(item.id)}" title="移除模型">删除</button>
      </div>
    `).join('');

    return `
      <div class="dsh-provider-card editing" data-provider-id="${escapeHtml(p.id)}">
        <div class="dsh-provider-edit-pane">
          <div class="dsh-edit-header">
            <div class="dsh-edit-header-title">
              <strong>${escapeHtml(p.name)}</strong>
              <span>${escapeHtml(p.officialId)}</span>
            </div>
            ${providers.length > 1 ? `<button type="button" class="dsh-btn dsh-btn-danger" data-delete-provider="${escapeHtml(p.id)}">删除</button>` : ''}
          </div>

          <div class="dsh-field-group">
            <label class="dsh-field-label">API 密钥</label>
            <div class="dsh-input-wrap">
              <input type="password" class="dsh-input" id="dsh-key-${escapeHtml(p.id)}"
                value="${escapeHtml(p.apiKey || '')}"
                placeholder="${p.hasKey ? (p.maskedKey || '已配置密钥') : '输入 API Key (如 sk-…)'}">
              <button type="button" class="dsh-btn" data-test-provider-input="${escapeHtml(p.id)}">测试</button>
            </div>
            <div class="dsh-input-helper">${p.isLocal ? '本地服务无需填写' : (p.hasKey ? '已配置凭据，留空保持原密钥' : '请输入服务商 API 密钥')}</div>
          </div>
          <div id="dsh-test-result-${escapeHtml(p.id)}" class="test-result-indicator" hidden></div>

          <details class="dsh-custom-details" id="dsh-details-${escapeHtml(p.id)}">
            <summary class="dsh-custom-summary">自定义设置</summary>
            <div class="dsh-custom-body">
              <div class="dsh-field-group">
                <label class="dsh-field-label">API 地址</label>
                <input type="text" class="dsh-input" id="dsh-url-${escapeHtml(p.id)}" value="${escapeHtml(p.baseUrl)}" placeholder="https://api.example.com/v1">
              </div>

              <div class="dsh-field-group">
                <label class="dsh-field-label">协议规范</label>
                <select class="dsh-input" id="dsh-proto-${escapeHtml(p.id)}">
                  <option value="chat" ${p.protocol !== 'gemini' ? 'selected' : ''}>chat (OpenAI 兼容)</option>
                  <option value="gemini" ${p.protocol === 'gemini' ? 'selected' : ''}>gemini (Google 原生)</option>
                </select>
              </div>

              <div class="dsh-catalog-section">
                <div class="dsh-catalog-header">
                  <span class="dsh-catalog-title">模型目录</span>
                  <button type="button" class="dsh-catalog-action-link" data-discover-provider="${escapeHtml(p.id)}">探测可用模型</button>
                </div>

                <div id="dsh-discover-box-${escapeHtml(p.id)}" class="discovered-models-box" hidden style="margin: 6px 0"></div>

                <div class="dsh-catalog-table" id="dsh-catalog-table-${escapeHtml(p.id)}">
                  <div class="dsh-catalog-table-header">
                    <span>模型标识 (Model)</span>
                    <span>显示名称 (Display Name)</span>
                    <span></span>
                  </div>
                  ${catalogRowsHtml}
                </div>

                <button type="button" class="dsh-add-submodel-btn" data-add-catalog-row="${escapeHtml(p.id)}" style="margin-top: 8px">
                  + 添加模型
                </button>
              </div>
            </div>
          </details>

          <div class="dsh-edit-footer">
            <button type="button" class="dsh-btn" data-cancel-edit-provider="${escapeHtml(p.id)}">取消</button>
            <button type="button" class="dsh-btn dsh-btn-primary" data-save-provider="${escapeHtml(p.id)}">保存</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  let addProviderBlockHtml = '';
  if (isAdding) {
    const isCustomTab = state.addProviderTab === 'custom';
    const selectedPresetId = state.selectedAddPresetId || 'OPENAI';
    const preset = MODEL_PRESETS.find(p => p.id === selectedPresetId) || MODEL_PRESETS[0];

    const presetOptions = MODEL_PRESETS.map(p => `
      <option value="${escapeHtml(p.id)}" ${p.id === selectedPresetId ? 'selected' : ''}>
        ${escapeHtml(p.label)}
      </option>
    `).join('');

    const presetCatalogRows = (preset.modelsList || [preset.model]).map(m => `
      <div class="dsh-catalog-row" data-new-catalog-row>
        <input type="text" class="dsh-input" data-new-catalog-model value="${escapeHtml(m)}" placeholder="模型标识">
        <input type="text" class="dsh-input" data-new-catalog-display value="${escapeHtml(m)}" placeholder="显示名称">
        <button type="button" class="dsh-btn dsh-btn-danger" data-remove-new-catalog-row title="删除">删除</button>
      </div>
    `).join('');

    addProviderBlockHtml = `
      <div class="dsh-new-provider-card">
        <div class="dsh-tabs-switch">
          <button type="button" class="dsh-tab-pill ${!isCustomTab ? 'active' : ''}" data-switch-add-tab="preset">第三方 API</button>
          <button type="button" class="dsh-tab-pill ${isCustomTab ? 'active' : ''}" data-switch-add-tab="custom">自定义 API</button>
        </div>

        ${!isCustomTab ? `
          <div class="dsh-field-group">
            <label class="dsh-field-label">模型提供商</label>
            <select class="dsh-input" id="dsh-new-preset-select">
              ${presetOptions}
            </select>
          </div>

          <div class="dsh-field-group">
            <label class="dsh-field-label">API 密钥</label>
            <input type="password" class="dsh-input" id="dsh-new-api-key" placeholder="输入 API Key (如 sk-…)">
            <div class="dsh-input-helper">${preset.isKeyless ? '本地服务无需填写密钥' : '请输入该提供商的 API 访问凭据'}</div>
          </div>

          <details class="dsh-custom-details" open>
            <summary class="dsh-custom-summary">自定义设置</summary>
            <div class="dsh-custom-body">
              <div class="dsh-field-group">
                <label class="dsh-field-label">API 地址</label>
                <input type="text" class="dsh-input" id="dsh-new-base-url" value="${escapeHtml(preset.baseUrl)}">
              </div>

              <div class="dsh-field-group">
                <label class="dsh-field-label">协议规范</label>
                <select class="dsh-input" id="dsh-new-protocol">
                  <option value="chat" ${preset.protocol !== 'gemini' ? 'selected' : ''}>chat (OpenAI 兼容)</option>
                  <option value="gemini" ${preset.protocol === 'gemini' ? 'selected' : ''}>gemini (Google 原生)</option>
                </select>
              </div>

              <div class="dsh-catalog-section">
                <div class="dsh-catalog-header">
                  <span class="dsh-catalog-title">初始模型目录</span>
                </div>
                <div class="dsh-catalog-table" id="dsh-new-catalog-table">
                  <div class="dsh-catalog-table-header">
                    <span>模型标识 (Model)</span>
                    <span>显示名称 (Display Name)</span>
                    <span></span>
                  </div>
                  ${presetCatalogRows}
                </div>
                <button type="button" class="dsh-add-submodel-btn" id="dsh-new-add-catalog-row" style="margin-top: 8px">+ 添加模型</button>
              </div>
            </div>
          </details>

          <div class="dsh-edit-footer">
            <button type="button" class="dsh-btn" data-cancel-add-provider>取消</button>
            <button type="button" class="dsh-btn dsh-btn-primary" data-confirm-add-preset>保存</button>
          </div>
        ` : `
          <div class="dsh-field-group">
            <label class="dsh-field-label">提供商名称</label>
            <input type="text" class="dsh-input" id="dsh-custom-name" placeholder="如：公司私有云 / vLLM">
          </div>

          <div class="dsh-field-group">
            <label class="dsh-field-label">API 地址</label>
            <input type="text" class="dsh-input" id="dsh-custom-url" placeholder="https://api.example.com/v1">
          </div>

          <div class="dsh-field-group">
            <label class="dsh-field-label">API 密钥</label>
            <input type="password" class="dsh-input" id="dsh-custom-key" placeholder="输入 API Key (本地或免密可留空)">
          </div>

          <div class="dsh-field-group">
            <label class="dsh-field-label">协议规范</label>
            <select class="dsh-input" id="dsh-custom-protocol">
              <option value="chat" selected>chat (OpenAI 兼容)</option>
              <option value="gemini">gemini (Google 原生)</option>
            </select>
          </div>

          <div class="dsh-catalog-section">
            <div class="dsh-catalog-header">
              <span class="dsh-catalog-title">模型目录</span>
            </div>
            <div class="dsh-catalog-table" id="dsh-new-catalog-table">
              <div class="dsh-catalog-table-header">
                <span>模型标识 (Model)</span>
                <span>显示名称 (Display Name)</span>
                <span></span>
              </div>
              <div class="dsh-catalog-row" data-new-catalog-row>
                <input type="text" class="dsh-input" data-new-catalog-model value="custom-model" placeholder="模型标识 (如 qwen-72b)">
                <input type="text" class="dsh-input" data-new-catalog-display value="Custom Model" placeholder="显示名称">
                <button type="button" class="dsh-btn dsh-btn-danger" data-remove-new-catalog-row title="删除">删除</button>
              </div>
            </div>
            <button type="button" class="dsh-add-submodel-btn" id="dsh-new-add-catalog-row" style="margin-top: 8px">+ 添加模型</button>
          </div>

          <div class="dsh-edit-footer">
            <button type="button" class="dsh-btn" data-cancel-add-provider>取消</button>
            <button type="button" class="dsh-btn dsh-btn-primary" data-confirm-add-custom>保存</button>
          </div>
        `}
      </div>
    `;
  } else {
    addProviderBlockHtml = `
      <button type="button" class="dsh-add-provider-btn" id="dsh-btn-open-add-provider">
        + 添加模型提供商
      </button>
    `;
  }

  return `
    <div class="dsh-models-container">
      <div class="dsh-models-header">
        <div class="dsh-models-header-left">
          <h3>模型</h3>
          <p>填入各提供商的 API 密钥即可使用其模型。</p>
        </div>
        <div class="dsh-main-model-bar">
          <span>主对话模型:</span>
          <select id="cfg-role-main" class="dsh-main-model-select">
            ${mainModelOptionsHtml}
          </select>
        </div>
      </div>

      <div class="dsh-providers-list">
        ${providerCardsHtml}
      </div>

      ${addProviderBlockHtml}
    </div>
  `;
}

function renderVaryTabContent(c, models, currentMain) {
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
          ${models.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === val ? 'selected' : ''}>${escapeHtml(m.providerName || m.id.split('_')[0])} · ${escapeHtml(m.displayName || m.model || m.id)}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  const seatsHtml = (c.seats || []).map((seat, idx) => {
    return `
      <div class="role-assign-item">
        <label>席位 #${idx + 1} (${escapeHtml(seat.id)})</label>
        <select data-cfg-seat="${escapeHtml(seat.id)}">
          ${models.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === seat.modelId ? 'selected' : ''}>${escapeHtml(m.providerName || m.id.split('_')[0])} · ${escapeHtml(m.displayName || m.model || m.id)}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div>
        <h3 style="margin:0;font-size:14px;color:var(--ink)">Vary 多视角推演调度规则</h3>
        <p style="margin:3px 0 0;font-size:11.5px;color:var(--muted)">分配 5 大核心功能角色与 8 席位深度推演模型。</p>
      </div>
      <button type="button" class="ghost-action-btn" id="cfg-sync-all-seats">一键同步席位为主模型</button>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">核心功能角色模型分配</div>
      <div class="role-assign-grid">
        ${roleAssignHtml}
      </div>
    </div>

    <div class="settings-section" style="margin-top:10px">
      <div class="settings-section-title">Varina 8 席位推演分配</div>
      <div class="role-assign-grid">
        ${seatsHtml}
      </div>
    </div>

    <div class="settings-section" style="margin-top:10px">
      <div class="settings-section-title">子问题独立发散</div>
      <div class="role-assign-grid">
        <div class="role-assign-item">
          <label title="每个拆解后的子问题分别调用多少个回答席位">每个子问题的回答数 n2</label>
          <input id="cfg-answers-per-subproblem" type="number" min="1" max="8" step="1" value="${escapeHtml(c.subproblemExpansion?.answersPerSubproblem ?? 2)}">
        </div>
      </div>
    </div>
  `;
}

function renderSettingsModalContent() {
  const container = $('#settings-tab-content');
  if (!container || !state.editingConfig) return;

  const tab = state.activeSettingsTab || 'general';
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const c = state.editingConfig;
  const models = c.models || [];
  const currentMain = c.roles?.main || c.roles?.chair || models[0]?.id || '';

  if (tab === 'general') {
    container.innerHTML = renderGeneralTabContent();
  } else if (tab === 'models') {
    container.innerHTML = renderModelsTabContent(c, models, currentMain);
  } else if (tab === 'vary') {
    container.innerHTML = renderVaryTabContent(c, models, currentMain);
  }
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
    state.editingProviderId = null;
    state.isAddingProvider = false;
    renderSettingsModalContent();
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    toast(`加载配置失败: ${error.message}`);
  }
}

function deleteProvider(providerId) {
  syncFieldsToState();
  const isMatch = m => m.providerId === providerId || (!m.providerId && (m.id === providerId || m.id.startsWith(`${providerId}_`)));
  const remaining = state.editingConfig.models.filter(m => !isMatch(m));
  if (remaining.length === 0) {
    toast('至少保留一个模型提供商');
    return;
  }
  state.editingConfig.models = remaining;
  state.editingProviderId = null;

  const validIds = new Set(remaining.map(m => m.id));
  const fallbackId = remaining[0].id;
  if (!validIds.has(state.editingConfig.roles.main)) state.editingConfig.roles.main = fallbackId;
  for (const [r, id] of Object.entries(state.editingConfig.roles)) {
    if (!validIds.has(id)) state.editingConfig.roles[r] = fallbackId;
  }
  (state.editingConfig.seats || []).forEach(seat => {
    if (!validIds.has(seat.modelId)) seat.modelId = fallbackId;
  });

  void persistConfig(false);
}

async function testProvider(providerId, fromInput = false) {
  const resultBox = document.getElementById(`dsh-test-result-${providerId}`);
  if (resultBox) {
    resultBox.hidden = false;
    resultBox.className = 'test-result-indicator running';
    resultBox.innerHTML = '<span class="activity-pulse"></span> 正在测试网络与 API 连通性…';
  }

  const providers = getDshProviders(state.editingConfig.models);
  const p = providers.find(item => item.id === providerId);
  if (!p) return;

  const keyInput = document.getElementById(`dsh-key-${providerId}`);
  const urlInput = document.getElementById(`dsh-url-${providerId}`);
  const protoSelect = document.getElementById(`dsh-proto-${providerId}`);

  let key = fromInput ? (keyInput?.value?.trim() || p.apiKey) : p.apiKey;
  let baseUrl = fromInput ? (urlInput?.value?.trim() || p.baseUrl) : p.baseUrl;
  let protocol = fromInput ? (protoSelect?.value || p.protocol) : p.protocol;
  let firstModel = p.catalog[0]?.model || p.model || 'test';

  const testConfig = {
    id: p.id,
    model: firstModel,
    baseUrl: baseUrl,
    protocol: protocol,
    tokenParameter: p.tokenParameter,
    structuredOutput: p.structuredOutput,
    supportsTemperature: p.supportsTemperature,
    supportsReasoning: p.supportsReasoning,
    supportsSeed: p.supportsSeed,
    isKeyless: p.isKeyless
  };

  try {
    const res = await api('/api/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelConfig: testConfig, apiKey: key })
    });
    if (resultBox) {
      if (res.ok) {
        resultBox.className = 'test-result-indicator success';
        resultBox.innerHTML = `测试通过！延迟 <b>${res.latencyMs}ms</b> · 响应: ${escapeHtml(res.response || 'OK')}`;
      } else {
        resultBox.className = 'test-result-indicator fail';
        resultBox.innerHTML = `连通失败 (${res.latencyMs ? res.latencyMs + 'ms' : '错误'}): ${escapeHtml(res.error || '未能连接到服务端点')}`;
      }
    }
  } catch (err) {
    if (resultBox) {
      resultBox.className = 'test-result-indicator fail';
      resultBox.innerHTML = `请求错误: ${escapeHtml(err.message)}`;
    }
  }
}

async function discoverProviderModels(providerId) {
  const box = document.getElementById(`dsh-discover-box-${providerId}`);
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div style="font-size:10.5px;color:var(--muted)">正在探测端点可用模型…</div>';

  const providers = getDshProviders(state.editingConfig.models);
  const p = providers.find(item => item.id === providerId);
  if (!p) return;

  const keyInput = document.getElementById(`dsh-key-${providerId}`);
  const urlInput = document.getElementById(`dsh-url-${providerId}`);
  const protoSelect = document.getElementById(`dsh-proto-${providerId}`);

  const apiKey = keyInput?.value?.trim() || p.apiKey;
  const baseUrl = urlInput?.value?.trim() || p.baseUrl;
  const protocol = protoSelect?.value || p.protocol;

  try {
    const res = await api('/api/models/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, protocol, modelId: p.id })
    });
    if (res.ok && res.models?.length) {
      box.innerHTML = `
        <div style="font-size:10.5px;font-weight:600;color:var(--accent);width:100%;margin-bottom:4px">
          命中 ${res.models.length} 个可用模型 (点击直接添加至目录)：
        </div>
        ${res.models.slice(0, 30).map(mod => `
          <button type="button" class="discovered-model-pill" data-fill-catalog-model="${escapeHtml(mod.id)}" data-provider-id="${escapeHtml(providerId)}">
            + ${escapeHtml(mod.id)}
          </button>
        `).join('')}
      `;
    } else {
      box.innerHTML = `<div style="font-size:10.5px;color:#a83832">${escapeHtml(res.error || '未能在该端点发现模型列表')}</div>`;
    }
  } catch (err) {
    box.innerHTML = `<div style="font-size:10.5px;color:#a83832">探测出错: ${escapeHtml(err.message)}</div>`;
  }
}

function addProviderFromPreset(presetId) {
  const preset = MODEL_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  const keyInput = document.getElementById('dsh-new-api-key');
  const urlInput = document.getElementById('dsh-new-base-url');
  const protoSelect = document.getElementById('dsh-new-protocol');
  const rows = document.querySelectorAll('#dsh-new-catalog-table [data-new-catalog-row]');

  const key = keyInput?.value?.trim() || '';
  const baseUrl = urlInput?.value?.trim() || preset.baseUrl;
  const protocol = protoSelect?.value || preset.protocol;

  const catalog = [];
  rows.forEach(r => {
    const m = r.querySelector('[data-new-catalog-model]')?.value?.trim() || '';
    const d = r.querySelector('[data-new-catalog-display]')?.value?.trim() || m;
    if (m) catalog.push({ model: m, displayName: d });
  });
  if (catalog.length === 0) {
    (preset.modelsList || [preset.model]).forEach(m => catalog.push({ model: m, displayName: m }));
  }

  const pName = preset.label.split(' ')[0];
  catalog.forEach((item, idx) => {
    let modelId = idx === 0 ? preset.id : `${preset.id}_${item.model.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let counter = 2;
    while (state.editingConfig.models.some(m => m.id === modelId)) {
      modelId = `${preset.id}_${item.model.replace(/[^a-zA-Z0-9_-]/g, '_')}_${counter++}`;
    }
    state.editingConfig.models.push({
      id: modelId,
      model: item.model,
      displayName: item.displayName,
      baseUrl: baseUrl,
      protocol: protocol,
      tokenParameter: preset.tokenParameter || 'max_tokens',
      structuredOutput: preset.structuredOutput || 'json_object',
      supportsTemperature: preset.supportsTemperature ?? true,
      supportsReasoning: preset.supportsReasoning ?? true,
      supportsSeed: preset.supportsSeed ?? false,
      providerId: preset.id,
      providerName: pName,
      hasKey: Boolean(key),
      apiKey: key || undefined
    });
  });

  state.isAddingProvider = false;
  void persistConfig(false);
}

function addProviderCustom() {
  const nameInput = document.getElementById('dsh-custom-name');
  const urlInput = document.getElementById('dsh-custom-url');
  const keyInput = document.getElementById('dsh-custom-key');
  const protoSelect = document.getElementById('dsh-custom-protocol');
  const rows = document.querySelectorAll('#dsh-new-catalog-table [data-new-catalog-row]');

  const pName = nameInput?.value?.trim() || '自定义API';
  const baseUrl = urlInput?.value?.trim() || 'https://';
  const key = keyInput?.value?.trim() || '';
  const protocol = protoSelect?.value || 'chat';

  const catalog = [];
  rows.forEach(r => {
    const m = r.querySelector('[data-new-catalog-model]')?.value?.trim() || '';
    const d = r.querySelector('[data-new-catalog-display]')?.value?.trim() || m;
    if (m) catalog.push({ model: m, displayName: d });
  });
  if (catalog.length === 0) {
    catalog.push({ model: 'custom-model', displayName: 'Custom Model' });
  }

  let pId = `CUSTOM_${Date.now()}`;
  catalog.forEach((item, idx) => {
    let modelId = idx === 0 ? pId : `${pId}_${item.model.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let counter = 2;
    while (state.editingConfig.models.some(m => m.id === modelId)) {
      modelId = `${pId}_${item.model.replace(/[^a-zA-Z0-9_-]/g, '_')}_${counter++}`;
    }
    state.editingConfig.models.push({
      id: modelId,
      model: item.model,
      displayName: item.displayName,
      baseUrl: baseUrl,
      protocol: protocol,
      tokenParameter: 'max_tokens',
      structuredOutput: 'json_object',
      supportsTemperature: true,
      supportsReasoning: true,
      supportsSeed: false,
      providerId: pId,
      providerName: pName,
      hasKey: Boolean(key),
      apiKey: key || undefined
    });
  });

  state.isAddingProvider = false;
  void persistConfig(false);
}

async function persistConfig(shouldCloseDialog = false) {
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
    if (shouldCloseDialog) {
      $('#settings-dialog')?.close();
      toast('大模型选型与配置已成功保存并即时生效！');
    } else {
      renderSettingsModalContent();
      toast('配置已成功更新并生效');
    }
  } catch (error) {
    toast(`保存失败: ${error.message}`);
  }
}

async function saveSettingsModal() {
  await persistConfig(true);
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
$('#message-input').addEventListener('keydown', event => {
  const prefs = getPreferences();
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  if (prefs.sendShortcut === 'ctrl_enter') {
    if (event.key === 'Enter' && isCtrlOrCmd) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  } else {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  }
});
$('#message-input').addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(210, event.target.scrollHeight)}px`; });
$('#session-list').addEventListener('click', event => {
  const deleteBtn = event.target.closest('[data-delete-session]');
  if (deleteBtn) {
    event.stopPropagation();
    deleteSession(deleteBtn.dataset.deleteSession).catch(error => toast(error.message));
    return;
  }
  const createInFolderBtn = event.target.closest('[data-create-in-folder]');
  if (createInFolderBtn) {
    event.stopPropagation();
    createSessionInFolder(createInFolderBtn.dataset.createInFolder).catch(error => toast(error.message));
    return;
  }
  const folderToggle = event.target.closest('[data-toggle-folder]');
  if (folderToggle) {
    event.stopPropagation();
    toggleFolderCollapse(folderToggle.dataset.toggleFolder);
    return;
  }
  const button = event.target.closest('[data-session]');
  if (button) openSession(button.dataset.session).catch(error => toast(error.message));
});
$('#messages').addEventListener('click', event => {
  const suggestion = event.target.closest('[data-suggestion]');
  if (suggestion) { $('#message-input').value = suggestion.dataset.suggestion; $('#message-input').focus(); }
  if (event.target.closest('[data-open-workspace]')) openFolderDialog().catch(error => toast(error.message));
  const confirmation = event.target.closest('[data-varina-confirm]');
  if (confirmation) {
    const message = state.session.messages[Number(confirmation.dataset.varinaConfirm)];
    const accepted = confirmation.dataset.accepted === 'true';
    api(`/api/agent/sessions/${state.session.session_id}/varina-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation_id: message.confirmation.id, accepted })
    }).then(() => refreshSession(state.session.session_id)).catch(error => toast(error.message));
  }
  const copyHeroPromptBtn = event.target.closest('[data-copy-hero-prompt]');
  if (copyHeroPromptBtn) {
    event.stopPropagation();
    copyHeroPrompt(copyHeroPromptBtn.dataset.copyHeroPrompt);
    return;
  }
  const tab = event.target.closest('[data-aha-tab]');
  if (tab) {
    state.ahaTabs[tab.dataset.runId] = tab.dataset.ahaTab;
    state.userScrolledUp = true;
    renderMessages();
  }
  const subproblem = event.target.closest('[data-subproblem-select]');
  if (subproblem) {
    state.subproblemSelections[subproblem.dataset.runId] = subproblem.dataset.subproblemSelect;
    state.userScrolledUp = true;
    renderMessages();
  }
});
$('#messages')?.addEventListener('scroll', event => {
  const el = event.target;
  if (el && el !== $('#messages') && el.dataset?.scrollId) {
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      state.scrollCache.set(el.dataset.scrollId, { top: el.scrollTop, left: el.scrollLeft });
    } else {
      state.scrollCache.delete(el.dataset.scrollId);
    }
  }
}, { capture: true, passive: true });
$('#messages')?.addEventListener('scroll', updateScrollBottomBtn, { passive: true });
$('#messages')?.addEventListener('wheel', event => {
  const inCard = event.target.closest?.('[data-scroll-id], pre, .thinking-body, .tool-card, .varina-workbench, .diff-container, details[open]');
  if (inCard || event.deltaY < 0) {
    state.userScrolledUp = true;
  }
}, { passive: true });
$('#scroll-bottom-btn')?.addEventListener('click', () => {
  const target = $('#messages');
  state.userScrolledUp = false;
  if (target) target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
  const btn = $('#scroll-bottom-btn');
  if (btn) btn.hidden = true;
});
$('#cancel-turn').addEventListener('click', async () => {
  if (!state.session) return;
  try { await api(`/api/agent/sessions/${state.session.session_id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('正在停止，已完成的中间结果会保留'); }
  catch (error) { toast(error.message); }
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && ['running', 'baseline_complete', 'evaluating_varina', 'running_varina'].includes(state.session?.status)) {
    event.preventDefault();
    $('#cancel-turn')?.click();
  }
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
  const modes = ['smart', 'ask', 'always', 'never'];
  const cur = getPreferences().varyTriggerMode;
  const nextIdx = (modes.indexOf(cur) + 1) % modes.length;
  const next = modes[nextIdx];
  savePreference('vary_trigger_mode', next);
  const labels = {
    smart: '智能判定 (推荐，遇到机制分歧自动推演)',
    ask: '每次询问 (执行前弹出确认卡片)',
    always: '总是开启 (强制启动 8 席位推演)',
    never: '总是关闭 (仅常规对话与工具操作)'
  };
  toast(`Vary 探索策略已切换为: ${labels[next]}`);
});

$('.settings-sidebar')?.addEventListener('click', event => {
  const tabBtn = event.target.closest('.settings-tab-btn');
  if (tabBtn) {
    syncFieldsToState();
    state.activeSettingsTab = tabBtn.dataset.tab;
    renderSettingsModalContent();
  }
});

$('#open-config-file-btn')?.addEventListener('click', async () => {
  try {
    const res = await api('/api/config/open', { method: 'POST' });
    if (res.ok) {
      toast(`已尝试在系统编辑器中打开配置文件: ${res.path}`);
    } else {
      toast(`配置文件路径: ${res.path}`);
    }
  } catch (err) {
    toast(`打开配置文件失败: ${err.message}`);
  }
});

$('#settings-body')?.addEventListener('change', event => {
  const prefSelect = event.target.closest('[data-pref]');
  if (prefSelect) {
    savePreference(prefSelect.dataset.pref, prefSelect.value);
    toast('已保存偏好设置');
    return;
  }
  const mainSelect = event.target.closest('#cfg-role-main');
  if (mainSelect && state.editingConfig) {
    state.editingConfig.roles ??= {};
    state.editingConfig.roles.main = mainSelect.value;
    return;
  }
  const presetSelect = event.target.closest('#dsh-new-preset-select');
  if (presetSelect) {
    state.selectedAddPresetId = presetSelect.value;
    renderSettingsModalContent();
    return;
  }
  const roleSelect = event.target.closest('[data-cfg-role]');
  if (roleSelect && state.editingConfig) {
    state.editingConfig.roles ??= {};
    state.editingConfig.roles[roleSelect.dataset.cfgRole] = roleSelect.value;
    return;
  }
  const seatSelect = event.target.closest('[data-cfg-seat]');
  if (seatSelect && state.editingConfig) {
    const seat = (state.editingConfig.seats || []).find(s => s.id === seatSelect.dataset.cfgSeat);
    if (seat) seat.modelId = seatSelect.value;
    return;
  }
});

$('#settings-body')?.addEventListener('click', event => {
  const syncSeatsBtn = event.target.closest('#cfg-sync-all-seats');
  if (syncSeatsBtn) {
    syncFieldsToState();
    const mainRoleModelId = state.editingConfig?.roles?.main || state.editingConfig?.roles?.chair || state.editingConfig?.models?.[0]?.id;
    if (mainRoleModelId) {
      (state.editingConfig.seats || []).forEach(seat => {
        seat.modelId = mainRoleModelId;
      });
      renderSettingsModalContent();
      toast(`已将 8 席位统一设置为主模型: ${mainRoleModelId}`);
    }
    return;
  }

  const editProviderBtn = event.target.closest('[data-edit-provider]');
  if (editProviderBtn) {
    syncFieldsToState();
    state.editingProviderId = editProviderBtn.dataset.editProvider;
    state.isAddingProvider = false;
    renderSettingsModalContent();
    return;
  }

  const cancelEditBtn = event.target.closest('[data-cancel-edit-provider]');
  if (cancelEditBtn) {
    state.editingProviderId = null;
    renderSettingsModalContent();
    return;
  }

  const saveProviderBtn = event.target.closest('[data-save-provider]');
  if (saveProviderBtn) {
    const pId = saveProviderBtn.dataset.saveProvider;
    syncProviderFieldsToState(pId);
    state.editingProviderId = null;
    void persistConfig(false);
    return;
  }

  const deleteProviderBtn = event.target.closest('[data-delete-provider]');
  if (deleteProviderBtn) {
    const pId = deleteProviderBtn.dataset.deleteProvider;
    if (confirm(`确定要移除提供商「${pId}」及其所有模型配置吗？`)) {
      deleteProvider(pId);
    }
    return;
  }

  const testProviderBtn = event.target.closest('[data-test-provider]');
  if (testProviderBtn) {
    void testProvider(testProviderBtn.dataset.testProvider, false);
    return;
  }

  const testProviderInputBtn = event.target.closest('[data-test-provider-input]');
  if (testProviderInputBtn) {
    void testProvider(testProviderInputBtn.dataset.testProviderInput, true);
    return;
  }

  const discoverProviderBtn = event.target.closest('[data-discover-provider]');
  if (discoverProviderBtn) {
    void discoverProviderModels(discoverProviderBtn.dataset.discoverProvider);
    return;
  }

  const fillCatalogModelBtn = event.target.closest('[data-fill-catalog-model]');
  if (fillCatalogModelBtn) {
    const pId = fillCatalogModelBtn.dataset.providerId;
    const modelId = fillCatalogModelBtn.dataset.fillCatalogModel;
    const table = document.getElementById(`dsh-catalog-table-${pId}`);
    if (table) {
      const row = document.createElement('div');
      row.className = 'dsh-catalog-row';
      row.dataset.catalogId = `${pId}_${modelId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      row.dataset.providerId = pId;
      row.innerHTML = `
        <input type="text" class="dsh-input" data-catalog-field="model" value="${escapeHtml(modelId)}" placeholder="模型标识">
        <input type="text" class="dsh-input" data-catalog-field="displayName" value="${escapeHtml(modelId)}" placeholder="显示名称">
        <button type="button" class="dsh-btn dsh-btn-danger" data-remove-catalog-row="${escapeHtml(row.dataset.catalogId)}" title="移除模型">删除</button>
      `;
      table.appendChild(row);
      toast(`已将模型「${modelId}」添加至目录`);
    }
    return;
  }

  const addCatalogRowBtn = event.target.closest('[data-add-catalog-row]');
  if (addCatalogRowBtn) {
    const pId = addCatalogRowBtn.dataset.addCatalogRow;
    const table = document.getElementById(`dsh-catalog-table-${pId}`);
    if (table) {
      const row = document.createElement('div');
      row.className = 'dsh-catalog-row';
      row.dataset.catalogId = `${pId}_custom_${Date.now()}`;
      row.dataset.providerId = pId;
      row.innerHTML = `
        <input type="text" class="dsh-input" data-catalog-field="model" value="" placeholder="模型标识 (如 gpt-6.1-sol)">
        <input type="text" class="dsh-input" data-catalog-field="displayName" value="" placeholder="显示名称 (如 GPT 6.1 Sol)">
        <button type="button" class="dsh-btn dsh-btn-danger" data-remove-catalog-row="${escapeHtml(row.dataset.catalogId)}" title="移除模型">删除</button>
      `;
      table.appendChild(row);
      row.querySelector('input')?.focus();
    }
    return;
  }

  const removeCatalogRowBtn = event.target.closest('[data-remove-catalog-row]');
  if (removeCatalogRowBtn) {
    const row = removeCatalogRowBtn.closest('.dsh-catalog-row');
    if (row) {
      const table = row.parentElement;
      if (table && table.querySelectorAll('.dsh-catalog-row').length <= 1) {
        toast('提供商至少需保留一个模型');
        return;
      }
      row.remove();
    }
    return;
  }

  const openAddProviderBtn = event.target.closest('#dsh-btn-open-add-provider');
  if (openAddProviderBtn) {
    syncFieldsToState();
    state.isAddingProvider = true;
    state.addProviderTab = 'preset';
    state.editingProviderId = null;
    renderSettingsModalContent();
    return;
  }

  const switchAddTabBtn = event.target.closest('[data-switch-add-tab]');
  if (switchAddTabBtn) {
    state.addProviderTab = switchAddTabBtn.dataset.switchAddTab;
    renderSettingsModalContent();
    return;
  }

  const cancelAddProviderBtn = event.target.closest('[data-cancel-add-provider]');
  if (cancelAddProviderBtn) {
    state.isAddingProvider = false;
    renderSettingsModalContent();
    return;
  }

  const newAddCatalogRowBtn = event.target.closest('#dsh-new-add-catalog-row');
  if (newAddCatalogRowBtn) {
    const table = document.getElementById('dsh-new-catalog-table');
    if (table) {
      const row = document.createElement('div');
      row.className = 'dsh-catalog-row';
      row.dataset.newCatalogRow = '';
      row.innerHTML = `
        <input type="text" class="dsh-input" data-new-catalog-model value="" placeholder="模型标识">
        <input type="text" class="dsh-input" data-new-catalog-display value="" placeholder="显示名称">
        <button type="button" class="dsh-btn dsh-btn-danger" data-remove-new-catalog-row title="删除">删除</button>
      `;
      table.appendChild(row);
      row.querySelector('input')?.focus();
    }
    return;
  }

  const removeNewCatalogRowBtn = event.target.closest('[data-remove-new-catalog-row]');
  if (removeNewCatalogRowBtn) {
    removeNewCatalogRowBtn.closest('.dsh-catalog-row')?.remove();
    return;
  }

  const confirmAddPresetBtn = event.target.closest('[data-confirm-add-preset]');
  if (confirmAddPresetBtn) {
    const presetSelect = document.getElementById('dsh-new-preset-select');
    addProviderFromPreset(presetSelect?.value || 'OPENAI');
    return;
  }

  const confirmAddCustomBtn = event.target.closest('[data-confirm-add-custom]');
  if (confirmAddCustomBtn) {
    addProviderCustom();
    return;
  }
});

try {
  applyPreferences();
  try { state.config = await api('/api/config'); } catch {}
  updateComposerModel();
  updateVarinaToggle();
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
