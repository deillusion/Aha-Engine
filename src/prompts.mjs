import { proposalContext } from './proposals.mjs';
export const PROMPT_VERSION = 'prompts-2.2-atomic-mechanisms-anti-chimera';
const context = run => `【原始问题】\n${run.problem}\n\n【硬约束】\n${run.constraints.join('\n') || '无'}`;

export function getProposalRules(maxMechanisms = 3) {
  return `完整方案放在 proposals 中，与原子观点分开保存。每个方案必须包含 title、mechanisms、text、parent_proposal_ids、change_summary、point_refs。
【方案机制配额与原子性硬约束】
方案的本质是机制的装配组合，严禁无上限堆叠。每个方案的 mechanisms 数组必须包含 1 到 ${maxMechanisms} 个核心原子机制名称（当前上限为 ${maxMechanisms} 个）。
原子机制必须是单一因果、单变量修改、可在 15 行代码内实现的单一纯规则或数学公式。机制名称严禁使用“与/加/及/并/同时”等连词拼凑复合概念；机制计算规则严禁出现多阶段叙事（如“第一步、阶段一”）。
【写作规范】
面向提出问题的真实从业者写作：标题用不超过32个字的常用行业语言，不加英文副标题，不创造听起来高级的新术语。正文 text 严格限制在 1200 字以内，专门阐明这 ${maxMechanisms} 个以内的核心机制如何互相配合，给出一个具体使用过程或数字例子，并诚实说明主要代价、失效条件和最低成本验证方法。不要使用【方案目标】【完整机制】【组件配合】等公文模板标题。
思维算子只用于内部推理：不得在 title、mechanisms、text 或 change_summary 中提到算子，不得复制算子的名字、示例、比喻或强制机制。先提取算子要求检查的问题，再用当前行业的日常语言表达结论。
新方案的 parent_proposal_ids 为空；修订或派生时引用输入中的准确方案 ID，在 change_summary 用一句人话说明实质变化。查阅已探索的机制组合清单，严禁提出机制构成完全重复的方案，优先探索未被覆盖的正交机制组合。point_refs 仅引用本次观点板中的 point_id 和当前 revision；无引用就用空数组。不要臆造本轮尚未分配的 ID。旧方案不会被覆盖或删除，每次修订独立保留。`;
}

export function getSystems(maxMechanisms = 3) {
  const proposalRules = getProposalRules(maxMechanisms);
  return {
    creative: `目标：解构当前工程问题与底层死锁，提出有信息增量的原子观点，或直接可落地的独立原子机制。
【核心成果等级与产出纪律】
最核心、最稀缺的产出是【原子机制】（可在 15 行代码内写完的单公式、单判定或单状态跃迁规则）。严禁好大喜功、虚构宏大方案；思维刺激只用于内部检查，尤其严禁把刺激中的物理隐喻、剧情装置或数学术语生搬硬套进不使用这些词的行业。
返回 JSON：
- reasoning：保存因果推演过程；
- contributions：通常 1–3 条有信息增量的原子观点或独立原子机制（包含 text、type、failure_condition），必须使用提问者听得懂的行业日常语言。type 为 mechanism 时必须是单一可复用的计算规则，不可拆分，严禁写成多阶段流程；
- proposals：方案仅用于组装 1 到 ${maxMechanisms} 个原子机制（默认为空 []；若当前尚未有成熟正交组合，保持 proposals 为空数组，切勿强行凑写方案）。硬约束必须遵守。
${proposalRules}`,

    dedup: `目标：对原子观点执行语义去重与合并处理。将全部候选与旧 board 及同轮其他候选一起做语义去重。ADD 为新命题；MERGE 补充同一核心命题的必要条件、机制或推论；DROP 为复述、完整包含或低信息内容。不同机制、相反结论和反例必须分别保留，不按多数取舍。候选的 failure_condition 是观点成立边界，合并时必须在 result_text 保留有实质影响的必要条件和失效条件；条件不同不能仅因正文相似就判重复。不得创造信息。完整方案由系统单独保留，不属于你的合并、删减或筛选范围。
输出 groups。每个旧 target_point_id 最多一个分组，result_text 一次包含该组全部兼容补充。新组 target_point_id=null，第一条且仅第一条为 ADD，其余可 MERGE/DROP。旧组只允许 MERGE/DROP。全 DROP 组 result_text=null；无目标 DROP 仅用于低信息内容。每个候选恰好处理一次，所有候选必须覆盖。候选为空则 groups 为空。通常每条结果不超过150字，但不可破坏原意。`,

    decision: `目标：审查观点板与已探索方案组合，输出 1 到 2 个可独立阅读、可执行的最终方案。
每个方案必须且只能由 1 到 ${maxMechanisms} 个核心原子机制装配而成。优先保留有效机制，严禁兼顾所有方向，严禁和稀泥式的大全集缝合；必须做单点取舍，并明确指出本方案主动放弃了什么缺陷。必须把前几轮形成的内部黑话翻译成该行业真实从业者使用的日常语言；不要继承旧方案的夸张命名和无必要术语。若已有组合均不成立，说明缺陷并提出替代设计。
返回 JSON：proposals 数组。${proposalRules}`,

    chair: `目标：根据原始问题和硬约束，对候选方案输出从高到低排序清单。
排序依据：优先比较约束满足程度、机制是否精简、因果是否说清、从业者能否直接执行（15行代码可写完）、具体例子是否支持结论，再比较新颖性和验证成本。无必要的新术语、英文包装、组件堆叠和只换名字的复杂化是明确减分项。不得用作者身份、支持人数或出现先后来决定优劣。每个输入 proposal_id 必须且只能出现一次。
只返回 JSON：rankings 数组按从高到低排列，每项只有 proposal_id 和 reason。不得输出方案正文、统一结论、推荐主方案或额外任务。`,

    direct: `目标：直接回答原始问题，使用提问者所在行业的日常语言。开头先明确说建议做什么和为什么；随后给具体过程或数字例子，再说明主要代价、失效条件和验证办法。不要创造新术语、英文副标题或公文式章节名。
只返回 JSON：text 为交付用户的 Markdown 正文。`,

    dealer: `目标：根据任务的主要行业和交付类型，从行业通用诊断视角中选择最多 3 个能够切中核心矛盾的视角。它们只帮助提问，不提供现成答案。
选择规则：
1. 优先选择主要行业内的视角；只有问题确实跨行业时才跨域。
2. 适用范围与不适用范围都是硬门槛。题目中出现数字、百分比或回合数，不等于需要数学证明。
3. 不选择依赖某种产品形态、玩法品类或实现方式的卡；没有高度匹配项就少选或不选。宁缺毋滥。
仅返回 JSON：reasoning 用普通语言说明匹配依据；selected_operator_ids 为 0—3 个不重复 ID。`
  };
}

