-- R5 read-only CloudBase preflight. No writes.
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('growth_learning_records','growth_family_members')
ORDER BY table_name,ordinal_position;
SELECT record_type,subject,learning_day,COUNT(*) AS rows,
 COUNT(*) FILTER (WHERE record_data ? 'answer') AS answer_json_count,
 COUNT(*) FILTER (WHERE record_data #>> '{answer,correct}' IN ('true','false')) AS scored,
 COUNT(*) FILTER (WHERE record_data #>> '{answer,date}' IS NOT NULL) AS dated,
 COUNT(*) FILTER (WHERE record_data ? 'completed_at') AS completed
FROM public.growth_learning_records
GROUP BY record_type,subject,learning_day
ORDER BY learning_day,record_type,subject;
SELECT tablename,policyname,cmd,roles,qual,with_check
FROM pg_policies WHERE schemaname='public'
 AND tablename IN ('growth_learning_records','growth_family_members')
ORDER BY tablename,policyname;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('growth_learning_records','growth_family_members');
SELECT proname,prosecdef,proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND (proname LIKE 'growth_%' OR proname LIKE 'r5_%');
