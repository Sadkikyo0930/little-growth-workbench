-- ===========================================================================
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
--   step1  05de9f4bb907f18166f73c46bbe41e101f2ded5618ac432d3328e233885eacb1  db/20261114_fragment_server_authority.sql
--   step2  56ff5b8d39851ec5f464be6c7a0cc388a9ba8654e5c88833c6e3da600fad7f99  db/20261114_fragment_scope_guard.sql
--   step3  9440bbd6e45c44750766a409aff70d1bce0e39d80bf4b9c356c2bf7cdcfcec8f  db/20261114_fragment_member_scope.sql
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '240s';

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

-- ==========================================================================
-- STEP 1/3: db/20261114_fragment_server_authority.sql
-- sha256: 05de9f4bb907f18166f73c46bbe41e101f2ded5618ac432d3328e233885eacb1
-- ==========================================================================
-- ============================================================================
-- 20261114_fragment_server_authority.sql   (step 1 of 3, **未执行**)
--
-- 这份文件只做一件事：把「奖励规则 + 车辆配方 + 谁是特权连接」变成**服务端数据**，
-- 让后面的函数有唯一事实来源可查。它不改任何函数的实现，也不动一张既有表的数据。
--
-- 为什么需要它（PR #3 审查阻断项 1 / 2 / 3）
--   阻断项 1：旧守卫把「没有 JWT claims」当成「可信服务端」。这个推断不成立——
--            谁能清掉 claims，谁就自动变成特权。必须改为**按数据库连接角色**判定，
--            并且允许在正式库里把角色写进白名单（r5_backend_role）。
--   阻断项 3：领取时调用方自己传 p_cfg（drop% / daily_cap / pity_target / record_day /
--            fragment_id），组装时自己传 p_cost。也就是说「掉几片、花几片」由调用方决定。
--            本文件把这些全部搬进表：r5_reward_config、r5_vehicle_recipe。
--
-- 三个文件的执行顺序（必须按序，缺一步就是「看起来安全」）
--   1) 20261114_fragment_server_authority.sql   ← 本文件：建配置表 + 角色白名单 + 种子
--   2) 20261114_fragment_scope_guard.sql        ：按角色重写守卫，claim/assemble 改为查表
--   3) 20261114_fragment_member_scope.sql       ：成员 RPC（只读快照 + 组装入口）
--
-- 回滚
--   DROP TABLE public.r5_backend_role, public.r5_reward_config, public.r5_vehicle_recipe;
--   三张表都是本文件新建的，没有任何既有表引用它们；删掉即回到今天的状态。
--
-- 安全口径
--   · 三张表全部开启 RLS 且**不建任何策略** → 只有表属主（迁移账号）能看到，
--     anon / authenticated 一旦查询就是 0 行（不是报错，也不会泄露配置）。
--   · 只给 service_role 精确授权，不给 PUBLIC。
--   · 不写 growth_family_members、不写 growth_learning_records、不写任何存档。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 谁是「特权数据库连接」
--    审查意见：不能靠 current_user 判断——SECURITY DEFINER 内 current_user 会切成函数属主。
--    实际可用的信号是 GUC `role`：PostgREST 用 SET [LOCAL] ROLE anon/authenticated，
--    这个 GUC 会如实反映调用方角色，而且 **不会被 SECURITY DEFINER 改写**。
--    没有 SET ROLE 时该 GUC 是 'none'，此时真实身份就是登录角色 session_user。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.r5_backend_role (
  role_name text PRIMARY KEY,
  note      text NOT NULL DEFAULT '',
  added_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.r5_backend_role IS
  '允许以「服务端身份」调用碎片函数的数据库角色白名单。apply 前必须先用第 6 节的探针确认实际角色。';

INSERT INTO public.r5_backend_role (role_name, note) VALUES
  ('postgres',     '库属主 / 云 API ExecutePGSql 通道'),
  ('service_role', 'PostgREST service key'),
  ('r5_backend',   '预留：如果将来给云函数建专用角色，把它加到这里')
ON CONFLICT (role_name) DO NOTHING;

ALTER TABLE public.r5_backend_role ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.r5_backend_role FROM PUBLIC;
REVOKE ALL ON public.r5_backend_role FROM anon, authenticated;
GRANT SELECT ON public.r5_backend_role TO service_role;


-- ---------------------------------------------------------------------------
-- 2. 奖励配置（服务端权威）
--    family_id = '*' 是全局默认；某个家庭要单独调参就插一行自己的 family_id。
--    当前值与既有云函数一致：60% / 每日 2 片 / 保底 5 次 / 稀有每日 1 片。
--    status 仍写 pending-parent-confirmation —— 本轮**没有**把 60% 定成正式规则。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.r5_reward_config (
  family_id             text PRIMARY KEY,
  common_fragment_id    text NOT NULL DEFAULT 'frag_common',
  rare_fragment_id      text NOT NULL DEFAULT 'frag_scholar',
  drop_percent          integer NOT NULL DEFAULT 60
                          CHECK (drop_percent BETWEEN 0 AND 100),
  daily_cap             integer NOT NULL DEFAULT 2
                          CHECK (daily_cap BETWEEN 0 AND 10),
  rare_daily_cap        integer NOT NULL DEFAULT 1
                          CHECK (rare_daily_cap BETWEEN 0 AND 10),
  pity_target           integer NOT NULL DEFAULT 5
                          CHECK (pity_target BETWEEN 2 AND 50),
  eligible_record_types text[] NOT NULL DEFAULT ARRAY['course-complete']::text[],
  rare_record_types     text[] NOT NULL DEFAULT
                          ARRAY['weekly-goal', 'weekly_goal', 'mastery', 'mastery-achievement']::text[],
  status                text   NOT NULL DEFAULT 'pending-parent-confirmation',
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.r5_reward_config IS
  '碎片掉落配置的唯一事实来源。领取函数只读这张表，不再接受调用方传 p_cfg。';

INSERT INTO public.r5_reward_config (family_id) VALUES ('*')
ON CONFLICT (family_id) DO NOTHING;

ALTER TABLE public.r5_reward_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.r5_reward_config FROM PUBLIC;
REVOKE ALL ON public.r5_reward_config FROM anon, authenticated;
GRANT SELECT ON public.r5_reward_config TO service_role;


-- ---------------------------------------------------------------------------
-- 3. 车辆配方 / 获取方式白名单（服务端权威）
--    obtainable_via 决定「这辆车能不能用碎片组装」，cost 决定「要几片」。
--    旧函数把这三类判断硬编码在 plpgsql 里（moto/turtle/scholar/生日车），
--    现在搬进表：改规则改数据，不改函数；组装时也再也不看客户端传的 p_cost。
--    pink-newyear* / pink-new-year* 这类前缀仍然在函数里按前缀拒绝（无法枚举）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.r5_vehicle_recipe (
  vehicle_id     text PRIMARY KEY,
  name           text NOT NULL,
  tier           text NOT NULL DEFAULT 'normal',
  cost           jsonb NOT NULL,
  obtainable_via text NOT NULL
                   CHECK (obtainable_via IN ('fragment', 'coin', 'story', 'birthday', 'retired', 'event')),
  enabled        boolean NOT NULL DEFAULT true,
  note           text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT r5_vehicle_recipe_cost_shape
    CHECK (jsonb_typeof(cost) = 'object' AND cost <> '{}'::jsonb)
);

COMMENT ON TABLE public.r5_vehicle_recipe IS
  '车辆白名单 + 组装成本。obtainable_via=fragment 的车才允许走碎片组装。';

INSERT INTO public.r5_vehicle_recipe (vehicle_id, name, tier, cost, obtainable_via, enabled, note) VALUES
  ('frag_car_common_01', '雷霆破晓', 'normal', '{"frag_common": 12}'::jsonb,  'fragment', true,  '12 片星星碎片'),
  ('frag_car_rare_01',   '秋名疾影', 'rare',   '{"frag_scholar": 8}'::jsonb, 'fragment', true,  '8 片学习徽章碎片'),
  ('moto',                  '摩托',   'normal', '{"coin": 1}'::jsonb, 'coin',     false, '金币购买车，碎片系统不提供第二条路径'),
  ('turtle',                '乌龟车', 'normal', '{"coin": 1}'::jsonb, 'coin',     false, '金币购买车，碎片系统不提供第二条路径'),
  ('scholar',               '学习奖励车', 'rare', '{"frag_scholar": 8}'::jsonb, 'retired', false, 'v1 遗留槽位，已冻结'),
  ('birthday-star-6',       '生日车', 'rare',   '{"event": 1}'::jsonb, 'birthday', false, '生日 / 限定车，永久隔离'),
  ('six-star-supercar-2026','六星超跑', 'rare', '{"event": 1}'::jsonb, 'birthday', false, '生日 / 限定车，永久隔离')
ON CONFLICT (vehicle_id) DO NOTHING;

ALTER TABLE public.r5_vehicle_recipe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.r5_vehicle_recipe FROM PUBLIC;
REVOKE ALL ON public.r5_vehicle_recipe FROM anon, authenticated;
GRANT SELECT ON public.r5_vehicle_recipe TO service_role;


-- ---------------------------------------------------------------------------
-- 4. 角色探针（apply 前后都用它，结论写进交付报告）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_caller_role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
           WHEN COALESCE(current_setting('role', true), 'none') IN ('', 'none')
             THEN session_user
           ELSE current_setting('role', true)
         END;
$function$;

COMMENT ON FUNCTION public.r5_fragment_caller_role() IS
  '调用方在数据库里的**有效角色**：优先 GUC role（不受 SECURITY DEFINER 影响），否则 session_user。';

CREATE OR REPLACE FUNCTION public.r5_fragment_is_privileged()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT public.r5_fragment_caller_role() AS role_name)
  SELECT EXISTS (
           SELECT 1 FROM public.r5_backend_role b, r WHERE b.role_name = r.role_name
         )
      OR EXISTS (
           SELECT 1 FROM pg_roles g, r
            WHERE g.rolname = r.role_name AND (g.rolsuper OR g.rolbypassrls)
         );
$function$;

COMMENT ON FUNCTION public.r5_fragment_is_privileged() IS
  '白名单角色、超级用户、或 BYPASSRLS 角色 = 特权；其他（anon/authenticated/未知）一律不是。';

REVOKE ALL ON FUNCTION public.r5_fragment_caller_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_is_privileged() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_caller_role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.r5_fragment_is_privileged() TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. 程序目录（展示用，与第 3 节同源，避免前端再留一份会漂移的副本）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_program_json()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'version', 'v2',
    'catalog_source', 'public.r5_vehicle_recipe',
    'common_fragment_id', c.common_fragment_id,
    'common_fragment_name', '星星碎片',
    'rare_fragment_id', c.rare_fragment_id,
    'rare_fragment_name', '学习徽章碎片',
    'daily_cap', c.daily_cap,
    'rare_daily_cap', c.rare_daily_cap,
    'pity_target', c.pity_target,
    'drop_percent', c.drop_percent,
    'drop_percent_status', c.status,
    'legacy_slots', jsonb_build_array('scholar'),
    'excluded_vehicles', COALESCE((
      SELECT jsonb_agg(v.vehicle_id ORDER BY v.vehicle_id)
        FROM public.r5_vehicle_recipe v
       WHERE v.obtainable_via = 'birthday'), '[]'::jsonb),
    'excluded_prefixes', jsonb_build_array('pink-newyear', 'pink-new-year'),
    'non_fragment_vehicles', COALESCE((
      SELECT jsonb_agg(v.vehicle_id ORDER BY v.vehicle_id)
        FROM public.r5_vehicle_recipe v
       WHERE v.obtainable_via IN ('coin', 'retired')), '[]'::jsonb),
    'vehicles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'vehicle_id', v.vehicle_id,
               'name', v.name,
               'tier', v.tier,
               'cost', v.cost,
               'drivable', true,
               'placeholder', false,
               'display_name_pending', false,
               'note', v.note) ORDER BY v.vehicle_id)
        FROM public.r5_vehicle_recipe v
       WHERE v.obtainable_via = 'fragment' AND v.enabled), '[]'::jsonb)
  )
  FROM (SELECT * FROM public.r5_reward_config WHERE family_id = '*') c;