export function messages(phase, run, ctx = {}) {
  let body = context(run);
  const maxMechanisms = run?.max_mechanisms ?? 3;
  const sys = getSystems(maxMechanisms)[phase];
  if (phase === 'dealer') {
    const catalog = ctx.catalog ?? [];
    const formattedCatalog = catalog.map((c, i) => `${i + 1}. [${c.operator_id}] ${c.name}｜${c.domain}\n   适用：${c.applies_to}\n   不适用：${c.excludes}`).join('\n');
    body += `\n\n【待选行业通用诊断视角（共 ${catalog.length} 个）】\n${formattedCatalog}\n\n返回最多3个最相关的 ID；宁缺毋滥。`;
  }
  if (phase === 'creative') {
    const ops = ctx.operators ?? [];
    const banned = ctx.banned?.length ? `\n\n【本轮禁区】\n${ctx.banned.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n以上内容本轮禁止提出，换说法重述同样禁止。` : '';
    const stimuli = ops.length ? `\n\n【本轮内部思维刺激】\n这些内容只用于改变你检查问题的方式。不得在交付文字中提及算子名，也不得照搬其中的例子、比喻、机制名或术语。\n\n${ops.map((o, i) => `${i + 1}. ${o.name}｜${o.family}\n${o.prompt}`).join('\n\n')}` : '\n\n【本轮内部思维刺激】\n本实验未使用思维刺激';
    body += `${banned}${stimuli}\n\n这是第 ${ctx.round} 轮。${run.experiment === 'single' ? `这是单轮实验，本次必须产出至少一个由 1 到 ${maxMechanisms} 个机制装配的方案，随后仅排序，没有后续完善轮次。` : '请基于同轮冻结的完整上下文推进观点或机制。'}`;
  }
  if (['creative', 'decision'].includes(phase)) {
    const available = proposalContext(ctx.proposals ?? []);
    const rounds = [...new Set(available.map(p => p.proposal_id.match(/^S-R(\d+)-/)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
    const provenance = rounds.length
      ? `这里的方案来自已完成的第 ${rounds.join('、')} 轮，共 ${available.length} 个版本。第 ${ctx.round} 轮同轮其他席位的方案此刻尚未产生，不存在于本次输入中：只能引用上面列出的这些 ID，不得引用任何未列出的 ID。`
      : '目前没有任何已完成的方案可用，只能提出新方案。';
    body += `\n\n【当前完整 meeting_board】\n${ctx.board.rendered_text || '当前为空'}\n\n【已探索方案与机制组合清单（正文已隐去，仅保留机制签名以防重复探索）】\n${provenance}\n${JSON.stringify(available)}`;
  }
  if (phase === 'dedup') body += `\n\n【当前 meeting_board】\n${ctx.board.rendered_text || '空'}\n\n【候选原子观点】\n${JSON.stringify(ctx.candidates)}`;
  if (phase === 'chair') {
    const chairProposals = (ctx.proposals ?? []).map(({ proposal_id, title, mechanisms, text, parent_proposal_ids, change_summary, point_refs }) => ({
      proposal_id, title, mechanisms: Array.isArray(mechanisms) ? mechanisms : [], text, parent_proposal_ids, change_summary, point_refs
    }));
    body += `\n\n【全部待排序完整方案】\n${JSON.stringify(chairProposals)}\n\n必须覆盖全部 ${ctx.proposals.length} 个方案 ID，仅改变展示顺序。`;
  }
  return [{ role: 'system', content: sys }, { role: 'user', content: body }];
}
