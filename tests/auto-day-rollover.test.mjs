import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const sql=readFileSync(new URL('../db/20261115_auto_next_learning_day.sql',import.meta.url),'utf8');
const bridge=readFileSync(new URL('../v6/r5-bridge.js',import.meta.url),'utf8');
let n=0;
async function query(q,p){return (await db.query(q,p)).rows}
function check(name,value){assert(value,name);n++;console.log('PASS '+name)}
try {
 await db.exec(\`
 CREATE ROLE authenticated;
 CREATE ROLE anon;
 CREATE TABLE public.growth_family_members(family_id text,user_id text,member_role text);
 CREATE TABLE public.r5_family_progress(
 family_id text primary key,authoritative_day integer not null,
 previous_day integer,last_advanced_on date,revision bigint not null default 0,
 updated_at timestamptz default now());
 CREATE TABLE public.r5_plan_audit(
 audit_id bigserial primary key,family_id text,occurred_on date,event text,
 authoritative_day integer,plan_date date,actor text,detail jsonb default '{}');
 CREATE TABLE public.r5_daily_plan(
 family_id text,study_date date,day_index integer,
 subjects jsonb,published boolean,primary key(family_id,study_date));
 CREATE TABLE public.r5_subject_template(day_index integer primary key,subjects jsonb);
 CREATE TABLE public.evidence_days(family_id text,day_index integer,
 study_date date,passed boolean);
 CREATE TABLE public.growth_learning_records(id text primary key);
 CREATE TABLE public.r5_racing_saves(family_id text primary key,save_data text);
 CREATE TABLE public.r5_parent_settings(family_id text primary key,daily_seconds int);
 CREATE FUNCTION public.r5_assert_member(p_family_id text, p_require_parent boolean)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog','public' AS $$
 DECLARE uid text; member text; claims jsonb;
 BEGIN
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
  uid:=claims->>'sub';
  IF claims->>'role' <> 'authenticated' OR uid IS NULL
  THEN RAISE EXCEPTION 'R5_AUTH_REQUIRED' USING ERRCODE='28000'; END IF;
  SELECT member_role INTO member FROM public.growth_family_members
   WHERE family_id=p_family_id AND user_id=uid;
  IF member IS NULL OR member NOT IN ('owner','parent','grandparent')
  THEN RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE='42501'; END IF;
  RETURN uid;
 END; $$;
 CREATE FUNCTION public.r5_day_evidence(p_family_id text,p_day integer)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
 DECLARE d date; passed boolean;
 BEGIN
 SELECT study_date INTO d FROM public.r5_daily_plan
 WHERE family_id=p_family_id AND day_index=p_day ORDER BY study_date DESC LIMIT 1;
 SELECT e.passed INTO passed FROM public.evidence_days e
 WHERE e.family_id=p_family_id AND e.day_index=p_day AND e.study_date=d LIMIT 1;
 RETURN jsonb_build_object('plan_date',d,'passed',coalesce(passed,false),
 'subjects','["语文","英语"]'::jsonb);
 END; $$;
 CREATE FUNCTION public.r5_guard_plan_day() RETURNS trigger
 LANGUAGE plpgsql AS $$
 DECLARE x integer;
 BEGIN
 SELECT authoritative_day INTO x FROM public.r5_family_progress
 WHERE family_id=NEW.family_id;
 IF x IS NOT NULL AND NEW.day_index<>x
 THEN RAISE EXCEPTION 'R5_PLAN_DAY_REGRESSION'; END IF;
 RETURN NEW; END; $$;
 CREATE TRIGGER r5_guard_plan BEFORE INSERT OR UPDATE ON public.r5_daily_plan
 FOR EACH ROW EXECUTE FUNCTION public.r5_guard_plan_day();
 CREATE FUNCTION public.r5_next_day_state(text) RETURNS jsonb
 LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
 INSERT INTO public.r5_subject_template VALUES
 (3,'["数学","英语"]'),(4,'["语文","英语"]'),
 (5,'["数学","科学"]'),(30,'["数学","英语"]');
 INSERT INTO public.growth_family_members VALUES
 ('family','mother','owner'),('family','grandmother','grandparent'),
 ('other','stranger','owner');
 INSERT INTO public.r5_family_progress(family_id,authoritative_day)
 VALUES('family',3),('other',3),('incomplete',3),('blank',3),
 ('todaydone',3),('maxfamily',30);
 INSERT INTO public.growth_family_members VALUES
 ('incomplete','mother','owner'),('blank','mother','owner'),
 ('todaydone','mother','owner'),('maxfamily','mother','owner');
 INSERT INTO public.r5_daily_plan
 VALUES ('family',timezone('Asia/Shanghai',now())::date-1,3,
 '["数学","英语"]',true),
 ('other',timezone('Asia/Shanghai',now())::date-1,3,
 '["数学","英语"]',true),
 ('incomplete',timezone('Asia/Shanghai',now())::date-1,3,
 '["数学","英语"]',true),
 ('todaydone',timezone('Asia/Shanghai',now())::date,3,
 '["数学","英语"]',true),
 ('maxfamily',timezone('Asia/Shanghai',now())::date-1,30,
 '["数学","英语"]',true);
 INSERT INTO public.evidence_days VALUES
 ('family',3,timezone('Asia/Shanghai',now())::date-1,true),
 ('other',3,timezone('Asia/Shanghai',now())::date-1,true),
 ('incomplete',3,timezone('Asia/Shanghai',now())::date-1,false),
 ('todaydone',3,timezone('Asia/Shanghai',now())::date,true),
 ('maxfamily',30,timezone('Asia/Shanghai',now())::date-1,true);
 INSERT INTO public.growth_learning_records VALUES ('unchanged-01');
 INSERT INTO public.r5_parent_settings VALUES ('family',1800);
 INSERT INTO public.r5_racing_saves VALUES ('family','preserved');
 \`);
 await db.exec(sql);
 async function as(uid,role='authenticated'){
  const claims=JSON.stringify({sub:uid,role}).replaceAll("'","''");
  await db.exec("SELECT set_config('request.jwt.claims','"+claims+"',false)");
 }
 const claim=async fam=>(await query('SELECT public.r5_auto_rollover_day($1) AS x',[fam]))[0].x;
 await as('mother');
 let r=await claim('family');
 check('3→4 when yesterday passed',r.result==='advanced'&&r.advanced===true&&r.study_day===4);
 check('next curriculum is exactly day 4',JSON.stringify(r.subjects)==='["语文","英语"]');
 check('study date is Asia/Shanghai today',r.study_date===new Date(Date.now()+28800000).toISOString().slice(0,10));
 check('single increment and previous_day preserved',
  (await query("SELECT authoritative_day,previous_day,revision FROM public.r5_family_progress WHERE family_id='family'"))[0].authoritative_day===4);
 check('identical follow-up does not jump day 5',(await claim('family')).result==='already_published');
 await as('grandmother');
 check('grandmother can safely see same day',(await claim('family')).study_day===4);
 await as('stranger');
 let forbidden=false;try{await claim('family')}catch(e){forbidden=true}
 check('cross-family caller cannot advance',forbidden);
 await as('mother');
 r=await claim('incomplete');
 check('unfinished day carries over',r.study_day===3&&r.result==='previous_day_incomplete');
 r=await claim('blank');
 check('no historical evidence cannot advance',r.study_day===3&&r.result==='no_previous_plan');
 r=await claim('todaydone');
 check('same-calendar-day cannot advance',r.study_day===3&&r.result==='already_published');
 r=await claim('maxfamily');
 check('end day 30 never wraps to 31',r.study_day===30&&r.result==='max_day_reached');
 r=await claim('uninitialized');
 check('no new family progress created by guess',r.result==='day_not_initialized');
 check('audit includes one auto_advance',Number((await query("SELECT count(*) AS n FROM public.r5_plan_audit WHERE family_id='family' AND event='auto_advance'"))[0].n)===1);
 check('same-day plan unique and exists once',Number((await query("SELECT count(*) AS n FROM public.r5_daily_plan WHERE family_id='family' AND study_date=timezone('Asia/Shanghai',now())::date"))[0].n)===1);
 check('child answer records preserved',Number((await query("SELECT count(*) AS n FROM public.growth_learning_records"))[0].n)===1);
 check('racing save and quota preserved',(await query("SELECT save_data FROM public.r5_racing_saves WHERE family_id='family'"))[0].save_data==='preserved'
  &&(await query("SELECT daily_seconds FROM public.r5_parent_settings WHERE family_id='family'"))[0].daily_seconds===1800);
 check('server never depends on device local day',!sql.includes('completedDays')&&!sql.includes('p_expected_day'));
 check('client calls auto RPC before status',bridge.indexOf("rpc('r5_auto_rollover_day'")<bridge.indexOf('var st = await cloudStatus(who);',bridge.indexOf('async function runOnce()')));
 check('client rejects absent backends instead of guessing',bridge.includes("state: 'auto_day_backend_not_ready'"));
 console.log('PASS '+n+'/'+n+' cross-day auto rollover checks');
} finally {
 await db.close();
}
