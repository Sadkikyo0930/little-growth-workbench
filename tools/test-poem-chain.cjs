const {JSDOM}=require(process.env.V6_TEST_JSDOM || 'jsdom');
const fs=require('fs'),assert=require('assert/strict');
const root=require('path').resolve(__dirname,'../v6')+'/';let count=0;
const pairs={4:[['远看山有色','近听水无声']],7:[['不解藏踪迹','浮萍一道开']],9:[['桃花潭水深千尺','不及汪伦送我情']],11:[['谁知盘中餐','粒粒皆辛苦']],13:[['小时不识月','呼作白玉盘'],['又疑瑶台镜','飞在青云端']],23:[['远看山有色','近听水无声'],['不解藏踪迹','浮萍一道开'],['谁知盘中餐','粒粒皆辛苦'],['桃花潭水深千尺','不及汪伦送我情'],['小时不识月','呼作白玉盘']],25:[['桃花潭水深千尺','不及汪伦送我情']],27:[['小时不识月','呼作白玉盘']],28:[['不解藏踪迹','浮萍一道开']],30:[['远看山有色','近听水无声'],['不解藏踪迹','浮萍一道开'],['谁知盘中餐','粒粒皆辛苦']]};
function check(v,msg){assert(v,msg);count++}
function setup(day){const dom=new JSDOM('<main><p>远看山有色，近听水无声。</p></main>',{url:'https://isolated.test/v6/lesson.html',runScripts:'outside-only'}),w=dom.window;w.speechSynthesis={cancel(){},getVoices(){return[]},speak(){}};w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.localStorage.setItem('v6PoemSpeech_'+day,JSON.stringify({99:{correct:true,recognized:'old'}}));let script={src:'https://isolated.test/v6/poem-audio.js',dataset:{}};Object.defineProperty(w.document,'currentScript',{get:()=>script,configurable:true});w.eval(fs.readFileSync(root+'poem-audio.js','utf8'));script.dataset.day=day;w.eval(fs.readFileSync(root+'poem-speech-check.js','utf8'));return dom}
for(const [day,expected] of Object.entries(pairs)){
 const dom=setup(day),w=dom.window,d=w.document;
 check(d.querySelectorAll('main p .v6-poem-speaker').length===2,'each line decorated once');
 for(const [prompt,answer] of expected){
  check(d.querySelector('#poemSpeechPrompt').textContent.includes(prompt),'correct prompt '+day);
  const buttons=[...d.querySelectorAll('.poem-choice')],texts=buttons.map(b=>b.dataset.line);
  check(buttons.length===4&&new Set(texts).size===4,'four unique choices');
  check(texts.filter(t=>t===answer).length===1,'one correct answer');
  d.querySelector('#poemSpeechPrompt .v6-poem-speaker').click();
  check(buttons.every(b=>!b.disabled)&&d.querySelector('#poemSpeechNext').hidden,'speaker never submits');
  const wrong=buttons.find(b=>b.dataset.line!==answer);wrong.click();
  check(d.querySelector('#poemSpeechState').textContent.includes(answer),'wrong answer reveals expected verse');
  check(d.querySelector('.poem-choice.correct').dataset.line===answer,'highlight expected answer');
  check(d.querySelector('#poemSpeechAnswer').textContent.length>answer.length+10,'explanation available');
  const stored=JSON.parse(w.localStorage.getItem('v6PoemSpeech_'+day));
  check(stored[99].recognized==='old','old records preserved');
  check(Object.values(stored).some(r=>r.mode==='choice'&&r.correct===false&&r.recognized===wrong.dataset.line),'legacy-compatible result');
  const before=w.localStorage.getItem('v6PoemSpeech_'+day);buttons.find(b=>b.dataset.line===answer).click();
  check(w.localStorage.getItem('v6PoemSpeech_'+day)===before,'double answer not counted');
  d.querySelector('#poemSpeechNext').click();
 }
 check(d.querySelector('#poemSpeechState').textContent.includes('已完成'),'all questions finish');dom.window.close();
}
const positions=new Set();for(let i=0;i<24;i++){const dom=setup(4),d=dom.window.document;positions.add([...d.querySelectorAll('.poem-choice')].findIndex(b=>b.dataset.line==='近听水无声'));d.querySelector('[data-line="近听水无声"]').click();check(d.querySelector('#poemSpeechState').textContent.includes('选对'),'correct encouragement');dom.window.close()};check(positions.size>=3,'correct position varies');
const src=fs.readFileSync(root+'poem-speech-check.js','utf8');check(!/getUserMedia|SpeechRecognition|MediaRecorder|开始录音|识别中|识别失败/.test(src),'no recording APIs or UI');
const manifest=JSON.parse(fs.readFileSync(root+'audio/poems/manifest.json'));for(const [text,path] of Object.entries(manifest.files)){check(fs.statSync(root+path).size>1000,'audio present '+text)}
console.log('PASS '+count+'/'+count+' assertions; 17 continuation questions across 10 days; SKIP 0');

