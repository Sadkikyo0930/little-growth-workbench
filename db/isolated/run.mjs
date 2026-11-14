/**
 * db/isolated/run.mjs —— 隔离环境验证（PGlite / WASM Postgres 17）
 *
 * 它做三件事：
 *   ① 用「线上原样」的三个碎片函数建库，先证明漏洞真实存在（B 组）
 *   ② 装上 r5_fragment_member_*（新接口），证明它绕不过去（C 组）
 *   ③ 装上 r5_fragment_scope_ok + 三个函数的入口守卫，证明
 *      「匿名跨家庭被拒」而「赛车设备那条路照常通」（D/E 组）
 *
 * 不连接任何正式库、不读任何密钥。三组各用一个全新的内存库，互不污染。
 *
 *   cd db/isolated && npm i && node run.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = p => readFileSync(path.resolve(ROOT, p), 'utf8');

/* PGlite 的报错栈非常吵，这里只留一行有效信息 */
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => { console.error('\nERROR: ' + ((e && e.message) || e)); process.exit(1); });
}

const SCHEMA = read('db/isolated/schema.sql');
const BEFORE = read('db/isolated/functions-before.sql');
const AUTHORITY = read('db/20261114_fragment_server_authority.sql');
const GUARD = read('db/20261114_fragment_scope_guard.sql');
const MEMBER = read('db/20261114_fragment_member_scope.sql');

/** 云函数/迁移通道：已装好服务端权威 + 守卫 + 成员接口的库 */
async function newStack() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(BEFORE);      // 线上原样的三个旧函数，下面两个文件把它们替换成 v3
  await db.exec(AUTHORITY);   // step 1：配置表 + 角色白名单 + 目录
  await db.exec(GUARD);       // step 2：按角色重写守卫 + 服务端权威的 claim/assemble + 表收权
  await db.exec(MEMBER);      // step 3：成员 RPC
  return db;
}


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

/* ------------------------------------------------------------------ 角色切换 */
async function asClaims(db, role, claims) {
  await db.exec(`RESET ROLE; SET request.jwt.claims = '${JSON.stringify(claims || {})}'; SET ROLE ${role};`);
}
const asAnon = db => asClaims(db, 'anon', { role: 'anon' });
const asParent = (db, uid) => asClaims(db, 'authenticated', { role: 'authenticated', sub: uid });
const asService = db => asClaims(db, 'service_role', { role: 'service_role' });
/** 模拟云函数/迁移：没有 PostgREST 注入的 claims */
const asServer = async db => { await db.exec(`RESET ROLE; SET request.jwt.claims = '';`); };

async function q(db, sql, params) {
  const r = await db.query(sql, params);
  return r.rows;
}
async function one(db, sql, params) {
  const rows = await q(db, sql, params);
  return rows[0] || {};
}
async function rpc(db, sql, params) {
  const row = await one(db, sql, params);
  return row.r;
}
async function denied(fn) {
  try { await fn(); return { denied: false }; }
  catch (e) { return { denied: true, code: e && e.code }; }
}

/* ================================================================ 组 A：成员模型 */
console.log('\n=== A 成员模型（正式家庭三人均保留） ===');
{
  const db = new PGlite();
  await db.exec(SCHEMA);
  await asServer(db);

  const fam = await q(db, `select user_id, member_role from public.growth_family_members
                           where family_id='${OFFICIAL}' order by member_role`);
  ok('A1', '正式家庭恰好 3 名成员', fam.length === 3, fam);
  ok('A2', '角色齐全：owner / parent / grandparent',
    JSON.stringify(fam.map(r => r.member_role)) === JSON.stringify(['grandparent', 'owner', 'parent']), fam.map(r => r.member_role));
  ok('A3', '三名家长分别对应 爸爸/妈妈/外婆 的 user_id',
    fam.some(r => r.user_id === DAD && r.member_role === 'owner')
    && fam.some(r => r.user_id === MOM && r.member_role === 'parent')
    && fam.some(r => r.user_id === GRANDMA && r.member_role === 'grandparent'));

  const multi = await q(db, `select user_id, count(distinct family_id) c from public.growth_family_members
                              group by 1 having count(distinct family_id) > 1`);
  ok('A4', '约束是「每个账号只挂 1 个家庭」——只有测试账号 u-two-families 违反',
    multi.length === 1 && multi[0].user_id === 'u-two-families', multi);

  // 主键形态：一个家庭可以有多名成员，但同一 (family,user) 不能重复
  const dup = await denied(() => db.exec(`insert into public.growth_family_members(family_id,user_id,member_role)
                                          values ('${OFFICIAL}','${MOM}','owner')`));
  ok('A5', '同一家庭同一账号不能重复（PK (family_id,user_id) 生效）', dup.denied && dup.code === '23505', dup);

  const sqlText = MEMBER;
  ok('A6', '迁移脚本对成员表只有 SELECT，没有任何写成员行的语句',
    !/insert\s+into\s+public\.growth_family_members/i.test(sqlText)
    && !/update\s+public\.growth_family_members/i.test(sqlText)
    && !/delete\s+from\s+public\.growth_family_members/i.test(sqlText)
    && !/truncate\s+.*growth_family_members/i.test(sqlText));
  ok('A7', '迁移脚本用 array_agg(DISTINCT …) —— 一个家庭多名成员不会被误判成「多家庭」',
    /array_agg\s*\(\s*distinct\s+m\.family_id\s*\)/i.test(sqlText));
  await db.close();
}

