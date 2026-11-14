/**
 * v6/r5/member-fragments.mjs — 家长身份模式下的碎片读取 / 组装
 *
 * 与 fragment-client.mjs（设备令牌模式）的关系：
 *   · 同一个数据库、同一批函数、同一套余额，**不是**第二套系统；
 *   · 差别只在「怎么证明你是谁」：
 *       设备模式：x-r5-device: r5dev_…  → 走 r5-gateway → r5-racing-save
 *       身份模式：Authorization: Bearer <家长会话> → 走 PostgREST RPC
 *   · 两条路的 family_id 都来自服务端（设备模式来自设备绑定，身份模式来自成员行），
 *     页面本身不提供「换一个家庭」的入口。
 *
 * 身份模式只做两件事：
 *   r5_fragment_snapshot(p_family)  只读，不发碎片
 *   r5_fragment_assemble(...)       组装，成本取目录、余额与拒绝规则由数据库判
 */
import { currentMember, IdentityError, RDB_BASE } from './identity.mjs';
import { FRAGMENT_PROGRAM, vehicleOf } from './catalog.mjs';

export class MemberError extends Error {
  constructor(code, detail) {
    super(code || 'MEMBER_ERROR');
    this.name = 'MemberError';
    this.code = code || 'MEMBER_ERROR';
    this.detail = detail || null;
  }
}

const TIMEOUT = 15000;

/** 与 fragment-client 的 FragmentError 保持同一套错误码语义，页面只认 code */
function wrap(e) {
  if (e instanceof MemberError) return e;
  if (e instanceof IdentityError) return new MemberError(e.code, e.detail);
  return new MemberError('SERVER', String((e && e.message) || e));
}

async function rpc(name, params, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(`${RDB_BASE}/rpc/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        prefer: 'return=representation',
      },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new MemberError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', name);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new MemberError('NO_SESSION', name + '-' + res.status);
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const code = (json && (json.message || json.code)) || ('HTTP_' + res.status);
    throw new MemberError('SERVER', String(code));
  }
  return json;
}

/** snapshot 的 jsonb → 页面现有渲染所需要的形状（与 loadState 的返回对齐） */
function normalize(snap, who, program) {
  const s = snap || {};
  const dailyCount = Number(s.daily_normal_count || 0);
  const cap = Number(program.daily_cap || 2);
  return {
    family_id: who.family_id,
    fragments: s.fragments || {},
    owned: s.owned || {},
    revision: Number(s.revision || 0),
    pity_points: Number(s.pity_points || 0),
    pity_total: Number(s.pity_total || 0),
    drops_total: Number(s.drops_total || 0),
    daily: {
      day: String(s.daily_day || ''),
      normal: dailyCount,
      rare: Number(s.daily_rare_count || 0),
      cap,
      remaining: Math.max(0, cap - dailyCount),
    },
    program,
    save: null,
    mode: 'member',
    member: { uid: who.uid, role: who.role, family_source: who.source },
    raw: s,
  };
}

/**
 * 以家长身份读取家庭碎片（只读）。
 * 抛 MemberError：NO_SESSION（未登录）/ NO_MEMBER（不是家庭成员）/ NO_SDK / NETWORK / SERVER
 */
export async function memberState() {
  try {
    const who = await currentMember();
    const snap = await rpc('r5_fragment_snapshot', { p_family: who.family_id }, who.token);
    /* 只读：这里拿到什么就是什么，不做任何「补齐 12 片」之类的本地兜底 */
    return normalize(snap, who, JSON.parse(JSON.stringify(FRAGMENT_PROGRAM)));
  } catch (e) {
    throw wrap(e);
  }
}

/**
 * 以家长身份组装。
 * 成本只从目录取（不取用户输入），family 只从成员行取；其余判断全在数据库函数里：
 * 余额不足 / 已拥有 / 生日车 / 金币车 / 遗留槽位 都会返回对应状态且 zero_write。
 */
export async function memberAssemble(vehicleId) {
  const v = vehicleOf(vehicleId);
  if (!v) throw new MemberError('NOT_IN_CATALOG', String(vehicleId || ''));
  try {
    const who = await currentMember();
    const out = await rpc('r5_fragment_assemble', {
      p_family: who.family_id,
      p_device: `v6:${who.uid}`,
      p_vehicle_id: v.vehicle_id,
      p_cost: v.cost,
    }, who.token);
    return out;
  } catch (e) {
    throw wrap(e);
  }
}

/** 身份模式的「这是谁」提示，只给页面显示用，不含令牌 */
export async function memberBadge() {
  try {
    const who = await currentMember();
    return { ok: true, uid: who.uid, role: who.role, family_id: who.family_id };
  } catch (e) {
    const err = wrap(e);
    return { ok: false, code: err.code };
  }
}
