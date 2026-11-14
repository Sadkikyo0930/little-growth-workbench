/**
 * tools/extract-function.mjs <file> <function-name> [<function-name> ...]
 *
 * 从一份 SQL 迁移里原样截取 CREATE OR REPLACE FUNCTION 的完整定义块
 * （从 `CREATE OR REPLACE FUNCTION ...` 到行首的 `$$;`），用于生成
 * 只包含函数替换的增量 migration。
 */
import { readFileSync } from 'node:fs';

const [, , file, ...names] = process.argv;
if (!file || !names.length) {
  console.error('usage: node tools/extract-function.mjs <sql-file> <fn> [fn...]');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
const out = [];

for (const name of names) {
  const start = lines.findIndex((l) =>
    new RegExp(`^CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i').test(l)
  );
  if (start < 0) {
    console.error(`not found: ${name}`);
    process.exit(1);
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$;/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) {
    console.error(`unterminated body: ${name}`);
    process.exit(1);
  }
  if (out.length) out.push('');
  out.push(...lines.slice(start, end + 1));
}

process.stdout.write(out.join('\n') + '\n');
