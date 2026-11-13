/* C0.1 Service Worker suite — runs the candidate v6/sw.js and v6-selftest/sw.js in a
 * mocked Service Worker environment (no network, no browser, no storage writes).
 *
 * 30 checks: static cache policy + install/activate lifecycle + online/offline
 * schedule behaviour + old-device upgrade + scope isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSuite, writeJson } from '../lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CAND = path.join(ROOT, 'candidate');
const EVID = path.join(ROOT, 'evidence');

const BASE_ORIGIN = 'https://example.com';
const SCOPE = BASE_ORIGIN + '/v6/';
const SELFTEST_SCOPE = BASE_ORIGIN + '/v6-selftest/';

const VERSION = '20261114-c01-authoritative-day';
const SELFTEST_VERSION = '20261114-c01-authoritative-day-selftest';
const FORMAL_PREFIX = 'little-growth-v6-pwa-';
const SELFTEST_PREFIX = 'little-growth-v6-selftest-pwa-';

const suite = createSuite('sw-cache');

function keyOf(req) {
  let u;
  if (req instanceof URL) u = req.href;
  else if (req && req.url) u = req.url;
  else u = String(req);
  try { const x = new URL(u, SCOPE); return x.origin + x.pathname; } catch { return u; }
}

class MockCache {
  constructor(name) { this.name = name; this.map = new Map(); }
  async put(req, res) { this.map.set(keyOf(req), res); }
  async match(req) { return this.map.get(keyOf(req)) || null; }
  async delete(req) { return this.map.delete(keyOf(req)); }
  async keys() { return [...this.map.keys()].map((k) => ({ url: k })); }
}

function makeHarness(src, { scope = SCOPE, offline = false, seedCaches = {} } = {}) {
  const listeners = {};
  const flags = { skipWaiting: false, claimed: false };
  const calls = { fetch: [], cacheMatch: [], cacheDelete: [], cacheOpen: [] };
  const cacheMap = new Map(Object.entries(seedCaches));
  const caches = {
    open: async (name) => {
      calls.cacheOpen.push(name);
      if (!cacheMap.has(name)) cacheMap.set(name, new MockCache(name));
      return cacheMap.get(name);
    },
    keys: async () => [...cacheMap.keys()],
    delete: async (name) => { calls.cacheDelete.push(name); return cacheMap.delete(name); },
    match: async (req) => {
      calls.cacheMatch.push(keyOf(req));
      for (const c of cacheMap.values()) {
        const r = await c.match(req);
        if (r) return r;
      }
      return null;
    },
  };
  const fetchImpl = async (req, opts) => {
    calls.fetch.push({ url: keyOf(req), opts: opts || {} });
    if (offline) throw new Error('offline');
    return new Response('window.V6_NOV_SCHEDULE={"version":"2026-11-14"};',
      { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  };
  const self = {
    registration: { scope },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { flags.skipWaiting = true; },
    clients: { claim: async () => { flags.claimed = true; } },
  };
  const ctx = vm.createContext({
    self, caches, fetch: fetchImpl, URL, Headers, Response, Request,
    Promise, console, Array, Object, String, Number, Boolean, JSON, Math,
    setTimeout, clearTimeout,
  });
  vm.runInContext(src, ctx, { filename: 'sw.js' });

  async function fire(type, req) {
    const pending = [];
    const evt = {
      request: req,
      waitUntil: (p) => pending.push(Promise.resolve(p)),
      respondWith: (p) => pending.push(Promise.resolve(p)),
    };
    if (!listeners[type]) throw new Error('no listener for ' + type);
    listeners[type](evt);
    let response = null;
    let guard = 0;
    while (pending.length && guard++ < 20) {
      const batch = pending.splice(0);
      for (const v of await Promise.all(batch)) {
        if (v && typeof v.ok === 'boolean' && typeof v.headers?.get === 'function') response = v;
      }
    }
    return response;
  }
  function request(url, mode = 'no-cors') {
    return { url: new URL(url, SCOPE).href, method: 'GET', mode, clone() { return this; } };
  }
  return { fire, request, flags, calls, caches, cacheMap, ctx };
}

const formalSrc = fs.readFileSync(path.join(CAND, 'v6/sw.js'), 'utf8');
const selftestSrc = fs.readFileSync(path.join(CAND, 'v6-selftest/sw.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(CAND, 'v6/r5-bridge.js'), 'utf8');

/* ---- S1 cache policy (static) ------------------------------------------- */
suite.check('S1.1', 'VERSION leaves 20261109-clean-home-daily1 behind',
  formalSrc.includes(`VERSION='${VERSION}'`) && !formalSrc.includes("VERSION='20261109-clean-home-daily1'"));

