/**
 * db/isolated/run-authority.mjs —— PR #3 四条发布阻断项的隔离验证
 *
 * 与 run.mjs 的区别：run.mjs 证明「家庭范围被守住了」，本文件证明
 * 「守住之后调用方还能不能自己给自己发奖励」——也就是四条阻断项本身。
 *
 *   F 阻断 1：空 JWT claims 不再等于特权；伪造 role=service_role 无效
 *   G 阻断 2：设备 UID 不再单独作为身份凭证（只走已鉴权网关）
 *   H 阻断 3：掉落配置 / 学习记录 / 车辆白名单 / 组装成本全部由服务端决定
 *   I 阻断 4：底层表不能再绕过 RPC 直接读写
 *   J 赛车兼容：真实网关形态（服务端连接 + 老设备令牌）照常领取与组装
 *
 * 只跑内存库，不连接任何正式环境。
 *
 *   cd db/isolated && node run-authority.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = p => readFileSync(path.resolve(ROOT, p), 'utf8');

for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => { console.error('\nERROR: ' + ((e && e.message) || e)); process.exit(1); });
}

const SCHEMA = read('db/isolated/schema.sql');
const BEFORE = read('db/isolated/functions-before.sql');
const AUTHORITY = read('db/20261114_fragment_server_authority.sql');
const GUARD = read('db/20261114_fragment_scope_guard.sql');
const MEMBER = read('db/20261114_fragment_member_scope.sql');

const OFFICIAL = 'synthetic-family-main-001';
const OTHER = 'synthetic-family-other-001';
const MOM = 'test-parent-member-002';
const DAD = 'test-parent-owner-001';
const GRANDMA = 'test-grandparent-003';
const DEV_MOM = 'r5dev_11111111111111111111111111111111';
const DEV_REVOKED = 'r5dev_revoked_0000000000000000000001';
const DEV_OTHER = 'r5-demo-device-0001';

let passed = 0, failed = 0;
const fails = [];
function ok(id, desc, cond, extra) {
  if (cond) { passed++; console.log(`[PASS] ${id} ${desc}`); }
  else { failed++; fails.push(id); console.log(`[FAIL] ${id} ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

/* ---------------------------------------------------------------- 连接形态 */
async function asClaims(db, role, claims) {
  await db.exec(`RESET ROLE; SET request.jwt.claims = '${JSON.stringify(claims || {})}'; SET ROLE ${role};`);
}
const asAnon = db => asClaims(db, 'anon', { role: 'anon' });
const asParent = (db, uid) => asClaims(db, 'authenticated', { role: 'authenticated', sub: uid });
const asService = db => asClaims(db, 'service_role', { role: 'service_role' });
/** 云函数 / 迁移：没有 PostgREST 注入的 claims，角色就是登录角色（库属主） */
const asServer = async db => { await db.exec(`RESET ROLE; SET request.jwt.claims = '';`); };

async function q(db, sql, params) { return (await db.query(sql, params)).rows; }
async function one(db, sql, params) { return (await q(db, sql, params))[0] || {}; }
async function rpc(db, sql, params) { return (await one(db, sql, params)).r; }
async function denied(fn) {
  try { await fn(); return { denied: false }; }
  catch (e) { return { denied: true, code: e && e.code, msg: (e && e.message || '').slice(0, 60) }; }
}

async function newStack({ rewardsActive = true } = {}) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(BEFORE);
  await db.exec(AUTHORITY);
  await db.exec(GUARD);
  await db.exec(MEMBER);
  await asServer(db);
  // Existing authority/compatibility fixtures explicitly opt in to rewards.
  // Production default remains pending-parent-confirmation and never auto-activates.
  if (rewardsActive) await db.exec("UPDATE public.r5_reward_config SET status = 'active' WHERE family_id = '*'");
  return db;
}

async function setConfig(db, patch) {
  const sets = Object.entries(patch).map(([k, v]) => {
    if (Array.isArray(v)) return `${k} = ARRAY[${v.map(x => `'${x}'`).join(',')}]::text[]`;
    if (typeof v === 'number') return `${k} = ${v}`;
    return `${k} = '${v}'`;
  }).join(', ');
  await asServer(db);
  await db.exec(`UPDATE public.r5_reward_config SET ${sets}, updated_at = now() WHERE family_id = '*'`);
}
async function seedFragments(db, family, n, item = 'frag_common') {
  await asServer(db);
  for (let i = 1; i <= n; i++) {
    const id = `seed:${family}:${item}:${++seedSeq}`;
    await db.exec(`INSERT INTO public.r5_racing_events(family_id,event_id,kind,payload,device)
      VALUES ('${family}','${id}','fragment_change',
              '{"item_id":"${item}","quantity_delta":1}'::jsonb,'seed')`);
  }
}
let seedSeq = 0;
const snapOf = async (db, fam) => rpc(db, `SELECT public.r5_fragment_snapshot('${fam}') AS r`);
/** 表已经被收权，统计一律服务端连接来做（顺势证明我们自己也得走特权） */
async function dropsOf(db, fam) {
  await asServer(db);
  return (await one(db, `SELECT count(*)::int c FROM public.r5_fragment_drops WHERE family_id='${fam}'`)).c;
}
async function revOf(db, fam) {
  await asServer(db);
  return (await one(db, `SELECT revision::int r FROM public.r5_racing_saves WHERE family_id='${fam}'`)).r;
}

