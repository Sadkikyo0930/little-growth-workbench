import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const rd = p => readFileSync(new URL('../../'+p, import.meta.url),'utf8');
const db=new PGlite();
const as=async(role,sub='')=>db.exec("RESET ROLE; SET request.jwt.claims = '"+JSON.stringify(sub?{role,sub}:{role})+"'; SET ROLE "+role+";");
const server=()=>db.exec("RESET ROLE; SET request.jwt.claims = '';");
const call=async()=> (await db.query('SELECT public.r5_fragment_member_weekly_claim() AS result')).rows[0].result;
let n=0;function pass(name,condition){if(!condition)throw Error('FAIL '+name);n++;console.log('PASS',name)}
try{
  for(const p of ['db/isolated/schema.sql','db/isolated/functions-before.sql',
                  'db/20261114_fragment_server_authority.sql',
                  'db/20261114_fragment_scope_guard.sql',
                  'db/20261114_fragment_member_scope.sql',
                  'db/20261114_fragment_weekly_guarantee.sql'])await db.exec(rd(p));
  const cfg=(await db.query("SELECT rare_record_types,status FROM public.r5_reward_config WHERE family_id='*'")).rows[0];
  pass('only weekly-goal is eligible for rare',cfg.rare_record_types.length===1&&cfg.rare_record_types[0]==='weekly-goal');
  await as('authenticated','test-parent-owner-001');
  const paused=await call();
  pass('inactive reward gives zero-write denial',paused.status==='REWARD_NOT_ACTIVE'&&paused.zero_write===true);
  await server();await db.exec("UPDATE public.r5_reward_config SET status='active' WHERE family_id='*'");
  await as('authenticated','test-parent-owner-001');
  const incomplete=await call();
  pass('incomplete week does not grant',incomplete.status==='WEEKLY_GOAL_NOT_MET'&&incomplete.zero_write===true);
  await server();
  const init=(await db.query("SELECT count(*)::int n FROM public.growth_learning_records WHERE record_type='weekly-goal'")).rows[0].n;
  pass('no fake weekly record for incomplete goal',init===0);
  // Five verified days with two different subjects per day (Monday-Friday).
  const sql="INSERT INTO public.growth_learning_records (record_id,family_id,record_type,subject,learning_day,record_data,created_at) "+
    "SELECT 'weekly-fixture-'||x.n||'-'||s.subject, 'synthetic-family-main-001', 'course-complete', s.subject, 1, "+
    "'{}'::jsonb, (date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai') + x.n * interval '1 day' + interval '12 hour') "+
    "AT TIME ZONE 'Asia/Shanghai' FROM generate_series(0,4) x(n) CROSS JOIN (VALUES('语文'),('数学')) AS s(subject)";
  await db.exec(sql);
  await as('authenticated','test-parent-owner-001');
  const paid=await call();
  pass('five valid days guarantee a rare fragment',paid.status==='CLAIMED'&&Number(paid.granted_rare)===1&&Number(paid.granted_normal)===0);
  const repeated=await call();
  pass('same parent repeat is idempotent',repeated.status==='ALREADY_CLAIMED'&&repeated.zero_write===true);
  await as('authenticated','test-parent-member-002');
  const secondParent=await call();
  pass('other authorized family device cannot double-claim',secondParent.status==='ALREADY_CLAIMED'&&secondParent.zero_write===true);
  await as('authenticated','r5-selftest-parent');
  const foreign=await call();
  pass('unqualified other family receives nothing',foreign.status==='WEEKLY_GOAL_NOT_MET'&&foreign.zero_write===true);
  await as('anon');
  let forbidden=false;try{await call()}catch(e){forbidden=e.code==='42501'}
  pass('anonymous cannot invoke weekly claim',forbidden);
  await server();
  const rows=(await db.query("SELECT count(*)::int n, coalesce(sum(rare_count),0)::int rare FROM public.r5_fragment_drops WHERE record_kind='weekly-goal'")).rows[0];
  pass('exactly one weekly rare grant in durable ledger',rows.n===1&&rows.rare===1);
  console.log('ALL '+n+' WEEKLY GUARANTEE CHECKS PASSED');
}finally{await db.close()}
