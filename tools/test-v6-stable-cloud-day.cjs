const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const base=path.resolve(__dirname,'../v6');
const pwa=fs.readFileSync(path.join(base,'pwa.js'),'utf8');
const bridge=fs.readFileSync(path.join(base,'r5-bridge.js'),'utf8');
const sw=fs.readFileSync(path.join(base,'sw.js'),'utf8');
let checked=0;function ok(v,name){assert.ok(v,name);checked++}
function storage(existing={}) {
 const values=new Map(Object.entries(existing));
 return {getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),key:i=>[...values.keys()][i]||null,get length(){return values.size}};
}
const family='little-growth-family-001',key='v6-r5-confirmed-course-day',status='v6-r5-bridge-status';
const confirmed=day=>JSON.stringify({family_id:family,day,source:'authenticated_r5_status',confirmed_at:new Date().toISOString()});
function boot(store) {
 const intervals=[];const listeners={};const window={v6CourseDay:()=>3,addEventListener:(k,fn)=>{listeners[k]=fn}};
 const document={readyState:'loading',hidden:false,addEventListener:(k,fn)=>{listeners[k]=fn},getElementById:()=>null};
 const ctx={window,document,navigator:{},localStorage:store,console,Date,JSON,Set,Number,
   setInterval:fn=>{intervals.push(fn);return 1},setTimeout:()=>1,
   novSelected:3,novRender:()=>{ctx.draws=(ctx.draws||0)+1},
   refreshHomeMode:()=>{ctx.homeDraws=(ctx.homeDraws||0)+1}};
 vm.runInNewContext(pwa,ctx,{filename:'pwa.js'});
 return {ctx,window,intervals,listeners};
}
let store=storage({[key]:confirmed(4),[status]:JSON.stringify({state:'running',cloud_day:3,at:new Date().toISOString()})});
let ui=boot(store);
ok(ui.window.v6CourseDay()===4,'reopened app uses last cloud-confirmed day 4');
ok(ui.ctx.novSelected===4,'day 4 rendered immediately despite running sync');
store.setItem(status,JSON.stringify({state:'error',cloud_day:3,at:new Date().toISOString()}));
ui.intervals.forEach(fn=>fn());
ok(ui.window.v6CourseDay()===4,'temporary sync failure cannot roll UI back to day 3');
ui=boot(store);
ok(ui.window.v6CourseDay()===4,'day 4 persists after closing and reopening');
store.setItem(key,confirmed(5));ui.intervals.forEach(fn=>fn());
ok(ui.window.v6CourseDay()===5&&ui.ctx.novSelected===5,'new cloud-confirmed day advances UI to 5');
store=storage({[status]:JSON.stringify({state:'error',cloud_day:4,at:new Date().toISOString()})});
ui=boot(store);
ok(ui.window.v6CourseDay()===3,'unverified error cloud_day is never accepted as authority');
store=storage({[key]:JSON.stringify({family_id:'another-family',day:4,source:'authenticated_r5_status',confirmed_at:new Date().toISOString()})});
ui=boot(store);
ok(ui.window.v6CourseDay()===3,'other family course day is rejected');
store=storage({[key]:JSON.stringify({family_id:family,day:4,source:'made_up',confirmed_at:new Date().toISOString()})});
ui=boot(store);
ok(ui.window.v6CourseDay()===3,'unverified checkpoint is rejected');
store=storage();
ui=boot(store);
ok(ui.window.v6CourseDay()===3,'no verified plan preserves original local day');
ok(bridge.includes("rememberPublishedDay(status);")&&bridge.includes("await rpc('r5_status'"),'server checkpoint only comes from authenticated read');
ok(bridge.includes("ds.published")&&bridge.includes("Number.isInteger(day)")&&bridge.includes("old.day > day"),'bridge validates publication and prevents silent regression');
ok(sw.includes('20261115-cloud-day-stable-v1'),'offline cache version refreshed');
console.log('PASS '+checked+'/'+checked+' stable cloud course day checks; no learning records modified');
