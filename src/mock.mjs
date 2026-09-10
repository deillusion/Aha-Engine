import { setTimeout as delay } from 'node:timers/promises';
// Deterministic fixtures verify plumbing; they do not judge or solve arbitrary tasks.
const ideas = [
  ['让参与者在共享资源和个人收益之间做可见的取舍，选择改变下一轮可用资源，使一次决策产生可追踪的后果。', '将共享资源限定为每轮可恢复的预算，防止早期错误让后续参与者永久失去行动机会。'],
  ['先用一个完整的短循环验证核心机制：做出选择、看到后果、调整策略，再增加内容规模。', '短循环应保留真实的机会成本，不能只用无代价按钮点击代替关键选择，否则无法验证机制价值。'],
  ['为同一个目标提供两种互有优势的策略，并让环境变化影响收益，避免固定最优解使重复体验失去意义。', '环境变化必须提前提供可理解的信号，使策略调整基于判断而非纯粹猜测。'],
  ['隐藏部分结果、公开规则与概率区间，使不确定性来自决策条件，而不是来自无法解释的惩罚。', '关键规则应先通过低风险实践被理解，再逐步加入不确定结果，减少新手把策略失败误读为随机惩罚。'],
  ['奖励个人贡献可能诱发争抢；把部分收益与整体结果关联，可以检验合作是否由机制自然产生。', '整体收益的权重过高会产生搭便车，应保留可见且有上限的个人贡献收益。'],
  ['记录参与者第一次主动改变策略的时点，区分理解后的探索与无法理解规则造成的反复试错。', '将行为记录与简短复述访谈结合；只看策略变化次数可能把困惑误判为深度。'],
  ['给落后参与者一个有成本的追赶选择，让其重新参与竞争，但不直接抹去领先者此前决策的价值。', '追赶成本应消耗未来选择空间，而非要求额外时间投入，以免扩大资源差距。'],
  ['用规模很小的手动模拟验证关键反馈，再决定是否开发自动化系统，降低错误方向的实现成本。', '手动模拟必须记录裁决规则，避免主持人的即时调整掩盖机制本身的缺陷。']
];
function completeProposal(c) {
  const index = (c.seatIndex ?? 0) % ideas.length;
  const pool = (c.proposals ?? []).slice(-8);
  const parent = pool.length ? pool[index % pool.length] : null;
  return {
    title: '短循环验证方案 ' + (index + 1),
    text: '## 完整机制\n' + ideas[index].join(' ') + '\n\n先给予有限资源，再提供互有代价的两种行动，公开行动后果，让参与者在下一轮调整选择。资源预算、可理解反馈和机会成本必须配套；去掉任何一项都无法验证取舍。\n\n## 条件与风险\n需要参与者能够理解规则；若连续两次无法解释选择后果，应停止扩充内容并调整反馈。\n\n## 本轮完善\nR' + c.round + '：用可撤销的小规模验证检查机制 ' + (index + 1) + '，记录策略变化与复述结果。\n\n*固定模拟方案，不是对当前输入问题的真实回答。*',
    parent_proposal_ids: parent ? [parent.proposal_id] : [],
    change_summary: parent ? '保留完整机制并补全本轮验证条件。' : '提出包含资源、行动、反馈及验证办法的完整机制。',
    point_refs: c.board?.points.slice(0, 2).map(p => ({ point_id: p.point_id, revision: p.current_revision })) ?? []
  };
}
function mockThinking(c, phase) {
  if (phase === 'creative') {
    const op = c.operators?.[0];
    const opName = op?.name || '逆向思考';
    const opFamily = op?.family || '思维刺激';
    const opPrompt = op?.prompt || '打破常规假设，反转既有因果';
    return `深度思考中（Thinking Process）：\n1. 审视任务目标与硬约束：面对开放性机制设计，需确保规则在极简短循环内自闭环，且满足两周可验证、单局不超过10分钟的边界条件。\n2. 观察公共观点板（v${c.board?.version ?? 0}）：提取前序轮次中关于“有限资源分配”和“可见反馈”的核心沉淀。\n3. 激活算子【${opName} / ${opFamily}】：核心指引为“${opPrompt}”。常规思路倾向于通过正向奖励激励合作，但容易引发搭便车或同质化策略；若反向切入，将“行动代价”转化为“下一轮的选择空间”，会产生怎样的策略张力？\n4. 推演因果链路：\n   - 步骤一：给予每位参与者独立且有上限的决策预算；\n   - 步骤二：提供两种互有成本的行动路径，强迫参与者根据局势权衡眼前收益与未来灵活性；\n   - 步骤三：公开全场行动结果，通过动态环境参数形成策略博弈。\n5. 检验失效条件：若参与者无法直观建立“当前选择”与“下轮惩罚/收益”的因果关系，该机制将退化为随机乱试。必须在规则表述中前置反馈信号。\n6. 推演完成，输出核心观点及方案雏形。`;
  }
  if (phase === 'decision') {
    return `深度思考中（Thinking Process）：\n1. 统揽第 1-5 轮沉淀的所有观点条目与候选方案池（共 ${(c.proposals || []).length} 个版本）。\n2. 核心命题检验：各席位提出的机制切入点各有优劣，本席位需补全闭环执行路径与落地验证手段。\n3. 补齐机制设计：梳理行动、资源、反馈的三位一体关系，确保无模糊推导。\n4. 设定验证办法与退出条件，完成第 6 轮方案完善。`;
  }
  if (phase === 'chair') {
    return `深度思考中（Thinking Process）：\n1. 作为 Chair 全面审视待排序的 ${(c.proposals || []).length} 个完整方案版本。\n2. 比对硬约束检查：严格筛选是否满足时间与验证周期约束。\n3. 评估方案的新颖度、机制完整性与潜在落地风险。\n4. 综合权衡得出最终排名与裁决理由。`;
  }
  if (phase === 'dealer') {
    return `深度思考中（Thinking Process）：\n1. 分析输入问题与硬约束的本质特征与卡点类型。\n2. 扫描全部 72 个待选特化认知算子，评估其结构契合度。\n3. 宁缺毋滥：按相关性挑选适配算子，无强相关的领域坚决不选，避免凑数干扰。`;
  }
  return '';
}
export async function mockCompletion(model, request, { signal, mockDelayMs = 180, onChunk } = {}) {
  const c = request.context, phase = request.phase;
  const thinking = mockThinking(c, phase);
  if (thinking && onChunk) {
    if (mockDelayMs > 20) {
      const chunkSize = 2;
      const totalSteps = Math.ceil(thinking.length / chunkSize);
      const stepDelay = Math.max(6, Math.min(25, Math.floor(mockDelayMs / totalSteps)));
      for (let i = 0; i < thinking.length; i += chunkSize) {
        signal?.throwIfAborted();
        onChunk({ type: 'thinking', text: thinking.slice(i, i + chunkSize) });
        await delay(stepDelay, undefined, { signal });
      }
    } else {
      onChunk({ type: 'thinking', text: thinking });
    }
    onChunk({ type: 'thinking_done' });
  } else {
    await delay(mockDelayMs, undefined, { signal });
  }
  let value;
  if (phase === 'creative') {
    const index = c.seatIndex % ideas.length;
    const items = c.round === 1 ? [ideas[index][0], ideas[1][0]] : c.round === 2 ? [ideas[index].join(' ')] : c.round === 3 ? [ideas[index].join(' ')] : c.round === 4 ? [`为机制 ${index + 1} 设置可撤销的小规模试验，若参与者无法说明选择与后果的关系，就先调整反馈表达再扩大规模。`] : [`为机制 ${index + 1} 设置退出条件：当连续两次试验都无法观察到有意义的策略差异，停止增加内容并重新检查核心取舍。`];
    value = {
      reasoning: thinking || `分析算子与当前局面：针对当前机制 ${index + 1} 进行推导与检验。`,
      proposals: [completeProposal(c)],
      contributions: items.map((t, i) => ({
        text: t,
        type: i === 0 ? 'proposal' : 'mechanism',
        failure_condition: '若参与者无法理解选择后果或规则变动过快则失效'
      }))
    };
  } else if (phase === 'dedup') {
    const groups = [];
    for (const candidate of c.candidates) {
      const target = c.board.points.find(p => p.text === candidate.text || candidate.text.startsWith(p.text));
      let g = groups.find(g => target ? g.target_point_id === target.point_id : g.target_point_id === null && g.result_text === candidate.text);
      const duplicate = target?.text === candidate.text || g?.result_text === candidate.text;
      if (!g) { g = { target_point_id: target?.point_id ?? null, result_text: duplicate ? null : candidate.text, decisions: [] }; groups.push(g); }
      g.decisions.push({ candidate_id: candidate.candidate_id, action: duplicate ? 'DROP' : target || g.decisions.length ? 'MERGE' : 'ADD', reason_code: duplicate ? 'semantic_duplicate' : target ? 'adds_condition' : 'novel' });
    }
    value = { groups };
  } else if (phase === 'decision') {
    value = { proposals: [completeProposal(c)] };
  } else if (phase === 'chair') {
    value = { rankings: [...c.proposals].reverse().map(p => ({ proposal_id: p.proposal_id, reason: '固定模拟排序，仅验证全部方案均保留且正文不被改写。' })) };
  } else if (phase === 'direct') {
    value = { text: '## 固定模拟回答\n\n构建有限资源、两种行动、可见后果与下一轮调整组成的短循环。用小规模试验验证参与者能否解释取舍，再决定下一步。\n\n这是固定模拟数据，没有解答当前输入问题。' };
  } else if (phase === 'dealer') {
    const catalog = c.catalog || [];
    const problem = c.problem || '';
    // Select 2-4 matching operators based on simple keywords, or default to first 3
    let selected = [];
    if (problem.includes('玩') || problem.includes('游戏') || problem.includes('策略')) {
      selected = ['exploit_canonization', 'negative_sum_thaw', 'sacrifice_as_engine', 'dynamic_catch_up'];
    } else if (problem.includes('商') || problem.includes('买') || problem.includes('钱') || problem.includes('客户')) {
      selected = ['subsidy_arbitrage', 'parasitic_distribution', 'negative_cash_flow_inversion'];
    } else if (problem.includes('证') || problem.includes('数') || problem.includes('命题')) {
      selected = ['strengthen_induction', 'invariant_monovariant', 'extremal_principle'];
    } else {
      selected = catalog.slice(0, 3).map(o => o.operator_id);
    }
    const validIds = new Set(catalog.map(o => o.operator_id));
    const selected_operator_ids = selected.filter(id => validIds.has(id));
    value = {
      reasoning: '模拟发卡节点：精准匹配问题特征，挑选高度相关的特化算子，非相关领域不强行凑数。',
      selected_operator_ids
    };
  } else {
    throw new Error('未知模拟阶段：' + phase);
  }
  return { text: typeof value === 'string' ? value : JSON.stringify(value), thinking, usage: null, finish_reason: 'stop', resolved_model: model.model };
}
