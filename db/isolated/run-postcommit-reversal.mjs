/**
 * Synthetic-only committed reverse-migration rehearsal.
 * This is NOT a generated or approved production rollback.
 * Mirrors the exact fixture's pre-migration ACL/RLS and original function bodies.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const load=p=>readFileSync(path.join(root,p),'utf8');
const files=[
 'db/20261114_fragment_server_authority.sql',
 'db/20261114_fragment_scope_guard.sql',
 'db/20261114_fragment_member_scope.sql',
];
const checksum=s=>createHash('sha256').update(s).digest('hex');
const assert=(x,s)=>{if(!x)throw Error(s)};
const db=new PGlite();
const q=(s)=>db.query(s);
const exec=(s)=>db.exec(s);
await exec(load('db/isolated/schema.sql'));
await exec(load('db/isolated/functions-before.sql'));

async function proof(){
  const obj={};
  obj.catalog=(await q(`SELECT
    (SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.name),'[]'::jsonb) FROM (
       SELECT c.relname name,c.relacl::text acl,c.relrowsecurity rls,c.relforcerowsecurity forced,
              pg_get_userbyid(c.relowner) owner
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ) x) tables,
    (SELECT COALESCE(jsonb_agg(row_to_json(f) ORDER BY f.signature),'[]'::jsonb) FROM (
       SELECT p.oid::regprocedure::text signature,p.proacl::text acl,
              pg_get_userbyid(p.proowner) owner,pg_get_functiondef(p.oid) definition
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'r5_fragment%'
    ) f) functions,
    (SELECT COALESCE(jsonb_agg(row_to_json(v) ORDER BY v.tablename,v.policyname),'[]'::jsonb) FROM (
       SELECT tablename,policyname,permissive,roles::text roles,cmd,qual,with_check
       FROM pg_policies WHERE schemaname='public'
    ) v) policies`)).rows[0];
  const names=(await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  obj.data={};
  for(const {tablename} of names){
    const t='"'+tablename.replaceAll('"','""')+'"';
    const r=(await q('SELECT count(*)::int n, COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),\'[]\'::jsonb) rows FROM public.'+t+' x')).rows[0];
    obj.data[tablename]={rows:r.n,sha256:checksum(JSON.stringify(r.rows))};
  }
  return JSON.stringify(obj);
}
const original=await proof();
console.log('Baseline fingerprint',checksum(original));
await exec('BEGIN');
try{
  for(const file of files) await exec(load(file));
  await exec('COMMIT');
}catch(e){await exec('ROLLBACK');throw e}
const changed=await proof();
assert(changed!==original,'migration did not change catalog');
console.log('PASS forward migration COMMIT changes catalog');

const reverse=`
  -- Drop new wrapper RPCs before their dependencies.
  DROP FUNCTION public.r5_fragment_member_assemble(text);
  DROP FUNCTION public.r5_fragment_member_snapshot();
`;
// NOTE: restore original functions first so that they no longer refer to the
// guarded snapshot helper, then drop the now-unreferenced helpers and tables.
await exec('BEGIN');
try {
  await exec(reverse);
  await exec(load('db/isolated/functions-before.sql'));
  await exec(`
    DROP FUNCTION public.r5_fragment_snapshot_internal(text);
    DROP FUNCTION public.r5_fragment_scope_ok(text,text);
    DROP FUNCTION public.r5_fragment_program_json();
    DROP FUNCTION public.r5_fragment_is_privileged();
    DROP FUNCTION public.r5_fragment_caller_role();
    DROP TABLE public.r5_vehicle_recipe;
    DROP TABLE public.r5_reward_config;
    DROP TABLE public.r5_backend_role;

    -- Exact ACL/RLS restore for *this synthetic fixture only*.
    -- Never apply these grants blindly to production.
    ALTER TABLE public.r5_fragment_state DISABLE ROW LEVEL SECURITY;
    ALTER TABLE public.r5_fragment_drops DISABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.r5_fragment_state, public.r5_fragment_drops,
                  public.r5_racing_events, public.r5_racing_saves,
                  public.r5_device FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT ON public.r5_fragment_state,public.r5_fragment_drops TO anon;
    GRANT ALL ON public.r5_fragment_state,public.r5_fragment_drops TO authenticated,service_role;
    GRANT ALL ON public.r5_racing_events,public.r5_racing_saves TO service_role;
  `);
  const restoredInside=await proof();
  if(restoredInside!==original){
    const pre=JSON.parse(original), post=JSON.parse(restoredInside);
    for(const section of ['tables','functions','policies']){
      const a=pre.catalog[section], b=post.catalog[section];
      const aa=new Map(a.map(x=>[x.name||x.signature||x.tablename+'.'+x.policyname,x]));
      const bb=new Map(b.map(x=>[x.name||x.signature||x.tablename+'.'+x.policyname,x]));
      for(const key of new Set([...aa.keys(),...bb.keys()])){
        if(JSON.stringify(aa.get(key))!==JSON.stringify(bb.get(key))){
          console.error('DIFF catalog',section,key,JSON.stringify({before:aa.get(key),after:bb.get(key)}).slice(0,1500));
        }
      }
    }
    for(const table of new Set([...Object.keys(pre.data),...Object.keys(post.data)])){
      if(JSON.stringify(pre.data[table])!==JSON.stringify(post.data[table])) console.error('DIFF data',table,pre.data[table],post.data[table]);
    }
  }
  assert(restoredInside===original,'reverse migration did not restore exact synthetic baseline before COMMIT');
  await exec('COMMIT');
} catch(e) {
  await exec('ROLLBACK');
  throw e;
}
const after=await proof();
assert(original===after,'committed reverse migration did not restore exact synthetic baseline');
console.log('PASS committed reverse migration: exact synthetic catalog, ACL/RLS and data hash restored');
console.log('SUCCESS: 2/2 isolated forward COMMIT + committed reverse COMMIT');
await db.close();