suite.check('S1.2', 'november-subject-schedule.js is inside CORE_FILES',
  /CORE_FILES=\[[\s\S]*?november-subject-schedule\.js[\s\S]*?\]/.test(formalSrc));

suite.check('S1.3', 'core prefetch uses cache:reload (never the HTTP cache)',
  /CORE_FILES\.map\([\s\S]{0,200}fetch\(url,\{cache:'reload'\}\)/.test(formalSrc));

suite.check('S1.4', 'schedule is network-first with cache:no-store',
  /SCHEDULE_FILES[\s\S]{0,200}networkFirstNoStore/.test(formalSrc)
  && /fetch\(req,\{cache:'no-store'\}\)/.test(formalSrc));

suite.check('S1.5', 'SW never touches localStorage / indexedDB',
  !/localStorage\s*(\.|\[|=)/.test(formalSrc) && !/indexedDB\s*(\.|\[|=)/.test(formalSrc));

suite.check('S1.6', 'bridge script keeps network-first + explicit stale marker',
  formalSrc.includes("'./r5-bridge.js'") && formalSrc.includes('X-R5-Bridge-Stale'));

suite.check('S1.7', 'offline schedule fallback carries X-R5-Schedule-Stale',
  formalSrc.includes('X-R5-Schedule-Stale'));

/* ---- S2 install / activate ---------------------------------------------- */
{
  const h = makeHarness(formalSrc);
  await h.fire('install');
  suite.check('S2.1', 'install opens the new CORE cache',
    h.calls.cacheOpen.some((n) => n === FORMAL_PREFIX + 'core-' + VERSION),
    h.calls.cacheOpen.join(','));
  suite.check('S2.2', 'install prefetches the schedule with cache:reload',
    h.calls.fetch.some((c) => c.url.endsWith('/november-subject-schedule.js') && c.opts.cache === 'reload'));
  suite.check('S2.3', 'install calls skipWaiting', h.flags.skipWaiting === true);

  const old = [
    FORMAL_PREFIX + 'core-20261109-clean-home-daily1',
    FORMAL_PREFIX + 'runtime-20261109-clean-home-daily1',
  ];
  const current = [FORMAL_PREFIX + 'core-' + VERSION, FORMAL_PREFIX + 'runtime-' + VERSION];
  const selftestCache = SELFTEST_PREFIX + 'core-' + SELFTEST_VERSION;
  const seeds = Object.fromEntries([...old, ...current, selftestCache].map((n) => [n, new MockCache(n)]));
  const h2 = makeHarness(formalSrc, { seedCaches: seeds });
  await h2.fire('activate');
  suite.check('S2.4', 'activate deletes the previous core/runtime caches',
    old.every((n) => h2.calls.cacheDelete.includes(n)), h2.calls.cacheDelete.join(','));
  suite.check('S2.5', 'activate keeps the current core/runtime caches',
    current.every((n) => !h2.calls.cacheDelete.includes(n)));
  suite.check('S2.6', 'activate never deletes the selftest scope cache',
    !h2.calls.cacheDelete.includes(selftestCache));
  suite.check('S2.7', 'activate calls clients.claim', h2.flags.claimed === true);
}

/* ---- S3 schedule online / offline --------------------------------------- */
{
  const h = makeHarness(formalSrc);
  const r = await h.fire('fetch', h.request('/v6/november-subject-schedule.js'));
  suite.check('S3.1', 'online schedule goes to the network with cache:no-store',
    h.calls.fetch.some((c) => c.url.endsWith('/november-subject-schedule.js') && c.opts.cache === 'no-store')
    && h.calls.cacheMatch.length === 0);
  suite.check('S3.2', 'online schedule response carries no stale marker',
    !!r && r.status === 200 && r.headers.get('X-R5-Schedule-Stale') === null);

  const stale = new Response('window.V6_NOV_SCHEDULE={"version":"2026-11-04"};',
    { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  const c = new MockCache(FORMAL_PREFIX + 'core-' + VERSION);
  c.map.set(BASE_ORIGIN + '/v6/november-subject-schedule.js', stale);
  const h2 = makeHarness(formalSrc, { offline: true, seedCaches: { [c.name]: c } });
  const r2 = await h2.fire('fetch', h2.request('/v6/november-subject-schedule.js'));
  suite.check('S3.3', 'offline schedule is served only with an explicit stale marker',
    !!r2 && r2.headers.get('X-R5-Schedule-Stale') === '1');
  suite.check('S3.4', 'offline schedule still attempted the network first',
    h2.calls.fetch.some((c2) => c2.url.endsWith('/november-subject-schedule.js') && c2.opts.cache === 'no-store'));

  const h3 = makeHarness(formalSrc, { offline: true });
  const r3 = await h3.fire('fetch', h3.request('/v6/november-subject-schedule.js'));
  suite.check('S3.5', 'offline without a cached schedule returns 503 (no fabricated schedule)',
    !!r3 && r3.status === 503);
}

/* ---- S4 bridge offline --------------------------------------------------- */
{
  const oldBridge = new Response('/* OLD BRIDGE */',
    { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  const c = new MockCache(FORMAL_PREFIX + 'runtime-' + VERSION);
  c.map.set(BASE_ORIGIN + '/v6/r5-bridge.js', oldBridge);
  const h = makeHarness(formalSrc, { offline: true, seedCaches: { [c.name]: c } });
  const r = await h.fire('fetch', h.request('/v6/r5-bridge.js'));
  suite.check('S4.1', 'offline bridge fallback is explicitly marked stale',
    !!r && r.headers.get('X-R5-Bridge-Stale') === '1');
  suite.check('S4.2', 'offline bridge still tried the network first',
    h.calls.fetch.some((c2) => c2.url.endsWith('/r5-bridge.js') && c2.opts.cache === 'no-store'));
}

/* ---- S5 old-device compatibility ---------------------------------------- */
suite.check('S5.1', 'bridge keeps the local answer queue on stale/offline paths',
  /本机成绩已保留/.test(bridgeSrc) && /stale_device_day/.test(bridgeSrc));
suite.check('S5.2', 'bridge aligns to STALE_DEVICE_DAY instead of local progress',
  bridgeSrc.includes('STALE_DEVICE_DAY') && /authoritative_day/.test(bridgeSrc));
suite.check('S5.3', 'bridge never rewrites a record learning_day to the cloud day',
  !/learning_day\s*:\s*cloudDay/.test(bridgeSrc) && !/learning_day\s*:\s*day0\.today/.test(bridgeSrc));
{
  const h = makeHarness(formalSrc);
  const r = await h.fire('fetch', h.request('/v6-selftest/index.html', 'navigate'));
  suite.check('S5.4', 'a selftest-scope navigation is not handled by the formal SW', r === null);
}

/* ---- S6 selftest scope isolation ---------------------------------------- */
suite.check('S6.1', 'selftest SW uses its own PREFIX',
  selftestSrc.includes(`const PREFIX='${SELFTEST_PREFIX}'`)
  && !selftestSrc.includes(`const PREFIX='${FORMAL_PREFIX}'`));
suite.check('S6.2', 'selftest SW also prefetches the schedule',
  selftestSrc.includes("'./november-subject-schedule.js'"));
suite.check('S6.3', 'selftest SW never touches localStorage / indexedDB',
  !/localStorage\s*(\.|\[|=)/.test(selftestSrc) && !/indexedDB\s*(\.|\[|=)/.test(selftestSrc));
{
  const legacy = SELFTEST_PREFIX + 'core-20261106-sync-live-2';
  const currentSelftest = SELFTEST_PREFIX + 'core-' + SELFTEST_VERSION;
  const formalCurrent = FORMAL_PREFIX + 'core-' + VERSION;
  const seeds = Object.fromEntries([legacy, currentSelftest, formalCurrent].map((n) => [n, new MockCache(n)]));
  const h = makeHarness(selftestSrc, { scope: SELFTEST_SCOPE, seedCaches: seeds });
  await h.fire('activate');
  suite.check('S6.4', 'selftest activate drops its own legacy cache and keeps the current one',
    h.calls.cacheDelete.includes(legacy) && !h.calls.cacheDelete.includes(currentSelftest));
  suite.check('S6.5', 'selftest activate never deletes a formal v6 cache',
    !h.calls.cacheDelete.includes(formalCurrent), h.calls.cacheDelete.join(','));
}

const summary = suite.print();
writeJson(path.join(EVID, 'sw-cache-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