$function$;

REVOKE ALL ON FUNCTION public.r5_fragment_program_json() FROM PUBLIC;
-- 只给已登录用户（anon 拿不到，避免把掉落参数白送出去）
GRANT EXECUTE ON FUNCTION public.r5_fragment_program_json() TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. apply 前必须跑的探针（只读，不改任何东西）
--    通过云 API ExecutePGSql 执行，返回的 role_name 才是 r5-racing-save 的真实连接角色。
--    如果它不是 postgres / service_role，必须先把它加进白名单，再执行第 2 个文件：
--      INSERT INTO public.r5_backend_role(role_name, note) VALUES ('<探针结果>', 'r5-racing-save 实际角色');
--
--  SELECT public.r5_fragment_caller_role() AS role_name,
--         public.r5_fragment_is_privileged() AS is_privileged;
--    期望：(postgres, true)  ← 若不是，停手，先加白名单
--
--  SELECT * FROM public.r5_backend_role;
--  SELECT * FROM public.r5_reward_config;
--  SELECT vehicle_id, obtainable_via, cost, enabled FROM public.r5_vehicle_recipe ORDER BY 1;
-- ============================================================================

-- ==========================================================================
-- STEP 2/3: db/20261114_fragment_scope_guard.sql
-- sha256: 56ff5b8d39851ec5f464be6c7a0cc388a9ba8654e5c88833c6e3da600fad7f99
-- ==========================================================================
-- ============================================================================
-- 20261114_fragment_scope_guard.sql  (v3, step 2 of 3, **未执行**)
--
-- 前置：先执行 20261114_fragment_server_authority.sql（建了 r5_backend_role /
--       r5_reward_config / r5_vehicle_recipe 三张表并写入种子）。
--
-- 这一版针对 PR #3 四条发布阻断项的改动，逐条对应：
--
--   阻断 1「空 JWT claims 直接放行」
--     旧写法：claims 为空 → RETURN true（把「没带身份」当成「可信服务端」）。
--     新写法：**先判定数据库连接角色**，再看 claims。
--       · 特权角色（r5_backend_role 白名单 / superuser / BYPASSRLS）→ 放行；
--         r5-racing-save 走云 API ExecutePGSql，就是这一类。
--       · anon / authenticated / 未知角色 → claims 为空一律拒绝；
--         有 claims 也只有「是该家庭的 owner/parent/grandparent」才放行。
--       · claims 里的 role=service_role **不再具备任何效力**（伪造无效，
--         证据是它只能来自 GUC role，而 GUC role 改不了）。
--     为什么不用 current_user：SECURITY DEFINER 内 current_user 会变成函数属主，
--     这就是旧实现不敢用它、转而看 claims 的原因。改用 GUC `role`——
--     它在 SECURITY DEFINER 内不被改写（隔离库实测，见 docs）。
--
--   阻断 2「设备 UID 不等于已验证认证」
--     旧写法：anon + 认识某个 device_uid → 放行。
--     新写法：**非特权连接完全不能走设备路径**，设备领取只走已鉴权的赛车网关
--     （网关在服务端用 r5_device 反查家庭、签 HMAC 再调云函数）。
--     特权连接如果声称了设备，设备必须确实绑定在该家庭且未撤销——
--     这是纵深防御：网关有 bug 也跨不了家庭。
--
--   阻断 3「领取/组装相信调用方参数」
--     r5_fragment_claim 的 p_cfg 与 r5_fragment_assemble 的 p_cost **全部不再采信**：
--       · 记录是否存在 / 属于哪个家庭 / 哪一天 / 什么类型 —— 查 growth_learning_records；
--       · 掉落概率 / 每日上限 / 保底 / 碎片 id —— 查 r5_reward_config；
--       · 车辆白名单 / 获取方式 / 成本 —— 查 r5_vehicle_recipe。
--     两个参数保留在签名里只为兼容既有调用方（云函数不用改），函数体一个字都不读它。
--
--   阻断 4「底层表可绕过 RPC 直接读写」
--     第 6 节：r5_fragment_state / r5_fragment_drops / r5_racing_events / r5_racing_saves
--     全部开 RLS + 收回 anon/authenticated 的所有权限，只留 service_role 与属主。
--     不再写成「可选注释」。
--
-- 赛车兼容性（先核实过才敢这么写）
--   链路：浏览器 x-r5-device → r5-gateway（服务端查 r5_device 反查家庭、签 r5_identity）
--         → 云函数 r5-racing-save（服务端调云 API ExecutePGSql）
--   两个云函数都不用 PostgREST 的 anon key，ExecutePGSql 是账号级凭据、库属主身份。
--   所以「anon 不能再用设备 UID 直接打 RPC」不影响赛车；赛车从来不走那条路。
--   落地前请先跑 authority 文件第 6 节的角色探针，确认返回值是 postgres/true。
--
-- 回滚
--   三个函数用 pg_get_functiondef 原文重建（原文存 db/isolated/functions-before.sql），
--   表权限按第 7 节的反向语句恢复。数据一行都不会动。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 范围判断（唯一入口，三个旧函数 + 两个新函数共用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_scope_ok(p_family text, p_device text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_privileged boolean;
  v_claims     jsonb;
  v_uid        text;
  v_dev        text;
BEGIN
  IF p_family IS NULL OR p_family = '' THEN
    RETURN false;
  END IF;
  IF p_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN false;
  END IF;

  v_privileged := public.r5_fragment_is_privileged();
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;

  -- ===== ① 非特权连接：只认 JWT 里的成员身份 =====
  IF NOT v_privileged THEN
    -- 没有 claims 就是没有身份。**绝不因为「没带 claims」而放行**（阻断项 1 的核心）。
    IF v_claims IS NULL OR v_claims = '{}'::jsonb THEN
      RETURN false;
    END IF;
    -- 说明：claims->>'role' 在这里完全没有用。伪造 role=service_role 也进不来，
    -- 因为数据库角色仍然是 anon/authenticated。
    v_uid := NULLIF(v_claims ->> 'sub', '');
    IF v_uid IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.growth_family_members m
       WHERE m.user_id = v_uid
         AND m.family_id = p_family
         AND m.member_role IN ('owner', 'parent', 'grandparent')
    );
  END IF;

  -- ===== ② 特权连接（云函数 / 迁移 / service_role）=====
  v_dev := NULLIF(p_device, '');
  IF v_dev IS NULL THEN
    RETURN true;                       -- 服务端直连且不声称任何设备
  END IF;

  -- 家长身份路径的审计标记 v6:<uid>：uid 必须是该家庭的家长成员
  IF left(v_dev, 3) = 'v6:' THEN
    v_uid := NULLIF(substr(v_dev, 4), '');
    IF v_uid IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.growth_family_members m
       WHERE m.user_id = v_uid
         AND m.family_id = p_family
         AND m.member_role IN ('owner', 'parent', 'grandparent')
    );
  END IF;

  -- 声称了设备：设备必须真的绑定在这个家庭且未撤销（纵深防御，不是认证）
  IF v_dev !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.r5_device d
     WHERE d.device_uid = v_dev
       AND d.family_id = p_family
       AND d.revoked_at IS NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.r5_fragment_scope_ok(text, text) IS
  '碎片函数的唯一范围判定：特权角色放行；非特权角色必须持家庭成员 JWT；设备 UID 不再单独作为凭证。';

