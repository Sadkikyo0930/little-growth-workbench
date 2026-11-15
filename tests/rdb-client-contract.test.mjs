/**
 * 家庭成员读取的传输层契约测试（2026-11-15 权限事故回归）
 *
 * 背景：家长页面用 `app.rdb()` 读 `growth_family_members`，该调用会被代理到
 * 本环境不存在的云函数 `httpOverCallFunction`，并且不携带家长身份，网关按匿名
 * 角色执行后返回 `permission denied for table growth_family_members`。
 *
 * 这里锁住修复后的四项保证：
 *   1. 每个请求都显式带 `Authorization: Bearer <家长 access token>`；
 *   2. 拿不到身份时明确失败，绝不退回匿名请求；
 *   3. 服务端 42501 被翻译成「身份没送到」，而不是被当成「不是这家人」；
 *   4. 页面里不再出现 `app.rdb()` 这条死链路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODULE = path.join(ROOT, 'v6', 'r5', 'rdb-client.mjs');

const mod = await import('file://' + MODULE.replace(/\\/g, '/'));

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(String(url), init || {});
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function authWithToken(token) {
  return {
    getAccessToken: async () => ({ accessToken: token }),
    getSession: async () => ({ data: { session: { access_token: token, user: { id: 'u1' } } } }),
  };
}

test('exports the client surface', () => {
  assert.equal(typeof mod.makeRdb, 'function');
  assert.equal(typeof mod.readAccessToken, 'function');
  assert.equal(typeof mod.RdbError, 'function');
  assert.match(mod.RDB_BASE, /^https:\/\/normal-goose-d5g4qyzr8bb389a4a\.api\.tcloudbasegateway\.com\/v1\/rdb\/rest$/);
});

test('a request always carries the family access token', async () => {
  const stub = stubFetch(() => jsonResponse(200, [{ family_id: 'f', user_id: 'u1', member_role: 'owner' }]));
  try {
    const db = mod.makeRdb(authWithToken('tok-123'));
    const res = await db.from('growth_family_members')
      .select('family_id,user_id,member_role')
      .eq('family_id', 'little-growth-family-001')
      .eq('user_id', 'u1');

    assert.equal(res.error, null);
    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.equal(init.headers.authorization, 'Bearer tok-123');
    assert.match(url, /\/growth_family_members\?/);
    assert.match(url, /select=family_id%2Cuser_id%2Cmember_role/);
    assert.match(url, /family_id=eq\.little-growth-family-001/);
    assert.match(url, /user_id=eq\.u1/);
    assert.equal(init.method, 'GET');
  } finally {
    stub.restore();
  }
});

test('no session means no request at all (never falls back to anon)', async () => {
  const stub = stubFetch(() => jsonResponse(200, []));
  try {
    const db = mod.makeRdb({
      getAccessToken: async () => { throw new Error('no token'); },
      getSession: async () => ({ data: { session: null } }),
    });
    const res = await db.from('growth_family_members').select('family_id');
    assert.equal(res.data, null);
    assert.equal(res.error.code, 'NO_SESSION');
    assert.equal(stub.calls.length, 0, 'must not send an anonymous request');
  } finally {
    stub.restore();
  }
});

test('the session token is used when getAccessToken is unavailable', async () => {
  const stub = stubFetch(() => jsonResponse(200, []));
  try {
    const db = mod.makeRdb({
      getAccessToken: async () => ({}),
      getSession: async () => ({ data: { session: { access_token: 'from-session' } } }),
    });
    const res = await db.from('growth_family_members').select('family_id');
    assert.equal(res.error, null);
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer from-session');
  } finally {
    stub.restore();
  }
});

test('42501 is reported as a missing identity, not as a non-member', async () => {
  const stub = stubFetch(() => jsonResponse(42501, {
    code: '42501',
    message: 'permission denied for table growth_family_members',
  }));
  try {
    const db = mod.makeRdb(authWithToken('tok'));
    const res = await db.from('growth_family_members').select('family_id');
    assert.equal(res.error.code, 'PERMISSION_DENIED_NO_IDENTITY');
    assert.match(res.error.message, /没有收到已登录的家长身份/);
    assert.equal(res.status, 42501);
  } finally {
    stub.restore();
  }
});

test('a real RLS miss is an empty result, not an error', async () => {
  const stub = stubFetch(() => jsonResponse(200, []));
  try {
    const db = mod.makeRdb(authWithToken('tok'));
    const res = await db.from('growth_family_members').select('family_id');
    assert.deepEqual(res.data, []);
    assert.equal(res.error, null);
  } finally {
    stub.restore();
  }
});

test('insert posts a json body and asks for the stored rows back', async () => {
  const stub = stubFetch(() => jsonResponse(201, [{ record_id: 'r1' }]));
  try {
    const db = mod.makeRdb(authWithToken('tok'));
    const res = await db.from('growth_learning_records').insert({ record_id: 'r1', family_id: 'f' });
    assert.equal(res.error, null);
    const { init } = stub.calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.headers.prefer, 'return=representation');
    assert.deepEqual(JSON.parse(init.body), [{ record_id: 'r1', family_id: 'f' }]);
  } finally {
    stub.restore();
  }
});

test('a network failure is surfaced, not swallowed', async () => {
  const stub = stubFetch(() => { throw new Error('offline'); });
  try {
    const db = mod.makeRdb(authWithToken('tok'));
    const res = await db.from('growth_family_members').select('family_id');
    assert.equal(res.error.code, 'NETWORK');
  } finally {
    stub.restore();
  }
});

test('the pages no longer use the app.rdb() transport', async () => {
  const files = [
    'v6/family-auto-sync.js',
    'v6/family-sync.html',
    'v6/family-dashboard.html',
    'v6/family-login-test.html',
  ];
  for (const rel of files) {
    const src = await readFile(path.join(ROOT, rel), 'utf8');
    assert.ok(!/db\s*=\s*app\.rdb\(\)/.test(src), rel + ' still binds db to app.rdb()');
    assert.match(src, /rdb-client\.mjs/, rel + ' must load the authenticated RDB client');
  }
});

test('the service worker ships the new module', async () => {
  const sw = await readFile(path.join(ROOT, 'v6', 'sw.js'), 'utf8');
  assert.match(sw, /rdb-client\.mjs/);
  assert.match(sw, /20261115-rdb-identity-v1/);
});
