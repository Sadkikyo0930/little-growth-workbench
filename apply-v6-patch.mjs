#!/usr/bin/env node
/**
 * v6/apply-v6-patch.mjs — 给 V6 的 v6/index.html 挂上 R5 桥接脚本
 *
 * v6/index.html 有 1.1 MB，不适合整文件替换，所以用这个幂等脚本只加一行：
 *   <script src="./r5-bridge.js?v=20261108-r5-2"></script>
 * 插在 family-auto-sync.js 之后、</body> 之前，保证 V6 的全局 state / v6CourseDay
 * 已经就绪，且不会打乱现有脚本顺序。
 *
 * 用法（在 little-growth-workbench 仓库根目录执行）：
 *   node apply-v6-patch.mjs                 # 注入
 *   node apply-v6-patch.mjs --check         # 检查
 *   node apply-v6-patch.mjs --revert        # 还原
 *   node apply-v6-patch.mjs --file v6/index.html
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const file = path.resolve(opt('--file', 'v6/index.html'));
const TAG = '<script src="./r5-bridge.js?v=20261108-r5-2"></script><!-- r5-bridge -->';

if (!fs.existsSync(file)) {
  console.error(`[r5-v6] 找不到 ${file}（请在 little-growth-workbench 根目录执行）`);
  process.exit(2);
}

const before = fs.readFileSync(file, 'utf8');
const has = before.includes('<!-- r5-bridge -->');

if (flag('--check')) {
  console.log(has ? 'PATCHED' : 'UNPATCHED');
  process.exit(has ? 0 : 1);
}

if (flag('--revert')) {
  if (!has) { console.log('[r5-v6] 未注入'); process.exit(0); }
  // 版本号无所谓：整段 script 标签 + 标记一起去掉，就能逐字节还原
  const out = before.replace(/<script src="\.\/r5-bridge\.js\?v=[^"]*"><\/script><!-- r5-bridge -->/g, '');
  fs.writeFileSync(file, out);
  console.log('[r5-v6] 已还原');
  process.exit(0);
}

if (has) { console.log('[r5-v6] 已经注入过（幂等）'); process.exit(0); }

const anchor = '<script src="./family-auto-sync.js?v=20261106-auth-help"></script>';
if (!before.includes(anchor)) {
  console.error('[r5-v6] 没有找到 family-auto-sync 脚本标签，已中止（不做猜测性注入）');
  process.exit(3);
}

fs.writeFileSync(file, before.replace(anchor, anchor + TAG));
console.log('[r5-v6] 已注入 R5 桥接 → v6/index.html');
