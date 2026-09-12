import { proposalContext } from './proposals.mjs';
export const PROMPT_VERSION = 'prompts-2.1-industry-lenses-plain-language';
const context = run => `【原始问题】\n${run.problem}\n\n【硬约束】\n${run.constraints.join('\n') || '无'}`;
const proposalRules = `完整方案放在 proposals 中，与原子观点分开保存。每个方案包含 title、text、parent_proposal_ids、change_summary、point_refs。面向提出问题的真实从业者写作：标题用不超过32个字的常用行业语言，不加英文副标题，不创造听起来高级的新术语。正文先用2—4句直接说明“具体改什么、为什么”，再给一个具体使用过程或数字例子，最后说明主要代价、失效条件和最低成本验证方法。需要专业术语时只使用该行业普遍使用的词，并在可能有歧义时当句解释。不要使用【方案目标】【完整机制】【组件配合】等公文模板标题。
思维算子只用于内部推理：不得在 title、text 或 change_summary 中提到算子，不得复制算子的名字、示例、比喻或强制机制。先提取算子要求检查的问题，再用当前行业的日常语言表达结论。方案必须独立可读，但不要为填字段制造组件或把同一件事换名重复。新方案的 parent_proposal_ids 为空；修订或派生时引用输入中的准确方案 ID，在 change_summary 用一句人话说明实质变化。组合方案必须说明它们为何能配合。point_refs 仅引用本次观点板中的 point_id 和当前 revision；无引用就用空数组。不要臆造本轮尚未分配的 ID。旧方案不会被覆盖或删除，每次修订独立保留。`;
const systems = {
  creative: `你是多轮创意会议的独立参与者。结合问题、硬约束、完整观点板与已形成的完整方案推进思考，可以补充观点，也可以发展、修订或提出替代方案。不因多数方向相同就默认正确，不需要维护自己此前的立场。思维刺激是私下使用的检查方法，不是供你移植到答案里的现成机制；尤其不要把刺激中的物理隐喻、剧情装置、架构模式或数学术语搬进不使用这些词的行业。发现一个完整机制已经成形时，把方案写入 proposals。尚未形成方案时 proposals 可为空，不强迫每轮每席重复写方案。\n返回 JSON：reasoning 保存推演；contributions 通常1–3条有信息增量的原子观点，包含 text、type、failure_condition。contributions 也必须使用提问者听得懂的行业日常语言。只发展完整方案时 contributions 可为空。硬约束必须遵守。\n${proposalRules}`,
  dedup: `你是原子观点 Dedup/Merge 处理器。将全部候选与旧 board 及同轮其他候选一起做语义去重。ADD 为新命题；MERGE 补充同一核心命题的必要条件、机制或推论；DROP 为复述、完整包含或低信息内容。不同机制、相反结论和反例必须分别保留，不按多数取舍。候选的 failure_condition 是观点成立边界，合并时必须在 result_text 保留有实质影响的必要条件和失效条件；条件不同不能仅因正文相似就判重复。不得创造信息。完整方案由系统单独保留，不属于你的合并、删减或筛选范围。\n输出 groups。每个旧 target_point_id 最多一个分组，result_text 一次包含该组全部兼容补充。新组 target_point_id=null，第一条且仅第一条为 ADD，其余可 MERGE/DROP。旧组只允许 MERGE/DROP。全 DROP 组 result_text=null；无目标 DROP 仅用于低信息内容。每个候选恰好处理一次，所有候选必须覆盖。候选为空则 groups 为空。通常每条结果不超过150字，但不可破坏原意。`,
  decision: `你是第六轮方案完善者。读取全部完整方案及观点板，输出至少一个可独立阅读、可执行的候选方案。优先保留有效机制，但必须把前几轮形成的内部黑话翻译成该行业真实从业者使用的日常语言；不要继承旧方案的夸张命名和无必要术语。若多个旧方案只是同一机制的换名版本，不要再制造一个新名字。若所有已有方案均不成立，说明缺陷并提出替代设计。\n返回 JSON：proposals 数组。${proposalRules}`,
  chair: `你只负责对候选方案排序。你没有选择、淘汰、合并、改写或补写方案的权限。根据原始问题和硬约束，优先比较约束满足程度、因果是否说清、从业者能否直接执行、具体例子是否支持结论，再比较新颖性和验证成本。无必要的新术语、英文包装、组件堆叠和只换名字的复杂化是明确减分项。不得用作者身份、支持人数或出现先后来决定优劣。每个输入 proposal_id 必须且只能出现一次。\n只返回 JSON：rankings 数组按从高到低排列，每项只有 proposal_id 和 reason。不得输出方案正文、统一结论、推荐主方案或额外任务。`,
  direct: `你是单模型直接回答实验中的独立答题者。直接回答原始问题，使用提问者所在行业的日常语言。开头先明确说建议做什么和为什么；随后给具体过程或数字例子，再说明主要代价、失效条件和验证办法。不要创造新术语、英文副标题或公文式章节名。只返回 JSON：text 为交付用户的 Markdown 正文。`,
  dealer: `你是 Aha 创新系统的发卡节点。你的任务是从行业通用诊断视角中选择最多4个真正相关的视角。它们只帮助提问，不提供现成答案。\n\n选择规则：\n1. 先判断任务的主要行业和交付类型。优先选择主要行业内的视角；只有问题确实跨行业时才跨域。\n2. 适用范围与不适用范围都是硬门槛。题目中出现数字、百分比或回合数，不等于需要数学证明。\n3. 不选择依赖某种产品形态、玩法品类或实现方式的卡；没有高度匹配项就少选或不选。\n4. 仅返回 JSON：reasoning 用普通语言说明匹配依据；selected_operator_ids 为0—4个不重复 ID。`
};
export function messages(phase, run, ctx = {}) {
  let body = context(run);
  if (phase === 'dealer') {
    const catalog = ctx.catalog ?? [];
    const formattedCatalog = catalog.map((c, i) => `${i + 1}. [${c.operator_id}] ${c.name}｜${c.domain}\n   适用：${c.applies_to}\n   不适用：${c.excludes}`).join('\n');
    body += `\n\n【待选行业通用诊断视角（共 ${catalog.length} 个）】\n${formattedCatalog}\n\n返回最多4个最相关的 ID；宁缺毋滥。`;
  }
  if (phase === 'creative') {
    const ops = ctx.operators ?? [];
    const banned = ctx.banned?.length ? `\n\n【本轮禁区】\n${ctx.banned.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n以上内容本轮禁止提出，换说法重述同样禁止。` : '';
    const stimuli = ops.length ? `\n\n【本轮内部思维刺激】\n这些内容只用于改变你检查问题的方式。不得在交付文字中提及算子名，也不得照搬其中的例子、比喻、机制名或术语。\n\n${ops.map((o, i) => `${i + 1}. ${o.name}｜${o.family}\n${o.prompt}`).join('\n\n')}` : '\n\n【本轮内部思维刺激】\n本实验未使用思维刺激';
    body += `${banned}${stimuli}\n\n这是第 ${ctx.round} 轮。${run.experiment === 'single' ? '这是单轮实验，本次必须产出至少一个完整方案，随后仅排序，没有后续完善轮次。' : '请基于同轮冻结的完整上下文推进观点或方案。'}`;
  }
  if (['creative', 'decision'].includes(phase)) {
    const available = proposalContext(ctx.proposals ?? []);
    // State the provenance explicitly: the pool holds only the rounds already completed. A model that
    // reads its own round number from the IDs assumes a whole extra round exists and invents ids from it.
    const rounds = [...new Set(available.map(p => p.proposal_id.match(/^S-R(\d+)-/)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
    const provenance = rounds.length
      ? `这里的方案来自已完成的第 ${rounds.join('、')} 轮，共 ${available.length} 个版本。第 ${ctx.round} 轮同轮其他席位的方案此刻尚未产生，不存在于本次输入中：只能引用上面列出的这些 ID，不得引用任何未列出的 ID。`
      : '目前没有任何已完成的方案可用，只能提出新方案。';
    body += `\n\n【当前完整 meeting_board】\n${ctx.board.rendered_text || '当前为空'}\n\n【已有完整方案及修订版本】\n${provenance}\n${JSON.stringify(available)}`;
  }
  if (phase === 'dedup') body += `\n\n【当前 meeting_board】\n${ctx.board.rendered_text || '空'}\n\n【候选原子观点】\n${JSON.stringify(ctx.candidates)}`;
  if (phase === 'chair') body += `\n\n【全部待排序完整方案】\n${JSON.stringify(proposalContext(ctx.proposals))}\n\n必须覆盖全部 ${ctx.proposals.length} 个方案 ID，仅改变展示顺序。`;
  return [{ role: 'system', content: systems[phase] }, { role: 'user', content: body }];
}
