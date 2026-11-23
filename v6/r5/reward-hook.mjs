/**
 * v6/r5/reward-hook.mjs  ——  提案 v2（最终收尾）
 *
 * 修复 v1 的三个 P0 缺口：
 *   1) v6.1.0 起服务端派生完成记录，record_id 形如 v6c-<dev>-complete-<科目>-d<day>；
 *      v1 的 RECORD 只认 v6-<hex>-course-N-<code>，导致入队的记录全被自己丢弃。
 *      本版同时接受两种格式，且最终资格仍由服务端判定。
 *   2) 先持久化「待处理任务」再异步领取：enqueuePending() 同步写 localStorage，
 *      resume() 只读队列逐条结算；页面关闭/断网/切后台后重开由 bootstrap() 恢复。
 *   3) 已授权设备用设备身份领取：优先 deviceToken -> /v1/racing/fragment/claim，
 *      没有设备令牌才退回家长会话 memberClaim；外婆手机不需要重新输入家长密码。
 *
 * 另新增 reconcileToday()：按服务端 pending_list 返回的当天真实记录对账补领，
 * 客户端只把「服务端确认存在且未领取」的 record_id 入队，绝不自行发奖。
 *
 * 幂等：SEEN_KEY + 服务端 source_record_id 唯一键 + 同日同学科检查；
 *       CLAIMED / ALREADY_CLAIMED 都视为完成并从队列移除，重复执行零写入。
 */
import { claimFragment, deviceToken, pendingList } from './fragment-client.mjs';
import { memberClaim } from './member-fragments.mjs';
import { showFragmentReward } from './fragment-reward.mjs';

export const QUEUE_KEY = 'v6-fragment-pending-v2';
export const SEEN_KEY = 'v6-fragment-claim-seen-v2';

/**
 * record_id 三种真实形态（全部由服务端派生，客户端只校验形状，不自造任务）：
 *   1) r5_child_complete_course 的真实返回：v6c-<device>-complete-<中文科目>-d<1..60>
 *      例：v6c-<device>-complete-语文-d9
 *   2) 隔离验收夹具的历史形态：v6c-<device>-complete-<科目码>-d<day>-<时间戳>
 *      例：v6c-fragweekly-complete-cn-d9-20261123112233445
 *   3) v6.0 旧记录：v6-<hex16>-course-<day>-<cn|ma|en|sc>
 * 科目、天数与设备都来自 growth_learning_records 的落库记录；领取资格仍由服务端判定。
 */
export const RECORD = /^(?:v6c-[A-Za-z0-9_-]{3,80}-complete-(?:语文|数学|英语|科学|cn|ma|en|sc)-d(?:[1-9]|[1-5][0-9]|60)(?:-[0-9]{6,20})?|v6-[a-f0-9]{16}-course-(?:[1-9]|[12][0-9]|30)-(?:cn|ma|en|sc))$/;

const take = (key) => {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(-160) : []; }
  catch { return []; }
};
const put = (key, values) => { try { localStorage.setItem(key, JSON.stringify(values.slice(-160))); } catch { /* 隐私模式 */ } };

let busy = false;
let bootstrapped = false;

/** 同步持久化一条待领取任务；返回是否新入队。不做任何网络请求。 */
export function enqueuePending(recordId) {
  const id = String(recordId || '');
  if (!RECORD.test(id)) return false;
  try {
    if (take(SEEN_KEY).includes(id)) return false;
    const q = take(QUEUE_KEY);
    if (q.includes(id)) return false; // 已在队列：幂等，不算新增
    q.push(id); put(QUEUE_KEY, q);
    return true;
  } catch { return false; }
}

/** 兼容旧调用名 */
export const enqueueVerifiedCourse = enqueuePending;

/**
 * 逐条结算待处理任务。设备身份优先；断网/失败保留队列，下次 bootstrap 或在线事件重试。
 */
export async function resumeRewardQueue() {
  if (busy || !navigator.onLine) return { status: 'OFFLINE_OR_BUSY' };
  const items = take(QUEUE_KEY).filter(x => !take(SEEN_KEY).includes(x));
  if (!items.length) return { status: 'EMPTY' };
  busy = true;
  try {
    const recordId = items[0];
    // 设备身份优先：claimFragment 内部先走 x-r5-device，无令牌才退回 memberClaim。
    const response = await claimFragment(recordId);
    const status = String(response && response.status || '');
    if (status === 'CLAIMED' || status === 'ALREADY_CLAIMED') {
      const seen = take(SEEN_KEY);
      if (!seen.includes(recordId)) { seen.push(recordId); put(SEEN_KEY, seen); }
      put(QUEUE_KEY, take(QUEUE_KEY).filter(x => x !== recordId));
      if (status === 'CLAIMED') {
        await showFragmentReward({ recordId, claimImpl: async () => response });
      }
      return { status, recordId };
    }
    // 服务端判定为无效/过期：移出队列，避免永久卡住；不下发奖励。
    if (['RECORD_NOT_FOUND', 'LEARNING_RECORD_NOT_FOUND', 'BAD_RECORD_ID',
         'NOT_TODAY', 'LEARNING_RECORD_NOT_TODAY', 'LEARNING_RECORD_SUBJECT_INVALID',
         'LEARNING_RECORD_NOT_REWARDABLE', 'LEARNING_RECORD_NO_DAY',
         'FORBIDDEN_SCOPE', 'DENIED'].includes(status)) {
      put(QUEUE_KEY, take(QUEUE_KEY).filter(x => x !== recordId));
      return { status: 'EXPIRED_OR_INVALID', raw: status };
    }
    return { status: status || 'NOT_CONFIRMED' };
  } catch (e) {
    return { status: 'RETRY_LATER', error: String((e && e.code) || (e && e.message) || 'SERVER') };
  } finally { busy = false; }
}

/**
 * 对账补领：服务端 pending_list 返回当天真实存在且未领取的 course-complete，
 * 客户端只把这些 record_id 入队，再走同一条结算链。重复执行零写入。
 */
export async function reconcileToday() {
  if (!navigator.onLine) return { status: 'OFFLINE' };
  try {
    const list = await pendingList();
    if (String(list && list.status || '') !== 'OK') return { status: 'LIST_FAILED', raw: list };
    const unclaimed = (list.records || []).filter(x => x && x.claimed === false && x.record_id);
    let added = 0;
    for (const x of unclaimed) if (enqueuePending(x.record_id)) added++;
    return { status: 'OK', added, unclaimed: unclaimed.length, weekly: list.weekly || null };
  } catch (e) {
    return { status: 'RETRY_LATER', error: String((e && e.code) || (e && e.message) || 'SERVER') };
  }
}

/**
 * 恢复入口：页面加载 / 回到前台 / 网络恢复时调用。
 * 用 bootstrapped 防重复注册；队列里的任务在断网时会保留，恢复在线后继续结算。
 */
export function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  const kick = () => { resumeRewardQueue().catch(() => {}); };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick, { once: true });
  } else kick();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }
}
