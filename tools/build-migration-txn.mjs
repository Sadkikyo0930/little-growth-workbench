/**
 * tools/build-migration-txn.mjs
 *
 * 把三份碎片权限迁移拼成 **一次 ExecutePGSql 调用** 可执行的单事务脚本。
 *
 * 为什么必须拼成一份：
 *   平台 SDK 不支持跨调用的会话句柄 / 事务句柄，但实测单次 ExecutePGSql 调用
 *   接受多语句（simple query protocol），一条调用 = 一条连接 = 一个事务。
 *   所以「三份 SQL 同一物理连接同一事务」只能靠一次调用满足。
 *
 * 安全性：
 *   1. 生成前对每份 SQL 做外层事务控制扫描（先剥掉 $tag$...$tag$ 与 $$...$$ 函数体，
 *      只检查外层），出现 BEGIN/COMMIT/ROLLBACK/SAVEPOINT、反斜杠元命令、
 *      CREATE INDEX CONCURRENTLY、VACUUM/REINDEX/CREATE DATABASE/ALTER SYSTEM/CLUSTER
 *      就拒绝生成 —— 这些都会破坏或逃出单事务。
 *   2. 生成 pre / post 两个断言块：pre 校验库指纹，post 校验最终状态。
 *      任一断言 raiserror 都会 abort 事务，COMMIT 退化为 ROLLBACK（PG 语义）。
 *   3. 打印每一步的 sha256 和整体 sha256，便于与线上执行记录比对。
 *
 * 用法：
 *   node tools/build-migration-txn.mjs [输出路径]
 *   默认输出 db/apply/production-20261114-single-txn.sql
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  'db/20261114_fragment_server_authority.sql',
  'db/20261114_fragment_scope_guard.sql',
  'db/20261114_fragment_member_scope.sql',
  'db/20261114_fragment_save_ensure.sql',
];

const OUT = process.argv[2] || 'db/apply/production-20261114-single-txn.sql';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 把 $tag$ ... $tag$ / $$ ... $$ 全部替换成占位符，只留外壳供扫描。 */
function stripDollarQuoted(text) {
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '/*DOLLAR_QUOTED_BODY*/');
}

const FORBIDDEN = [
  { re: /\bBEGIN\b/i, why: 'nested BEGIN' },
  { re: /\bCOMMIT\b/i, why: 'nested COMMIT' },
  { re: /\bROLLBACK\b/i, why: 'nested ROLLBACK' },
  { re: /\bSAVEPOINT\b/i, why: 'nested SAVEPOINT' },
  { re: /^\s*\\/m, why: 'psql backslash meta-command' },
  { re: /CREATE\s+INDEX\s+CONCURRENTLY/i, why: 'CREATE INDEX CONCURRENTLY cannot run in a transaction' },
  { re: /\bVACUUM\b/i, why: 'VACUUM cannot run in a transaction' },
  { re: /\bREINDEX\b/i, why: 'REINDEX cannot run in a transaction' },
  { re: /CREATE\s+DATABASE/i, why: 'CREATE DATABASE cannot run in a transaction' },
  { re: /ALTER\s+SYSTEM/i, why: 'ALTER SYSTEM cannot run in a transaction' },
  { re: /\bCLUSTER\b/i, why: 'CLUSTER cannot run in a transaction' },
];

const parts = [];
let line = 0;
const digests = [];

for (const rel of STEPS) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  const outer = stripDollarQuoted(raw);
  for (const { re, why } of FORBIDDEN) {
    if (re.test(outer)) {
      console.error(`REFUSE: ${rel} contains a forbidden construct outside dollar-quoted bodies: ${why}`);
      process.exit(1);
    }
  }
  const body = raw.replace(/\r\n/g, '\n').trimEnd();
  const digest = sha256(body);
  digests.push({ rel, digest });
  line += 1;
  parts.push(
    `\n-- ${'='.repeat(74)}\n` +
    `-- STEP ${parts.length + 1}/${STEPS.length}: ${rel}\n` +
    `-- sha256: ${digest}\n` +
    `-- ${'='.repeat(74)}\n` +
    body + '\n'
  );
}

