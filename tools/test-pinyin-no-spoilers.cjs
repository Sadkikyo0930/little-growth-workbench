const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require(process.env.V6_TEST_JSDOM||'jsdom');
const v6=path.resolve(__dirname,'../v6');let checks=0;
const ck=(condition,msg)=>{assert.ok(condition,msg);checks++};
const days=[12,13,14,15,16,17];
for(const day of days){
 const html=fs.readFileSync(path.join(v6,'chinese-day'+day+'-preview.html'),'utf8');
 const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
 ck(inline.length>=1,'inline script day '+day);
 inline.forEach(src=>{new Function(src);ck(true,'JavaScript parses day '+day)});
 ck(html.includes('v6-no-quiz-leak'),'background answer masking day '+day);
 ck(!/modal\("🔤 "\+current\+" · "\+d\.p/.test(html),'no full pinyin in challenge title day '+day);
 ck(!/show\("🔤 "\+word\+" · "\+d\.full/.test(html),'no full pinyin in challenge title day '+day);
 ck(!/modal\("🔤 "\+active\+" · "\+d\.p/.test(html),'no full pinyin in challenge title day '+day);
 if(day===12)ck(html.includes('class="blendPart">?</div><span>＋</span><div class="blendPart">?</div>'),'no final answer in initial prompt');
 if(day===17){
  ck(!html.includes('$("hint").textContent="「寻」的韵母'),'no hard-coded answer hint');
  const dom=new JSDOM(html,{url:'https://isolated.test/v6/chinese-day17-preview.html',runScripts:'outside-only'});
  const w=dom.window;w.speechSynthesis={cancel(){},getVoices(){return []},speak(){}};
  w.SpeechSynthesisUtterance=function(t){this.text=t};
  w.V6ChineseDailyQuestions={extend(day,original){return original}};
  inline.forEach(src=>w.eval(src));
  for(const [word,answer] of [['迹','j'],['寻','x'],['馆','g']]){
   w.document.querySelector('[data-blend="'+word+'"]').click();
   const title=w.document.querySelector('#dialogTitle')?.textContent||'';
   const hint=w.document.querySelector('#hint')?.textContent||'';
   const body=w.document.querySelector('#dialogBody')?.textContent||'';
   ck(title.includes(word)&&!/[a-zA-Züǎúnì]{2,}/.test(title),'no romanized phonetic title '+word);
   ck(!hint.includes('「寻」的韵母')&&!hint.includes('遇 x'),'neutral hint '+word);
   ck(!body.includes('正确答案'),'no answer in before-choice body '+word);
   const choices=[...w.document.querySelectorAll('button.choosePart')];
   ck(choices.length>=3,'choices rendered '+word);
   ck(choices.some(b=>b.textContent.trim()===answer),'correct initial present '+word);
  }
  dom.window.close();
 }
}
console.log('PASS '+checks+'/'+checks+' pinyin spoiler prevention checks');
