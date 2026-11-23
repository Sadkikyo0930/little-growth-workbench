/**
 * v6/r5/weekly-goal.mjs —— 提案 v2（最终收尾）
 *
 * 修复：v1 只定义 resumeWeeklyGoal() 但没有任何调用点（学习流程未接入），
 * 且仅走家长 JWT（memberWeeklyClaim）——外婆手机没有家长会话就领不到。
 *
 * v2：
 *   · 设备身份优先：via deviceToken -> /v1/racing/fragment/weekly-claim，
 *     无设备令牌才退回 memberWeeklyClaim；
 *   · 达标判定 / 唯一记录 / 每周上限全部在服务端 r5_fragment_weekly_claim_device 里完成；
 *   · 接入学习流程：sync 成功后由 r5-bridge 调 resumeWeeklyGoal()；
 *     页面加载 / 回前台 / 网络恢复由 bootstrap() 自动补领；
 *   · 只有服务端确认 CLAIMED 才弹奖励，重复/不达标/未授权一律静默，零写入。
 */
import { weeklyClaimDevice, deviceToken } from './fragment-client.mjs';
import { memberWeeklyClaim, memberState } from './member-fragments.mjs';
import { showFragmentReward } from './fragment-reward.mjs';
import { normalizeClaimResponse } from './fragment-contract.mjs';

let busy = false;
let bootstrapped = false;

async function claimWeekly() {
  if (deviceToken()) return weeklyClaimDevice();
  return memberWeeklyClaim();
}

export async function resumeWeeklyGoal() {
  if (busy || !navigator.onLine) return { status: 'OFFLINE_OR_BUSY' };
  busy = true;
  try {
    const result = normalizeClaimResponse(await claimWeekly());
    const status = String(result && result.status || '');
    if (status === 'CLAIMED') {
      // 不二次调用领取 RPC；弹窗只展示服务端已确认发放的结果。
      try {
        const load = deviceToken()
          ? async () => (await import('./fragment-client.mjs')).loadState()
          : memberState;
        await showFragmentReward({ recordId: 'weekly-goal', claimImpl: async () => result, loadStateImpl: load });
      } catch { /* 展示失败不影响发放结果 */ }
    }
    return { status, completed_days: (result && result.completed_days) ?? null,
             granted_rare: (result && result.granted && result.granted.rare) ?? null };
  } catch (e) {
    return { status: 'RETRY_LATER', error: String((e && e.code) || (e && e.message) || 'SERVER') };
  } finally { busy = false; }
}

export function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  const kick = () => { resumeWeeklyGoal().catch(() => {}); };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick, { once: true });
  } else kick();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }
}