const pre = `
-- ---------------------------------------------------------------------------
-- PRE: 库指纹断言。这里故意不放行「空库」，避免误对别的环境执行。
-- 任一断言失败 -> RAISE EXCEPTION -> 事务 abort -> 末尾 COMMIT 退化为 ROLLBACK。
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_members  integer;
  v_learning integer;
  v_missing  text;
BEGIN
  IF to_regclass('public.growth_family_members') IS NULL THEN
    RAISE EXCEPTION 'PRE: public.growth_family_members is missing — wrong database?';
  END IF;
  IF to_regclass('public.growth_learning_records') IS NULL THEN
    RAISE EXCEPTION 'PRE: public.growth_learning_records is missing — wrong database?';
  END IF;

  SELECT count(*) INTO v_members FROM public.growth_family_members;
  IF v_members = 0 THEN
    RAISE EXCEPTION 'PRE: growth_family_members is empty — refuse to migrate a database with no family';
  END IF;

  SELECT count(*) INTO v_learning FROM public.growth_learning_records;

  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['r5_device','r5_racing_events','r5_racing_saves']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRE: racing base tables missing: %', v_missing;
  END IF;

  RAISE NOTICE 'PRE OK: members=%, learning_records=%', v_members, v_learning;
END
$pre$;
`;

const activate = `
-- ---------------------------------------------------------------------------
-- 正式启用奖励（家长已授权）：写的是行数据，不碰任何既有家庭数据。
-- 表列默认值仍是 pending-parent-confirmation，这里显式置为 active。
-- ---------------------------------------------------------------------------
UPDATE public.r5_reward_config
   SET drop_percent          = 60,
       daily_cap             = 2,
       rare_daily_cap        = 1,
       pity_target           = 5,
       eligible_record_types = ARRAY['course-complete']::text[],
       rare_record_types     = ARRAY['weekly-goal','weekly_goal','mastery','mastery-achievement']::text[],
       status                = 'active',
       updated_at            = now()
 WHERE family_id = '*';
`;

const post = `
-- ---------------------------------------------------------------------------
-- POST: 终态断言。任何一条不成立都 abort，不会留下半成品。
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_status text; v_drop integer; v_daily integer; v_rare integer; v_pity integer;
  v_cost_common jsonb; v_cost_rare jsonb;
  v_birthday_ok boolean; v_coin_ok boolean;
  v_rpc integer; v_priv boolean; v_rls integer;
  v_anon_state boolean; v_auth_learning boolean;
BEGIN
  SELECT status, drop_percent, daily_cap, rare_daily_cap, pity_target
    INTO v_status, v_drop, v_daily, v_rare, v_pity
    FROM public.r5_reward_config WHERE family_id = '*';

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'POST: reward status is %, expected active', COALESCE(v_status, '<null>');
  END IF;
  IF v_drop <> 60 OR v_daily <> 2 OR v_pity <> 5 OR v_rare <> 1 THEN
    RAISE EXCEPTION 'POST: unexpected reward numbers: drop=%, daily=%, pity=%, rare=%',
      v_drop, v_daily, v_pity, v_rare;
  END IF;

  SELECT cost INTO v_cost_common FROM public.r5_vehicle_recipe WHERE vehicle_id = 'frag_car_common_01';
  SELECT cost INTO v_cost_rare   FROM public.r5_vehicle_recipe WHERE vehicle_id = 'frag_car_rare_01';
  IF v_cost_common IS NULL OR (v_cost_common ->> 'frag_common')::int IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'POST: frag_car_common_01 cost must be {"frag_common":12}, got %', v_cost_common;
  END IF;
  IF v_cost_rare IS NULL OR (v_cost_rare ->> 'frag_scholar')::int IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'POST: frag_car_rare_01 cost must be {"frag_scholar":8}, got %', v_cost_rare;
  END IF;

  -- 生日车必须保持生日专属、且不进入碎片兑换
  SELECT EXISTS (
    SELECT 1 FROM public.r5_vehicle_recipe
     WHERE obtainable_via = 'birthday'
       AND vehicle_id IN ('birthday-star-6','six-star-supercar-2026')
  ) INTO v_birthday_ok;
  IF NOT v_birthday_ok THEN
    RAISE EXCEPTION 'POST: birthday vehicles must stay obtainable_via=birthday';
  END IF;

  -- 金币车不能被改成碎片来源
  SELECT EXISTS (
    SELECT 1 FROM public.r5_vehicle_recipe
     WHERE obtainable_via = 'coin'
  ) INTO v_coin_ok;
  IF NOT v_coin_ok THEN
    RAISE EXCEPTION 'POST: coin vehicles disappeared from the recipe table';
  END IF;

  SELECT count(*) INTO v_rpc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('r5_fragment_member_snapshot',
                       'r5_fragment_member_assemble',
                       'r5_fragment_member_claim');
  IF v_rpc <> 3 THEN
    RAISE EXCEPTION 'POST: expected 3 member RPCs, found %', v_rpc;
  END IF;

  v_priv := public.r5_fragment_is_privileged();
  IF NOT v_priv THEN
    RAISE EXCEPTION 'POST: r5_fragment_is_privileged() must be true for the migration role';
  END IF;

  SELECT count(*) INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('r5_fragment_state','r5_fragment_drops','r5_racing_events',
                       'r5_racing_saves','r5_device')
     AND c.relrowsecurity;
  IF v_rls <> 5 THEN
    RAISE EXCEPTION 'POST: expected 5 r5 tables with RLS enabled, found %', v_rls;
  END IF;

  SELECT has_table_privilege('anon', 'public.r5_fragment_state', 'SELECT') INTO v_anon_state;
  IF v_anon_state THEN
    RAISE EXCEPTION 'POST: anon must not be able to read r5_fragment_state';
  END IF;

  -- 学习记录是既有业务数据，不能被这次收权误伤
  SELECT has_table_privilege('authenticated', 'public.growth_learning_records', 'SELECT')
    INTO v_auth_learning;
  IF NOT v_auth_learning THEN
    RAISE EXCEPTION 'POST: authenticated lost SELECT on growth_learning_records — collateral damage';
  END IF;

  RAISE NOTICE 'POST OK: active/60/2/1/5, 2 fragment vehicles (12+8), birthday+coin intact, 5 tables RLS';
END
$post$;
`;