REVOKE ALL ON FUNCTION public.r5_fragment_scope_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_scope_ok(text, text) TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. 无守卫的内部快照（只给属主与上面这些 SECURITY DEFINER 函数用）
--    函数体与线上 r5_fragment_snapshot 完全一致，只改了名字。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_snapshot_internal(p_family text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'fragments', COALESCE((
      SELECT jsonb_object_agg(t.k, t.q) FROM (
        SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
        FROM public.r5_racing_events x
        WHERE x.family_id = p_family AND x.kind = 'fragment_change'
          AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
        GROUP BY 1
      ) t), '{}'::jsonb),
    'owned', COALESCE((SELECT s.owned FROM public.r5_racing_saves s WHERE s.family_id = p_family), '{}'::jsonb),
    'revision', COALESCE((SELECT s.revision FROM public.r5_racing_saves s WHERE s.family_id = p_family), 0),
    'pity_points', COALESCE((SELECT st.pity_points FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'pity_total', COALESCE((SELECT st.pity_total FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'daily_day', COALESCE((SELECT st.daily_day::text FROM public.r5_fragment_state st WHERE st.family_id = p_family), ''),
    'daily_normal_count', COALESCE((SELECT st.daily_normal_count FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'daily_rare_count', COALESCE((SELECT st.daily_rare_count FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'drops_total', COALESCE((SELECT count(*) FROM public.r5_fragment_drops d WHERE d.family_id = p_family), 0)
  );
$function$;

REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. 对外快照（签名不变，老调用方无需改）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_snapshot(p_family text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.r5_fragment_scope_ok(p_family, NULL) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  RETURN public.r5_fragment_snapshot_internal(p_family);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 4. 领取（服务端权威：记录 / 概率 / 上限 / 保底 / 碎片 id 全部查表）
--    p_cfg 保留只为签名兼容，函数体不再读它任何一个字段。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_claim(p_family text, p_device text, p_record_id text, p_cfg jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg         public.r5_reward_config;
  v_kind        text;
  v_subject     text;
  v_day         date;
  v_today       date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_prev        public.r5_fragment_drops;
  v_state       public.r5_fragment_state;
  v_cap         int;
  v_pity_target int;
  v_frag        text;
  v_rare_frag   text;
  v_pity        int;
  v_daily       int;
  v_daily_rare  int;
  v_pity_exempt boolean := false;
  v_outcome     text;
  v_count       int := 0;
  v_rare_count  int := 0;
  v_pity_after  int := 0;
  v_daily_index int := 0;
  v_rev         bigint;
BEGIN
  -- ▼ 入口守卫（读写之前）：非特权连接必须持家庭成员 JWT
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  -- ▲

  IF p_family IS NULL OR p_family = '' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY', 'zero_write', true);
  END IF;
  IF p_record_id IS NULL OR p_record_id = '' OR length(p_record_id) > 160 THEN
    RETURN jsonb_build_object('status', 'BAD_RECORD_ID', 'zero_write', true);
  END IF;

  -- 幂等：同一条记录只结算一次
  SELECT * INTO v_prev FROM public.r5_fragment_drops d
   WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
  IF FOUND THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
      'status', 'ALREADY_CLAIMED', 'outcome', v_prev.outcome,
      'granted_normal', v_prev.fragment_count, 'granted_rare', v_prev.rare_count,
      'fragment_id', v_prev.fragment_id, 'rare_fragment_id', v_prev.rare_fragment_id,
      'pity_points', COALESCE((SELECT pity_points FROM public.r5_fragment_state WHERE family_id = p_family), 0),
      'claimed_at', v_prev.created_at, 'zero_write', true);
  END IF;

  -- ▼ 服务端验证真实学习记录（阻断项 3 的核心）
  SELECT r.record_type,
         COALESCE(r.subject, ''),
         (r.created_at AT TIME ZONE 'Asia/Shanghai')::date
    INTO v_kind, v_subject, v_day
    FROM public.growth_learning_records r
   WHERE r.record_id = p_record_id
     AND r.family_id = p_family;
  IF NOT FOUND THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'RECORD_NOT_FOUND', 'zero_write', true);
  END IF;
  IF v_day <> v_today THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'NOT_TODAY', 'record_day', v_day::text, 'zero_write', true);
  END IF;
  -- ▲

  -- ▼ 服务端配置（掉落概率 / 上限 / 保底 / 碎片 id）
  SELECT * INTO v_cfg FROM public.r5_reward_config c WHERE c.family_id = p_family;
  IF NOT FOUND THEN
    SELECT * INTO v_cfg FROM public.r5_reward_config c WHERE c.family_id = '*';
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'CONFIG_MISSING', 'zero_write', true);
  END IF;

  -- Explicit parent approval is a hard authorization gate, not merely a UI label.
  -- Must exit before any claim row, pity counter, fragment event or save revision write.
  -- A zero drop percent is NOT a substitute: pity and rare awards have separate paths.
  IF v_cfg.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object(
      'status', 'REWARD_NOT_ACTIVE',
      'config_status', v_cfg.status,
      'zero_write', true
    );
  END IF;

  v_cap := GREATEST(0, v_cfg.daily_cap);
  v_pity_target := GREATEST(2, v_cfg.pity_target);
  v_frag := NULLIF(v_cfg.common_fragment_id, '');
  v_rare_frag := NULLIF(v_cfg.rare_fragment_id, '');
  -- ▲

  SELECT s.revision INTO v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'SAVE_NOT_INITIALIZED', 'zero_write', true);
  END IF;

  -- The same course/day/subject may be uploaded on several authorized devices
  -- with different record IDs. Locking the family save above serializes this check.
  -- Only one of these cloud records may earn a fragment reward.
  IF v_kind = 'course-complete' THEN
    SELECT * INTO v_prev FROM public.r5_fragment_drops d
     WHERE d.family_id = p_family
       AND d.record_day = v_day
       AND d.record_kind = v_kind
       AND d.subject = v_subject
     ORDER BY d.created_at, d.source_record_id LIMIT 1;
    IF FOUND THEN
      RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
        'status','ALREADY_CLAIMED', 'duplicate_course',true,
        'granted_normal',v_prev.fragment_count,
        'granted_rare',v_prev.rare_count, 'zero_write',true);
    END IF;
  END IF;

  INSERT INTO public.r5_fragment_state (family_id) VALUES (p_family)
  ON CONFLICT (family_id) DO NOTHING;
  SELECT * INTO v_state FROM public.r5_fragment_state st
   WHERE st.family_id = p_family FOR UPDATE;

  IF v_state.daily_day = v_today THEN
    v_pity := v_state.pity_points;
    v_daily := v_state.daily_normal_count;
    v_daily_rare := v_state.daily_rare_count;
  ELSE
    v_pity := v_state.pity_points;
    v_daily := 0;
    v_daily_rare := 0;
  END IF;

  -- 记录类型不在白名单 → 不产出、也不消耗保底
  IF NOT (v_kind = ANY (v_cfg.eligible_record_types)) THEN
    v_outcome := 'none';
    v_pity_exempt := true;
  ELSIF v_daily >= v_cap THEN
    v_outcome := 'capped';
    v_pity_exempt := true;
  ELSIF (random() * 100) < v_cfg.drop_percent THEN
    v_outcome := 'drop';
  ELSE
    v_outcome := 'none';
  END IF;

  IF v_outcome = 'drop' THEN
    v_count := 1;
    v_daily_index := v_daily + 1;
    v_pity_after := 0;
  ELSIF v_outcome = 'none' THEN
    IF v_pity_exempt THEN
      v_pity_after := v_pity;
    ELSE
      v_pity_after := v_pity + 1;
      IF v_pity_after >= v_pity_target THEN
        v_outcome := 'pity';
        v_count := 1;
        v_daily_index := v_daily + 1;
        v_pity_after := 0;
      END IF;
    END IF;
  ELSE
    v_pity_after := v_pity;
  END IF;

  IF v_kind = ANY (v_cfg.rare_record_types)
     AND v_rare_frag IS NOT NULL
     AND v_daily_rare < v_cfg.rare_daily_cap THEN
    v_rare_count := 1;
  END IF;

  INSERT INTO public.r5_fragment_drops (
    family_id, source_record_id, record_day, record_kind, subject, outcome,
    fragment_id, fragment_count, rare_fragment_id, rare_count,
    pity_before, pity_after, daily_index, device)
  VALUES (
    p_family, p_record_id, v_day, v_kind, v_subject, v_outcome,
    CASE WHEN v_count > 0 THEN v_frag ELSE NULL END, v_count,
    CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END, v_rare_count,
    v_pity, v_pity_after, v_daily_index, COALESCE(p_device, ''))
  ON CONFLICT (family_id, source_record_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_prev FROM public.r5_fragment_drops d
     WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
      'status', 'ALREADY_CLAIMED', 'outcome', v_prev.outcome,
      'granted_normal', v_prev.fragment_count, 'granted_rare', v_prev.rare_count,
      'zero_write', true);
  END IF;

  IF v_count > 0 AND v_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id, 'fragment_change', 0,
      jsonb_build_object('item_id', v_frag, 'quantity_delta', v_count, 'source', 'study',
                         'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject,
                         'record_day', v_day::text, 'outcome', v_outcome, 'pity_after', v_pity_after),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  IF v_rare_count > 0 AND v_rare_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id || ':rare', 'fragment_change', 0,
      jsonb_build_object('item_id', v_rare_frag, 'quantity_delta', v_rare_count, 'source', 'study-rare',
                         'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject,
                         'record_day', v_day::text),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  UPDATE public.r5_fragment_state st
     SET pity_points = v_pity_after,
         pity_total = st.pity_total + CASE WHEN v_outcome = 'pity' THEN 1 ELSE 0 END,
         daily_day = v_today,
         daily_normal_count = v_daily + v_count,
         daily_rare_count = v_daily_rare + v_rare_count,
         updated_at = now()
   WHERE st.family_id = p_family;

  UPDATE public.r5_racing_saves s
     SET revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
    'status', 'CLAIMED', 'outcome', v_outcome,
    'granted_normal', v_count, 'granted_rare', v_rare_count,
    'fragment_id', CASE WHEN v_count > 0 THEN v_frag ELSE NULL END,
    'rare_fragment_id', CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END,
    'pity_points', v_pity_after, 'pity_before', v_pity,
    'daily_normal_count', v_daily + v_count, 'daily_rare_count', v_daily_rare + v_rare_count,
    'daily_index', v_daily_index, 'record_day', v_day::text, 'record_kind', v_kind,
    'zero_write', false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 5. 组装（服务端权威：车辆白名单 / 获取方式 / 成本全部查表）
--    p_cost 保留只为签名兼容，函数体不再读它。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_assemble(p_family text, p_device text, p_vehicle_id text, p_cost jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipe public.r5_vehicle_recipe;
  v_game_vehicle_id text;
  v_cost   jsonb;
  v_owned  jsonb;
  v_rev    bigint;
  v_bal    jsonb;
  v_deficit jsonb := '{}'::jsonb;
  v_k      text;
  v_q      int;
  v_have   bigint;
BEGIN
  -- ▼ 入口守卫（读写之前）
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  -- ▲

  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status', 'BAD_VEHICLE_ID', 'zero_write', true);
  END IF;

  -- 前缀类限定车无法枚举，只能按前缀拒绝
  IF p_vehicle_id LIKE 'pink-newyear%' OR p_vehicle_id LIKE 'pink-new-year%' THEN
    RETURN jsonb_build_object('status', 'BIRTHDAY_VEHICLE_FORBIDDEN', 'zero_write', true);
  END IF;

  -- ▼ 车辆白名单 / 获取方式（服务端表）
  SELECT * INTO v_recipe FROM public.r5_vehicle_recipe r WHERE r.vehicle_id = p_vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'UNKNOWN_VEHICLE', 'zero_write', true);
  END IF;
  -- 先判获取方式（更具体的拒绝原因），再看开关
  CASE v_recipe.obtainable_via
    WHEN 'fragment' THEN
      NULL;
    WHEN 'birthday' THEN
      RETURN jsonb_build_object('status', 'BIRTHDAY_VEHICLE_FORBIDDEN', 'zero_write', true);
    WHEN 'coin' THEN
      RETURN jsonb_build_object('status', 'COIN_VEHICLE_FORBIDDEN', 'zero_write', true);
    WHEN 'retired' THEN
      RETURN jsonb_build_object('status', 'LEGACY_SLOT_RETIRED', 'zero_write', true);
    ELSE
      RETURN jsonb_build_object('status', 'VEHICLE_NOT_ASSEMBLABLE', 'zero_write', true);
  END CASE;
  IF NOT v_recipe.enabled THEN
    RETURN jsonb_build_object('status', 'VEHICLE_DISABLED', 'zero_write', true);
  END IF;

  -- One canonical V6 recipe maps to one V2 drivable vehicle (no extra debit).
  v_game_vehicle_id := CASE p_vehicle_id
    WHEN 'frag_car_common_01' THEN 'frag_common'
    WHEN 'frag_car_rare_01' THEN 'frag_rare'
    ELSE p_vehicle_id
  END;
  -- 成本只认表里的，客户端传什么都不看
  v_cost := v_recipe.cost;
  IF v_cost IS NULL OR jsonb_typeof(v_cost) <> 'object' OR v_cost = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'RECIPE_INVALID', 'zero_write', true);
  END IF;
  -- ▲

  SELECT s.owned, s.revision INTO v_owned, v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'SAVE_NOT_INITIALIZED', 'zero_write', true);
  END IF;

  IF v_owned ? p_vehicle_id OR v_owned ? v_game_vehicle_id THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'ALREADY_OWNED', 'vehicle_id', p_vehicle_id, 'zero_write', true);
  END IF;

  IF EXISTS (SELECT 1 FROM public.r5_racing_events e
              WHERE e.family_id = p_family AND e.event_id = 'asm:' || p_vehicle_id) THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'ALREADY_ASSEMBLED', 'vehicle_id', p_vehicle_id, 'zero_write', true);
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.k, t.q), '{}'::jsonb) INTO v_bal FROM (
    SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
    FROM public.r5_racing_events x
    WHERE x.family_id = p_family AND x.kind = 'fragment_change'
      AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
    GROUP BY 1
  ) t;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(v_cost) LOOP
    v_have := COALESCE((v_bal->>v_k)::bigint, 0);
    IF v_have < v_q THEN
      v_deficit := v_deficit || jsonb_build_object(v_k, v_q - v_have);
    END IF;
  END LOOP;

  IF v_deficit <> '{}'::jsonb THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'INSUFFICIENT_FRAGMENTS', 'vehicle_id', p_vehicle_id,
                            'required', v_cost, 'deficit', v_deficit, 'zero_write', true);
  END IF;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(v_cost) LOOP
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'asm:' || p_vehicle_id || ':' || v_k, 'fragment_change', 0,
      jsonb_build_object('item_id', v_k, 'quantity_delta', -v_q, 'source', 'assemble', 'vehicle_id', p_vehicle_id),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
  VALUES (p_family, 'asm:' || p_vehicle_id, 'grant', 0,
    jsonb_build_object('vehicle_id', p_vehicle_id, 'source', 'fragment-assembly', 'cost', v_cost),
    COALESCE(p_device, ''), now(), NULL)
  ON CONFLICT (family_id, event_id) DO NOTHING;

  UPDATE public.r5_racing_saves s
     SET owned = COALESCE(s.owned, '{}'::jsonb)
              || jsonb_build_object(p_vehicle_id,
                 jsonb_build_object('at', (extract(epoch from now())*1000)::bigint,
                                    'source', 'fragment-assembly', 'note', '碎片组装'))
              || jsonb_build_object(v_game_vehicle_id,
                 jsonb_build_object('at', (extract(epoch from now())*1000)::bigint,
                                    'source', 'fragment-assembly', 'note', '碎片组装')),
         revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
    'status', 'ASSEMBLED', 'vehicle_id', p_vehicle_id, 'game_vehicle_id', v_game_vehicle_id,
    'cost', v_cost, 'zero_write', false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 6. 表权限收紧（阻断项 4，不再是「可选注释」）