/* ============================================================ F 阻断项 1 */
console.log('\n=== F 阻断项 1：空 JWT claims 不再等于特权，伪造 role 无效 ===');
{
  const db = await newStack();

  await db.exec(`RESET ROLE; SET request.jwt.claims = ''; SET ROLE anon;`);
  const f1 = await snapOf(db, OFFICIAL);
  ok('F1', 'anon + 空 claims 读自家 → FORBIDDEN_SCOPE（旧实现这里会放行）',
    f1.status === 'FORBIDDEN_SCOPE' && f1.fragments === undefined, f1);

  await db.exec(`RESET ROLE; SET request.jwt.claims = ''; SET ROLE authenticated;`);
  const f2 = await snapOf(db, OFFICIAL);
  ok('F2', 'authenticated + 空 claims → FORBIDDEN_SCOPE', f2.status === 'FORBIDDEN_SCOPE', f2);

  await asClaims(db, 'anon', { role: 'service_role' });
  const f3 = await snapOf(db, OFFICIAL);
  ok('F3', 'anon 伪造 claims.role=service_role → FORBIDDEN_SCOPE', f3.status === 'FORBIDDEN_SCOPE', f3);

  await asClaims(db, 'authenticated', { role: 'service_role', sub: 'nobody-at-all' });
  const f4 = await snapOf(db, OFFICIAL);
  ok('F4', 'authenticated 伪造 service_role + 非成员 sub → FORBIDDEN_SCOPE',
    f4.status === 'FORBIDDEN_SCOPE', f4);

  await asClaims(db, 'authenticated', { role: 'service_role', sub: MOM });
  const f5own = await snapOf(db, OFFICIAL);
  const f5other = await snapOf(db, OTHER);
  ok('F5', '伪造 service_role 不产生额外权力：仍只按成员身份判（自家通、别家拒）',
    f5own.status === undefined && !!f5own.fragments && f5other.status === 'FORBIDDEN_SCOPE',
    { own: f5own.status, other: f5other.status });

  await asServer(db);
  const f6 = await snapOf(db, OFFICIAL);
  ok('F6', '真实服务端连接（云函数 / 迁移，无 claims）→ 放行', !!f6 && f6.fragments !== undefined, f6 && Object.keys(f6));

  await asService(db);
  const f7 = await snapOf(db, OTHER);
  ok('F7', 'service_role → 放行', !!f7 && f7.fragments !== undefined);

  await asAnon(db);
  const f8anon = await one(db, `SELECT public.r5_fragment_is_privileged() AS p, public.r5_fragment_caller_role() AS r`);
  await asServer(db);
  const f8srv = await one(db, `SELECT public.r5_fragment_is_privileged() AS p, public.r5_fragment_caller_role() AS r`);
  ok('F8', 'SECURITY DEFINER 内仍能识别原调用者（anon→false/postgres→true），不是靠 current_user',
    f8anon.p === false && f8anon.r === 'anon' && f8srv.p === true && f8srv.r === 'postgres',
    { anon: f8anon, server: f8srv });

  await asParent(db, GRANDMA);
  const f9 = await one(db, `SELECT public.r5_fragment_is_privileged() AS p, public.r5_fragment_caller_role() AS r`);
  ok('F9', 'authenticated 连接不被误判成特权', f9.p === false && f9.r === 'authenticated', f9);

  const before = await dropsOf(db, OFFICIAL);
  await asClaims(db, 'anon', { role: 'service_role' });
  await rpc(db, `SELECT public.r5_fragment_claim('${OFFICIAL}','${DEV_MOM}','lr-official-today-1','{}'::jsonb) AS r`);
  const after = await dropsOf(db, OFFICIAL);
  ok('F10', '伪造 service_role 去领取 → 零写入', before === after, { before, after });

  await db.close();
}