/* ================================================================ 组 B：漏洞复现（改之前） */
console.log('\n=== B 旧接口的漏洞（改之前，证明它确实存在） ===');
{
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(BEFORE);

  await asAnon(db);
  const snap = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('B1', 'anon 直接传别家 family_id 就能读到那家的快照', !!snap && snap.fragments !== undefined, snap && Object.keys(snap));
  ok('B2', '返回里连一个「你没权限」都没有（旧函数不做任何授权判断）',
    !!snap && snap.status === undefined);

  const beforeDrops = (await one(db, `select count(*)::int c from public.r5_fragment_drops where family_id='${OTHER}'`)).c;
  const claim = await rpc(db,
    `select public.r5_fragment_claim('${OTHER}', '${DEV_OTHER}', 'cross-family-1', '{"want":"drop","fragment_id":"frag_common"}'::jsonb) as r`);
  const afterDrops = (await one(db, `select count(*)::int c from public.r5_fragment_drops where family_id='${OTHER}'`)).c;
  ok('B3', 'anon 还能对别家**写入**领取记录（drops 行数 +1）',
    claim && claim.status === 'CLAIMED' && afterDrops === beforeDrops + 1, { status: claim && claim.status, beforeDrops, afterDrops });

  await asParent(db, MOM);
  const crossRead = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('B4', '登录家长（妈妈）能读别人家', !!crossRead && crossRead.fragments !== undefined);

  await asAnon(db);
  const tbl = await one(db, `select count(*)::int c from public.r5_fragment_drops`);
  ok('B5', 'anon 还能直接 SELECT r5_fragment_drops / r5_fragment_state（表级也在漏）', tbl.c > 0, tbl);
  await db.close();
}