--    思路：奖励相关的表只有「属主（迁移/云函数通道）」和 service_role 能碰，
--    anon / authenticated 一律没有任何权限；RLS 同时开启，双保险。
--    不改任何一行的数据，也不删表。
-- ---------------------------------------------------------------------------
ALTER TABLE public.r5_fragment_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_fragment_drops  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_racing_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_racing_saves   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_device          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.r5_fragment_state  FROM PUBLIC;
REVOKE ALL ON public.r5_fragment_drops  FROM PUBLIC;
REVOKE ALL ON public.r5_racing_events   FROM PUBLIC;
REVOKE ALL ON public.r5_racing_saves    FROM PUBLIC;
REVOKE ALL ON public.r5_device          FROM PUBLIC;

REVOKE ALL ON public.r5_fragment_state  FROM anon, authenticated;
REVOKE ALL ON public.r5_fragment_drops  FROM anon, authenticated;
REVOKE ALL ON public.r5_racing_events   FROM anon, authenticated;
REVOKE ALL ON public.r5_racing_saves    FROM anon, authenticated;
REVOKE ALL ON public.r5_device          FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_fragment_state TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_fragment_drops TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_racing_events  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_racing_saves   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_device         TO service_role;

-- 学习记录表**不动**：V6 页面本来就用登录会话读自己的记录，收权会直接打断学习进度。


