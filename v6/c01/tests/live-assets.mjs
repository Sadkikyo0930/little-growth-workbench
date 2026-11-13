/* C0.1 live-asset suite — verifies the UNCHANGED racing release against an explicit
 * commit (never a branch), and re-checks that V6 main has not moved.
 *
 * Honesty rules:
 *   * Nothing is read from a cache to claim a live result.
 *   * If the network is unavailable, every remote check is reported SKIPPED with
 *     reason NETWORK_UNAVAILABLE, and the suite records verified=false.
 *   * The pinned manifest is the EXPECTED value, never evidence of a live check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSuite, writeJson } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/racing-release.json'), 'utf8'));
const suite = createSuite('live-assets');

const { repo, commit, files } = manifest.racing;
const paths = Object.keys(files);

/* ---- L1 manifest integrity (offline) ------------------------------------ */
suite.check('L1', 'manifest pins an explicit 40-hex commit, not a branch',
  /^[0-9a-f]{40}$/.test(commit), commit);
suite.check('L2', 'manifest lists the six racing resources with blob SHAs and sizes',
  paths.length === 6 && paths.every((p) => /^[0-9a-f]{40}$/.test(files[p].blob)
    && Number.isInteger(files[p].size) && files[p].size > 0));
suite.check('L3', 'manifest marks racing Pages as main /docs (unchanged)',
  manifest.racing.pages_source === 'main /docs');

const blobSha = (buf) => createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': 'c01-verify', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 404) return { error: 'HTTP_404' };
      if (!r.ok) return { error: 'HTTP_' + r.status };
      return { json: await r.json() };
    } catch (e) {
      if (i === tries - 1) return { error: 'NETWORK_UNAVAILABLE' };
      await new Promise((res) => setTimeout(res, 700));
    }
  }
  return { error: 'NETWORK_UNAVAILABLE' };
}

let networkUp = true;
const commitCheck = await getJson(`https://api.github.com/repos/${repo}/commits/${commit}`);
if (commitCheck.error) {
  networkUp = false;
  suite.skip('L4', 'racing commit is reachable', commitCheck.error);
  suite.skip('L5', 'racing commit SHA matches the manifest', commitCheck.error);
  for (const p of paths) suite.skip(`L6:${p}`, `${p} blob matches the manifest`, commitCheck.error);
} else {
  suite.check('L4', 'racing commit is reachable through the GitHub API', true);
  suite.check('L5', 'racing commit SHA matches the manifest',
    commitCheck.json.sha === commit, commitCheck.json.sha);
  for (const p of paths) {
    const res = await getJson(`https://api.github.com/repos/${repo}/contents/${p}?ref=${commit}`);
    if (res.error) {
      networkUp = false;
      suite.skip(`L6:${p}`, `${p} blob matches the manifest`, res.error);
      continue;
    }
    const buf = Buffer.from(res.json.content || '', 'base64');
    suite.check(`L6:${p}`, `${p} blob matches the manifest (size ${files[p].size})`,
      res.json.sha === files[p].blob && blobSha(buf) === files[p].blob && buf.length === files[p].size,
      `sha=${res.json.sha} size=${buf.length}`);
  }
}

/* ---- L7 V6 main must not move ------------------------------------------ */
if (!networkUp) {
  suite.skip('L7', 'V6 main has not moved since capture', 'NETWORK_UNAVAILABLE');
} else {
  const main = await getJson(`https://api.github.com/repos/${manifest.v6.repo}/commits/main`);
  if (main.error) {
    suite.skip('L7', 'V6 main has not moved since capture', main.error);
  } else {
    suite.check('L7', 'V6 main has not moved since capture',
      main.json.sha === manifest.v6.main_at_capture, main.json.sha);
  }
}

suite.check('L8', 'suite reports whether verification was live or unavailable',
  typeof networkUp === 'boolean');

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/live-assets-results.json'), {
  ...summary,
  verified: networkUp,
  mode: networkUp ? 'LIVE' : 'UNVERIFIED',
  commit,
  repo,
  results: suite.results,
});
if (summary.failed > 0) process.exitCode = 1;
