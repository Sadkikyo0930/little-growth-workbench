/* Proof that the live-asset suite degrades honestly when the network is down.
 *
 * It replaces global fetch with a throwing stub (simulating ENETUNREACH) and then
 * imports the REAL suite, so the SKIPPED / UNVERIFIED path is exercised by the
 * shipping code rather than described in prose. It is NOT part of run-all.
 *
 *   node tests/offline-proof.mjs
 *   cp evidence/live-assets-results.json evidence/live-assets-offline-proof.json   (then re-run the live suite)
 */
globalThis.fetch = async () => { throw new Error('ENETUNREACH (simulated outage)'); };
await import('./live-assets.mjs');