-- ---------------------------------------------------------------------------
-- 7. apply 后自检（三条都要符合期望值）
-- ---------------------------------------------------------------------------
-- 7.1 角色与特权
-- SELECT public.r5_fragment_caller_role(), public.r5_fragment_is_privileged();   -- 期望 postgres / true
--
-- 7.2 非特权连接必须拿不到东西（在 PostgREST 侧用 anon key 打这两个接口）
--   POST /rest/v1/rpc/r5_fragment_snapshot  {"p_family":"little-growth-family-001"}
--     → {"status":"FORBIDDEN_SCOPE","zero_write":true}
--   POST /rest/v1/rpc/r5_fragment_claim     {"p_family":"...","p_device":"r5dev_...","p_record_id":"..."}
--     → {"status":"FORBIDDEN_SCOPE","zero_write":true}
--   GET  /rest/v1/r5_fragment_drops?select=*     → 空数组或 401（不再是明文数据）
--
-- 7.3 表权限
-- SELECT c.relname,
--        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
--        has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='public'
--    AND c.relname IN ('r5_fragment_state','r5_fragment_drops','r5_racing_events','r5_racing_saves','r5_device');
--   期望：anon_select 全 false，auth_insert 全 false
--
-- 7.4 函数权限（anon 仍然可以 EXECUTE，但都会在入口被挡；内部快照 anon 必须 false）
-- SELECT has_function_privilege('anon','public.r5_fragment_snapshot_internal(text)','EXECUTE');  -- 期望 false
--
-- 8. 回滚
--   三个函数按 db/isolated/functions-before.sql 里的原文重建；
--   表权限反向执行：
--     GRANT SELECT ON public.r5_fragment_state, public.r5_fragment_drops TO anon;
--     GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.r5_fragment_state, public.r5_fragment_drops TO authenticated;
--     ALTER TABLE public.r5_fragment_state DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.r5_fragment_drops DISABLE ROW LEVEL SECURITY;
-- ============================================================================

