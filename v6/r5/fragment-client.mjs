/**
 * v6/r5/fragment-client.mjs — 学习碎片 / 赛车组装 浏览器端 SDK（零依赖）
 *
 * 唯一真相在服务端（r5-racing-save 云函数，经 r5-gateway 暴露）：
 *   POST /v1/racing/save/get             → 碎片余额 + 保底 + 每日额度 + 已拥有车辆 + 车辆目录
 *   POST /v1/racing/fragment/claim       → 学习记录结算（每日上限 / 保底 / 幂等）
 *   POST /v1/racing/fragment/assemble    → 原子扣片 + 永久授予车辆
 *
 * 前端绝不自己算碎片、绝不自己发奖、绝不在网络失败时显示成功，
 * 也不保留任何本地碎片余额副本（不新造第二套存档）。
 */
import { R5_CONFIG } from './config.mjs';
import {normalizeClaimResponse,validateFragmentSnapshot} from './fragment-contract.mjs';

const BASE = String(R5_CONFIG.base || '').replace(/\/$/, '');
const FAMILY = R5_CONFIG.familyId;
const TIMEOUT = R5_CONFIG.timeoutMs || 15000;

export class FragmentError extends Error {
  constructor(code, detail) {
    super(code || 'FRAGMENT_ERROR');
    this.code = code || 'FRAGMENT_ERROR';
    this.detail = detail || null;
  }
}

const MESSAGES = {
  NETWORK: '网络连不上，先看看 WiFi 哦',
  TIMEOUT: '等太久啦，再试一次吧',
  DEVICE: '请用爸爸妈妈给你的链接打开',
  SERVER: '云端忙了一下，再试一次吧',
  INSUFFICIENT: '碎片还不够，再去学习攒一攒',
  NO_RECORD: '找不到这条学习记录',
  NOT_TODAY: '这是以前的学习记录，今天的不算哦',
  CAPPED: '今天的碎片已经拿满 2 片啦',
  FORBIDDEN: '这辆车不能这样获得',
  COIN: '这辆车要用金币购买，不能靠碎片组装',
};

export function messageOf(code) {
  return MESSAGES[code] || MESSAGES.SERVER;
}

export function deviceToken() {
  try {
    const fromQuery = new URLSearchParams(location.search).get('d');
    if (fromQuery) return fromQuery;
    return localStorage.getItem('r5_device') || '';
  } catch {
    return '';
  }
}

async function post(path, body) {
  const device = deviceToken();
  if (!device) throw new FragmentError('DEVICE');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-r5-device': device },
      body: JSON.stringify(Object.assign({ family_id: FAMILY }, body || {})),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new FragmentError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new FragmentError('DEVICE');
  let text = '';
  try { text = await res.text(); } catch { throw new FragmentError('NETWORK'); }
  let json = null;
  try { json = JSON.parse(text); } catch { throw new FragmentError('SERVER'); }
  if (json && json.error) throw new FragmentError('SERVER', json.error);
  if (json && json.status === 'DENIED') throw new FragmentError('SERVER', json.error);
  return json;
}

/** 读取碎片与车辆状态（真实云端，不含任何本地缓存兜底） */
export async function loadState() {
  const j = validateFragmentSnapshot(await post('/v1/racing/save/get', {}));
  const f = j.fragment;
  return {
    fragments: f.fragments || {},
    owned: f.owned || (j.save && j.save.owned) || {},
    revision: Number(f.revision || (j.save && j.save.revision) || 0),
    pity_points: Number(f.pity_points || 0),
    pity_total: Number(f.pity_total || 0),
    drops_total: Number(f.drops_total || 0),
    daily: f.daily || { day: '', normal: 0, rare: 0, cap: 2, remaining: 2 },
    program: j.fragment_program || null,
    save: j.save || null,
    raw: j,
  };
}

/** 用一条真实学习记录结算碎片；服务端可能返回 CLAIMED / ALREADY_CLAIMED / 封顶 */
export async function claimFragment(recordId) {
  try {
    return normalizeClaimResponse(await post('/v1/racing/fragment/claim', { learning_record_id: String(recordId || '') }));
  } catch (e) {
    if (e && (e.message === 'BAD_CLAIM_RESPONSE' || e.message === 'BAD_CLAIM_COUNTS')) throw new FragmentError('SERVER', e.message);
    throw e;
  }
}

/** 组装：服务端原子扣片并永久授予；返回 ASSEMBLED / INSUFFICIENT_FRAGMENTS / ALREADY_OWNED ... */
export async function assembleVehicle(vehicleId) {
  return post('/v1/racing/fragment/assemble', { vehicle_id: String(vehicleId || '') });
}

/** 把碎片 + 车辆目录算成界面要用的进度结构（只读展示，不改写任何余额） */
export function buildProgress(state) {
  const program = state.program || { vehicles: [] };
  const frags = state.fragments || {};
  const owned = state.owned || {};
  return (program.vehicles || []).map(v => {
    const rows = Object.keys(v.cost || {}).map(k => ({
      fragment_id: k,
      name: k === program.common_fragment_id ? program.common_fragment_name : (program.rare_fragment_name || k),
      need: Number(v.cost[k]),
      have: Number(frags[k] || 0),
    }));
    const ready = rows.every(r => r.have >= r.need) && !owned[v.vehicle_id];
    const primary = rows.reduce((a, b) => (b.need >= (a ? a.need : -1) ? b : a), null) || { have: 0, need: 1 };
    return {
      vehicle_id: v.vehicle_id,
      name: v.name,
      tier: v.tier,
      drivable: v.drivable !== false,
      note: v.note || '',
      placeholder: !!v.placeholder,
      display_name_pending: !!v.display_name_pending,
      art: v.art || null,
      owned: !!owned[v.vehicle_id],
      rows,
      ready,
      ratio: Math.max(0, Math.min(1, primary.need ? primary.have / primary.need : 0)),
      missing: rows.reduce((s, r) => s + Math.max(0, r.need - r.have), 0),
    };
  });
}

/**
 * 已组装车辆列表：只包含「碎片目录内的车」+「v1 遗留槽位」。
 * 金币购买 / 剧情解锁的车不在这个列表里（它们由赛车游戏车库负责展示）。
 */
export function assembledList(state) {
  const program = state.program || {};
  const owned = state.owned || {};
  const legacy = new Set(program.legacy_slots || []);
  const out = [];
  for (const v of program.vehicles || []) {
    if (owned[v.vehicle_id]) {
      out.push({ vehicle_id: v.vehicle_id, name: v.name, tier: v.tier, via: '碎片组装', info: owned[v.vehicle_id] });
    }
  }
  for (const id of legacy) {
    if (owned[id]) out.push({ vehicle_id: id, name: '学习奖励车（v1 遗留）', tier: 'rare', via: 'v1 槽位已冻结', info: owned[id] });
  }
  return out;
}
