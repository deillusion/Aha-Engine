export class VarinaGateController {
  constructor({ firstVarinaMode = 'auto', firstAhaMode, followUpTimeoutSeconds = 30 } = {}) {
    const mode = firstVarinaMode ?? firstAhaMode ?? 'auto';
    if (!['auto', 'confirm'].includes(mode)) throw new Error('firstVarinaMode 无效');
    if (!Number.isFinite(followUpTimeoutSeconds) || followUpTimeoutSeconds < 15 || followUpTimeoutSeconds > 60) {
      throw new Error('followUpTimeoutSeconds 必须在 15–60 秒之间');
    }
    this.firstVarinaMode = mode;
    this.firstAhaMode = mode;
    this.followUpTimeoutSeconds = followUpTimeoutSeconds;
  }

  async evaluateTrigger({ isExplicitVarina, isExplicitAha, sessionState, askUserFn = null, signal }) {
    const isExplicit = isExplicitVarina ?? isExplicitAha;
    if (isExplicit) return { decision: 'ALLOW', trigger_mode: 'explicit_varina', reason: 'explicit_command' };
    const count = sessionState.varina_runs?.length ?? sessionState.aha_runs?.length ?? 0;
    if (count === 0 && this.firstVarinaMode === 'auto') {
      return { decision: 'ALLOW', trigger_mode: 'auto', reason: 'first_varina_in_session' };
    }
    if (!askUserFn) {
      return {
        decision: 'CONFIRM',
        reason: count === 0 ? 'first_varina_requires_confirmation' : 'repeat_varina_requires_confirmation',
        question: count === 0
          ? '是否启动本次 Varina 深度探索？'
          : `当前会话已启动过 ${count} 次 Varina。是否为这个新议题再次启动深度探索？`,
        options: [
          { id: 'decline_varina', label: '基于已有成果继续（推荐）' },
          { id: 'start_new_varina', label: '启动全新 Varina' }
        ]
      };
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer;
    try {
      const answer = await Promise.race([
        Promise.resolve(askUserFn(
          count === 0 ? '是否启动本次 Varina 深度探索？' : `当前会话已启动过 ${count} 次 Varina。是否再次启动？`,
          [
            { id: 'decline_varina', label: '基于已有成果继续（推荐）' },
            { id: 'start_new_varina', label: '启动全新 Varina' }
          ],
          combined
        )).catch(() => 'decline_varina'),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort('timeout'); resolve('decline_varina'); }, this.followUpTimeoutSeconds * 1000); })
      ]);
      const accepted = answer === 'start_new_varina' || answer === 'start_new_aha';
      return accepted
        ? { decision: 'ALLOW', trigger_mode: 'user_confirmed', reason: count === 0 ? 'first_varina_confirmed' : 'repeat_varina_confirmed' }
        : { decision: 'DENY', reason: 'declined_or_timed_out' };
    } finally {
      clearTimeout(timer);
      controller.abort('settled');
    }
  }
}

export { VarinaGateController as AhaGateController };