-- ==========================================================================
-- STEP 3/3: db/20261114_fragment_member_scope.sql
-- sha256: 9440bbd6e45c44750766a409aff70d1bce0e39d80bf4b9c356c2bf7cdcfcec8f
-- ==========================================================================
-- ============================================================================
-- 20261114_fragment_member_scope.sql  (v3, step 3 of 3, **未执行**)
-- 「按登录身份读/组装碎片」的服务端封装
--
-- v3 改动（对应 PR #3 审查阻断项 3）
--   · r5_fragment_member_assemble 不再自带成本白名单：成本与车辆白名单只认
--     public.r5_vehicle_recipe（由 step 1 建立、step 2 的 assemble 读取）；
--     本函数只负责「把身份换成家庭」，然后把 p_cost 传空对象下去。
--   · r5_fragment_member_snapshot 额外返回 program（服务端目录），
--     前端不再依赖自己那份 catalog.mjs 作为事实来源。
--
-- 执行顺序：先 step 1 authority，再 step 2 scope_guard，最后本文件。
--
-- 成员模型（重要，别搞反）
--   public.growth_family_members 主键 = (family_id, user_id)
--   → 一个家庭可以有**多名成员**（爸爸 owner / 妈妈 parent / 外婆 grandparent 都合法）；
--   → 约束是「**每个登录账号的家庭归属唯一**」：同一个 user_id 只能落在 1 个 family_id 上，
--     落到 2 个家庭时本函数拒绝（AMBIGUOUS_MEMBER），不替家长二选一。
--   本文件**不 INSERT / UPDATE / DELETE 任何成员行**，三名家长的成员资格原样保留。
--
-- 回滚：DROP FUNCTION 两个新函数即可；既有数据、成员表都不受影响。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 只读：按登录身份取家庭碎片
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    text;
  v_fams   text[];
  v_family text;
  v_role   text;
