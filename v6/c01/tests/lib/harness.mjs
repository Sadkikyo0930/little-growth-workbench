/* Minimal zero-dependency test harness shared by every C0.1 suite. */
import fs from 'node:fs';
import path from 'node:path';

export function createSuite(name) {
  const results = [];
  const api = {
    name,
    results,
    check(id, title, condition, detail = '') {
      results.push({
        id,
        title,
        pass: !!condition,
        detail: condition ? '' : String(detail).slice(0, 400),
      });
      return !!condition;
    },
    equals(id, title, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      return api.check(id, title, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    },
    skip(id, title, reason) {
      results.push({ id, title, pass: true, skipped: true, detail: String(reason).slice(0, 300) });
    },
    summary() {
      const passed = results.filter((r) => r.pass).length;
      const skipped = results.filter((r) => r.skipped).length;
      return {
        suite: name,
        total: results.length,
        passed,
        failed: results.length - passed,
        skipped,
        failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, title: r.title, detail: r.detail })),
      };
    },
    print() {
      const s = api.summary();
      for (const r of results) {
        const mark = r.pass ? (r.skipped ? 'SKIP' : 'PASS') : 'FAIL';
        console.log(`[${mark}] ${r.id} ${r.title}${r.detail ? ' :: ' + r.detail : ''}`);
      }
      console.log(`\n${name}: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.skipped} skipped`);
      return s;
    },
  };
  return api;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Local YYYY-MM-DD using the same local-date getters as the bridge's today(). */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}

/** Shift a YYYY-MM-DD string by n days. */
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
