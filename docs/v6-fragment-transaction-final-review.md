# V6 fragment migration: isolated transaction acceptance

Scope: preparation only. No production connection, SQL execution, deployment, game change, reward or balance change.

## Executed evidence

- Node v24.22.1, PGlite 0.5.16 (lockfile pinned).
- Attached independent rehearsal: 4/4 PASS (`original-atomicity.log`).
- Strengthened rehearsal against the exact three SQL files at branch b41fe33fcb81c321a40c4ba938a6248fffc6747f: 4/4 PASS.
- Each failure is PostgreSQL division-by-zero 22012, followed by a rejected statement 25P02, then explicit ROLLBACK.
- Rollback proof includes exact function definitions/ACL/owner, table ACL/owner/RLS flags, policy definitions, schema/column/default ACLs, role flags, and count + SHA256 of all public-table contents. Only synthetic fixture contents are hashed; no real account or data is imported.
- COMMIT compares the complete pre-COMMIT proof to the post-COMMIT proof, in addition to checking the member RPC exists and the migration changed the baseline.
- Machine evidence: `evidence/transaction-rehearsal/atomicity-results.json`. JSON includes exact tested migration hashes and synthetic catalog proof.
- Seven original suites: 361/361 PASS, 0 skipped: listening45, garage69, data-contract20, sync-simulation37, member-identity82, db-authz54, db-authority54. Full-suite stdout in `regression.log`; database assertion details in `db-authz.log` and `db-authority.log`.
- The seven-suite run used the existing (6) delivery harness. Its three SQL inputs are byte-identical to this branch; this change does not alter those production SQL files.

## Problems found and corrections

1. Remote repository lacked PGlite package/lockfile, baseline schema and functions required by its rehearsal. These are restored as synthetic-only fixtures here; node_modules is ignored.
2. Original script injected a JavaScript exception, not a database error. Now verifies PostgreSQL's aborted-transaction state before rollback.
3. Original COMMIT check only inspected one function. Now compares full catalog/permissions/data proof before and after COMMIT.
4. Original snapshot omitted fragment-state/config tables' row counts and could miss same-count data changes. Now includes every public table and content hashes.
5. Full delivery omitted `_repo` baseline inputs used by garage tests. Restored matching original main inputs locally; no application files were replaced.
6. Legacy full-delivery database fixture and two test runners contained real account IDs/device identifiers. Replaced their references consistently with synthetic IDs before execution or publication. The attached independent rehearsal already supplied synthetic schema data. The first 253-pass run with two SKIPs is not counted as full acceptance; only the completed zero-SKIP run is accepted.

The test mock of auth.jwt/SET ROLE and the PGlite superuser are not evidence of CloudBase's actual gateway roles, authentication injection, pooler behavior, or live privileges. Real-device concurrency, Safari and production credentials were not tested here.

## Single physical connection deployment plan — NOT RUN

Official CloudBase documentation supports PostgreSQL-protocol access for native transaction control. Its SDK FAQ recommends RPC or pg-protocol access for transactions. The ExecutePGSql API does not document cross-request session affinity: never send BEGIN, three scripts and COMMIT as independent ExecutePGSql requests.

Use a backend worker with an approved native PostgreSQL endpoint, TLS verification and an authorized operator identity. Obtain credentials from a secure runtime; never log them, put them in URLs/arguments, or commit them. Prefer direct instance access, or a session-pool endpoint whose session semantics have been confirmed; do not assume transaction/statement pooling preserves session state.

Use one `pg.Client` (or one checked-out Pool client retained until completion). On that client only:

1. Verify database identity/server_version/current_user/session_user/role and `pg_backend_pid()`. Confirm intended target and the migration file hashes. Stop for schema drift, concurrent migration or an unverified effective role.
2. In a maintenance window, quiesce reward issuance/assembly writers. Take and verify a private backup before DDL. Do not infer consent to pause production from this plan.
3. BEGIN; set appropriate LOCAL lock_timeout and statement_timeout; acquire a transaction advisory lock. Read the baseline catalog in this transaction. Record the same backend PID after each stage (never reconnect/retry a failed stage on another client).
4. Execute server_authority, scope_guard, member_scope in that order with awaited client.query calls, with no intervening COMMIT, concurrent connection or pool.query. Reject embedded transaction-control statements or nontransactional commands in future SQL revisions.
5. Before COMMIT verify all expected functions/ACLs/RLS/policies/recipes, stable pre-existing family data counts, intended role allowlist and unchanged pending probability status. On any failure, ROLLBACK on the same client. If transport is lost, treat commit outcome as unknown and inspect migration evidence with a new read-only connection before retrying anything.
6. COMMIT only after approval and checks. Verify persistence and data fingerprints through a new read-only session. Restore traffic only after approved smoke checks. This task does not authorize this workflow.

## Exact privilege backup and rollback plan — NOT RUN ON PRODUCTION

Before migration, save a private `pg_dump --schema-only` retaining OWNER and ACL statements (do not use --no-owner or --no-acl), plus full custom-format backup/PITR restore point and `pg_dumpall --roles-only --no-role-passwords` where managed permissions allow. Include dependent public/auth objects, overload signatures, table/sequence/schema/column ACLs, grants with grant option/grantor, default privileges, role membership/flags, policies (roles, permissive/restrictive, command, USING/WITH CHECK) and both RLS flags. ACL NULL means default grants and must not be converted blindly into an empty ACL. Store table counts/content fingerprints and each affected pg_get_functiondef/owner/proacl independently. None of these live backups belong in the public repo.

Confirm managed role metadata can be read and the backup can restore to an isolated instance first; inability to recover exact privilege state is a release blocker. Avoid creating broad REVOKE/GRANT guesses as a rollback.

Before COMMIT: ROLLBACK restores transactional DDL/DCL/data atomically; this is the operation exercised here. Compare the same baseline catalog and data proof.

After COMMIT: use a reviewed reverse migration generated from the exact pre-change schema/privilege dump. While traffic remains quiesced, restore original function overloads and ACLs (including owners/grant options/grantors/default semantics), original table/column privileges, policy definitions and RLS flags in dependency order; remove only new migration-owned objects, without CASCADE. Remove new authority/config/recipe tables only after confirming no dependencies or post-release state require preservation. Do not restore a whole older data backup over new learning/fragment/gameplay records. If writes have resumed or exact dependency/privilege restoration is uncertain, stop and choose an audited forward correction or separately approved recovery. The committed reverse migration itself has not been rehearsed in this task and remains a gate.

## Approval status and remaining gates

Isolated atomicity and the stated 361 regression assertions pass. This is sufficient to review the candidate, not sufficient to approve production release by itself. Still required: actual CloudBase native endpoint/TLS/session behavior, pg_backend_pid continuity, gateway effective-role/claim compatibility, exact private privilege backup and committed rollback rehearsal, current production schema drift check, and separate parent approval for migrations and deployment. The 60% drop rate remains pending parent confirmation; this task neither approves nor changes it. Keep PR #3 Draft and main unchanged.

Sources checked 2026-11-14:
- https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql
- https://docs.cloudbase.net/en/database/postgresql/faq
- https://node-postgres.com/features/transactions
