/**
 * 每周达标领取：只向服务端询问，不接受本地成绩自报。
 * 服务端已经按 family + Shanghai 自然周做唯一凭据和防重。
 */
import { memberWeeklyClaim, memberState } from './member-fragments.mjs';
import { showFragmentReward } from './fragment-reward.mjs';
let busy = false;
let lastAttempt = 0;
export async function resumeWeeklyGoal() {
  if (busy || !navigator.onLine) return { status: 'OFFLINE_OR_BUSY' };
  if (Date.now() - lastAttempt < 60000) return { status: 'THROTTLED' };
  busy = true;
  lastAttempt = Date.now();
  try {
    const result = await memberWeeklyClaim();
    const status = String(result?.status || '');
    if (status === 'CLAIMED') {
      // 与普通课程奖励共用已存在的弹窗，但绝不二次调用领取 RPC。
      // 此弹窗只有数据库确认确实发放之后才会出现。
      await showFragmentReward({
        recordId: 'weekly-goal',
        claimImpl: async () => result,
        loadStateImpl: memberState
      });
    }
    return { status, completed_days: result?.completed_days ?? null };
  } catch (e) {
    // 还没迁移的旧客户端也不应影响课程学习、成绩同步或普通碎片。
    return { status: 'RETRY_LATER', error: e?.code || 'SERVER' };
  } finally {
    busy = false;
  }
}