/* ================================================================ 组 C：新接口 */
console.log('\n=== C 新接口 r5_fragment_member_*（只能读到自己家） ===');
{
  const db = await newStack();
  // 给另一家备 12 片普通碎片，用来测组装
  await asServer(db);
  for (let i = 1; i <= 12; i++) {
    await db.exec(`insert into public.r5_racing_events(family_id,event_id,kind,payload,device)
      values ('${OTHER}','seed:frag:${i}','fragment_change','{"item_id":"frag_common","quantity_delta":1}'::jsonb,'seed')`);
  }

  const a1 = await denied(() => (asAnon(db), rpc(db, `select public.r5_fragment_member_snapshot() as r`)));
  ok('C1', 'anon 对 member_snapshot 没有执行权', a1.denied && a1.code === '42501', a1);
  const a2 = await denied(() => (asAnon(db), rpc(db, `select public.r5_fragment_member_assemble('frag_car_common_01') as r`)));
  ok('C2', 'anon 对 member_assemble 没有执行权', a2.denied && a2.code === '42501', a2);

  await asParent(db, 'nobody-at-all');
  const nonMember = await rpc(db, `select public.r5_fragment_member_snapshot() as r`);
  ok('C3', '登录了但不是任何家庭成员 → NOT_MEMBER', nonMember.status === 'NOT_MEMBER', nonMember);

  await asParent(db, 'r5-selftest-child');
  const child = await rpc(db, `select public.r5_fragment_member_snapshot() as r`);
  ok('C4', '角色是 child → NOT_MEMBER（孩子账号不能读家长视图）', child.status === 'NOT_MEMBER', child);

  for (const [id, uid, role] of [['C5', DAD, 'owner'], ['C6', MOM, 'parent'], ['C7', GRANDMA, 'grandparent']]) {
    await asParent(db, uid);
    const r = await rpc(db, `select public.r5_fragment_member_snapshot() as r`);
    ok(id, `${role} 能读到 ${OFFICIAL}，且 family 由服务端给出（member_role=${r.member_role}）`,
      r.status === 'OK' && r.family_id === OFFICIAL && r.member_role === role, r);
  }

  await asParent(db, MOM);
  const mom = await rpc(db, `select public.r5_fragment_member_snapshot() as r`);
  ok('C8', '零碎片时返回空对象而不是报错（前端据此显示 0/12、0/8）',
    JSON.stringify(mom.fragments) === '{}' && JSON.stringify(mom.owned) === '{}', { f: mom.fragments, o: mom.owned });

  await asParent(db, 'u-two-families');
  const amb = await rpc(db, `select public.r5_fragment_member_snapshot() as r`);
  ok('C9', '一个账号挂两个家庭 → AMBIGUOUS_MEMBER，且不带任何碎片数据',
    amb.status === 'AMBIGUOUS_MEMBER' && amb.fragments === undefined, amb);

  const sig = await one(db, `select p.pronargs::int n, coalesce(array_to_string(p.proargnames,','),'') names
                               from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                              where ns.nspname='public' and p.proname='r5_fragment_member_snapshot'`);
  ok('C10', '函数签名里没有任何 family 参数（pronargs=0）', sig.n === 0 && sig.names === '', sig);
  const sig2 = await one(db, `select p.pronargs::int n, array_to_string(p.proargnames,',') names
                                from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                               where ns.nspname='public' and p.proname='r5_fragment_member_assemble'`);
  ok('C11', '组装函数只接受 p_vehicle_id，没有 family / cost 参数',
    sig2.n === 1 && sig2.names === 'p_vehicle_id', sig2);

  // 组装：非成员
  await asParent(db, 'nobody-at-all');
  const na = await rpc(db, `select public.r5_fragment_member_assemble('frag_car_common_01') as r`);
  ok('C12', '非成员组装 → NOT_MEMBER + zero_write', na.status === 'NOT_MEMBER' && na.zero_write === true, na);

  // 组装：目录外 / 生日车 / 金币车（状态码由 r5_vehicle_recipe.obtainable_via 决定）
  await asParent(db, 'r5-selftest-parent');
  for (const [id, vid, want] of [
    ['C13a', 'birthday-star-6', 'BIRTHDAY_VEHICLE_FORBIDDEN'],
    ['C13b', 'moto', 'COIN_VEHICLE_FORBIDDEN'],
    ['C13c', 'not-a-real-car', 'UNKNOWN_VEHICLE'],
  ]) {
    const r = await rpc(db, `select public.r5_fragment_member_assemble('${vid}') as r`);
    ok(id, `${vid} 由服务端配方表拒绝 → ${want}`, r.status === want && r.zero_write === true, r);
  }
  // 非法 vehicle id 形态
  const badId = await rpc(db, `select public.r5_fragment_member_assemble('DROP TABLE x') as r`);
  ok('C13d', '非法车辆 ID 形态 → BAD_VEHICLE_ID', badId.status === 'BAD_VEHICLE_ID', badId);

  // 组装：12 片 → 成功
  await asServer(db);
  const before = (await one(db, `select revision::int r from public.r5_racing_saves where family_id='${OTHER}'`)).r;
  await asParent(db, 'r5-selftest-parent');
  const asm = await rpc(db, `select public.r5_fragment_member_assemble('frag_car_common_01') as r`);
  ok('C14', '12 片时组装成功（ASSEMBLED）且扣到 0',
    asm.status === 'ASSEMBLED' && Number(asm.fragments.frag_common) === 0, asm && asm.fragments);
  ok('C15', '车辆进入 owned，revision 前进 1',
    !!asm.owned.frag_car_common_01 && Number(asm.revision) === Number(before) + 1, { rev: asm.revision, before });

  await asServer(db);
  const dev = await one(db, `select device from public.r5_racing_events where family_id='${OTHER}' and event_id='asm:frag_car_common_01'`);
  ok('C16', '事件里的设备标识是 v6:<uid>（不伪装成 r5dev_ 设备令牌）',
    dev.device === 'v6:r5-selftest-parent', dev);

  await asParent(db, 'r5-selftest-parent');
  const again = await rpc(db, `select public.r5_fragment_member_assemble('frag_car_common_01') as r`);
  ok('C17', '再装一次 → ALREADY_OWNED + zero_write，余额不再扣',
    again.status === 'ALREADY_OWNED' && again.zero_write === true && Number(again.fragments.frag_common) === 0, again);
  await db.close();
}

