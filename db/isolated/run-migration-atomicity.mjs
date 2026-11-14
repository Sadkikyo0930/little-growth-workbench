/**
 * Offline-only transaction failure-injection rehearsal.
 * NO CloudBase credentials, HTTP, database URLs, or production writes.
 * Run: npm --prefix db/isolated install && node db/isolated/run-migration-atomicity.mjs
 *
 * IMPORTANT: PGlite demonstrating PostgreSQL transaction rollback does NOT prove
 * CloudBase ExecutePGSql transports three independent calls on one session.
 */
import { readFileSync } from 'node:fs';
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

async function fresh() {
  const db = new PGlite();
  await db.exec(load('db/isolated/schema.sql'));
  await db.exec(load('db/isolated/functions-before.sql'));
  return db;
}
async function fingerprint(db) {
  const r = await db.query(evidenceSql);
  return JSON.stringify(r.rows[0].fingerprint);
}
async function rollbackCheck(stage) {
  const db = await fresh();
  const before = await fingerprint(db);
  let injected = false;
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < stage; i++) await db.exec(migration[i]);
    throw new Error('INTENTIONAL_FAILURE_STAGE_' + stage);
  } catch (err) {
    injected = err.message === 'INTENTIONAL_FAILURE_STAGE_' + stage;
    await db.exec('ROLLBACK');
  }
  const after = await fingerprint(db);
  assert(injected, 'failure injection not reached at stage ' + stage);
  assert(before === after, 'rollback mismatch at stage ' + stage);
  // Zero new migration tables/functions and exact baseline ACL, RLS, policies,
  // function definitions and seeded row counts are proven by the fingerprint.
  console.log('PASS rollback after ' + stage + ' script(s): original catalog + row counts restored');
  await db.close();
}
for (const stage of [1,2,3]) await rollbackCheck(stage);

const db = await fresh();
await db.exec('BEGIN');
for (const script of migration) await db.exec(script);
const mid = (await db.query(
  "SELECT to_regprocedure('public.r5_fragment_member_snapshot()') IS NOT NULL AS installed"
)).rows[0].installed;
assert(mid, 'member function missing inside transaction');
await db.exec('COMMIT');
const committed = (await db.query(
  "SELECT to_regprocedure('public.r5_fragment_member_snapshot()') IS NOT NULL AS installed"
)).rows[0].installed;
assert(committed, 'function did not persist after COMMIT');
console.log('PASS single-session 3-script COMMIT persists member RPC');
await db.close();
console.log('ALL 4 ISOLATED TRANSACTION REHEARSALS PASSED. Production transport still unverified.');
