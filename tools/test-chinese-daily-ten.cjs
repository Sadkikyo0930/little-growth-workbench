const fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process'),assert=require('assert/strict');
const {JSDOM,ResourceLoader,VirtualConsole}=require(process.env.V6_TEST_JSDOM||'jsdom');
const root=path.resolve(__dirname,'..'),v6=path.join(root,'v6');let checks=0;
const check=(value,message)=>{assert(value,message);checks++};
const BASE='69608017a69fff5feae9b23e13e467e4acb729e3';
function original(file){return cp.execFileSync('git',['show',BASE+':v6/'+file],{cwd:root,encoding:'utf8',maxBuffer:3e6})}
function literal(src,name){const match=new RegExp('\\b'+name+'\\s*=\\s*([\\[{])').exec(src);if(!match)throw Error('Missing '+name);const start=match.index+match[0].length-1;let depth=0,quote=null,escape=false;for(let i=start;i<src.length;i++){const c=src[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote=null}else if('"\'`'.includes(c))quote=c;else if(c==='['||c==='{')depth++;else if(c===']'||c==='}'){depth--;if(!depth)return vm.runInNewContext('('+src.slice(start,i+1)+')')}}throw Error('Unclosed literal')}
const specs=[
[2,'chinese-classroom.js','story'],[4,'chinese-day2-day3-preview.html','flat2'],[6,'chinese-day2-day3-preview.html','flat3'],
[7,'chinese-day4-preview.html','qs'],[9,'chinese-day5-preview.html','qs'],[11,'chinese-day6-preview.html','quiz'],[13,'chinese-day7-preview.html','questions'],[14,'chinese-day8-preview.html','questions'],[16,'chinese-day9-preview.html','questions'],[18,'chinese-day10-preview.html','questions'],[20,'chinese-day11-preview.html','questions'],[21,'chinese-day12-preview.html','questions'],[23,'chinese-day13-preview.html','questions'],[25,'chinese-day14-preview.html','data'],[27,'chinese-day15-preview.html','data'],[28,'chinese-day16-preview.html','data'],[30,'chinese-day17-preview.html','qs']
];
const bankSrc=fs.readFileSync(path.join(v6,'chinese-daily-questions.js'),'utf8');const sandbox={window:{}};vm.runInNewContext(bankSrc,sandbox);const bank=sandbox.window.V6ChineseDailyQuestions;
let added=0;
for(const[day,file,kind]of specs){
 const src=original(file);let rows;if(kind==='story')rows=literal(src,'lessons')[0].slice(4).map(q=>[q[0],q.slice(1),0]);else if(kind.startsWith('flat'))rows=literal(src,'lessons')[kind==='flat2'?2:3].questions.map(q=>[q[0],q.slice(1,-1),q.at(-1)]);else rows=kind==='data'?literal(src,'LESSON_DATA').questions:literal(src,kind);
 const before=JSON.stringify(rows),all=bank.extend(day,rows);added+=all.length-rows.length;
 check(all.length===10,'day '+day+' has ten');check(JSON.stringify(rows)===before,'original immutable');check(JSON.stringify(all.slice(0,rows.length))===before,'original order/answers unchanged');check(new Set(all.map(q=>q[0])).size===10,'no duplicate prompts day '+day);
 all.forEach(q=>{check(q[1].length===3&&new Set(q[1]).size===3,'three distinct options');check(Number.isInteger(q[2])&&q[2]>=0&&q[2]<3,'one valid answer')});
 for(const q of bank.additions[day])check(src.includes(q[3].evidence),'source evidence '+day+': '+q[3].evidence);
 console.log('PASS day '+day+': '+rows.length+' -> 10; source '+file);
}
check(added===115,'115 new questions');
const instrument=bankSrc+`;window.__questionSets={};const bank=window.V6ChineseDailyQuestions;window.V6ChineseDailyQuestions={...bank,extend(day,rows){const result=bank.extend(day,rows);window.__questionSets[day]=result;return result},extendFlat(day,rows){const result=bank.extend(day,rows.map(r=>[r[0],r.slice(1,-1),r.at(-1)]));window.__questionSets[day]=result;return result.map(r=>[r[0],...r[1],r[2]])}};`;
class Local extends ResourceLoader{fetch(url){const name=new URL(url).pathname.split('/').pop();if(name==='chinese-daily-questions.js')return Promise.resolve(Buffer.from(instrument));if(name.endsWith('.html'))return null;const p=path.join(v6,name);return name.endsWith('.js')&&fs.existsSync(p)?Promise.resolve(fs.readFileSync(p)):null}}
async function load(day,file){
 const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.detail?.stack||e.message));
 const html=day===2?'<div id="dailyChinese" class="active"></div><div id="novLesson"></div><div id="v6ChineseLesson"></div><script src="./chinese-classroom.js"></script>':fs.readFileSync(path.join(v6,file),'utf8');
 const dom=new JSDOM(html,{url:'https://isolated.test/v6/'+file,runScripts:'dangerously',resources:new Local(),virtualConsole:console,beforeParse(w){w.__cnPreviewMode=true;w.novSelected=day;w.NOV_PLAN=Array.from({length:30},()=>({type:'story'}));w.novData=()=>({});w.speechSynthesis={cancel(){},getVoices(){return[]},speak(){}};w.SpeechSynthesisUtterance=function(t){this.text=t};w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:()=>()=>{}});w.HTMLMediaElement.prototype.pause=function(){};w.HTMLMediaElement.prototype.play=function(){return Promise.resolve()};w.HTMLElement.prototype.scrollIntoView=function(){};const native=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...a)=>ms>=1000?0:native(fn,ms,...a);}});
 await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));await new Promise(r=>setImmediate(r));return{dom,errors};
}
async function main(){
for(const[day,file,kind]of specs){
 const{dom,errors}=await load(day,file),w=dom.window,d=w.document;
 if(day===2)d.querySelector('[data-pane="story"]').click();else if(kind==='flat2'||kind==='flat3')w.choose(kind==='flat2'?2:3);else if([7,9].includes(day))d.querySelectorAll('img.lesson-art')[3].click();else if(day===11)w.openQuiz();else if(day===14)w.quizStart();else if([23,25,27,28,30].includes(day))d.querySelector('[data-quiz]').click();else w.startQuiz();
 const rows=w.__questionSets[day];check(rows?.length===10,'runtime extends correct day '+day);
 for(let i=0;i<10;i++){
  const row=rows[i],needle=row[1][row[2]];
  const candidates=[...d.querySelectorAll('button')].filter(b=>!b.disabled&&!b.closest('.v6PoemPractice')&&((/^(?:data-answer|data-choice|data-a|data-opt)$/.test([...b.attributes].find(a=>/^data-(answer|choice|a|opt)$/.test(a.name))?.name||''))||b.classList.contains('option')||b.classList.contains('choice')));
  const answer=candidates.find(b=>b.textContent.includes(needle));check(!!answer,'answer available day '+day+' item '+i+': '+needle);answer.click();
  const next=[...d.querySelectorAll('button')].find(b=>!b.closest('.v6PoemPractice')&&(b.textContent.includes('下一题')||b.textContent.includes('进入下一题')||b.textContent.includes('查看闯关成绩'))&&b.style.display!=='none'&&!b.hidden);
  check(!!next,'advance available day '+day+' item '+i);next.click();
 }
 const text=d.body.textContent;check(/完成|结束/.test(text),'finished day '+day);if(day!==2)check(/(?:答对\s*10|答对10|10\s*\/\s*10)/.test(text),'full score ten day '+day);
 check(errors.length===0,'no runtime errors day '+day+': '+errors.join(';'));console.log('PASS runtime 10/10 day '+day);
}
const {dom:parentDom}=await load(2,'chinese-classroom.js'),w=parentDom.window,data={23:{done:true,poemSpeech:{0:{correct:true}}}};
w.__cnPreviewMode=false;w.novData=()=>data;w.novSelected=23;w.novRender();const frame=w.document.getElementById('lionLessonFrame');
function deliver(score,total,source=frame.contentWindow,origin=w.location.origin){w.dispatchEvent(new w.MessageEvent('message',{origin,source,data:{type:'v6-poem-quiz-complete',lessonDay:23,score,total}}))}
deliver(10,10);check(data[23].poemQuiz?.score===10&&data[23].poemQuiz?.total===10,'parent accepts ten-question result');check(data[23].done&&data[23].poemSpeech[0].correct,'historical completion and poem record preserved');
deliver(4,4);check(data[23].poemQuiz.total===4,'parent still accepts legacy four-question result');const before=JSON.stringify(data);
deliver(11,10);check(JSON.stringify(data)===before,'parent rejects score above total');deliver(3,9);check(JSON.stringify(data)===before,'parent rejects unexpected total');deliver(9,10,w);check(JSON.stringify(data)===before,'parent rejects wrong window');deliver(9,10,frame.contentWindow,'https://other.test');check(JSON.stringify(data)===before,'parent rejects cross-origin event');w.__cnPreviewMode=true;deliver(9,10);check(JSON.stringify(data)===before,'preview cannot update parent history');
console.log('PASS '+checks+'/'+checks+' checks; 17 days / 170 primary questions / 115 added; SKIP 0');}
main().catch(e=>{console.error(e);process.exitCode=1});
