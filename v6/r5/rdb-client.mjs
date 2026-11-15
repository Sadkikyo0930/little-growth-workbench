/**
 * v6/r5/rdb-client.mjs — 家长页面的 RDB 访问客户端（明示携带家长 JWT）
 *
 * 为什么需要这一层：`app.rdb()` 不是浏览器直连 PostgREST。
 * 它把每个请求代理给云函数 `httpOverCallFunction`，由那个函数替客户端发 HTTP。
 * 本环境（normal-goose-d5g4qyzr8bb389a4a）没有这个云函数，
 * 所以 `db.from(...).select(...)` 只会得到 `FetchError`；
 * 即使有，代理发出的请求也不带家长的身份，网关只能按匿名角色执行。
 *
 * 而 `anon` 对 `growth_family_members` 没有任何权限（这是对的，不能放开），
 * 于是读取失败并被报成：
 *     permission denied for table growth_family_members
 *
 * 正确做法是像 `r5-bridge.js` / `r5/identity.mjs` 那样：
 * 用 `auth.getAccessToken()` 拿到家长本人的 access token，
 * 显式放进 `Authorization: Bearer ...` 直接请求 RDB REST 网关。
 * 网关据此把请求执行成 `authenticated` 角色，
 * 再由服务端 RLS（`growth_members_self_select` 等）决定这一行能不能读。
 *
 * 本模块只做传输，不做鉴权判断，也不做任何降级：
 * 拿不到身份就明确失败，绝不退回匿名请求。
 */

export const ENV_ID = 'normal-goose-d5g4qyzr8bb389a4a';
export const RDB_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;

/** 给页面直接展示的中文说明：这不是「孩子没达标」，而是身份没有送到服务端。 */
export const PERMISSION_HINT =
  '云端没有收到已登录的家长身份，这次读取被当成匿名访问拒掉了。请先在「家长登录云端」重新登录，'
  + '再刷新本页；本机学习记录不会因此丢失，也不会被覆盖。';

export class RdbError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'RdbError';
    this.code = code;
    this.detail = detail || null;
  }
}

function pickToken(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.accessToken
    || value.access_token
    || (value.data && (value.data.accessToken || value.data.access_token))
    || '';
}

/**
 * 取当前家长会话的 access token。
 * 先问 `auth.getAccessToken()`（会顺手续期），失败再退回会话里的静态 token。
 * 两者都没有就抛 NO_SESSION —— 调用方必须把它当成「需要重新登录」，不能当匿名继续。
 */
export async function readAccessToken(auth) {
  if (!auth) throw new RdbError('NO_SDK', '云端组件尚未初始化');
  let token = '';
  try {
    token = pickToken(await auth.getAccessToken());
  } catch {
    token = '';
  }
  if (!token) {
    try {
      const res = await auth.getSession();
      const session = res && res.data && res.data.session;
      token = pickToken(session && session.access_token);
    } catch {
      token = '';
    }
  }
  if (!token) throw new RdbError('NO_SESSION', '当前浏览器没有有效的家长登录凭证');
  return token;
}

function errorFromResponse(status, body) {
  const raw = body && typeof body === 'object' ? body : {};
  const message = String(raw.message || raw.error_description || raw.code || '');
  const code = String(raw.code || '');
  // 42501 / permission denied 只在服务端没认出身份时出现（匿名角色）。
  // 真正的「不是这家人」走的是 RLS：返回 0 行，不会报错。
  if (/permission denied/i.test(message) || code === '42501') {
    return new RdbError('PERMISSION_DENIED_NO_IDENTITY', PERMISSION_HINT, message);
  }
  if (status === 401) return new RdbError('NO_SESSION', '家长登录凭证已失效，请重新登录', message);
  if (status === 403) return new RdbError('FORBIDDEN', '当前账号无权执行这次云端操作', message);
  if (status === 404) return new RdbError('NOT_FOUND', '云端接口不存在（可能尚未部署）', message);
  return new RdbError(code || ('HTTP_' + status), message || ('HTTP ' + status), message);
}

function encodeValue(value) {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

class Query {
  constructor(table, auth) {
    this.table = table;
    this.auth = auth;
    this.columns = null;
    this.filters = [];
    this.orderBy = null;
    this.limitCount = null;
    this.method = 'GET';
    this.payload = null;
  }

  select(columns) {
    this.columns = columns || '*';
    return this;
  }

  eq(column, value) {
    this.filters.push([column, 'eq.' + encodeValue(value)]);
    return this;
  }

  order(column, options) {
    const ascending = !options || options.ascending !== false;
    this.orderBy = column + (ascending ? '.asc' : '.desc');
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  insert(row) {
    this.method = 'POST';
    this.payload = Array.isArray(row) ? row : [row];
    return this;
  }

  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.run().catch(onRejected);
  }

  async run() {
    let token;
    try {
      token = await readAccessToken(this.auth);
    } catch (e) {
      return { data: null, error: e, status: 0 };
    }

    const url = new URL(`${RDB_BASE}/${this.table}`);
    if (this.columns) url.searchParams.set('select', this.columns);
    for (const [column, expression] of this.filters) url.searchParams.append(column, expression);
    if (this.orderBy) url.searchParams.set('order', this.orderBy);
    if (this.limitCount) url.searchParams.set('limit', String(this.limitCount));

    const init = {
      method: this.method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    };
    if (this.payload) {
      init.headers['content-type'] = 'application/json';
      init.headers.prefer = 'return=representation';
      init.body = JSON.stringify(this.payload);
    }

    let response;
    try {
      response = await fetch(url.toString(), init);
    } catch (e) {
      return { data: null, error: new RdbError('NETWORK', '无法连接云端：' + String(e && e.message || e)), status: 0 };
    }

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      return { data: null, error: errorFromResponse(response.status, body), status: response.status };
    }
    return { data: body, error: null, status: response.status };
  }
}

/**
 * 与 `app.rdb()` 同样的调用形状：`makeRdb(auth).from('表名').select(...).eq(...)`
 * 页面里只需要把 `db = app.rdb()` 换成 `db = makeRdb(app.auth)`。
 */
export function makeRdb(auth) {
  return {
    from(table) {
      return new Query(table, auth);
    },
  };
}
