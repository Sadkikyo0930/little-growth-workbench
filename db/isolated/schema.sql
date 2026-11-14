-- ============================================================================
-- schema.sql —— 隔离验证用的**副本**，不是生产 DDL，不要在任何正式环境执行
--
-- 目的：在 WASM Postgres（PGlite）里重建一份与线上同形的库，
--       用来证明「旧函数能被绕过」「新函数绕不过」「守卫之后赛车路仍通」。
--
-- 与线上的对应关系（2026-11-14 只读核对）：
--   growth_family_members  PK (family_id,user_id)   RLS: 自读一行
--   r5_device              PK (device_uid)          RLS: on / 无策略 / 无 anon 权限
--   r5_racing_saves        PK (family_id)           RLS: on / 无策略 / 仅 service_role
--   r5_racing_events       PK (family_id,event_id)  RLS: on / 无策略 / 仅 service_role
--   r5_fragment_state      PK (family_id)           RLS: off
--   r5_fragment_drops      PK (family_id,source_record_id)  RLS: off
--   auth.jwt()             Supabase 内建函数，这里用同样的语义重写
-- ============================================================================

-- 角色（线上是平台预置的，这里手工建）
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$do$;

-- auth.jwt()：没有 claims 时返回空对象，与 Supabase 一致
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$function$;

-- ---------------------------------------------------------------- 表
CREATE TABLE public.growth_family_members (
  family_id   text        NOT NULL,
  user_id     text        NOT NULL,
  member_role text        NOT NULL,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);
ALTER TABLE public.growth_family_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY growth_members_self_select ON public.growth_family_members
  FOR SELECT TO authenticated USING (user_id = auth.jwt() ->> 'sub');
GRANT SELECT ON public.growth_family_members TO authenticated;

CREATE TABLE public.r5_device (
  device_uid text        NOT NULL PRIMARY KEY,
  family_id  text        NOT NULL,
  label      text        NOT NULL DEFAULT '孩子设备',
  bound_by   text        NOT NULL,
  bound_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  last_seen  timestamptz
);
ALTER TABLE public.r5_device ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.r5_racing_saves (
  family_id           text        NOT NULL PRIMARY KEY,
  schema_version      integer     NOT NULL DEFAULT 1,
  revision            bigint      NOT NULL DEFAULT 0,
  baseline_confirmed  boolean     NOT NULL DEFAULT false,
  baseline_coins      bigint      NOT NULL DEFAULT 0,
  baseline_source     text        NOT NULL DEFAULT '',
  baseline_device     text        NOT NULL DEFAULT '',
  baseline_confirmed_at timestamptz,
  coins_balance       bigint      NOT NULL DEFAULT 0,
  owned               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  current_vehicle     text        NOT NULL DEFAULT 'red',
  chapter1_state      text        NOT NULL DEFAULT 'idle',
  chapter2_state      text        NOT NULL DEFAULT 'idle',
  story               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  study               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  achievements        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reward_ledger       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  claims              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  coin_rewards        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  items               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  fragments           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_device   text        NOT NULL DEFAULT ''
);
ALTER TABLE public.r5_racing_saves ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.r5_racing_saves TO service_role;

CREATE TABLE public.r5_racing_events (
  family_id     text        NOT NULL,
  event_id      text        NOT NULL,
  kind          text        NOT NULL,
  coin_delta    bigint      NOT NULL DEFAULT 0,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  device        text        NOT NULL DEFAULT '',
  applied_at    timestamptz NOT NULL DEFAULT now(),
  result_balance bigint,
  PRIMARY KEY (family_id, event_id)
);
ALTER TABLE public.r5_racing_events ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.r5_racing_events TO service_role;

CREATE TABLE public.r5_fragment_state (
  family_id           text        NOT NULL PRIMARY KEY,
  pity_points         integer     NOT NULL DEFAULT 0,
  pity_total          integer     NOT NULL DEFAULT 0,
  daily_day           date        NOT NULL DEFAULT '1970-01-01',
  daily_normal_count  integer     NOT NULL DEFAULT 0,
  daily_rare_count    integer     NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.r5_fragment_state TO anon;
GRANT ALL ON public.r5_fragment_state TO authenticated, service_role;

CREATE TABLE public.r5_fragment_drops (
  family_id        text        NOT NULL,
  source_record_id text        NOT NULL,
  record_day       date        NOT NULL,
  record_kind      text        NOT NULL DEFAULT '',
  subject          text        NOT NULL DEFAULT '',
  outcome          text        NOT NULL,
  fragment_id      text,
  fragment_count   integer     NOT NULL DEFAULT 0,
  rare_fragment_id text,
  rare_count       integer     NOT NULL DEFAULT 0,
  pity_before      integer     NOT NULL DEFAULT 0,
  pity_after       integer     NOT NULL DEFAULT 0,
  daily_index      integer     NOT NULL DEFAULT 0,
  device           text        NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, source_record_id)
);
GRANT SELECT ON public.r5_fragment_drops TO anon;
GRANT ALL ON public.r5_fragment_drops TO authenticated, service_role;

