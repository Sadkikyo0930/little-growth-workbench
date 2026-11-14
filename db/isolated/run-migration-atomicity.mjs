/**
 * Offline-only transaction failure-injection rehearsal.
 * NO CloudBase credentials, HTTP, database URLs, or production writes.
 * Run: npm --prefix db/isolated install && node db/isolated/run-migration-atomicity.mjs
 *
 * IMPORTANT: PGlite demonstrating PostgreSQL transaction rollback does NOT prove
 * CloudBase ExecutePGSql transports three independent calls on one session.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = p => readFileSync(path.join(root, p), 'utf8');
const migration = [
  'db/20261114_fragment_server_authority.sql',
  'db/20261114_fragment_scope_guard.sql',
  'db/20261114_fragment_member_scope.sql',
].map(load);

const evidenceSql = `
  SELECT jsonb_build_object(
    'tables', COALESCE((
      SELECT jsonb_agg(row_to_json(t) ORDER BY t.name) FROM (
        SELECT c.relname AS name, c.relacl::text AS acl, c.relrowsecurity AS rls,
               c.relforcerowsecurity AS force_rls,
               pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      ) t), '[]'::jsonb),
    'functions', COALESCE((
      SELECT jsonb_agg(row_to_json(f) ORDER BY f.signature) FROM (
        SELECT p.oid::regprocedure::text AS signature, p.proacl::text AS acl,
               pg_get_userbyid(p.proowner) AS owner,
               pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'r5_fragment%'
      ) f), '[]'::jsonb),
    'policies', COALESCE((
      SELECT jsonb_agg(row_to_json(q) ORDER BY q.tablename, q.policyname) FROM (
        SELECT tablename, policyname, permissive, roles::text AS roles,
               cmd, qual, with_check FROM pg_policies WHERE schemaname='public'
      ) q), '[]'::jsonb),
    'counts', jsonb_build_object(
      'members', (SELECT count(*) FROM public.growth_family_members),
      'records', (SELECT count(*) FROM public.growth_learning_records),
      'drops', (SELECT count(*) FROM public.r5_fragment_drops),
      'events', (SELECT count(*) FROM public.r5_racing_events),
      'saves', (SELECT count(*) FROM public.r5_racing_saves)
    )
  ) AS fingerprint
`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const output = path.join(root, 'evidence/transaction-rehearsal');
mkdirSync(output, {recursive:true});
const results=[];
const hash=s=>createHash('sha256').update(s).digest('hex');
const version=JSON.parse(load('db/isolated/node_modules/@electric-sql/pglite/package.json')).version;
console.log(`Node ${process.version}; PGlite ${version}; synthetic fixtures only`);

async function fresh() {
  const db = new PGlite();
  await db.exec(load('db/isolated/schema.sql'));
  await db.exec(load('db/isolated/functions-before.sql'));
  return db;
}
async function fingerprint(db) {
  const r = await db.query(evidenceSql);
  const data={};
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {tablename} of tables){
    const sql='SELECT count(*)::int AS count, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) AS data FROM public."'+tablename.replaceAll('"','""')+'" t';
    const row=(await db.query(sql)).rows[0];
    data[tablename]={count:row.count,sha256:hash(JSON.stringify(row.data))};
  }
  const privileges=(await db.query(`SELECT jsonb_build_object(
    'schemas',(SELECT jsonb_agg(jsonb_build_object('name',nspname,'acl',nspacl::text,'owner',pg_get_userbyid(nspowner)) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('public','auth')),
    'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl::text) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p')),
    'defaults',(SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(defaclrole),'namespace',defaclnamespace,'type',defaclobjtype,'acl',defaclacl::text) ORDER BY defaclrole,defaclnamespace,defaclobjtype) FROM pg_default_acl),
    'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'bypassrls',rolbypassrls,'inherit',rolinherit,'login',rolcanlogin) ORDER BY rolname) FROM pg_roles)
  ) AS proof`)).rows[0].proof;
  return JSON.stringify({catalog:r.rows[0].fingerprint,privileges,data});
}
async function rollbackCheck(stage) {
  const db = await fresh();
  const before = await fingerprint(db);
  let injected = false;
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < stage; i++) await db.exec(migration[i]);
    await db.exec('SELECT 1/0');
  } catch (err) {
    injected = err.code === '22012';
    if(injected){
      let aborted=false;
      try{await db.query('SELECT 1')}catch(e){aborted=e.code==='25P02'}
      assert(aborted, 'database transaction not aborted at stage '+stage);
    }
    await db.exec('ROLLBACK');
  }
  const after = await fingerprint(db);
  assert(injected, 'failure injection not reached at stage ' + stage);
  assert(before === after, 'rollback mismatch at stage ' + stage);
  results.push({stage,status:'PASS',injected_sqlstate:'22012',aborted_sqlstate:'25P02',before_sha256:hash(before),after_sha256:hash(after),proof:JSON.parse(after)});
  // Zero new migration tables/functions and exact baseline ACL, RLS, policies,
  // function definitions and seeded row counts are proven by the fingerprint.
  console.log('PASS rollback after ' + stage + ' script(s): original catalog + row counts restored');
  await db.close();
}
for (const stage of [1,2,3]) await rollbackCheck(stage);

const db = await fresh();
const baseline=await fingerprint(db);
await db.exec('BEGIN');
for (const script of migration) await db.exec(script);
const mid = (await db.query(
  "SELECT to_regprocedure('public.r5_fragment_member_snapshot()') IS NOT NULL AS installed"
)).rows[0].installed;
assert(mid, 'member function missing inside transaction');
const preCommit=await fingerprint(db);
assert(preCommit!==baseline,'migrations did not alter catalog');
await db.exec('COMMIT');
const committed = (await db.query(
  "SELECT to_regprocedure('public.r5_fragment_member_snapshot()') IS NOT NULL AS installed"
)).rows[0].installed;
assert(committed, 'function did not persist after COMMIT');
const postCommit=await fingerprint(db);
assert(preCommit===postCommit,'COMMIT catalog/data mismatch');
results.push({stage:'commit',status:'PASS',pre_commit_sha256:hash(preCommit),post_commit_sha256:hash(postCommit),proof:JSON.parse(postCommit)});
console.log('PASS single-session 3-script COMMIT persists member RPC');
await db.close();
console.log('ALL 4 ISOLATED TRANSACTION REHEARSALS PASSED. Production transport still unverified.');
writeFileSync(path.join(output,'atomicity-results.json'),JSON.stringify({node:process.version,pglite:version,generated_at:new Date().toISOString(),migrations:migration.map(hash),passed:4,failed:0,results},null,2)+'\n');
