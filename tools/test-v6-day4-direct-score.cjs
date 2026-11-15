'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../v6');
const html=fs.readFileSync(path.join(base,'chinese-day2-day3-preview.html'),'utf8');
const bridge=fs.readFileSync(path.join(base,'r5-bridge.js'),'utf8');
const classroom=fs.readFileSync(path.join(base,'chinese-classroom.js'),'utf8');
const sw=fs.readFileSync(path.join(base,'sw.js'),'utf8');
let checked=0;const ok=(value,message)=>{assert.ok(value,message);checked++};
const begin=html.indexOf("function draw(){const qs=lessons[day].questions");
const end=html.indexOf("if(new URLSearchParams(location.search).has('embed'))",begin);
ok(begin>=0&&end>begin,'live quiz draw function found');
const draw=html.slice(begin,end);
new Function(draw);
function testFinish(n,score,expectedDay,embed){
 const messages=[];const box={innerHTML:''};const again={onclick:null};
 const context={day:n,qi:10,score,lessons:{[n]:{questions:Array.from({length:10},()=>['?', 'a','b','c',0])}},location:{search:embed?'?embed=1':'' ,origin:'https://example.test'},
   window:{parent:{postMessage:(msg,origin)=>messages.push({msg,origin})}},URLSearchParams,
   $:id=>id==='questions'?box:again,document:{},setTimeout,clearTimeout,console};
 vm.createContext(context);vm.runInContext(draw+';draw();',context);
 ok(box.innerHTML.includes('答对 '+score+' / 10 题'),'completed score is visible');
 ok(messages.length===(embed?1:0),'only embedded official page sends score');
 if(embed){
  ok(messages[0].msg.type==='v6-cn-quiz-score','direct message type accepted by bridge');
  ok(messages[0].msg.lessonDay===expectedDay,'reported study day is correct');
  ok(messages[0].msg.total===10&&messages[0].msg.score===score,'actual result, not placeholder');
  ok(messages[0].origin==='https://example.test','same origin target');
 }
}
testFinish(2,9,4,true);
testFinish(2,10,4,true);
testFinish(3,8,6,true);
testFinish(2,10,4,false);
ok(bridge.includes("e.data.lessonDay != null && Number(e.data.lessonDay) !== day"),'bridge rejects stale/foreign-day message');
ok(bridge.includes("pack.cnPageQuizHistory.push(previous)"),'bridge retains old 3-question history');
ok(bridge.includes("previous.total >= total"),'bridge does not overwrite longer results with shorter ones');
ok(classroom.includes('chinese-day2-day3-preview.html?embed=1&v=20261115-direct-score'),'official iframe has a new URL');
ok(sw.includes('20261115-chinese-direct-result-v1'),'PWA cache key updated');
ok(sw.includes('if(freshLesson || url.pathname.endsWith'), 'lesson uses network-first cache');
ok(sw.includes("url.pathname.endsWith('/chinese-day2-day3-preview.html')"),'day 4 iframe network-first');
console.log('PASS '+checked+'/'+checked+' day 4 direct ten-question result handoff checks');