/* ============================================================ G 阻断项 2 */
console.log('\n=== G 阻断项 2：设备 UID 不再单独作为身份凭证 ===');
{
  const db = await newStack();

  const g1before = await dropsOf(db, OFFICIAL);
  await asAnon(db);
  const g1 = await rpc(db, `SELECT public.r5_fragment_claim('${OFFICIAL}','${DEV_MOM}','lr-official-today-1','{}'::jsonb) AS r`);
  const g1after = await dropsOf(db, OFFICIAL);
  ok('G1', 'anon 拿着真实设备 UID 直接打 RPC → FORBIDDEN_SCOPE 且零写入（旧实现这里 CLAIMED）',
    g1.status === 'FORBIDDEN_SCOPE' && g1before === g1after, { g1, g1before, g1after });

  await asParent(db, MOM);
  const g2 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('G2', '登录家长 + 别家真实设备 UID → 仍 FORBIDDEN_SCOPE（设备不能提权）',
    g2.status === 'FORBIDDEN_SCOPE', g2);

  await asServer(db);
  const g3 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_MOM}','lr-other-today-2','{}'::jsonb) AS r`);
  ok('G3', '服务端连接 + 属于别家的设备 → FORBIDDEN_SCOPE（纵深防御）',
    g3.status === 'FORBIDDEN_SCOPE', g3);

  const g4 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('G4', '服务端连接 + 本家庭设备 → CLAIMED（赛车网关形态）', g4.status === 'CLAIMED', g4);

  const g5 = await rpc(db, `SELECT public.r5_fragment_claim('${OFFICIAL}','${DEV_REVOKED}','lr-official-today-1','{}'::jsonb) AS r`);
  ok('G5', '服务端连接 + 已撤销设备 → FORBIDDEN_SCOPE', g5.status === 'FORBIDDEN_SCOPE', g5);

  const g6 = await rpc(db, `SELECT public.r5_fragment_scope_ok('${OFFICIAL}','v6:nobody-at-all') AS r`);
  ok('G6', '特权连接声称 v6:<非家长> → false', g6 === false, g6);

  const g7 = await rpc(db, `SELECT public.r5_fragment_scope_ok('${OFFICIAL}','v6:${DAD}') AS r`);
  ok('G7', '特权连接声称 v6:<爸爸 uid> → true', g7 === true, g7);

  const g8 = await rpc(db, `SELECT public.r5_fragment_scope_ok('${OFFICIAL}','r5dev_短') AS r`);
  ok('G8', '特权连接声称长度不足的设备 UID → false（低熵值不受理）', g8 === false, g8);

  // claims 与设备同时存在时，特权连接只看设备，claims 不参与
  await asServer(db);
  await db.exec(`SET request.jwt.claims = '{"role":"service_role","sub":"nobody-at-all"}';`);
  const g9 = await rpc(db, `SELECT public.r5_fragment_scope_ok('${OTHER}','${DEV_OTHER}') AS r`);
  await asServer(db);
  ok('G9', '特权连接里 claims 是垃圾也不影响：仍按设备绑定判定', g9 === true, g9);

  await db.close();
}

