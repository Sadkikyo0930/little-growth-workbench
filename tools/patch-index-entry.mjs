#!/usr/bin/env node
/**
 * tools/patch-index-entry.mjs
 *
 * Wires the V6 home hotspot 「我的车库」 to the restored 赛车组装中心.
 *
 *   node tools/patch-index-entry.mjs <v6/index.html> [--check]
 *
 * The home page is a single-line 1.1 MB bundle, so a unified diff is useless.
 * This does one exact, counted string replacement and refuses to write if the
 * anchor is missing or appears more than once.
 *
 * What changes: only the click handler.
 *   before: alert('车库功能即将开放')      ← the "未开启" the parent saw
 *   after : location.href = './assemble-center.html?d=…&family=…'
 *
 * What deliberately does NOT change: the visible label. The home artwork bakes
 * the words 「我的车库」 into the bitmap and the family calls the feature by that
 * name, so renaming it to 赛车组装中心 (as the 11-12 patch did) would fight the
 * parent's own vocabulary for no benefit.
 */
import fs from 'node:fs';

const FILE = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!FILE) {
  console.error('usage: node tools/patch-index-entry.mjs <v6/index.html> [--check]');
  process.exit(2);
}
const src = fs.readFileSync(FILE, 'utf8');

const OLD = "$('goGarage').onclick=()=>alert('车库功能即将开放');";
const NEW = [
  "$('goGarage').onclick=()=>{",
  'const q=new URLSearchParams(location.search);',
  'const p=new URLSearchParams();',
  "const d=q.get('d'),fam=q.get('family');",
  "if(d)p.set('d',d);",
  "if(fam)p.set('family',fam);",
  "try{const dev=localStorage.getItem('r5_device');if(!p.get('d')&&dev&&/^r5dev_[0-9a-f]{32}$/.test(dev))p.set('d',dev)}catch(e){}",
  "const s=p.toString();location.href='./assemble-center.html'+(s?'?'+s:'')",
  '};',
].join('');

if (CHECK) {
  if (src.includes(OLD)) {
    console.error('entry still dead-ends on alert(): ' + FILE);
    process.exit(1);
  }
  if (!src.includes("location.href='./assemble-center.html'")) {
    console.error('entry does not point at the assembly centre: ' + FILE);
    process.exit(1);
  }
  console.log('entry wired: ' + FILE);
  process.exit(0);
}

const parts = src.split(OLD);
if (parts.length !== 2) {
  console.error(`anchor must appear exactly once, found ${parts.length - 1}`);
  process.exit(1);
}
const out = parts[0] + NEW + parts[1];

/* post-conditions */
if (out.includes("alert('车库功能即将开放')")) throw new Error('old handler left behind');
if (!out.includes('id="goGarage"')) throw new Error('hotspot button disappeared');
if (out.length - src.length !== NEW.length - OLD.length) {
  throw new Error('unexpected byte delta, refusing to write');
}

fs.writeFileSync(FILE, out);
console.log(`patched ${FILE} (${src.length} -> ${out.length} chars, +${out.length - src.length})`);
