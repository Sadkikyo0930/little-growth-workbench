-- ============================================================================
-- functions-before.sql —— 线上三个碎片函数的**原始定义**（2026-11-14 从
-- pg_get_functiondef 原样抄下，仅用于隔离环境复现漏洞）
--
-- 用途：
--   1. 在 PGlite 里先按「现状」建库，跑 B 组断言 → 证明漏洞真实存在；
--   2. 作为回滚备份：万一需要撤销 20261114_fragment_scope_guard.sql，
--      执行本文件即可把三个函数恢复成现在的样子（数据一行不动）。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.r5_fragment_snapshot(p_family text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION public.r5_fragment_snapshot(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.r5_fragment_claim(p_family text, p_device text, p_record_id text, p_cfg jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day date := COALESCE((p_cfg->>'record_day')::date, (now() AT TIME ZONE 'Asia/Shanghai')::date);
  v_cap int := GREATEST(1, COALESCE((p_cfg->>'daily_cap')::int, 2));
  v_pity_target int := GREATEST(2, COALESCE((p_cfg->>'pity_target')::int, 5));
  v_frag text := NULLIF(p_cfg->>'fragment_id', '');
  v_rare_frag text := NULLIF(p_cfg->>'rare_fragment_id', '');
  v_want_rare boolean := COALESCE((p_cfg->>'rare')::boolean, false);
  v_pity_exempt boolean := COALESCE((p_cfg->>'pity_exempt')::boolean, false);
  v_want text := CASE WHEN p_cfg->>'want' = 'drop' THEN 'drop' ELSE 'none' END;
  v_kind text := COALESCE(p_cfg->>'record_kind', '');
  v_subject text := COALESCE(p_cfg->>'subject', '');
  v_prev public.r5_fragment_drops;
  v_state public.r5_fragment_state;
  v_pity int; v_daily int; v_daily_rare int; v_capped boolean;
  v_outcome text; v_count int := 0; v_rare_count int := 0; v_pity_after int;
  v_daily_index int := 0; v_rev bigint;
BEGIN
  IF p_family IS NULL OR p_family = '' THEN RETURN jsonb_build_object('status','BAD_FAMILY'); END IF;
  IF p_record_id IS NULL OR p_record_id = '' OR length(p_record_id) > 160 THEN RETURN jsonb_build_object('status','BAD_RECORD_ID'); END IF;

  SELECT * INTO v_prev FROM public.r5_fragment_drops d WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
  IF FOUND THEN
    RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','ALREADY_CLAIMED','outcome',v_prev.outcome,'granted_normal',v_prev.fragment_count,'granted_rare',v_prev.rare_count,'fragment_id',v_prev.fragment_id,'rare_fragment_id',v_prev.rare_fragment_id,'pity_points',COALESCE((SELECT pity_points FROM public.r5_fragment_state WHERE family_id = p_family),0),'claimed_at',v_prev.created_at,'zero_write',true);
  END IF;

  SELECT s.revision INTO v_rev FROM public.r5_racing_saves s WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','SAVE_NOT_INITIALIZED','zero_write',true); END IF;

  INSERT INTO public.r5_fragment_state (family_id) VALUES (p_family) ON CONFLICT (family_id) DO NOTHING;
  SELECT * INTO v_state FROM public.r5_fragment_state st WHERE st.family_id = p_family FOR UPDATE;

  IF v_state.daily_day = v_day THEN
    v_pity := v_state.pity_points; v_daily := v_state.daily_normal_count; v_daily_rare := v_state.daily_rare_count;
  ELSE
    v_pity := v_state.pity_points; v_daily := 0; v_daily_rare := 0;
  END IF;

  v_capped := v_daily >= v_cap;
  IF v_capped THEN v_outcome := 'capped';
  ELSIF v_want = 'none' THEN v_outcome := 'none';
  ELSE v_outcome := 'drop'; END IF;

  IF v_outcome = 'drop' THEN
    v_count := 1; v_daily_index := v_daily + 1; v_pity_after := 0;
  ELSIF v_outcome = 'none' THEN
    IF v_pity_exempt THEN
      v_pity_after := v_pity;
    ELSE
      v_pity_after := v_pity + 1;
      IF v_pity_after >= v_pity_target THEN
        v_outcome := 'pity'; v_count := 1; v_daily_index := v_daily + 1; v_pity_after := 0;
      END IF;
    END IF;
  ELSE
    v_pity_after := v_pity;
  END IF;

  IF v_want_rare AND v_rare_frag IS NOT NULL AND v_daily_rare < 1 THEN
    v_rare_count := 1;
  END IF;

  INSERT INTO public.r5_fragment_drops (family_id, source_record_id, record_day, record_kind, subject, outcome, fragment_id, fragment_count, rare_fragment_id, rare_count, pity_before, pity_after, daily_index, device)
  VALUES (p_family, p_record_id, v_day, v_kind, v_subject, v_outcome,
    CASE WHEN v_count > 0 THEN v_frag ELSE NULL END, v_count,
    CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END, v_rare_count,
    v_pity, v_pity_after, v_daily_index, COALESCE(p_device, ''))
  ON CONFLICT (family_id, source_record_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_prev FROM public.r5_fragment_drops d WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
    RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','ALREADY_CLAIMED','outcome',v_prev.outcome,'granted_normal',v_prev.fragment_count,'granted_rare',v_prev.rare_count,'zero_write',true);
  END IF;

  IF v_count > 0 AND v_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id, 'fragment_change', 0,
      jsonb_build_object('item_id', v_frag, 'quantity_delta', v_count, 'source', 'study', 'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject, 'record_day', v_day::text, 'outcome', v_outcome, 'pity_after', v_pity_after),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  IF v_rare_count > 0 AND v_rare_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id || ':rare', 'fragment_change', 0,
      jsonb_build_object('item_id', v_rare_frag, 'quantity_delta', v_rare_count, 'source', 'study-rare', 'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject, 'record_day', v_day::text),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  UPDATE public.r5_fragment_state st
     SET pity_points = v_pity_after,
         pity_total = st.pity_total + CASE WHEN v_outcome = 'pity' THEN 1 ELSE 0 END,
         daily_day = v_day,
         daily_normal_count = v_daily + v_count,
         daily_rare_count = v_daily_rare + v_rare_count,
         updated_at = now()
   WHERE st.family_id = p_family;

  UPDATE public.r5_racing_saves s
     SET revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','CLAIMED','outcome',v_outcome,'granted_normal',v_count,'granted_rare',v_rare_count,'fragment_id',CASE WHEN v_count > 0 THEN v_frag ELSE NULL END,'rare_fragment_id',CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END,'pity_points',v_pity_after,'pity_before',v_pity,'daily_normal_count',v_daily + v_count,'daily_rare_count',v_daily_rare + v_rare_count,'daily_index',v_daily_index,'record_day',v_day::text,'zero_write',false);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.r5_fragment_claim(text, text, text, jsonb) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.r5_fragment_assemble(p_family text, p_device text, p_vehicle_id text, p_cost jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owned jsonb; v_rev bigint; v_bal jsonb; v_deficit jsonb := '{}'::jsonb;
  v_k text; v_q int; v_have bigint; v_n int := 0; v_cost_ok boolean;
BEGIN
  -- 车辆 ID：小写字母开头，允许数字 / 短横线 / 下划线（占位车带下划线）
  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status','BAD_VEHICLE_ID','zero_write',true);
  END IF;

  -- 生日 / 限定车：永久隔离
  IF p_vehicle_id IN ('birthday-star-6','six-star-supercar-2026')
     OR p_vehicle_id LIKE 'pink-newyear%' OR p_vehicle_id LIKE 'pink-new-year%' THEN
    RETURN jsonb_build_object('status','BIRTHDAY_VEHICLE_FORBIDDEN','zero_write',true);
  END IF;

  -- 既有取得方式的车辆：金币购买 / 剧情解锁。碎片系统不得提供第二条路径
  IF p_vehicle_id IN ('moto','turtle') THEN
    RETURN jsonb_build_object('status','COIN_VEHICLE_FORBIDDEN','zero_write',true);
  END IF;

  -- v1 遗留槽位已冻结
  IF p_vehicle_id = 'scholar' THEN
    RETURN jsonb_build_object('status','LEGACY_SLOT_RETIRED','zero_write',true);
  END IF;

  -- 成本：非空对象，键必须是 frag_*，值必须是 1..200 的整数，条目数 1..4。
  IF p_cost IS NULL OR jsonb_typeof(p_cost) <> 'object' OR p_cost = '{}'::jsonb THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;
  SELECT bool_and(c.k ~ '^frag_[a-z0-9_]{1,40}$' AND c.v ~ '^[0-9]{1,3}$'), count(*)
    INTO v_cost_ok, v_n
    FROM jsonb_each_text(p_cost) AS c(k, v);
  IF NOT COALESCE(v_cost_ok, false) OR v_n < 1 OR v_n > 4 THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_cost) AS c(k, v) WHERE c.v::int < 1 OR c.v::int > 200) THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;

  SELECT s.owned, s.revision INTO v_owned, v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','SAVE_NOT_INITIALIZED','zero_write',true); END IF;

  IF v_owned ? p_vehicle_id THEN
    RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','ALREADY_OWNED','vehicle_id',p_vehicle_id,'zero_write',true);
  END IF;

  IF EXISTS (SELECT 1 FROM public.r5_racing_events e WHERE e.family_id = p_family AND e.event_id = 'asm:' || p_vehicle_id) THEN
    RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','ALREADY_ASSEMBLED','vehicle_id',p_vehicle_id,'zero_write',true);
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.k, t.q), '{}'::jsonb) INTO v_bal FROM (
    SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
    FROM public.r5_racing_events x
    WHERE x.family_id = p_family AND x.kind = 'fragment_change'
      AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
    GROUP BY 1
  ) t;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(p_cost) LOOP
    v_have := COALESCE((v_bal->>v_k)::bigint, 0);
    IF v_have < v_q THEN
      v_deficit := v_deficit || jsonb_build_object(v_k, v_q - v_have);
    END IF;
  END LOOP;

  IF v_deficit <> '{}'::jsonb THEN
    RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','INSUFFICIENT_FRAGMENTS','vehicle_id',p_vehicle_id,'required',p_cost,'deficit',v_deficit,'zero_write',true);
  END IF;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(p_cost) LOOP
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'asm:' || p_vehicle_id || ':' || v_k, 'fragment_change', 0,
      jsonb_build_object('item_id', v_k, 'quantity_delta', -v_q, 'source', 'assemble', 'vehicle_id', p_vehicle_id),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
  VALUES (p_family, 'asm:' || p_vehicle_id, 'grant', 0,
    jsonb_build_object('vehicle_id', p_vehicle_id, 'source', 'fragment-assembly', 'cost', p_cost),
    COALESCE(p_device, ''), now(), NULL)
  ON CONFLICT (family_id, event_id) DO NOTHING;

  UPDATE public.r5_racing_saves s
     SET owned = COALESCE(s.owned, '{}'::jsonb) || jsonb_build_object(p_vehicle_id, jsonb_build_object('at', (extract(epoch from now())*1000)::bigint, 'source', 'fragment-assembly', 'note', '碎片组装')),
         revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot(p_family) || jsonb_build_object('status','ASSEMBLED','vehicle_id',p_vehicle_id,'cost',p_cost,'zero_write',false);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.r5_fragment_assemble(text, text, text, jsonb) TO anon, authenticated, service_role;