/* ============================================================ H 阻断项 3 */
console.log('\n=== H 阻断项 3：配置 / 学习记录 / 白名单 / 成本由服务端决定 ===');
{
  let db = await newStack();

  // H1 调用方传 want=drop 但服务端概率是 0 → 不掉
  await setConfig(db, { drop_percent: 0 });
  await asServer(db);
  const h1 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1',
      '{"want":"drop","fragment_id":"frag_scholar","daily_cap":9,"pity_target":2}'::jsonb) AS r`);
  ok('H1', '伪造 p_cfg（want=drop/daily_cap=9/pity_target=2）全部无效：服务端 0% 就是不掉',
    h1.status === 'CLAIMED' && Number(h1.granted_normal) === 0 && h1.outcome !== 'drop', h1 && { o: h1.outcome, n: h1.granted_normal });

  // H2 概率 100% → 必掉；每日上限仍按服务端 2
  await setConfig(db, { drop_percent: 100, daily_cap: 2 });
  const h2a = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-2','{"daily_cap":99}'::jsonb) AS r`);
  const h2b = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-3','{"daily_cap":99}'::jsonb) AS r`);
  const h2c = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-4','{"daily_cap":99}'::jsonb) AS r`);
  ok('H2', '服务端 100% 必掉；但每日上限只认服务端 2 —— 第三条 capped，p_cfg 抬不动',
    h2a.outcome === 'drop' && h2b.outcome === 'drop' && h2c.outcome === 'capped',
    { a: h2a.outcome, b: h2b.outcome, c: h2c.outcome });

  // H3 不存在的记录
  const before3 = await dropsOf(db, OTHER);
  const h3 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-made-up-record','{}'::jsonb) AS r`);
  ok('H3', '凭空捏造的 record_id → RECORD_NOT_FOUND 且零写入',
    h3.status === 'RECORD_NOT_FOUND' && (await dropsOf(db, OTHER)) === before3, h3);

  // H4 别家的真实记录
  const h4 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-official-today-1','{}'::jsonb) AS r`);
  ok('H4', '拿别家的真实 record_id → RECORD_NOT_FOUND（记录必须属于本家庭）',
    h4.status === 'RECORD_NOT_FOUND', h4);

  // H5 昨天的记录
  const h5 = await rpc(db, `SELECT public.r5_fragment_claim('${OFFICIAL}','${DEV_MOM}','lr-official-yesterday','{}'::jsonb) AS r`);
  ok('H5', '昨天的学习记录 → NOT_TODAY（不能补领昨天来重置今天的额度）',
    h5.status === 'NOT_TODAY' && h5.zero_write === true, h5);

  // H6 record_day 由记录自己决定，p_cfg 改不了
  const h6 = await rpc(db, `SELECT public.r5_fragment_claim('${OFFICIAL}','${DEV_MOM}','lr-official-today-1',
      '{"record_day":"1999-01-01","record_kind":"sync-test","subject":"伪造"}'::jsonb) AS r`);
  const today = (await one(db, `SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') d`)).d;
  ok('H6', 'record_day / record_kind / subject 全部取自真实记录，p_cfg 改不动',
    h6.record_day === today && h6.record_kind === 'answer', { got: h6.record_day, want: today, kind: h6.record_kind });

  // H7 起用一个干净的库：余额从 3 片开始，才看得出「客户端说 1 片」到底算不算数
  await db.close();
  db = await newStack();
  await seedFragments(db, OTHER, 3);

  const balBefore = Number((await snapOf(db, OTHER)).fragments.frag_common || 0);
  const h7 = await rpc(db, `SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{"frag_common":1}'::jsonb) AS r`);
  ok('H7', 'p_cost 传 {"frag_common":1} 无效 → INSUFFICIENT_FRAGMENTS（按服务端 12 片判）',
    h7.status === 'INSUFFICIENT_FRAGMENTS' && h7.required.frag_common === 12,
    { status: h7.status, required: h7.required, bal: balBefore });

  const h8 = await rpc(db, `SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{}'::jsonb) AS r`);
  ok('H8', 'p_cost 为空也能走到正确判定（配方来自表，客户端不参与）',
    h8.status === 'INSUFFICIENT_FRAGMENTS' && h8.required.frag_common === 12, h8.status);

  // 给够 12 片，用 1 片的假成本再试
  await seedFragments(db, OTHER, 9);
  const h9 = await rpc(db, `SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{"frag_common":1}'::jsonb) AS r`);
  ok('H9', '凑够 12 片后按配方扣 12 片（不是客户端说的 1 片）',
    h9.status === 'ASSEMBLED' && Number(h9.fragments.frag_common) === 0 && h9.cost.frag_common === 12,
    { status: h9.status, left: h9.fragments.frag_common, cost: h9.cost });

  // H10 - H12 白名单
  const h10 = await rpc(db, `SELECT public.r5_fragment_assemble('${OFFICIAL}','${DEV_MOM}','not-a-real-car','{}'::jsonb) AS r`);
  ok('H10', '目录外的车 → UNKNOWN_VEHICLE', h10.status === 'UNKNOWN_VEHICLE', h10.status);
  const h11 = await rpc(db, `SELECT public.r5_fragment_assemble('${OFFICIAL}','${DEV_MOM}','moto','{}'::jsonb) AS r`);
  ok('H11', '金币车 → COIN_VEHICLE_FORBIDDEN', h11.status === 'COIN_VEHICLE_FORBIDDEN', h11.status);
  const h12 = await rpc(db, `SELECT public.r5_fragment_assemble('${OFFICIAL}','${DEV_MOM}','pink-newyear-2027','{}'::jsonb) AS r`);
  ok('H12', '生日 / 限定期前缀车 → BIRTHDAY_VEHICLE_FORBIDDEN', h12.status === 'BIRTHDAY_VEHICLE_FORBIDDEN', h12.status);
  const h13 = await rpc(db, `SELECT public.r5_fragment_assemble('${OFFICIAL}','${DEV_MOM}','scholar','{}'::jsonb) AS r`);
  ok('H13', 'v1 遗留槽位 → LEGACY_SLOT_RETIRED', h13.status === 'LEGACY_SLOT_RETIRED', h13.status);

  // H14 配置是唯一事实来源：改表立即生效
  await setConfig(db, { drop_percent: 100 });
  await asServer(db);
  await db.exec(`INSERT INTO public.growth_learning_records(record_id,family_id,record_type,subject,learning_day,created_at)
                 VALUES ('lr-other-fresh','${OTHER}','answer','语文',3, now())`);
  const h14 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-fresh','{"want":"none"}'::jsonb) AS r`);
  ok('H14', '改 r5_reward_config 立刻生效，且 p_cfg want=none 也拦不住服务端 100%',
    h14.outcome === 'drop' && Number(h14.granted_normal) === 1, { o: h14.outcome, n: h14.granted_normal });

  await db.close();
}

