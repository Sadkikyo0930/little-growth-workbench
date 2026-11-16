/* V6 four-subject attempt history. Append-only; never fabricates cloud answers. */
(function(){
'use strict';
const KEY='v6-attempt-history-v1';
const SUBJECTS=new Set(['语文','数学','英语','科学']);
function read(){try{const v=JSON.parse(localStorage.getItem(KEY)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch(_){return {}}}
function record(input){
 if(!input||!SUBJECTS.has(input.subject)||!Number.isInteger(Number(input.lesson))||Number(input.lesson)<1)return null;
 const total=Number(input.total),correct=Number(input.correct);
 if(!Number.isInteger(total)||total<1||!Number.isInteger(correct)||correct<0||correct>total)return null;
 const day=Number(input.learningDay);
 const k=input.subject+'|'+(Number.isInteger(day)&&day>=1&&day<=30?'day'+day:'lesson'+Number(input.lesson));
 const data=read(),history=Array.isArray(data[k])?data[k]:[];
 const id=typeof input.attemptId==='string'&&input.attemptId?input.attemptId:
   (typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));
 if(history.some(x=>x.id===id))return history.find(x=>x.id===id);
 const entry={id,subject:input.subject,lesson:Number(input.lesson),
   learningDay:Number.isInteger(day)&&day>=1&&day<=30?day:null,
   correct,total,rate:Math.round(correct/total*1000)/10,passed:correct*5>=total*4,
   at:input.at||new Date().toISOString(),
   source:input.source||'course-finish'};
 history.push(entry);
 data[k]=history;
 localStorage.setItem(KEY,JSON.stringify(data));
 return {entry,attemptNo:history.length,first:history[0],best:history.reduce((a,b)=>b.rate>a.rate?b:a)};
}
window.V6AttemptHistory={record,read,key:KEY};
})();
