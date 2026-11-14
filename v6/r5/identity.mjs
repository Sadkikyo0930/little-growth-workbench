/**
 * v6/r5/identity.mjs — 「家长登录身份 → 家庭成员资格 → 家庭碎片」的唯一入口
 *
 * 这一层要解决的问题：碎片接口原来只认 `r5dev_` 设备令牌（赛车游戏里发的），
 * 孩子从 V6 首页点「我的车库」时没有这个令牌，于是永远显示「还没有连接家庭」。
 *
 * 现在的链路（不新增账号、不手工配置任何东西）：
 *
 *   1. 复用 V6 已有的 CloudBase 家长登录会话（family-sync.html 用同一套 auth）；
 *   2. 用**服务端已经生效的 RLS** 读 `growth_family_members`：
 *        策略 growth_members_self_select：user_id = auth.jwt()->>'sub'
 *      也就是说，「能读到哪一行」由数据库决定，不由前端决定；
 *   3. family_id 只从这一行取，**绝不**接受 URL / localStorage / 调用方传入；
 *   4. 之后所有碎片读写都把 family_id 固定成这个值。
 *
 * 这一层不写任何数据：不建成员、不改角色、不发碎片。
 */

export const ENV_ID = 'normal-goose-d5g4qyzr8bb389a4a';
export const REGION = 'ap-shanghai';
/** PostgREST 网关：带用户 JWT 的 REST / RPC 入口（与 r5-bridge.js 用的是同一个） */
export const RDB_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;

const SDK_URLS = [
  'https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js',
  'https://static.cloudbase.net/cloudbase-js-sdk/3.0.1/cloudbase.full.js',
  'https://imgcache.qq.com/qcloud/cloudbase-js-sdk/latest/cloudbase.full.js',
];

/** 与 family-sync.html 的准入角色保持一致：只读碎片也只要这三类家庭角色 */
export const MEMBER_ROLES = ['owner', 'parent', 'grandparent'];

/** 家庭 ID 形状校验：只用来挡住脏数据/注入，不用来「猜」家庭 */
const FAMILY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class IdentityError extends Error {
  constructor(code, detail) {
    super(code || 'IDENTITY_ERROR');
    this.name = 'IdentityError';
    this.code = code || 'IDENTITY_ERROR';
    this.detail = detail || null;
  }
}

/**
 * 家庭 ID 只能来自服务端返回的成员行。
 * 任何来自 URL / localStorage 的值都会被这个断言挡下 —— 这是「不能指定别人的家庭」的落点。
 */
export function assertServerFamily(family, source) {
  if (typeof family !== 'string' || !FAMILY_RE.test(family)) {
    throw new IdentityError('BAD_FAMILY', source || 'unknown');
  }
  return family;
}

/* --------------------------------------------------------------- SDK 装载 */

let appPromise = null;

function sdkReady() {
  return typeof window !== 'undefined' && window.cloudbase
    && typeof window.cloudbase.init === 'function';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('SDK_LOAD_FAILED'));
    document.head.appendChild(s);
  });
}

async function loadSdk(i = 0) {
  if (sdkReady()) return;
  if (typeof document === 'undefined') throw new IdentityError('NO_SDK', 'no-document');
  if (i >= SDK_URLS.length) throw new IdentityError('NO_SDK', 'all-cdn-failed');
  try {
    await loadScript(SDK_URLS[i]);
  } catch {
    return loadSdk(i + 1);
  }
  if (!sdkReady()) return loadSdk(i + 1);
}

async function cloudbaseApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    await loadSdk(0);
    const app = window.cloudbase.init({ env: ENV_ID, region: REGION });
    if (!app || !app.auth) throw new IdentityError('NO_SDK', 'no-auth');
    return app;
  })();
  try {
    return await appPromise;
  } catch (e) {
    appPromise = null;
    throw e;
  }
}

/* ----------------------------------------------------------- 会话与成员资格 */

async function readSession(auth) {
  if (typeof auth.getSession !== 'function') throw new IdentityError('NO_SDK', 'no-getSession');
  let res;
  try {
    res = await auth.getSession();
  } catch {
    throw new IdentityError('NO_SESSION', 'getSession-threw');
  }
  if (res && res.error) throw new IdentityError('NO_SESSION', 'getSession-error');
  const session = res && res.data && res.data.session;
  if (!session || !session.user || !session.user.id) throw new IdentityError('NO_SESSION', 'empty-session');

  let token = '';
  try {
    const tok = await auth.getAccessToken();
    token = (tok && (tok.accessToken || tok.access_token))
      || (tok && tok.data && (tok.data.accessToken || tok.data.access_token))
      || session.access_token || '';
  } catch {
    token = session.access_token || '';
  }
  if (!token) throw new IdentityError('NO_SESSION', 'no-access-token');
  return { uid: String(session.user.id), token };
}

/**
 * 读当前登录账号自己的成员行。
 * 显式带 user_id=eq.<uid> 只是让 SQL 更清楚；即使去掉，RLS 也只会返回自己那一行。
 */
async function fetchMembership(uid, token) {
  const url = `${RDB_BASE}/growth_family_members`
    + `?select=family_id,user_id,member_role`
    + `&user_id=eq.${encodeURIComponent(uid)}&limit=2`;
  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch {
    throw new IdentityError('NETWORK', 'membership-fetch');
  }
  if (res.status === 401 || res.status === 403) throw new IdentityError('NO_SESSION', 'membership-' + res.status);
  if (!res.ok) throw new IdentityError('SERVER', 'membership-' + res.status);
  let rows = null;
  try { rows = await res.json(); } catch { throw new IdentityError('SERVER', 'membership-json'); }
  return Array.isArray(rows) ? rows : [];
}

/**
 * 当前家长身份。
 * @returns {{uid:string, token:string, family_id:string, role:string, source:'growth_family_members'}}
 * 失败时抛 IdentityError：
 *   NO_SDK / NO_SESSION（没登录）/ NO_MEMBER（登录了但不是这个家庭的成员）/ BAD_FAMILY / NETWORK / SERVER
 */
export async function currentMember() {
  const app = await cloudbaseApp();
  const { uid, token } = await readSession(app.auth);
  const rows = await fetchMembership(uid, token);

  if (rows.length === 0) throw new IdentityError('NO_MEMBER', 'not-in-any-family');
  if (rows.length > 1) throw new IdentityError('NO_MEMBER', 'multiple-families');
  const row = rows[0] || {};
  if (String(row.user_id || '') !== uid) throw new IdentityError('NO_MEMBER', 'uid-mismatch');
  const role = String(row.member_role || '');
  if (!MEMBER_ROLES.includes(role)) throw new IdentityError('NO_MEMBER', 'role-' + role);

  return {
    uid,
    token,
    role,
    family_id: assertServerFamily(String(row.family_id || ''), 'growth_family_members'),
    source: 'growth_family_members',
  };
}

/** 会话是否已建立（不查成员表，用于首屏决定显示「登录」还是「读取中」） */
export async function hasSession() {
  try {
    const app = await cloudbaseApp();
    await readSession(app.auth);
    return true;
  } catch {
    return false;
  }
}

/** 只给「登录入口」用：告诉页面把家长送去哪一页登录 */
export function loginUrl(next) {
  const base = './family-sync.html';
  const n = String(next || '').trim();
  if (!n) return base;
  return `${base}?next=${encodeURIComponent(n)}`;
}