/* ============================================================ I 阻断项 4 */
console.log('\n=== I 阻断项 4：底层表不能再绕过 RPC 直接读写 ===');
{
  const db = await newStack();
  await seedFragments(db, OTHER, 1);
  await asServer(db);
  await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);

  const TABLES = ['r5_fragment_state', 'r5_fragment_drops', 'r5_racing_events', 'r5_racing_saves', 'r5_device'];

  await asAnon(db);
  const i1 = await denied(() => q(db, `SELECT * FROM public.r5_fragment_drops LIMIT 1`));
  ok('I1', 'anon 直接 SELECT r5_fragment_drops → 拒绝', i1.denied && i1.code === '42501', i1);

  const i2 = await denied(() => q(db, `SELECT * FROM public.r5_fragment_state LIMIT 1`));
  ok('I2', 'anon 直接 SELECT r5_fragment_state → 拒绝', i2.denied && i2.code === '42501', i2);

  await asParent(db, MOM);
  const i3 = await denied(() => db.exec(`INSERT INTO public.r5_fragment_drops(family_id,source_record_id,record_day,record_kind,outcome)
    VALUES ('${OFFICIAL}','forged','2026-01-01','answer','drop')`));
  ok('I3', 'authenticated 直接 INSERT drops → 拒绝', i3.denied && i3.code === '42501', i3);

  const i4 = await denied(() => db.exec(`UPDATE public.r5_fragment_state SET pity_points=99 WHERE family_id='${OFFICIAL}'`));
  ok('I4', 'authenticated 直接 UPDATE state（改保底）→ 拒绝', i4.denied && i4.code === '42501', i4);

  const i5 = await denied(() => db.exec(`DELETE FROM public.r5_fragment_drops WHERE family_id='${OTHER}'`));
  ok('I5', 'authenticated 直接 DELETE drops（删了重领）→ 拒绝', i5.denied && i5.code === '42501', i5);

  const i6 = await denied(() => q(db, `SELECT * FROM public.r5_racing_events LIMIT 1`));
  ok('I6', 'authenticated 直接 SELECT racing_events → 拒绝', i6.denied && i6.code === '42501', i6);

  const i7 = await denied(() => q(db, `SELECT * FROM public.r5_racing_saves LIMIT 1`));
  ok('I7', 'authenticated 直接 SELECT racing_saves → 拒绝', i7.denied && i7.code === '42501', i7);

  const i8 = await denied(() => db.exec(`INSERT INTO public.r5_device(device_uid,family_id,bound_by)
    VALUES ('r5dev_selfbound00000000000000000001','${OFFICIAL}','${MOM}')`));
  ok('I8', 'authenticated 自己给自己绑设备 → 拒绝', i8.denied && i8.code === '42501', i8);

  await asService(db);
  const i9 = await denied(() => db.exec(`INSERT INTO public.r5_fragment_state(family_id) VALUES ('r5-svc-probe')`));
  ok('I9', 'service_role 仍可写（服务端任务没被误伤）', i9.denied === false, i9);

  const i10 = await one(db, `SELECT count(*)::int c FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                              WHERE n.nspname='public' AND c.relname = ANY(ARRAY['${TABLES.join("','")}'])
                                AND c.relrowsecurity`);
  ok('I10', '五张奖励相关表全部开启 RLS', i10.c === 5, i10);

  await asParent(db, MOM);
  const i11 = await one(db, `SELECT count(*)::int c FROM public.growth_learning_records WHERE family_id='${OFFICIAL}'`);
  ok('I11', '登录家长仍能读自家学习记录（没有误伤学习进度）', i11.c >= 1, i11);

  await asAnon(db);
  const i12 = await denied(() => q(db, `SELECT * FROM public.growth_learning_records LIMIT 1`));
  ok('I12', 'anon 读学习记录 → 拒绝', i12.denied && i12.code === '42501', i12);

  // 幂等：被拒的删除没有生效，同一条记录再领仍是 ALREADY_CLAIMED
  await asServer(db);
  const i13 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('I13', '绕过尝试失败后幂等仍成立：同一条记录再领 → ALREADY_CLAIMED 且 zero_write',
    i13.status === 'ALREADY_CLAIMED' && i13.zero_write === true, i13 && i13.status);

  await db.close();
}

