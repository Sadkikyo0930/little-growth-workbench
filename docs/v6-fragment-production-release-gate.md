# V6 Fragment Garage — production migration safety gate (2026-11-14)

**Status: HOLD / Draft PR #3. This document does not authorize production changes.**
Reviewed candidate: `c2ee63c734410e551cedee7883c74508631ad477`.

## Verified evidence and remaining boundaries
- Uploaded PROD-VERIFY-r5.md reports `growth_learning_records` columns match the isolated schema, and `learning_day` is a curriculum-day integer, **not** a calendar date. The migration must continue to use `created_at AT TIME ZONE 'Asia/Shanghai'` to assess eligibility.
- Its read-only role probe reports `cloudbase_postgres_postgres_130fh140` with `BYPASSRLS`. This is evidence **about the observed path**, not proof that every deployed gateway/function or all future invocations share that identity.
- `db/20261114_fragment_scope_guard.sql` currently contains broad illustrative rollback grants. **Do not execute those grant examples.** They may expand permissions beyond the pre-migration state.
- The three scripts have no explicit cross-script `BEGIN`/`COMMIT` scope. Three independent ExecutePGSql requests are **not automatically an atomic migration**.

## Mandatory read-only preflight, captured as an access-restricted evidence file
Run these in the **same production connection path that will apply the migration**, and separately identify gateway/cloud-function runtime identities. Do not publish private IDs, tokens, or full production rows.

```sql
-- Caller identity; this works before the new helper functions exist
SELECT current_user, session_user, current_setting('role', true) AS active_role;
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'service_role',
                  'cloudbase_postgres_postgres_130fh140');

-- Exact original ACL, RLS settings, ownership and policies for every affected table
SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner,
       c.relacl::text AS raw_acl, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('r5_fragment_state','r5_fragment_drops',
                    'r5_racing_events','r5_racing_saves','r5_device')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('r5_fragment_state','r5_fragment_drops',
                    'r5_racing_events','r5_racing_saves','r5_device')
ORDER BY tablename, policyname;

-- Restore function bodies from the actual live database, not a stale fixture.
SELECT p.oid::regprocedure::text AS signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS raw_acl,
       pg_get_functiondef(p.oid) AS original_definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('r5_fragment_snapshot','r5_fragment_claim','r5_fragment_assemble')
ORDER BY signature;
```

Also record pre-existing row counts/checksums by family **without exposing detailed rows**; record existing grants on related sequences and database functions; prove that no other client or integration directly depends on the table privileges being revoked. Obtain a production-safe backup and a tested restore method.

## Atomicity decision gate
1. First establish whether the CloudBase SQL interface supports a **single physical transaction on one session spanning all three scripts**. Do not infer that separate tool calls share a transaction. PostgreSQL DDL is ordinarily transactional; CloudBase transport/batching behavior must be verified.
2. If supported, in a rehearsed isolated environment test `BEGIN` → server-authority → scope-guard → member-scope → read-only invariants → `COMMIT`; inject deliberate failures after script 1 and 2 to show a complete rollback. Set an appropriate lock timeout. No application traffic in a half-migrated state.
3. If the interface cannot ensure same-session atomicity, **stop** and create a separately approved maintenance/compensating-migration procedure. Never fire three production scripts independently under an assumed transaction.
4. Only after explicit production authorization and a successful preflight may migration be considered. During this PR, **do not apply** the scripts.

## Exact rollback, not broad grants
- Preferred for an error *before commit*: roll back the **same transaction**; confirm original functions, table ACL, RLS and policies are intact.
- For a committed migration: use the preflight **live original** function definitions and **exact per-object/per-role** ACL/RLS/policy states. Preserve every original grant option and revoke only newly added permissions. Restore `relrowsecurity` and `relforcerowsecurity` exactly as captured. Never use blanket grants to `anon`/`authenticated`.
- Preserve all learning records, claim rows, fragment balances, saves, family members, vehicle awards and IDs. Do not delete or overwrite any game state to roll back code.
- Account for any new tables/functions created by migration. Do not drop those if production writes may have occurred or dependencies reference them; keep them inert pending an audited cleanup.
- After rollback, re-evaluate **security posture**: restoring an old, insecure RPC must not be treated as an acceptable long-term recovery. Prefer disabling the new flow or blocking affected RPC exposure while a corrected migration is prepared.

## Release blockers that must be signed off
- Validate active database role and permissions for **gateway, racing-save function, PostgREST, and direct DB** separately.
- Confirm old RPC requests with missing/forged claims, foreign device UID, forged `p_cfg`, forged `p_cost`, and direct table reads/writes are denied **without changing family data**.
- Confirm entitled parents can view only their family's real snapshot; reject a user in two families; preserve the three distinct authorized family members.
- Verify vehicle recipe `frag_car_common_01=12` and `frag_car_rare_01=8`, idempotent assembly, no birthday/coin grants, no new user login requirement.
- Run all seven suites and iPhone/PWA, grandmother's phone, and iPad acceptance tests.
- Verify and explicitly approve the pending 60% fragment-drop probability before enabling real rewards.
- Record deployed gateway/function versions, migration fingerprint, rollout time and rollback owner.

**Do not merge the Draft PR or modify production CloudBase until the owner explicitly approves the exact migration and deployment.**
