-- 2026-11-15 家庭成员权限：验收脚本（全部只读或事务内回滚，净写入 0）
-- 在正式库以 cloudbase_postgres 执行。每个 BEGIN 块都以 ROLLBACK 结束。
-- 真实 uid：妈妈 2118316498342715393(owner)、外婆 2118318551127629825(grandparent)。

-- ============================================================ 1. 只读权限矩阵
BEGIN TRANSACTION READ ONLY;
SELECT p.proname,
       pg_get_userbyid(p.proowner)::text AS owner,
       p.prosecdef                      AS security_definer,
       has_table_privilege(p.proowner,'public.growth_family_members','SELECT') AS owner_reads_members,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth_exec,
       has_function_privilege('anon',p.oid,'EXECUTE')          AS anon_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname='public'
   AND p.proname IN ('r5_assert_member','r5_auto_rollover_day','r5_status',
                     'growth_is_family_member','r5_gate_status_core','r5_next_day_state_impl')
 ORDER BY p.proname;
COMMIT;

BEGIN TRANSACTION READ ONLY;
SELECT c.relname,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force_rls,
       has_table_privilege('authenticated',c.oid,'SELECT') AS auth_sel,
       has_table_privilege('anon',c.oid,'SELECT')          AS anon_sel
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
   AND c.relname IN ('growth_family_members','growth_learning_records',
                     'r5_family_progress','r5_plan_audit','r5_acl_baseline')
 ORDER BY c.relname;
COMMIT;

-- ================================================ 2. A：妈妈（owner）读云端状态
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118316498342715393"}';
SET LOCAL ROLE authenticated;
SELECT current_user::text AS effective_role,
       (SELECT count(*) FROM public.growth_family_members) AS own_member_rows,
       public.r5_status('little-growth-family-001')->>'study_day'           AS study_day,
       public.r5_status('little-growth-family-001')->>'authoritative_day'   AS authoritative_day,
       public.r5_status('little-growth-family-001')->>'schedule_published'  AS published;
ROLLBACK;

-- ============================================ 3. B：外婆（grandparent）同一结果
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118318551127629825"}';
SET LOCAL ROLE authenticated;
SELECT public.r5_fragment_member_snapshot()->>'member_role'                  AS member_role,
       public.r5_status('little-growth-family-001')->>'study_day'            AS study_day,
       public.r5_status('little-growth-family-001')->>'schedule_published'   AS published;
ROLLBACK;

-- ================================================== 4. C：匿名什么都拿不到
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"anon"}';
SET LOCAL ROLE anon;
SELECT has_table_privilege(current_user,'public.growth_family_members','SELECT')      AS members,
       has_function_privilege(current_user,'public.r5_status(text)','EXECUTE')       AS r5_status,
       has_function_privilege(current_user,'public.r5_auto_rollover_day(text)','EXECUTE') AS rollover;
ROLLBACK;

-- ============================== 5. D：跨家庭（妈妈读 selftest 家庭，预期报错）
-- 预期结果：ERROR R5_MEMBER_DENIED (SQLSTATE 42501)。报错本身就是通过。
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118316498342715393"}';
SET LOCAL ROLE authenticated;
SELECT public.r5_status('r5-selftest-family');
ROLLBACK;

-- ================================ 6. E：已第 4 日再调跨日（预期不推进）
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118316498342715393"}';
SET LOCAL ROLE authenticated;
SELECT public.r5_auto_rollover_day('little-growth-family-001')->>'result' AS result,
       public.r5_auto_rollover_day('little-growth-family-001')->>'study_day' AS study_day;
ROLLBACK;

-- ============== 7. F1：旧设备把今天的作答记成第 3 日（预期 R5_RECORD_DAY_MISMATCH）
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118316498342715393"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data,created_by)
VALUES ('acc-today-day3','little-growth-family-001','answer','数学',3,
        jsonb_build_object('answer',jsonb_build_object('date',to_char(timezone('Asia/Shanghai',clock_timestamp()),'YYYY-MM-DD'),
                          'correct','true','track','acceptance','index',9901)),'2118316498342715393');
ROLLBACK;

-- ============ 8. F2：补传 11-14 的第 3 日历史记录（预期成功，不改变权威日）
BEGIN;
SET LOCAL "request.jwt.claims" = '{"role":"authenticated","sub":"2118316498342715393"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data,created_by)
VALUES ('acc-hist-day3','little-growth-family-001','answer','数学',3,
        jsonb_build_object('answer',jsonb_build_object('date','2026-11-14','correct','true','track','acceptance','index',9902)),
        '2118316498342715393');
SELECT count(*) AS accepted FROM public.growth_learning_records WHERE record_id='acc-hist-day3';
ROLLBACK;