/* ============================================================ J 赛车兼容 */
console.log('\n=== J 赛车兼容：真实网关形态 + 老设备令牌 ===');
{
  const db = await newStack();
  await seedFragments(db, OTHER, 12);

  // 网关 → r5-racing-save → ExecutePGSql 的形态：服务端连接 + x-r5-device 透传
  await asServer(db);
  const j1 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('J1', '赛车领取照常：服务端连接 + 老设备 r5-demo-device-0001 → CLAIMED',
    j1.status === 'CLAIMED' && j1.fragments !== undefined, j1 && j1.status);

  const j2 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-2','{}'::jsonb) AS r`);
  ok('J2', '同一设备连续领取第二条 → CLAIMED（没有误伤）', j2.status === 'CLAIMED', j2 && j2.status);

  const j3before = Number((await snapOf(db, OTHER)).fragments.frag_common || 0);
  const j3 = await rpc(db, `SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{"frag_common":12}'::jsonb) AS r`);
  const j3after = Number((j3.fragments && j3.fragments.frag_common) || 0);
  ok('J3', '赛车侧组装照常：12 片 → ASSEMBLED，余额扣 12 片且不为负',
    j3.status === 'ASSEMBLED' && j3after >= 0 && (j3before < 12 || j3after === j3before - 12),
    { status: j3.status, before: j3before, after: j3after });

  const j4 = await one(db, `SELECT device FROM public.r5_racing_events
                             WHERE family_id='${OTHER}' AND event_id='asm:frag_car_common_01'`);
  ok('J4', '事件里的设备列就是原设备 UID（审计链没断）', j4.device === DEV_OTHER, j4);

  const j5 = await snapOf(db, OTHER);
  ok('J5', 'save.get 需要的那几个字段都在：fragments/owned/revision/pity/daily/drops_total',
    ['fragments', 'owned', 'revision', 'pity_points', 'pity_total', 'daily_normal_count', 'drops_total']
      .every(k => j5[k] !== undefined), Object.keys(j5));

  const j6 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','','lr-other-today-3','{}'::jsonb) AS r`);
  ok('J6', '云函数不带设备（p_device 为空）也能领取', j6.status === 'CLAIMED', j6 && j6.status);

  const sigs = await q(db, `SELECT p.proname, pg_get_function_identity_arguments(p.oid) a
                              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                             WHERE n.nspname='public'
                               AND p.proname IN ('r5_fragment_snapshot','r5_fragment_claim','r5_fragment_assemble')
                             ORDER BY 1`);
  ok('J7', '三个旧函数签名一字未改（网关与云函数无需改代码）',
    sigs.length === 3
    && sigs.find(s => s.proname === 'r5_fragment_snapshot').a === 'p_family text'
    && sigs.find(s => s.proname === 'r5_fragment_claim').a === 'p_family text, p_device text, p_record_id text, p_cfg jsonb'
    && sigs.find(s => s.proname === 'r5_fragment_assemble').a === 'p_family text, p_device text, p_vehicle_id text, p_cost jsonb',
    sigs);

  // 旧设备被撤销之后必须停用（安全性没有为了兼容而放弃）
  await asServer(db);
  await db.exec(`UPDATE public.r5_device SET revoked_at = now() WHERE device_uid='${DEV_OTHER}'`);
  const j8 = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-4','{}'::jsonb) AS r`);
  ok('J8', '设备被撤销后立刻停用（撤销是真实的解除授权）', j8.status === 'FORBIDDEN_SCOPE', j8.status);

  await db.close();
}