BEGIN
  v_uid := NULLIF(auth.jwt() ->> 'sub', '');
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED');
  END IF;

  -- 同一账号在同一家庭只能有一行（主键约束），这里仍用 DISTINCT：
  -- 防的是「一个账号挂多个家庭」，不是「一个家庭有多名成员」。
  SELECT array_agg(DISTINCT m.family_id)
    INTO v_fams
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid
     AND m.member_role IN ('owner', 'parent', 'grandparent');

  IF v_fams IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_MEMBER');
  END IF;
  IF array_length(v_fams, 1) <> 1 THEN
    -- 一个账号挂多个家庭时不替用户选，交给家长入口处理
    RETURN jsonb_build_object('status', 'AMBIGUOUS_MEMBER', 'families', to_jsonb(v_fams));
  END IF;

  v_family := v_fams[1];
  IF v_family IS NULL OR v_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY');
  END IF;

  -- role 只用于页面标注「以什么身份查看」，不参与授权判断（授权只看成员行是否存在）
  SELECT m.member_role INTO v_role
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid AND m.family_id = v_family;

  -- 只读：直接复用既有快照函数，不在这里重新算余额
  RETURN public.r5_fragment_snapshot(v_family)
    || jsonb_build_object(
         'status', 'OK',
         'family_id', v_family,
         'family_source', 'growth_family_members',
         'member_role', v_role,
         'member_uid', v_uid,
         'zero_write', true,
         -- 服务端目录：车辆白名单 / 成本 / 掉落参数都来自 r5_vehicle_recipe 与 r5_reward_config
         'program', public.r5_fragment_program_json()
       );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. 组装：只负责「身份 → 家庭」，成本与白名单交给服务端配方表
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_assemble(p_vehicle_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    text;
  v_fams   text[];
  v_family text;
  v_device text;
BEGIN
  v_uid := NULLIF(auth.jwt() ->> 'sub', '');
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED', 'zero_write', true);
  END IF;

  SELECT array_agg(DISTINCT m.family_id) INTO v_fams
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid
     AND m.member_role IN ('owner', 'parent', 'grandparent');

  IF v_fams IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_MEMBER', 'zero_write', true);
  END IF;
  IF array_length(v_fams, 1) <> 1 THEN
    RETURN jsonb_build_object('status', 'AMBIGUOUS_MEMBER', 'zero_write', true);
  END IF;
  v_family := v_fams[1];
  IF v_family IS NULL OR v_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY', 'zero_write', true);
  END IF;

  -- 车辆 ID 形态先过一遍（与旧函数同一套正则），避免把奇怪字符串带进事件 ID。
  -- 不在白名单 / 不是碎片车 / 成本多少，全部由 r5_fragment_assemble 查
  -- public.r5_vehicle_recipe 决定；本函数不揣任何成本，也不允许调用方自带价格。
  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status', 'BAD_VEHICLE_ID', 'zero_write', true);
  END IF;

  -- 设备列只做审计，不参与授权（身份已经是家长本人）
  v_device := 'v6:' || v_uid;

  RETURN public.r5_fragment_assemble(v_family, v_device, p_vehicle_id, '{}'::jsonb);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 2b. Authenticated V6: claim only an already-persisted learning record.
-- Family is derived from JWT member lookup; no browser-provided family,
-- drop percentage, vehicle price, or device authority is accepted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_claim(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_family text;
  v_uid text;
BEGIN
  v_snapshot := public.r5_fragment_member_snapshot();
  IF v_snapshot IS NULL OR v_snapshot->>'status' IS DISTINCT FROM 'OK' THEN
    RETURN jsonb_build_object(
      'status', COALESCE(v_snapshot->>'status','UNAUTHENTICATED'),
      'zero_write', true
    );
  END IF;
  v_family := NULLIF(v_snapshot->>'family_id', '');
  v_uid := NULLIF(auth.jwt()->>'sub','');
  IF v_family IS NULL OR v_uid IS NULL THEN
    RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
  END IF;
  RETURN public.r5_fragment_claim(v_family,'v6:' || v_uid,p_record_id,'{}'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. 授权：家长身份三个 RPC 只允许 authenticated 执行。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.r5_fragment_member_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_member_assemble(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_member_claim(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_assemble(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_claim(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. 预检（只读，跑完看清楚再决定是否继续）
-- ---------------------------------------------------------------------------
-- 4.1 正式家庭的成员：**应当是 3 行**（owner / parent / grandparent），
--     并且每个 user_id 只能出现在 1 个家庭里。期望输出：
--       little-growth-family-001 | owner       | 1
--       little-growth-family-001 | parent      | 1
--       little-growth-family-001 | grandparent | 1
--       (0 rows)  ← 第二段「一个账号挂多个家庭」必须是空
--
-- SELECT family_id, member_role, count(*) AS members
--   FROM public.growth_family_members
--  WHERE family_id = 'little-growth-family-001'
--  GROUP BY 1, 2 ORDER BY 2;
--
-- SELECT user_id, count(DISTINCT family_id) AS families
--   FROM public.growth_family_members
--  GROUP BY 1 HAVING count(DISTINCT family_id) > 1;
--
-- 4.2 正式家庭当前的碎片/车辆（应当是 0 片、无车）
-- SELECT public.r5_fragment_snapshot('little-growth-family-001');
--
-- 4.3 应用后自检：两个新函数的权限（anon 必须没有）
-- SELECT p.proname,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('r5_fragment_member_snapshot','r5_fragment_member_assemble');
--
-- 5. 旧函数的 p_family 口子：**不在本文件处理**，见
--    20261114_fragment_scope_guard.sql（同样未执行，需要单独批准）。
-- ============================================================================

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

COMMIT;
