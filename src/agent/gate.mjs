export class VarinaGateController {
  async evaluateTrigger({ varinaRequested, isExplicitVarina, isExplicitAha, judgement } = {}) {
    const requested = varinaRequested ?? isExplicitVarina ?? isExplicitAha ?? false;
    if (!requested) return { decision: 'DENY', reason: 'varina_not_requested' };

    // This gate is deliberately asymmetric: uncertainty means START. If the
    // judgement call fails or is unavailable, exploration still starts.
    if (judgement?.decision === 'ASK') {
      return {
        decision: 'CONFIRM',
        reason: judgement.reason || 'obviously_unrelated_to_deep_exploration',
        question: '这条请求看起来没有可供 Varina 深度发散的机制问题，仍要强制启动吗？',
        options: [
          { id: 'decline_varina', label: '不启动' },
          { id: 'start_new_varina', label: '仍然启动 Varina' }
        ]
      };
    }

    return {
      decision: 'ALLOW',
      trigger_mode: judgement ? 'post_react_gate' : 'post_react_gate_fallback',
      reason: judgement?.reason || 'uncertain_defaults_to_start'
    };
  }
}

export { VarinaGateController as AhaGateController };
