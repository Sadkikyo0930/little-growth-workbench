import {readFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
const html=readFileSync(new URL('../v6/assemble-center.html',import.meta.url),'utf8');
const member=readFileSync(new URL('../v6/r5/member-fragments.mjs',import.meta.url),'utf8');
const client=readFileSync(new URL('../v6/r5/fragment-client.mjs',import.meta.url),'utf8');
const checks=[
 ['common model thumbnail wired',html.includes("'./assets/cars/frag_common_01-thumb.png'")],
 ['rare model thumbnail wired',html.includes("'./assets/cars/frag_rare_01-thumb.png'")],
 ['thumbnail selection keyed by exact vehicle ID',html.includes('thumbById[p.vehicle_id]')],
 ['vehicle pricing still derived server-side',html.includes('progress = buildProgress(state)')],
 ['stale device token falls back only after DEVICE error',html.includes("deviceError.code) !== 'DEVICE'")],
 ['fallback reads authenticated member identity',html.includes('state = await memberState();\n        mode = \'member\';')],
 ['member snapshot does not accept client family',member.includes("rpc('r5_fragment_member_snapshot', {}, who.token)")],
 ['member assembly accepts only car ID',member.includes("{ p_vehicle_id: v.vehicle_id }")],
 ['device token still checked by gateway',client.includes("'x-r5-device': device")],
 ['rate confirmation does not claim rewards are active',html.includes('奖励尚未启用') && !html.includes('待家长确认</b>')],
 ['rare award source accurately shown as unimplemented',html.includes('专属碎片发放来源尚未接入')],
 ['birthday and non-fragment vehicle separation preserved',html.includes('BIRTHDAY_VEHICLE_FORBIDDEN') && html.includes('COIN_VEHICLE_FORBIDDEN')],
];
checks.forEach(([name,yes])=>{assert.ok(yes,name);console.log('PASS',name)});
console.log('ALL 12 GARAGE CROSS-DEVICE THUMBNAIL CHECKS PASSED');
