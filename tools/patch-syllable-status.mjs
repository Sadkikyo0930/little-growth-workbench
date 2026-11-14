#!/usr/bin/env node
/**
 * tools/patch-syllable-status.mjs
 *
 * Same class of leak, second file: chinese-day2-day3-preview.html 的
 * syllable() 在播放时把音节名写进状态栏。
 *
 * 这一处不是「听音选答案」题型（孩子点的就是那个音节卡片，名字本来就看得见），
 * 但为了把规则收敛成一句话 —— V6 任何音频状态栏都不出现音节名 —— 一并改成
 * 「正在播放…」。点击反馈（按钮本身的高亮）不受影响。
 *
 *   node tools/patch-syllable-status.mjs <file> [--check]
 */
import fs from 'node:fs';

const FILE = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!FILE) {
  console.error('usage: node tools/patch-syllable-status.mjs <file> [--check]');
  process.exit(2);
}
const src = fs.readFileSync(FILE, 'utf8');
const OLD = "v.textContent='正在播放 '+s;";
const NEW = "v.textContent='正在播放…';";

if (CHECK) {
  if (src.includes(OLD)) {
    console.error('status still names the syllable: ' + FILE);
    process.exit(1);
  }
  console.log('clean: ' + FILE);
  process.exit(0);
}

const parts = src.split(OLD);
if (parts.length !== 2) {
  console.error(`anchor must appear exactly once, found ${parts.length - 1}`);
  process.exit(1);
}
const out = parts[0] + NEW + parts[1];
if (out.includes("正在播放 '+")) throw new Error('another leak of the same shape remains');
fs.writeFileSync(FILE, out);
console.log(`patched ${FILE} (${src.length} -> ${out.length} chars)`);
