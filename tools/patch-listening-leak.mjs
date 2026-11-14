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
const OLD_AUDIO = "function audio(s,next){if(!Object.prototype.hasOwnProperty.call(PINYIN_FIXED_AUDIO,s))return;serial++;let t=serial;if(player)player.pause();window.speechSynthesis?.cancel();player=new Audio(PINYIN_FIXED_AUDIO[s]);let status=$('lionAudioState');if(status)status.textContent='正在播放 '+s;player.onended=()=>{if(serial===t&&next)setTimeout(()=>{if(serial===t)next()},280)};player.onerror=()=>{if(serial===t&&status)status.textContent=s+' 音频未能载入，请检查网络。不会使用其他拼音代替。'};player.play().catch(()=>{if(status)status.textContent='请再次点击播放'})}";

const NEW_AUDIO = [
  'function audio(s,next,mode){',
  "if(!Object.prototype.hasOwnProperty.call(PINYIN_FIXED_AUDIO,s))return;",
  'serial++;let t=serial;',
  'if(player)player.pause();window.speechSynthesis?.cancel();',
  'player=new Audio(PINYIN_FIXED_AUDIO[s]);',
  "let status=$('lionAudioState');",
  '/* 挑战模式下，播放前/中/后都不出现目标拼音：那是答案本身。 */',
  "const quiz=mode==='quiz';",
  "if(status)status.textContent=quiz?'正在播放题目…':'正在播放…';",
  'player.onended=()=>{',
  'if(serial!==t)return;',
  "if(status)status.textContent=quiz?'请选出听到的拼音':'播放结束，可以再听一遍';",
  'if(next)setTimeout(()=>{if(serial===t)next()},280)',
  '};',
  'player.onerror=()=>{',
  'if(serial!==t)return;',
  "if(status)status.textContent=quiz?'题目音频没能载入，请检查网络后再点一次播放。':'这段录音没能载入，请检查网络后再试一次。'",
  '};',
  "player.play().catch(()=>{if(serial===t&&status)status.textContent='还没开始播放，请再点一次播放'})",
  '}',
].join('');

const OLD_CALL = "$('lionListen').onclick=()=>audio(s);";
const NEW_CALL = "$('lionListen').onclick=()=>audio(s,null,'quiz');";

function replaceOnce(haystack, needle, replacement, label) {
  const parts = haystack.split(needle);
  if (parts.length !== 2) {
    throw new Error(`${label}: expected exactly 1 occurrence, found ${parts.length - 1}`);
  }
  return parts[0] + replacement + parts[1];
}

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
