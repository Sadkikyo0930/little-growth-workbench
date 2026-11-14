/**
 * Preflight contract validation ONLY against synthetic, in-memory PGlite.
 * The public GitHub runner never connects to production CloudBase.
 * A real production run must use an authorized read-only session and retain results privately.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {strict as assert} from 'node:assert';
import {PGlite} from '@electric-sql/pglite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const load=p=>readFileSync(path.join(root,p),'utf8');
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

const requiredColumns={
  growth_learning_records:{record_id:'text',family_id:'text',record_type:'text',created_at:'timestamp with time zone',learning_day:'integer'},
  growth_family_members:{family_id:'text',user_id:'text',member_role:'text'},
  r5_device:{device_uid:'text',family_id:'text',revoked_at:'timestamp with time zone'},
  r5_racing_saves:{family_id:'text',revision:'bigint',owned:'jsonb',fragments:'jsonb'},
  r5_racing_events:{family_id:'text',event_id:'text',payload:'jsonb'},
  r5_fragment_state:{family_id:'text',pity_points:'integer',daily_normal_count:'integer'},
  r5_fragment_drops:{family_id:'text',source_record_id:'text',fragment_count:'integer'},
};
const requiredFunctions=[
  'r5_fragment_snapshot(text)',
  'r5_fragment_claim(text,text,text,jsonb)',
  'r5_fragment_assemble(text,text,text,jsonb)',
];

async function baseline(db){
  const columns=(await db.query(`
    SELECT table_name,column_name,data_type
      FROM information_schema.columns
     WHERE table_schema='public'
     ORDER BY table_name,column_name
  `)).rows;
  const functions=(await db.query(`
    SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
     WHERE n.nspname='public'
  `)).rows;
  const problems=[];
  for(const [table,expected] of Object.entries(requiredColumns)){
    for(const [column,type] of Object.entries(expected)){
      const found=columns.find(r=>r.table_name===table&&r.column_name===column);
      if(!found) problems.push('missing '+table+'.'+column);
      else if(found.data_type!==type) problems.push('type '+table+'.'+column+': '+found.data_type+' != '+type);
    }
  }
  for(const signature of requiredFunctions){
    if(!functions.some(r=>r.signature===signature||r.signature==='public.'+signature))
      problems.push('missing function '+signature);
  }
  return problems;
}
async function dataHash(db){
  const names=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const values=[];
  for(const {tablename} of names){
    const escaped='"'+tablename.replaceAll('"','""')+'"';
    const rows=(await db.query('SELECT to_jsonb(t) AS data FROM public.'+escaped+' t ORDER BY to_jsonb(t)::text')).rows;
    values.push([tablename,rows]);
  }
  return digest(values);
}
const db=new PGlite();
await db.exec(load('db/isolated/schema.sql'));
await db.exec(load('db/isolated/functions-before.sql'));
const ok=await baseline(db);
assert.deepEqual(ok,[],'the exact synthetic baseline must satisfy preflight contract');
console.log('PASS original isolated legacy schema matches required migration contracts');
const before=await dataHash(db);
const sql=load('db/preflight/production-readonly.sql');
assert.match(sql,/BEGIN READ ONLY;/);
await db.exec(sql);
assert.equal(await dataHash(db),before,'preflight altered seeded table rows');
console.log('PASS same preflight SQL executes without writes in synthetic PostgreSQL');

await db.exec('ALTER TABLE public.growth_learning_records ALTER COLUMN learning_day TYPE text USING learning_day::text');
const badType=await baseline(db);
assert(badType.some(s=>s.includes('type growth_learning_records.learning_day')),'curriculum day schema drift not identified');
console.log('PASS schema validator blocks wrong curriculum day column type');
await db.exec('ALTER TABLE public.growth_learning_records ALTER COLUMN learning_day TYPE integer USING learning_day::integer');
await db.exec('ALTER TABLE public.r5_racing_saves DROP COLUMN fragments');
const missing=await baseline(db);
assert(missing.some(s=>s==='missing r5_racing_saves.fragments'),'missing fragment storage not found');
console.log('PASS schema validator blocks missing save fragment column');
await db.close();
console.log('ALL 4 PREFLIGHT SCHEMA VALIDATION CHECKS PASSED');
