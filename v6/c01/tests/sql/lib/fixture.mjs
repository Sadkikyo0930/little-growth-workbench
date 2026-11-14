/* Shared PGlite fixture for the C0.1 SQL suites.
 *
 * One place for: production-shaped schema, the two client roles PostgREST uses,
 * the deployment candidate, and the row builders. e2e.test.mjs keeps its own
 * copy on purpose (it is the already-reviewed baseline); the newer suites
 * (init-day / security) import from here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../../');
export const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

export const BASE = read('fixtures/schema/base-schema.sql');
export const M010 = read('candidate/sql/010_authoritative_day.sql');
export const LEGACY_GATE = read('candidate/sql/legacy/r5_gate_status_core.production.sql');
export const LEGACY_PUB = read('candidate/sql/legacy/r5_publish_today.production.sql');
export const M020 = read('candidate/sql/020_gate_and_publish.sql');
export const ROLLBACK_SQL = read('candidate/sql/900_rollback.sql');

/* PostgREST connects as `authenticated` (logged in) or `anon` (not logged in),
 * and server-to-server callers use `service_role`. Creating all three is what
 * makes the GRANT/REVOKE assertions real: without the roles the privilege
 * checks would silently pass against a superuser only. */
export const ROLES = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN;
    END IF;
  END $$;
`;

export async function newDb({ candidate = true, roles = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  if (roles) await db.exec(ROLES);
  if (candidate) {
    await db.exec(M010);
    await db.exec(LEGACY_GATE);
    await db.exec(LEGACY_PUB);
    await db.exec(M020);
  }
  return db;
}

export async function today(db) {
  const r = await db.query("SELECT (timezone('Asia/Shanghai', clock_timestamp()))::date::text AS d");
  return r.rows[0].d;
}

export async function addDays(db, base, n) {
  const r = await db.query('SELECT ($1::date + $2::int)::text AS d', [base, n]);
  return r.rows[0].d;
}

export const CLAIMS = {
  parent: `SET request.jwt.claims = '{"sub":"u-parent","role":"authenticated"}'`,
  child: `SET request.jwt.claims = '{"sub":"u-child","role":"authenticated"}'`,
  outsider: `SET request.jwt.claims = '{"sub":"u-outsider","role":"authenticated"}'`,
  anon: `SET request.jwt.claims = '{"role":"anon"}'`,
};

export async function asParent(db) { await db.exec(CLAIMS.parent); }
export async function asChild(db) { await db.exec(CLAIMS.child); }
export async function asOutsider(db) { await db.exec(CLAIMS.outsider); }
export async function clearClaims(db) { await db.exec('RESET request.jwt.claims'); }

/* seedFamily: create family + members + settings, and (by default) an already
 * initialised progress row. `progress:false` leaves the family uninitialised,
 * which is the state the real family is in right after the migration runs. */
export async function seedFamily(db, { id, day = 1, child = true, progress = true, grandparentOnly = false } = {}) {
  await asParent(db);
  await db.query('INSERT INTO growth_families(family_id) VALUES ($1)', [id]);
  await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-parent','parent')", [id]);
  if (child) {
    await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-child','grandparent')", [id]);
  }
  if (grandparentOnly) {
    await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-gp','grandparent')", [id]);
  }
  await db.query('INSERT INTO r5_parent_settings(family_id,daily_seconds,bonus_seconds) VALUES ($1,1800,0)', [id]);
  if (progress) {
    await db.query('INSERT INTO r5_family_progress(family_id,authoritative_day) VALUES ($1,$2)', [id, day]);
  }
}

export async function putPlan(db, id, date, dayIndex, subjects, published = true) {
  await db.query('INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [id, date, dayIndex, JSON.stringify(subjects), published]);
}

let seq = 0;
export async function addAnswer(db, id, subject, day, correct, date, track = '课程') {
  const rid = `rec-${id}-${seq++}`;
  await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'answer',$3,$4,$5::jsonb)`,
    [rid, id, subject, day, JSON.stringify({ answer: { correct: correct ? 'true' : 'false', date, track, index: seq } })]);
  return rid;
}

export async function addCompletion(db, id, subject, day, completedAt) {
  const rid = `rec-${id}-${seq++}`;
  await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'course-complete',$3,$4,$5::jsonb)`,
    [rid, id, subject, day, JSON.stringify(completedAt ? { completed_at: completedAt } : {})]);
  return rid;
}

export async function status(db, id) {
  return (await db.query('SELECT public.r5_status($1) AS s', [id])).rows[0].s;
}

export async function publish(db, id, day, noTasks = false) {
  return (await db.query('SELECT public.r5_publish_today($1,$2,$3) AS r', [id, day, noTasks])).rows[0].r;
}

export async function fingerprint(db, id) {
  const r = await db.query(`SELECT count(*)::int AS n,
    md5(string_agg(record_id||'|'||coalesce(subject,'~')||'|'||coalesce(learning_day::text,'~')||'|'||record_data::text, E'\\n' ORDER BY record_id)) AS fp
    FROM growth_learning_records WHERE family_id=$1`, [id]);
  return { n: r.rows[0].n, fp: r.rows[0].fp };
}

export const dstr = (v) => (v == null ? null
  : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function derive(db, id) {
  const rows = (await db.query(
    'SELECT * FROM public.r5_credential_derive($1) ORDER BY learning_day_raw, subject_canonical, record_date', [id])).rows;
  return rows.map((r) => ({ ...r, record_date: dstr(r.record_date) }));
}

export async function snapshot(db, id) {
  return (await db.query('SELECT public.r5_initialization_snapshot($1) AS s', [id])).rows[0].s;
}

export async function initialize(db, id, day, by, fingerprintValue) {
  const fp = fingerprintValue || (await snapshot(db, id)).snapshot_fingerprint;
  // the operator path: a database owner session, not an app session
  await clearClaims(db);
  const out = (await db.query('SELECT public.r5_initialize_authoritative_day($1,$2,$3,$4) AS r',
    [id, day, by, fp])).rows[0].r;
  await asParent(db);
  return out;
}

/** Runs fn and returns the raised message/code instead of throwing. */
export async function grab(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: e.message || String(e), code: e.code }; }
}

export async function progressRow(db, id) {
  const r = await db.query('SELECT * FROM public.r5_family_progress WHERE family_id=$1', [id]);
  return r.rows[0] || null;
}

export async function plans(db, id) {
  return (await db.query(
    'SELECT study_date::text AS d, day_index, subjects, published FROM public.r5_daily_plan WHERE family_id=$1 ORDER BY study_date', [id])).rows;
}
