-- V6 家庭学习记录：允许家庭成员仅新增成绩（SQL 完整版）
-- CloudBase PostgreSQL / 环境 normal-goose
-- 用法：在 CloudBase PostgreSQL SQL 编辑器执行整个脚本。
-- 只调整 growth_learning_records 的权限，不修改已有学习记录。
-- 妈妈、爸爸、外婆都必须已在 growth_family_members 中有自己真实的 user_id。
-- 注意：本脚本不能替代真机 INSERT/SELECT 与禁止 UPDATE/DELETE 的验收。

BEGIN;

-- 旧的家庭校验函数必须存在，并由 SECURITY DEFINER 安全检查成员关系。
DO $$
DECLARE
  function_is_definer boolean;
BEGIN
  IF to_regprocedure('public.growth_is_family_member(text)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.growth_is_family_member(text)，已停止，不会调整权限';
  END IF;
  SELECT p.prosecdef INTO function_is_definer
    FROM pg_proc p
   WHERE p.oid = 'public.growth_is_family_member(text)'::regprocedure;
  IF function_is_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'growth_is_family_member 不是 SECURITY DEFINER，已停止';
  END IF;
END $$;

ALTER TABLE public.growth_learning_records ENABLE ROW LEVEL SECURITY;

-- 禁止未登录角色及 PUBLIC 写入；登录账号只能 INSERT 指定业务列。
REVOKE INSERT, UPDATE, DELETE ON TABLE public.growth_learning_records FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.growth_learning_records FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.growth_learning_records FROM authenticated;
-- 早期如果曾经进行列级授权，也清理该授权，以免残留 UPDATE 权限。
REVOKE UPDATE (record_data, updated_at) ON TABLE public.growth_learning_records FROM authenticated;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON TABLE public.growth_learning_records TO authenticated;
GRANT INSERT (record_id, family_id, record_type, subject, learning_day, record_data, created_by)
  ON TABLE public.growth_learning_records TO authenticated;
GRANT EXECUTE ON FUNCTION public.growth_is_family_member(text) TO authenticated;

-- 仅实际属于目标家庭的人，可以插入自己名下的不可变学习成绩。
DROP POLICY IF EXISTS growth_learning_member_insert ON public.growth_learning_records;
CREATE POLICY growth_learning_member_insert
  ON public.growth_learning_records
  FOR INSERT
  TO authenticated
  WITH CHECK (
    family_id IS NOT NULL
    AND public.growth_is_family_member(family_id)
    AND created_by = (SELECT auth.jwt() ->> 'sub')
  );

COMMIT;

-- 执行后请另做只读审计，确认权限：
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'growth_learning_records'
   AND grantee IN ('authenticated', 'anon', 'PUBLIC')
 ORDER BY grantee, privilege_type;

SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'growth_learning_records'
 ORDER BY policyname;