/* ================================================================ 组 D/E：守卫 */
console.log('\n=== D 旧接口加守卫之后（匿名跨家庭被拒，赛车路仍通） ===');
{
  const db = await newStack();

  const stateRev = async () => (await one(db, `select revision::int r from public.r5_racing_saves where family_id='${OFFICIAL}'`)).r;
  const dropsCount = async fam => (await one(db, `select count(*)::int c from public.r5_fragment_drops where family_id='${fam}'`)).c;
  const rev0 = await stateRev();
  const drops0 = await dropsCount(OFFICIAL);

  await asAnon(db);
  const d1 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('D1', 'anon 传别家 family → FORBIDDEN_SCOPE，返回里没有碎片字段',
    d1.status === 'FORBIDDEN_SCOPE' && d1.fragments === undefined, d1);

  const d2 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}', '${DEV_MOM}') as r`).catch(() => null);
  ok('D2', '旧快照函数签名未变（仍只有 1 个参数），多传参数会被数据库拒绝',
    d2 === null || d2.status === undefined, d2);

  const d3 = await rpc(db, `select public.r5_fragment_claim('${OTHER}', '${DEV_MOM}', 'lr-other-today-1', '{}'::jsonb) as r`);
  ok('D3', 'anon 拿自家设备令牌去领别家 → FORBIDDEN_SCOPE', d3.status === 'FORBIDDEN_SCOPE', d3);

  const d5 = await rpc(db, `select public.r5_fragment_claim('${OFFICIAL}', '${DEV_REVOKED}', 'lr-official-today-2', '{}'::jsonb) as r`);
  ok('D5', 'anon + 已撤销的设备令牌 → FORBIDDEN_SCOPE', d5.status === 'FORBIDDEN_SCOPE', d5);

  const d7 = await rpc(db, `select public.r5_fragment_assemble('${OFFICIAL}', 'r5dev_forged', 'frag_car_common_01', '{"frag_common":1}'::jsonb) as r`);
  ok('D7', 'anon 伪造设备令牌组装 → FORBIDDEN_SCOPE + zero_write',
    d7.status === 'FORBIDDEN_SCOPE' && d7.zero_write === true, d7);

  const d8a = await one(db, `select public.r5_fragment_scope_ok('', 'x') as empty`);
  await asServer(db);
  const d8b = await one(db, `select public.r5_fragment_scope_ok('${OFFICIAL}', '') as ok`);
  ok('D8', 'scope_ok 对空 family 一律 false；空设备在特权连接下视为「不声称设备」',
    d8b.ok === true && d8a.empty === false, { asServer: d8b, asAnon: d8a });

  // ---- 以下三条是「允许」路径，全部落在 synthetic-family-other-001，不碰正式家庭 ----
  const d4 = await rpc(db, `select public.r5_fragment_claim('${OTHER}', '${DEV_OTHER}', 'lr-other-today-1', '{}'::jsonb) as r`);
  ok('D4', '服务端连接 + 该家庭自己的老设备令牌 → 照常 CLAIMED（赛车那条路没坏）',
    d4.status === 'CLAIMED', d4 && d4.status);

  const d6 = await rpc(db, `select public.r5_fragment_claim('${OTHER}', '', 'lr-other-today-2', '{}'::jsonb) as r`);
  ok('D6', '服务端连接且不声称设备 → 放行（云函数直连形态）', d6.status === 'CLAIMED', d6 && d6.status);

  const d9 = await rpc(db, `select public.r5_fragment_claim('${OTHER}', '${DEV_OTHER}', 'lr-other-today-3', '{}'::jsonb) as r`);
  ok('D9', '设备路径可以连续领取（第三条记录仍 CLAIMED，未误伤）',
    d9.status === 'CLAIMED', d9 && d9.status);

  // 正常路径 2：登录家长
  await asParent(db, MOM);
  const d10 = await rpc(db, `select public.r5_fragment_snapshot('${OFFICIAL}') as r`);
  ok('D10', '登录家长读自家 → 正常返回', !!d10 && d10.fragments !== undefined, d10 && Object.keys(d10));
  const d11 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('D11', '登录家长读别家 → FORBIDDEN_SCOPE', d11.status === 'FORBIDDEN_SCOPE', d11);

  await asParent(db, 'r5-selftest-child');
  const d12 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('D12', 'child 账号读自家也不行（不是家长角色）→ FORBIDDEN_SCOPE', d12.status === 'FORBIDDEN_SCOPE', d12);

  await asService(db);
  const d13 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('D13', 'service_role → 放行（服务端任务不受影响）', !!d13 && d13.fragments !== undefined);

  await asServer(db);
  const d14 = await rpc(db, `select public.r5_fragment_snapshot('${OTHER}') as r`);
  ok('D14', '无 claims 的服务端连接（云函数/迁移）→ 放行', !!d14 && d14.fragments !== undefined);

  await asAnon(db);
  const d15 = await denied(() => rpc(db, `select public.r5_fragment_snapshot_internal('${OTHER}') as r`));
  ok('D15', '内部快照函数 anon 没有执行权（42501）', d15.denied && d15.code === '42501', d15);

  // E：被拒之后什么都没变
  await asServer(db);
  const revAfter = await stateRev();
  const dropsAfter = await dropsCount(OFFICIAL);
  ok('E1', '所有越权尝试之后，正式家庭 revision 未变', revAfter === rev0, { rev0, revAfter });
  ok('E2', '所有越权尝试之后，正式家庭 drops 未增（被拒=零写入）',
    dropsAfter === drops0, { drops0, dropsAfter });
  const offDrops = await one(db, `select count(*)::int c from public.r5_fragment_drops where family_id='${OTHER}' and source_record_id like 'x%'`);
  ok('E3', '被拒的跨家庭领取没有留下任何行', offDrops.c === 0, offDrops);
  const offSnap = await rpc(db, `select public.r5_fragment_snapshot('${OFFICIAL}') as r`);
  ok('E4', '正式家庭仍然是 0 片（本轮没给正式家庭补发任何碎片）',
    JSON.stringify(offSnap.fragments) === '{}' && JSON.stringify(offSnap.owned) === '{}', offSnap);

  // 旧签名兼容：三个函数参数列表与线上完全一致
  const sigs = await q(db, `select p.proname, pg_get_function_identity_arguments(p.oid) a
                              from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                             where ns.nspname='public'
                               and p.proname in ('r5_fragment_snapshot','r5_fragment_claim','r5_fragment_assemble')
                             order by 1`);
  ok('E5', '三个旧函数的签名一字未改（调用方无需改代码）',
    sigs.length === 3
    && sigs.find(s => s.proname === 'r5_fragment_snapshot').a === 'p_family text'
    && sigs.find(s => s.proname === 'r5_fragment_claim').a === 'p_family text, p_device text, p_record_id text, p_cfg jsonb'
    && sigs.find(s => s.proname === 'r5_fragment_assemble').a === 'p_family text, p_device text, p_vehicle_id text, p_cost jsonb',
    sigs);

  // 守卫仍在 trusted 边界内：搜索路径被钉死
  const cfg = await q(db, `select p.proname, coalesce(array_to_string(p.proconfig,','),'') c
                             from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                            where ns.nspname='public'
                              and p.proname in ('r5_fragment_snapshot','r5_fragment_claim','r5_fragment_assemble',
                                                'r5_fragment_member_snapshot','r5_fragment_member_assemble','r5_fragment_scope_ok')
                            order by 1`);
  ok('E6', '六个函数都钉死了 search_path（防 search_path 注入）',
    cfg.every(r => /search_path=/.test(r.c)), cfg);
  const definer = await q(db, `select p.proname, p.prosecdef d from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                where ns.nspname='public'
                                  and p.proname in ('r5_fragment_member_snapshot','r5_fragment_member_assemble','r5_fragment_scope_ok')`);
  ok('E7', '三个新函数都是 SECURITY DEFINER', definer.every(r => r.d === true), definer);

  await db.close();
}

/* ================================================================ 汇总 */
console.log('\n' + '='.repeat(60));
console.log(`TOTAL  ${passed}/${passed + failed} passed, ${failed} failed`);
if (failed) console.log('FAILED: ' + fails.join(', '));
console.log(failed ? 'VERDICT FAIL' : 'VERDICT PASS');
process.exit(failed ? 1 : 0);
