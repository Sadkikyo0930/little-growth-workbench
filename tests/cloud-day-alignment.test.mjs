import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../v6/pwa.js', import.meta.url), 'utf8');
const start = source.indexOf('const CLOUD_BRIDGE_STATUS =');
const end = source.indexOf("const MAIN=", start);
assert(start > 0 && end > start, 'cloud day alignment must be present in pwa.js');
const patch = source.slice(start, end);
let n = 0;function check(name,fn){fn();console.log('PASS '+name);n++;}
function setup(localDay=1){
 const data=new Map();
 let render=0, home=0, selected=1;
 const clock = new Date().toISOString();
 const ctx={window:{v6CourseDay:()=>localDay,addEventListener:()=>{}},
   document:{hidden:false,addEventListener:()=>{}},
   Date,Set,Number,JSON,localStorage:{
    getItem:k=>data.get(k)||null,
    setItem:(k,v)=>data.set(k,String(v))
   },setInterval:()=>{},
   novSelected:selected,novRender:()=>{render++},
   refreshHomeMode:()=>{home++}};
 vm.runInNewContext(patch,ctx,{filename:'v6/pwa.js#cloud-day'});
 return {ctx,data,clock,counts:()=>({render,home})};
}
const s=setup(1);
check('original local day before any cloud confirmation',()=>assert.equal(s.ctx.window.v6CourseDay(),1));
s.data.set('v6-r5-bridge-status', JSON.stringify({state:'stale_device_day',cloud_day:3,at:s.clock}));
check('grandmother device day 1 shows cloud day 3',()=>assert.equal(s.ctx.window.v6CourseDay(),3));
check('view alignment does not change local learning storage',()=>assert.equal(s.data.has('growth-workbench-v6-adaptive-2'),false));
check('cloud day 3 remains the active curriculum day even when local is ahead',()=>{
 const a=setup(4);a.data.set('v6-r5-bridge-status',JSON.stringify({state:'device_ahead',cloud_day:3,at:a.clock}));
 assert.equal(a.ctx.window.v6CourseDay(),3);
});
check('error status never uses cached cloud_day',()=>{
 const a=setup();a.data.set('v6-r5-bridge-status',JSON.stringify({state:'error',cloud_day:3,at:a.clock}));
 assert.equal(a.ctx.window.v6CourseDay(),1);
});
check('yesterday cached status never overrides today',()=>{
 const a=setup();const old=new Date(Date.now()-86400000).toISOString();
 a.data.set('v6-r5-bridge-status',JSON.stringify({state:'ok',cloud_day:3,at:old}));
 assert.equal(a.ctx.window.v6CourseDay(),1);
});
check('out-of-range cloud day rejected',()=>{
 const a=setup();a.data.set('v6-r5-bridge-status',JSON.stringify({state:'ok',cloud_day:31,at:a.clock}));
 assert.equal(a.ctx.window.v6CourseDay(),1);
});
check('temporary running state cannot reuse cached cloud day',()=>{
 const a=setup();a.data.set('v6-r5-bridge-status',JSON.stringify({state:'running',cloud_day:3,at:a.clock}));
 assert.equal(a.ctx.window.v6CourseDay(),1);
});
console.log('PASS '+n+'/'+n+' multi-device cloud day alignment checks');
