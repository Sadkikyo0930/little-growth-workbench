import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const bridge=fs.readFileSync(new URL('../v6/r5-bridge.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../v6/r5-parent-check.html',import.meta.url),'utf8');
new vm.Script(bridge);
for(const m of page.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const checks=[
['fresh status timestamp cannot preserve old Nov 8 at',bridge.includes('Object.assign({}, prev, patch || {}, { at: new Date().toISOString() })')],
['auto RPC errors trigger authenticated read-only status',bridge.includes('readOnlyStatus = await cloudStatus(who)')],
['both failures cannot claim a real cloud day',bridge.includes('cloud_day: serverDayAtFailure')&&bridge.includes('serverDayAtFailure = verifiedToday ? readOnlyDay.plan_day : null')],
['only verified published matching authoritative day can select cloud day',bridge.includes('readOnlyDay.published')&&bridge.includes('readOnlyDay.authoritative_day === readOnlyDay.plan_day')],
['read-only fallback still blocks uploads',bridge.includes("cloud_verified_reason: 'AUTO_DAY_RPC_FAILED'")&&bridge.includes('pending: null, pending_known: false')],
['read-only fallback does not automatically advance or publish',!bridge.slice(bridge.indexOf('catch (rolloverError)'),bridge.indexOf('var st = await cloudStatus(who);',bridge.indexOf('catch (rolloverError)'))).includes('await publishPlan(')],
['parent page renders local/cloud status Chinese',page.includes('云端今日计划只读核实')&&page.includes('本机学习日')],
['parent page busts bridge script cache',page.includes('auto-next-day-c01-7')],
['no local data clearing',!bridge.includes('localStorage.clear(')],
['cloud score records unchanged by this patch path',bridge.includes('学习记录未改动')],
];
checks.forEach(([name,result])=>{assert(result,name);console.log('PASS '+name)});
console.log('PASS '+checks.length+'/'+checks.length);
