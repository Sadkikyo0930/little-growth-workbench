-- V6 每周学习达标奖励：每个自然周（Asia/Shanghai 周一至周日）
-- 5 个不同学习日期，每日云端确认至少 2 门不同科目的 course-complete。
-- 达标后固定奖励 frag_scholar x1；绝不抽取随机数，也不改变普通碎片 60%。
-- 通过登录会话推导家庭，不接收 family_id；重复/跨设备只结算一次。
-- 生产发布必须在真实 CloudBase 连接上单事务审查执行，不能靠独立 ExecutePGSql 多调用假设原子性。

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 只允许每周目标产生专属碎片，停用历史“掌握成就”来源。
ALTER TABLE public.r5_reward_config
  ALTER COLUMN rare_record_types SET DEFAULT ARRAY['weekly-goal']::text[];
UPDATE public.r5_reward_config
   SET rare_record_types = ARRAY['weekly-goal']::text[],
       updated_at = now()
 WHERE family_id = '*';

CREATE OR REPLACE FUNCTION public.r5_fragment_member_weekly_claim()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_family text;
  v_uid text;
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_week date := date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_days integer := 0;
  v_record text;
  v_result jsonb;
BEGIN
  -- 与现有家长领取接口使用同一份家庭成员身份验证。
  v_snapshot := public.r5_fragment_member_snapshot();
  IF v_snapshot IS NULL OR v_snapshot->>'status' IS DISTINCT FROM 'OK' THEN
    RETURN jsonb_build_object('status', COALESCE(v_snapshot->>'status', 'UNAUTHENTICATED'), 'zero_write', true);
  END IF;
  v_family := NULLIF(v_snapshot->>'family_id', '');
  v_uid := NULLIF(auth.jwt()->>'sub', '');
  IF v_family IS NULL OR v_uid IS NULL OR length(v_family) > 64
     OR v_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
  END IF;
  v_record := 'r5-weekly-' || v_family || '-' || to_char(v_week, 'YYYYMMDD');

  -- 已结算的本周奖励不重复写入；返回现有账本的结果。
  IF EXISTS (
    SELECT 1 FROM public.r5_fragment_drops
     WHERE family_id = v_family AND source_record_id = v_record
  ) THEN
    RETURN public.r5_fragment_member_claim(v_record);
  END IF;

  -- 服务端判定，不接受客户端自报“达标”或答题分数。
  -- 一天的两科只能来自同一家庭已入库的课程完成事件。
  SELECT count(*) INTO v_days FROM (
    SELECT (r.created_at AT TIME ZONE 'Asia/Shanghai')::date AS study_date
      FROM public.growth_learning_records r
     WHERE r.family_id = v_family AND r.record_type = 'course-complete'
       AND r.subject IN ('语文','数学','英语','科学')
       AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN v_week AND v_today
     GROUP BY (r.created_at AT TIME ZONE 'Asia/Shanghai')::date
    HAVING count(DISTINCT r.subject) >= 2
  ) AS completed_days;

  IF v_days < 5 THEN
    RETURN jsonb_build_object('status','WEEKLY_GOAL_NOT_MET','completed_days',v_days,
                              'required_days',5,'subjects_per_day',2,'zero_write',true);
  END IF;

  -- 防止同日其它历史稀有奖励占用日上限而让周奖永久记成 0 片。
  IF EXISTS (
    SELECT 1 FROM public.r5_fragment_state s
     WHERE s.family_id = v_family
       AND s.daily_day = v_today
       AND s.daily_rare_count >= 1
  ) THEN
    RETURN jsonb_build_object('status','WEEKLY_RARE_DAY_LIMIT','zero_write',true);
  END IF;

  -- 唯一稳定 ID 兼顾重复请求/多设备竞争；由服务端写入达标凭据。
  INSERT INTO public.growth_learning_records
       (record_id, family_id, record_type, subject, learning_day, record_data, created_by)
  VALUES (v_record, v_family, 'weekly-goal', '每周学习目标', NULL,
          jsonb_build_object('source','r5-weekly-server','week_start',v_week::text,
                             'verified_days',v_days,'required_days',5,
                             'subjects_per_day',2), v_uid)
  ON CONFLICT (record_id) DO NOTHING;

  v_result := public.r5_fragment_member_claim(v_record);
  -- 保护不变量：不能出现“已成功但稀有奖励为 0”的周结算。
  IF v_result->>'status' = 'CLAIMED'
     AND COALESCE((v_result->>'granted_rare')::int,0) <> 1 THEN
    RAISE EXCEPTION 'WEEKLY_RARE_GRANT_INVARIANT';
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.r5_fragment_member_weekly_claim() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_weekly_claim() TO authenticated;
COMMIT;
