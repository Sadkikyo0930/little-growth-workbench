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