/* ============================================================ K 家长审批硬开关 */
console.log('\n=== K 家长未批准时所有奖励发放路径必须零写入 ===');
{
  const db = await newStack({ rewardsActive: false });
  await asServer(db);
  const before = await one(db, `SELECT
    (SELECT count(*)::int FROM public.r5_fragment_drops WHERE family_id='${OTHER}') AS drops,
    (SELECT count(*)::int FROM public.r5_racing_events WHERE family_id='${OTHER}') AS events,
    (SELECT revision::int FROM public.r5_racing_saves WHERE family_id='${OTHER}') AS revision,
    (SELECT count(*)::int FROM public.r5_fragment_state WHERE family_id='${OTHER}') AS states`);
  const pending = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{"want":"drop","daily_cap":99}'::jsonb) AS r`);
  ok('K1', '待确认不能发奖，明确 REWARD_NOT_ACTIVE + zero_write',
    pending.status === 'REWARD_NOT_ACTIVE' && pending.zero_write === true, pending);
  const after = await one(db, `SELECT
    (SELECT count(*)::int FROM public.r5_fragment_drops WHERE family_id='${OTHER}') AS drops,
    (SELECT count(*)::int FROM public.r5_racing_events WHERE family_id='${OTHER}') AS events,
    (SELECT revision::int FROM public.r5_racing_saves WHERE family_id='${OTHER}') AS revision,
    (SELECT count(*)::int FROM public.r5_fragment_state WHERE family_id='${OTHER}') AS states`);
  ok('K2', '待确认不写领取记录、碎片事件、保底状态或存档 revision',
    JSON.stringify(before) === JSON.stringify(after), {before,after});
  const repeat = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('K3', '待确认重复请求不消耗记录且始终拒绝', repeat.status === 'REWARD_NOT_ACTIVE' && repeat.zero_write === true, repeat);

  await setConfig(db, { status: 'paused', drop_percent: 100, pity_target: 2, rare_record_types: ['answer'] });
  const paused = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-2','{}'::jsonb) AS r`);
  ok('K4', '暂停状态下即使概率 100% 且稀有和保底已开启仍不得发奖',
    paused.status === 'REWARD_NOT_ACTIVE' && paused.zero_write === true, paused);
  const pausedAfter = await one(db, `SELECT
    (SELECT count(*)::int FROM public.r5_fragment_drops WHERE family_id='${OTHER}') AS drops,
    (SELECT count(*)::int FROM public.r5_racing_events WHERE family_id='${OTHER}') AS events,
    (SELECT revision::int FROM public.r5_racing_saves WHERE family_id='${OTHER}') AS revision,
    (SELECT count(*)::int FROM public.r5_fragment_state WHERE family_id='${OTHER}') AS states`);
  ok('K5', '暂停后仍完全零写入', JSON.stringify(before) === JSON.stringify(pausedAfter), {before,pausedAfter});

  await setConfig(db, { status: 'active', drop_percent: 100, rare_record_types: [] });
  const active = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('K6', '只有明确 active 才能首次领取原记录', active.status === 'CLAIMED' && Number(active.granted_normal) === 1, active);
  const duplicate = await rpc(db, `SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('K7', '启用后同一学习记录仍幂等，不重复发放', duplicate.status === 'ALREADY_CLAIMED' && duplicate.zero_write === true, duplicate);
  await db.close();
}

/* ============================================================ L 稀有奖励通道
 * Only an isolated synthetic fixture uses rare_record_types=['answer'] here.
 * It is NOT a proposal to grant rare fragments for ordinary answers in production.
 */
console.log('\n=== L 稀有碎片端到端契约（仅合成库测试，正式来源仍关闭） ===');
{
  const db=await newStack();
  await asServer(db);
  const defaultRare=await one(db,"SELECT cardinality(rare_record_types) AS n FROM public.r5_reward_config WHERE family_id='*'");
  ok('L1','默认稀有奖励来源关闭，不能自动给真实家庭发专属碎片',Number(defaultRare.n)===0,defaultRare);
  await setConfig(db,{drop_percent:0,rare_record_types:['answer'],rare_daily_cap:1});
  const first=await rpc(db,`SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('L2','合成启用白名单后，第一条真实学习记录获得 1 片稀有碎片',
    first.status==='CLAIMED'&&Number(first.granted_rare)===1&&Number(first.granted_normal)===0,first);
  const firstAgain=await rpc(db,`SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-1','{}'::jsonb) AS r`);
  ok('L3','重复请求稀有奖励不会重复发放',
    firstAgain.status==='ALREADY_CLAIMED'&&firstAgain.zero_write===true,firstAgain);
  const second=await rpc(db,`SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-2','{}'::jsonb) AS r`);
  ok('L4','同一天第二条记录触发稀有每日上限',
    second.status==='CLAIMED'&&Number(second.granted_rare)===0,second);
  const snap=await snapOf(db,OTHER);
  ok('L5','云端碎片快照中恰好保留 1 片稀有碎片',
    Number(snap.fragments?.frag_scholar||0)===1,snap.fragments);
  const audit=await one(db,`SELECT count(*)::int AS n FROM public.r5_racing_events
    WHERE family_id='${OTHER}' AND kind='fragment_change'
      AND payload->>'item_id'='frag_scholar'`);
  ok('L6','稀有碎片只产生一条审计事件',Number(audit.n)===1,audit);
  await setConfig(db,{status:'paused'});
  const afterPause=await rpc(db,`SELECT public.r5_fragment_claim('${OTHER}','${DEV_OTHER}','lr-other-today-3','{}'::jsonb) AS r`);
  ok('L7','暂停后稀有发奖立即禁止（即使稀有类型白名单仍存在）',
    afterPause.status==='REWARD_NOT_ACTIVE'&&afterPause.zero_write===true,afterPause);
  await db.close();
}


/* ============================================================ M: V6→V2 cross-game vehicle bridge */
console.log('\n=== M V6 组装同步到 V2 可驾驶车辆 ID ===');
{
  const db=await newStack();
  await seedFragments(db,OTHER,12,'frag_common');
  await seedFragments(db,OTHER,8,'frag_scholar');
  await asServer(db);
  const b=await one(db,`SELECT coins_balance::int coins,revision::int rev FROM public.r5_racing_saves WHERE family_id='${OTHER}'`);
  const c=await rpc(db,`SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{}'::jsonb) AS r`);
  ok('M1','普通车真实兑换 12 片，映射 V2 雷霆车辆',
    c.status==='ASSEMBLED'&&c.game_vehicle_id==='frag_common'&&Number(c.fragments?.frag_common||0)===0,c);
  const d=await rpc(db,`SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{}'::jsonb) AS r`);
  ok('M2','雷霆重复组装不二次扣片',d.status==='ALREADY_OWNED'&&d.zero_write===true,d);
  const rare=await rpc(db,`SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_rare_01','{}'::jsonb) AS r`);
  ok('M3','稀有车真实兑换 8 片，映射 V2 秋名车辆',
    rare.status==='ASSEMBLED'&&rare.game_vehicle_id==='frag_rare'&&Number(rare.fragments?.frag_scholar||0)===0,rare);
  const s=await one(db,`SELECT owned,coins_balance::int coins,revision::int rev FROM public.r5_racing_saves WHERE family_id='${OTHER}'`);
  ok('M4','存档中两组 V6 配方 ID 和 V2 车辆 ID 同时存在',
    ['frag_car_common_01','frag_common','frag_car_rare_01','frag_rare'].every(x=>!!s.owned?.[x]),s.owned);
  ok('M5','兑换不消耗金币，只增加两次 revision',s.coins===b.coins&&s.rev===b.rev+2,s);
  const events=await one(db,`SELECT count(*)::int n FROM public.r5_racing_events WHERE family_id='${OTHER}' AND kind='grant' AND event_id LIKE 'asm:%'`);
  ok('M6','两车只记两条 grant，无重复领奖',Number(events.n)===2,events);
  const birthday=await rpc(db,`SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','birthday-star-6','{}'::jsonb) AS r`);
  ok('M7','生日车被隔离，不走碎片兑换',birthday.status==='BIRTHDAY_VEHICLE_FORBIDDEN'&&birthday.zero_write===true,birthday);
  await db.close();
}
{
  const db=await newStack();
  await seedFragments(db,OTHER,12,'frag_common');
  await asServer(db);
  await db.exec(`UPDATE public.r5_racing_saves SET owned='{"frag_common":{"source":"legacy"}}'::jsonb WHERE family_id='${OTHER}'`);
  const already=await rpc(db,`SELECT public.r5_fragment_assemble('${OTHER}','${DEV_OTHER}','frag_car_common_01','{}'::jsonb) AS r`);
  ok('M8','曾解锁 V2 雷霆的家庭不能再花碎片兑换同一辆车',
    already.status==='ALREADY_OWNED'&&already.zero_write===true,already);
  await db.close();
}

/* ============================================================ N member claim
 * V6 parent-authenticated claim is the SAME ledger, not a second reward system.
 * These checks use synthetic families only; production remains closed.
 */
console.log('\n=== N 家长登录模式领取碎片 · 设备令牌非必需 ===');
{
  const db=await newStack({rewardsActive:false});
  await asAnon(db);
  const anon=await denied(()=>rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r"));
  ok('N1','匿名用户无家长领取 RPC 的 EXECUTE 权限',anon.denied&&anon.code==='42501',anon);
  await asParent(db,'nobody-at-all');
  const stranger=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N2','非家庭成员禁止领取且零写',stranger.status==='NOT_MEMBER'&&stranger.zero_write===true,stranger);
  await asParent(db,'u-two-families');
  const amb=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N3','一个账号归属两家时拒绝代选',amb.status==='AMBIGUOUS_MEMBER'&&amb.zero_write===true,amb);
  await asParent(db,MOM);
  const cross=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N4','家长不能拿别家学习记录领碎片',cross.status==='RECORD_NOT_FOUND'&&cross.zero_write===true,cross);
  await asParent(db,'r5-selftest-parent');
  const paused=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N5','即使已登录家长，奖励未启用仍零写',paused.status==='REWARD_NOT_ACTIVE'&&paused.zero_write===true,paused);
  await setConfig(db,{status:'active',drop_percent:100});
  await asParent(db,'r5-selftest-parent');
  const earned=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N6','隔离启用后家长模式复用 60% 所属的服务端领取规则',
     earned.status==='CLAIMED'&&Number(earned.granted_normal)===1,earned);
  const repeat=await rpc(db,"SELECT public.r5_fragment_member_claim('lr-other-today-1') AS r");
  ok('N7','家长重复领取幂等，零写且无额外碎片',
    repeat.status==='ALREADY_CLAIMED'&&repeat.zero_write===true,repeat);
  const sig=await one(db,"SELECT p.pronargs::int n, array_to_string(p.proargnames,',') args FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname='r5_fragment_member_claim'");
  ok('N8','家长领取 RPC 只接受 record_id，不接受 family/cost/probability',sig.n===1&&sig.args==='p_record_id',sig);
  await db.close();
}

/* ================================================================ 汇总 */
console.log('\n' + '='.repeat(60));
console.log(`TOTAL  ${passed}/${passed + failed} passed, ${failed} failed`);
if (failed) console.log('FAILED: ' + fails.join(', '));
console.log(failed ? 'VERDICT FAIL' : 'VERDICT PASS');
process.exit(failed ? 1 : 0);
