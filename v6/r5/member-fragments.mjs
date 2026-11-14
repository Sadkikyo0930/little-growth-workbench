/**
 * v6/r5/member-fragments.mjs — 家长身份模式下的碎片读取 / 组装
 *
 * 与 fragment-client.mjs（设备令牌模式）的关系：
 *   · 同一个数据库、同一批表、同一套余额，**不是**第二套系统；
 *   · 差别只在「怎么证明你是谁」：
 *       设备模式：x-r5-device: r5dev_…  → 走 r5-gateway → r5-racing-save
 *       身份模式：Authorization: Bearer <家长会话> → 走 PostgREST RPC
 *
 * 身份模式**只调两个函数，而且都不接受 family 参数**：
 *   r5_fragment_member_snapshot()          只读；家庭由服务端从 JWT 反查成员表得出
 *   r5_fragment_member_assemble(vehicle)   组装；成本由服务端白名单决定
 *
 * 为什么不再调 r5_fragment_snapshot(p_family) / r5_fragment_assemble(p_family,…)：
 *   那两个旧函数带 p_family 且对 anon 可执行 —— 谁能直接调，谁就能指定别家。
 *   浏览器这条路上不允许再出现「由前端传 family」的调用（哪怕传的是自己家）。
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
  if (res.status === 404) throw new MemberError('NO_SDK', name + '-404'); // 函数还没 apply
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const code = (json && (json.message || json.code)) || ('HTTP_' + res.status);
    throw new MemberError('SERVER', String(code));
  }
  return json;
}

/** 服务端身份状态 → 页面错误码。服务端说「你是谁」才算数，前端不自己猜。 */
const STATUS_ERROR = {
  UNAUTHENTICATED: 'NO_SESSION',
  NOT_MEMBER: 'NO_MEMBER',
  AMBIGUOUS_MEMBER: 'NO_MEMBER',
};

/** snapshot 的 jsonb → 页面现有渲染所需要的形状（与 loadState 的返回对齐） */
function normalize(snap, who, program) {
  const s = snap || {};
  const dailyCount = Number(s.daily_normal_count || 0);
  const cap = Number(program.daily_cap || 2);
  return {
    /* family 以服务端函数返回值为准；本地成员行只用于显示兜底 */
    family_id: String(s.family_id || who.family_id || ''),
    family_source: String(s.family_source || who.source || ''),
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
    member: {
      uid: who.uid,
      role: String(s.member_role || who.role || ''),
      family_source: String(s.family_source || who.source || ''),
    },
    raw: s,
  };
}

/**
 * 以家长身份读取家庭碎片（只读）。
 * 抛 MemberError：NO_SESSION（未登录/会话过期）/ NO_MEMBER（不是家庭成员）/ NO_SDK（函数未上线）/ NETWORK / SERVER
 *
 * 目录来源：服务端 `r5_fragment_member_snapshot()` 现在会带回 `program`
 * （来自 public.r5_vehicle_recipe + public.r5_reward_config）。
 * 有就用服务端的，没有才退回本地 catalog.mjs —— 本地那份只是离线兜底，不再是事实来源。
 */
export async function memberState() {
  try {
    const who = await currentMember();
    /* 关键：不带任何 family 参数。家庭由数据库函数从 JWT 反查。 */
    const snap = await rpc('r5_fragment_member_snapshot', {}, who.token);
    const st = String((snap && snap.status) || '');
    if (STATUS_ERROR[st]) throw new MemberError(STATUS_ERROR[st], st);
    if (st !== 'OK' || !snap || String(snap.family_id || '') !== who.family_id ||
        !snap.fragments || typeof snap.fragments !== 'object' || Array.isArray(snap.fragments) ||
        !snap.owned || typeof snap.owned !== 'object' || Array.isArray(snap.owned))
      throw new MemberError('SERVER', st || 'INVALID_MEMBER_SNAPSHOT');
    const program = (snap && snap.program) || JSON.parse(JSON.stringify(FRAGMENT_PROGRAM));
    return normalize(snap, who, program);
  } catch (e) {
    throw wrap(e);
  }
}

/**
 * 以家长身份组装。
 * 只传车辆 ID：family 由服务端反查，成本由服务端白名单决定 —— 客户端连价格都传不进去。
 * 其余判断全在数据库函数里：余额不足 / 已拥有 / 生日车 / 金币车 / 遗留槽位 都会返回对应状态且 zero_write。
 */
export async function memberAssemble(vehicleId) {
  const v = vehicleOf(vehicleId);
  if (!v) throw new MemberError('NOT_IN_CATALOG', String(vehicleId || ''));
  try {
    const who = await currentMember();
    const out = await rpc('r5_fragment_member_assemble', { p_vehicle_id: v.vehicle_id }, who.token);
    const st = String((out && out.status) || '');
    if (STATUS_ERROR[st]) throw new MemberError(STATUS_ERROR[st], st);
    if (!['ASSEMBLED','INSUFFICIENT_FRAGMENTS','ALREADY_OWNED','ALREADY_ASSEMBLED',
          'COIN_VEHICLE_FORBIDDEN','BIRTHDAY_VEHICLE_FORBIDDEN','LEGACY_SLOT_RETIRED',
          'VEHICLE_NOT_ASSEMBLABLE','UNKNOWN_VEHICLE','BAD_VEHICLE_ID'].includes(st))
      throw new MemberError('SERVER', st || 'INVALID_ASSEMBLE_RESULT');
    return out;
  } catch (e) {
    throw wrap(e);
  }
}

/** 只发 recordId；云端从 JWT 反查唯一家庭后复用现有领取逻辑。 */
export async function memberClaim(recordId) {
  const id=String(recordId||'');
  if(!id || id.length>160) throw new MemberError('BAD_RECORD_ID');
  try {
    const who=await currentMember();
    const out=await rpc('r5_fragment_member_claim',{p_record_id:id},who.token);
    if(!out || typeof out!=='object') throw new MemberError('SERVER','INVALID_CLAIM_RESPONSE');
    if(STATUS_ERROR[out.status]) throw new MemberError(STATUS_ERROR[out.status],String(out.status));
    return out;
  }catch(e){throw wrap(e);}
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
