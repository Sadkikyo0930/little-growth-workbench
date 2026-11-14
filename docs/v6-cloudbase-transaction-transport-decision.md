# CloudBase V6 fragmented-car release: transaction transport decision

**Status: BLOCKED for production. No owner authorization to deploy, merge or modify CloudBase.**
Reviewed on 2026-11-14. PR #3 is a Draft.

## Confirmed CloudBase behavior (official docs)

1. `ExecutePGSql` accepts **one SQL statement per API invocation**. The official SQL execution guide explicitly says multi-statement SQL must be split into calls. This transport does **not** provide a documented multi-call transaction/session handle.
   - https://docs.cloudbase.net/database/postgresql/initialization
   - https://docs.cloudbase.net/database/postgresql/troubleshooting/common-errors
2. The official CloudBase PostgreSQL FAQ states that the SDK does not currently support direct transaction operations. For transactions, use database RPC (single function) or **PostgreSQL protocol connectivity** with a native driver.
   - https://docs.cloudbase.net/database/postgresql/faq
   - https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql

**Decision:** DO NOT split the three production migration scripts into three `ExecutePGSql` requests and claim they share one transaction. A `BEGIN` request followed by later calls is not a documented same-connection transaction and must not be used. No production migration is authorized here.

## Required isolated dry run before deployment approval

1. Install PGlite in an environment with package access. Run the original 361 tests **and** `node db/isolated/run-migration-atomicity.mjs`. Current package in GitHub is missing its `schema.sql`, `functions-before.sql` and package configuration: they exist in the uploaded delivery ZIP, **not** the remote branch. Do not copy production-like fixture IDs or credentials into a public repository.
2. For a reproducible hosted CI, generate a **fully synthetic** schema/fixture with random test family/user/device identifiers and no production rows, or use access-controlled private CI artifacts. The test should fail loudly rather than silently skip the database suites.
3. Run migration in a disposable PostgreSQL instance using a single physical `pg` connection or equivalent:
   - `BEGIN`; `SET LOCAL lock_timeout`; apply `20261114_fragment_server_authority.sql`;
   - apply `20261114_fragment_scope_guard.sql`; apply `20261114_fragment_member_scope.sql`;
   - run invariants; `COMMIT` only after all invariants pass.
   - Failure-inject after script 1, script 2, script 3: `ROLLBACK` and compare function definitions, ACL, policies, table RLS and row counts.
4. Validate the exact CloudBase connectivity method and credentials/connection role **without disclosing credentials**. Verify server role differs from front-end `anon`/`authenticated`; check behavior under pooler/proxy and whether transaction-pooling has limitations. If no supported native single-connection path can be established, **stop and design an alternative single-call RPC migration with a reviewed security boundary**.
5. Re-check the migration's scope and all direct table consumers, gateway auth, date interpretation (`learning_day` is curriculum day, date comes from `created_at`) and real schema before any production deployment.
6. Back up **exact original** live table ACL, `relrowsecurity`, `relforcerowsecurity`, RLS policies, owners, original function text/ACL and dependent objects. Rehearse exact rollback; do not use blanket `GRANT` rollback examples.
7. A successful PGlite transaction test is only PostgreSQL engine evidence; it is **not** proof of CloudBase `ExecutePGSql` multi-call session atomicity.

## Release gate

Keep PR #3 Draft; do not deploy either V6/GitHub Pages or the three SQL migrations until:
- independent 361 suite and transaction tests pass;
- real CloudBase protocol/connection and role are verified, with a tested backup and rollback;
- iPhone / grandmother device / iPad acceptance is complete;
- final 60% reward drop configuration is explicitly approved;
- owner authorizes the exact production migration and release batch.

Do not reset or backfill family fragments, learning records, birthday car, or racing saves.