-- ---------------------------------------------------------------- 学习记录
-- 与线上 growth_learning_records 同形（record_id PK / family_id / record_type /
-- subject / learning_day / record_data / created_at）。碎片领取只能认这张表里的真实记录。
CREATE TABLE public.growth_learning_records (
  record_id    text PRIMARY KEY,
  family_id    text NOT NULL,
  record_type  text NOT NULL,
  subject      text,
  learning_day integer,
  record_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.growth_learning_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY growth_records_family_select ON public.growth_learning_records
  FOR SELECT TO authenticated
  USING (family_id IN (
    SELECT m.family_id FROM public.growth_family_members m
     WHERE m.user_id = auth.jwt() ->> 'sub'));
GRANT SELECT ON public.growth_learning_records TO authenticated;

-- ---------------------------------------------------------------- 种子数据
-- 正式家庭：3 名家长（与线上 growth_family_members 完全一致的 user_id 与角色）
INSERT INTO public.growth_family_members (family_id, user_id, member_role) VALUES
  ('synthetic-family-main-001', 'test-parent-owner-001', 'owner'),        -- 爸爸
  ('synthetic-family-main-001', 'test-parent-member-002', 'parent'),       -- 妈妈
  ('synthetic-family-main-001', 'test-grandparent-003', 'grandparent'),  -- 外婆
  -- 另一家（用来验证跨家庭隔离）
  ('synthetic-family-other-001', 'r5-selftest-parent', 'owner'),
  ('synthetic-family-other-001', 'r5-selftest-child', 'child'),
  -- 一个账号挂两个家庭的边界数据
  ('synthetic-family-other-001', 'u-two-families', 'parent'),
  ('r5-other-family', 'u-two-families', 'parent');

INSERT INTO public.r5_device (device_uid, family_id, label, bound_by, revoked_at) VALUES
  ('r5dev_11111111111111111111111111111111', 'synthetic-family-main-001', 'Synthetic phone A', 'test-parent-owner-001', NULL),
  ('r5dev_22222222222222222222222222222222', 'synthetic-family-main-001', 'Synthetic phone B', 'test-parent-owner-001', NULL),
  ('r5dev_33333333333333333333333333333333', 'synthetic-family-main-001', 'Synthetic tablet C', 'test-parent-owner-001', NULL),
  ('r5dev_revoked_0000000000000000000001',   'synthetic-family-main-001', '已撤销设备', 'test-parent-owner-001', now()),
  ('r5-demo-device-0001', 'synthetic-family-other-001', '赛车测试站', 'r5-selftest-parent', NULL);

-- 两家都有存档（线上正式家庭也有 1 行存档，只是碎片为空）
INSERT INTO public.r5_racing_saves (family_id) VALUES
  ('synthetic-family-main-001'), ('synthetic-family-other-001');

-- 今天的真实学习记录（领取函数只认这里的 record_id）
-- 正式家庭：2 条答题 + 1 条课程完成（今天），外加 1 条昨天的用来验证 NOT_TODAY
INSERT INTO public.growth_learning_records (record_id, family_id, record_type, subject, learning_day, created_at) VALUES
  ('lr-official-today-1', 'synthetic-family-main-001', 'answer',          '语文', 9, now()),
  ('lr-official-today-2', 'synthetic-family-main-001', 'answer',          '英语', 1, now()),
  ('lr-official-today-3', 'synthetic-family-main-001', 'course-complete', '科学', 1, now()),
  ('lr-official-yesterday', 'synthetic-family-main-001', 'answer',        '数学', 6, now() - interval '1 day');

-- 测试家庭：4 条今天（够测设备路径连续领取 / 组装前后）
INSERT INTO public.growth_learning_records (record_id, family_id, record_type, subject, learning_day, created_at) VALUES
  ('lr-other-today-1', 'synthetic-family-other-001', 'answer',          '语文', 3, now()),
  ('lr-other-today-2', 'synthetic-family-other-001', 'answer',          '语文', 3, now()),
  ('lr-other-today-3', 'synthetic-family-other-001', 'answer',          '语文', 3, now()),
  ('lr-other-today-4', 'synthetic-family-other-001', 'course-complete', '英语', 1, now());
