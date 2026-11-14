/* Restore drill — proves that the read-only export of the live CloudBase
 * database is a *restorable* backup, not just an aggregate summary.
 *
 * What it does, in a brand-new PostgreSQL instance that has never seen this
 * data:
 *   1. creates the six tables with the production column types (read from
 *      information_schema on the live instance, see the columns array in the
 *      dump);
 *   2. inserts the exported rows byte-for-byte;
 *   3. recomputes the same table hash the live instance reported and compares.
 *
 * Step 3 is the actual test: the hash is md5 over jsonb_agg(to_jsonb(row)),
 * which covers every column of every row in a canonical order. If one value,
 * one type or one timestamp offset changed, the hash changes.
 *
 * Then it repeats the insert after deleting everything, which is what a real
 * recovery looks like (the table comes back empty or half-written, and the
 * dump has to put it back).
 *
 * Run: node tests/isolated/restore-drill.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DUMP = process.env.DRILL_DUMP
  || path.join(ROOT, 'evidence/backup-drill/tables-2026-11-14.json');

const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));

/* Production DDL for the six tables, generated from
 * information_schema.columns on the live instance. Constraints that only
 * matter to the application (CHECK / FK) are kept out on purpose: the drill is
 * about data fidelity, and a CHECK that rejects a restored legacy value would
 * be a catalog problem, not a backup problem. */
const DDL = {
  r5_parent_settings: `CREATE TABLE public.r5_parent_settings (
    family_id text PRIMARY KEY, enabled boolean NOT NULL, daily_seconds integer NOT NULL,
    bonus_seconds integer NOT NULL, updated_at timestamptz NOT NULL, updated_by text)`,
  r5_daily_plan: `CREATE TABLE public.r5_daily_plan (
    family_id text NOT NULL, study_date date NOT NULL, day_index integer NOT NULL,
    subjects jsonb NOT NULL, published boolean NOT NULL,
    PRIMARY KEY (family_id, study_date))`,
  r5_subject_template: `CREATE TABLE public.r5_subject_template (
    day_index integer PRIMARY KEY, subjects jsonb NOT NULL)`,
  r5_racing_saves: `CREATE TABLE public.r5_racing_saves (
    family_id text PRIMARY KEY, schema_version integer NOT NULL, revision bigint NOT NULL,
    baseline_confirmed boolean NOT NULL, baseline_coins bigint NOT NULL,
    baseline_source text NOT NULL, baseline_device text NOT NULL,
    baseline_confirmed_at timestamptz, coins_balance bigint NOT NULL, owned jsonb NOT NULL,
    current_vehicle text NOT NULL, chapter1_state text NOT NULL, chapter2_state text NOT NULL,
    story jsonb NOT NULL, study jsonb NOT NULL, achievements jsonb NOT NULL,
    reward_ledger jsonb NOT NULL, claims jsonb NOT NULL, coin_rewards jsonb NOT NULL,
    items jsonb NOT NULL, fragments jsonb NOT NULL, created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL, updated_by_device text NOT NULL)`,
  r5_daily_usage: `CREATE TABLE public.r5_daily_usage (
    family_id text NOT NULL, play_date date NOT NULL, used_ms bigint NOT NULL,
    active boolean NOT NULL, last_beat timestamptz,
    PRIMARY KEY (family_id, play_date))`,
  growth_family_members: `CREATE TABLE public.growth_family_members (
    family_id text NOT NULL, user_id text NOT NULL, member_role text NOT NULL,
    joined_at timestamptz NOT NULL, PRIMARY KEY (family_id, user_id))`,
};

/* columns that must be handed to the driver as JSON text, not as a JS object */
const JSONB_COLS = new Set(['subjects', 'owned', 'story', 'study', 'achievements', 'reward_ledger',
  'claims', 'coin_rewards', 'items', 'fragments']);

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) console.log(`FAIL ${id} ${name} :: ${detail}`);
};

const db = new PGlite();
await db.exec(`SET TIME ZONE 'Asia/Shanghai'`);

for (const [table, spec] of Object.entries(dump.tables)) {
  await db.exec(DDL[table]);
}

const insertAll = async (table, spec) => {
  const cols = spec.columns;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  for (const row of spec.rows) {
    const args = cols.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return null;
      if (JSONB_COLS.has(c)) return JSON.stringify(v);
      return v;
    });
    await db.query(sql, args);
  }
};

const hashOf = async (table, spec) => {
  const order = spec.order_by.map((c) => `x.${c}`).join(', ');
  const r = await db.query(
    `SELECT count(*)::int AS n, md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY ${order})::text,'[]')) AS h
       FROM public.${table} x`);
  return { n: r.rows[0].n, h: r.rows[0].h };
};

/* ---- pass 1: clean instance, straight insert ------------------------------ */
for (const [table, spec] of Object.entries(dump.tables)) {
  await insertAll(table, spec);
}
for (const [table, spec] of Object.entries(dump.tables)) {
  const got = await hashOf(table, spec);
  check(`B1:${table}`,
    `${table}: ${spec.rows.length} rows restored into a fresh instance, table hash identical to production`,
    got.n === spec.production_count && got.h === spec.production_hash,
    `want ${spec.production_count}/${spec.production_hash} got ${got.n}/${got.h}`);
}

/* ---- pass 2: wipe and recover, which is what a real restore is ------------ */
for (const table of Object.keys(dump.tables)) {
  await db.exec(`DELETE FROM public.${table}`);
}
for (const [table, spec] of Object.entries(dump.tables)) {
  const emptied = await hashOf(table, spec);
  check(`B2:${table}`, `${table}: emptied before the recovery`,
    emptied.n === 0, `got ${emptied.n}`);
  await insertAll(table, spec);
  const got = await hashOf(table, spec);
  check(`B3:${table}`,
    `${table}: recovered from the dump alone, table hash identical to production`,
    got.n === spec.production_count && got.h === spec.production_hash,
    `want ${spec.production_count}/${spec.production_hash} got ${got.n}/${got.h}`);
}

/* ---- B0: the dump itself must be internally consistent ------------------- */
check('B0', 'every table in the dump carries its own row count and hash',
  Object.values(dump.tables).every((s) => Number.isInteger(s.production_count)
    && /^[0-9a-f]{32}$/.test(s.production_hash) && Array.isArray(s.rows)
    && s.rows.length === s.production_count),
  Object.entries(dump.tables).map(([t, s]) => `${t}:${s.rows.length}/${s.production_count}`).join(' '));

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.length - pass;
await db.close();

const out = {
  generated_at: new Date().toISOString(),
  engine: 'fresh PostgreSQL instance (PGlite), never held this data before',
  dump: path.relative(ROOT, DUMP).replace(/\\/g, '/'),
  totals: { pass, fail },
  results,
};
fs.writeFileSync(path.join(ROOT, 'evidence/backup-drill/restore-drill-results.json'),
  JSON.stringify(out, null, 2) + '\n');

console.log(`restore-drill: ${pass}/${results.length} PASS`);
for (const r of results) console.log(`${r.status} ${r.id} ${r.name}`);
process.exit(fail === 0 ? 0 : 1);
