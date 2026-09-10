const FORMAL_REQUEST = /(?:数学|严格|形式化)?(?:证明|证伪)|(?:上界|下界|复杂度|收敛性|正确性)(?:证明|推导)|充要条件|不变量|单调量|定理|引理|反证法|归纳法|\bproof\b|\bprove\b|\btheorem\b|\blemma\b|formal verification|convergence proof|complexity bound/i;

export function requestsFormalReasoning(problem, constraints = []) {
  return FORMAL_REQUEST.test([problem, ...constraints].join('\n'));
}

export function eligibleDomainCatalog(catalog, problem, constraints = []) {
  const allowFormal = requestsFormalReasoning(problem, constraints);
  return catalog.filter(item => !item.task_types?.includes('formal_reasoning') || allowFormal);
}
