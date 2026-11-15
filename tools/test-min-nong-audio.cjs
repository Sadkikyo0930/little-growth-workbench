// Min Nong targeted regression; safe static build gate.
const fs=require('node:fs'),assert=require('node:assert/strict');
const s=fs.readFileSync(require('node:path').join(__dirname,'../v6/chinese-day6-preview.html'),'utf8');
let n=0;function ok(x,label){assert.ok(x,label);n++; console.log('PASS',label)}
ok((s.match(/class="verse-reading-row"/g)||[]).length===4,'four always-visible per-line audio rows');
for(const line of ['锄禾日当午','汗滴禾下土','谁知盘中餐','粒粒皆辛苦'])ok(s.includes('aria-label="朗读'+line+'"'),'audio '+line);
ok(s.includes('aria-label="朗读题目"'),'question audio control');
ok(s.includes('data-speak-option'),'each answer has audio control');
ok(s.includes('e.stopPropagation();say(options[Number(b.dataset.speakOption)])'),'option speaker does not submit');
ok(s.includes('window.V6ChineseDailyQuestions.extend(11,'),'day 11 uses 10-item bank');
ok(s.includes('poem-audio.js?v=20261115a'),'existing poem assets retained');
const inline=[...s.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
for(const js of inline)new Function(js);
ok(inline.length===1,'inline lesson JavaScript parses');
console.log('PASS '+n+'/'+n+' Min Nong static build checks');
