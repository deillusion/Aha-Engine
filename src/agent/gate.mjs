export class AhaGateController {
  constructor({ firstAhaMode = 'auto', followUpTimeoutSeconds = 30 } = {}) {
    if (!['auto', 'confirm'].includes(firstAhaMode)) throw new Error('firstAhaMode 无效');
    if (!Number.isFinite(followUpTimeoutSeconds) || followUpTimeoutSeconds < 15 || followUpTimeoutSeconds > 60) {
      throw new Error('followUpTimeoutSeconds 必须在 15–60 秒之间');
    }
    this.firstAhaMode = firstAhaMode;
    this.followUpTimeoutSeconds = followUpTimeoutSeconds;
  }

  async evaluateTrigger({ isExplicitAha, sessionState, askUserFn = null, signal }) {
    if (isExplicitAha) return { decision: 'ALLOW', trigger_mode: 'explicit_aha', reason: 'explicit_command' };
    const count = sessionState.aha_runs?.length ?? 0;
    if (count === 0 && this.firstAhaMode === 'auto') {
      return { decision: 'ALLOW', trigger_mode: 'auto', reason: 'first_aha_in_session' };
    }
    if (!askUserFn) {
      return {
        decision: 'CONFIRM',
        reason: count === 0 ? 'first_aha_requires_confirmation' : 'repeat_aha_requires_confirmation',
        question: count === 0
          ? '是否启动本次 Aha 深度探索？'
          : `当前会话已启动过 ${count} 次 Aha。是否为这个新议题再次启动深度探索？`,
        options: [
          { id: 'decline_aha', label: '基于已有成果继续（推荐）' },
          { id: 'start_new_aha', label: '启动全新 Aha' }
        ]
      };
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer;
    try {
      const answer = await Promise.race([
        Promise.resolve(askUserFn(
          count === 0 ? '是否启动本次 Aha 深度探索？' : `当前会话已启动过 ${count} 次 Aha。是否再次启动？`,
          [
            { id: 'decline_aha', label: '基于已有成果继续（推荐）' },
            { id: 'start_new_aha', label: '启动全新 Aha' }
          ],
          combined
        )).catch(() => 'decline_aha'),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort('timeout'); resolve('decline_aha'); }, this.followUpTimeoutSeconds * 1000); })
      ]);
      return answer === 'start_new_aha'
        ? { decision: 'ALLOW', trigger_mode: 'user_confirmed', reason: count === 0 ? 'first_aha_confirmed' : 'repeat_aha_confirmed' }
        : { decision: 'DENY', reason: 'declined_or_timed_out' };
    } finally {
      clearTimeout(timer);
      controller.abort('settled');
    }
  }
}
