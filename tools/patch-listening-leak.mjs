#!/usr/bin/env node
/**
 * tools/patch-listening-leak.mjs
 *
 * Fixes the "听音挑战 reveals the answer" defect with exact, counted replacements
 * (the V6 files are single-line bundles, so a unified diff would be unreadable).
 *
 *   node tools/patch-listening-leak.mjs <file> [--check]
 *
 * Invariants enforced here, not by hand:
 *   1. the old audio() body must appear exactly once;
 *   2. the quiz call site `audio(s)` must appear exactly once;
 *   3. after patching, no `'正在播放 '+` string may remain anywhere in the file;
 *   4. the patched file must still parse (`new Function`) and must still contain
 *      the 7-question generator, the scoring call and the "下一题" control.
 *
 * --check exits 1 if the file still contains the leak, 0 if it is clean.
 */
import fs from 'node:fs';
import { EDITS, replaceOnce } from './edits.mjs';

const FILE = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!FILE) {
  console.error('usage: node tools/patch-listening-leak.mjs <file> [--check]');
  process.exit(2);
}
const src = fs.readFileSync(FILE, 'utf8');

/* ---------------- the leak, expressed as text ---------------- */
const LEAK_MARKERS = [
  /'正在播放 '\s*\+/,                 // status shows the target syllable
  /textContent\s*=\s*s\s*\+\s*'[^']*音频/, // error text starts with the target
];

function leakReport(text) {
  const hits = [];
  for (const re of LEAK_MARKERS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

if (CHECK) {
  const hits = leakReport(src);
  if (hits.length) {
    console.error('LEAK STILL PRESENT in ' + FILE + ': ' + hits.join(' | '));
    process.exit(1);
  }
  console.log('clean: ' + FILE + ' does not reveal the target syllable');
  process.exit(0);
}

/* ---------------- the replacement ---------------- */
/* 改动内容统一放在 tools/edits.mjs，测试用同一份数据做反向校验 */
const [AUDIO_EDIT, CALL_EDIT] = EDITS['chinese-classroom.js'];
const OLD_AUDIO = AUDIO_EDIT.old;
const NEW_AUDIO = AUDIO_EDIT.new;
const OLD_CALL = CALL_EDIT.old;
const NEW_CALL = CALL_EDIT.new;

let out = src;
out = replaceOnce(out, OLD_AUDIO, NEW_AUDIO, 'audio() body');
out = replaceOnce(out, OLD_CALL, NEW_CALL, 'quiz call site');

/* ---------------- post-conditions ---------------- */
const hits = leakReport(out);
if (hits.length) throw new Error('post-condition failed, leak remains: ' + hits.join(' | '));

const mustKeep = [
  ['7-question generator', /let q=quiz%7/],
  ['answer recording', /recordChineseAnswer\('听音挑战'/],
  ['next-question control', /lionNext/],
  ['answer reveal only after submit', /正确答案是 '\+s/],
];
for (const [label, re] of mustKeep) {
  if (!re.test(out)) throw new Error('post-condition failed: lost ' + label);
}

/* parse check: strip the IIFE wrapper and compile as a function body */
try {
  // eslint-disable-next-line no-new-func
  new Function(out);
} catch (e) {
  throw new Error('patched file does not parse: ' + e.message);
}

fs.writeFileSync(FILE, out);
console.log('patched ' + FILE + ' (' + src.length + ' -> ' + out.length + ' bytes)');