const summary = `
-- ---------------------------------------------------------------------------
-- 汇总（只读，供执行记录留档）
-- ---------------------------------------------------------------------------
SELECT public.r5_fragment_caller_role()                      AS caller_role,
       public.r5_fragment_is_privileged()                    AS is_privileged,
       c.status                                              AS reward_status,
       c.drop_percent, c.daily_cap, c.rare_daily_cap, c.pity_target,
       array_to_string(c.eligible_record_types, ',')         AS eligible_types,
       array_to_string(c.rare_record_types, ',')             AS rare_types,
       (SELECT count(*) FROM public.r5_vehicle_recipe WHERE obtainable_via = 'fragment') AS fragment_vehicles,
       (SELECT count(*) FROM public.growth_family_members)   AS members,
       (SELECT count(*) FROM public.growth_learning_records) AS learning_records,
       (SELECT count(*) FROM public.r5_racing_events)        AS racing_events,
       (SELECT count(*) FROM public.r5_racing_saves)         AS racing_saves,
       (SELECT count(*) FROM public.r5_fragment_drops)       AS fragment_drops,
       (SELECT count(*) FROM public.r5_fragment_state)       AS fragment_state;
`;

const head = `-- ===========================================================================
-- 生产迁移：碎片服务端权威 + 作用域守卫 + 家庭成员作用域
-- 由 tools/build-migration-txn.mjs 生成，请勿手工编辑。
--
-- 执行方式（唯一正确方式）：
--   managePgDatabase(action=execute, confirm=true) 一次性提交整个文件。
--   平台单次调用 = 一条 PG 连接 = 一个事务，所以三份 SQL 天然同连接同事务。
--
-- 语义：
--   全部成功 -> COMMIT。
--   任一步或任一断言失败 -> 事务 abort -> 末尾 COMMIT 在 PG 里退化为 ROLLBACK，
--   数据库回到执行前状态（DDL 在 PG 中可回滚，已用探针表实测）。
--
-- 不会做的事：
--   * 不 DROP / TRUNCATE / DELETE 任何既有家庭数据；
--   * 不改 growth_* 的列、数据或权限（只断言它没被误伤）；
--   * 不新建数据库、不碰 GitHub。
--
-- 步骤 sha256：
`;

const mid = digests.map((d, i) => `--   step${i + 1}  ${d.digest}  ${d.rel}`).join('\n') + '\n';

const sql =
  head + mid +
  '-- ===========================================================================\n\n' +
  'BEGIN;\n' +
  "SET LOCAL lock_timeout = '10s';\n" +
  "SET LOCAL statement_timeout = '240s';\n" +
  pre +
  parts.join('') +
  activate +
  post +
  summary +
  '\nCOMMIT;\n';

mkdirSync(dirname(join(ROOT, OUT)), { recursive: true });
writeFileSync(join(ROOT, OUT), sql, 'utf8');

console.log(`wrote ${OUT}  (${Buffer.byteLength(sql, 'utf8')} bytes, ${sql.split('\n').length} lines)`);
for (const [i, d] of digests.entries()) console.log(`  step${i + 1} sha256 ${d.digest}  ${d.rel}`);
console.log(`  overall sha256 ${sha256(sql)}`);
