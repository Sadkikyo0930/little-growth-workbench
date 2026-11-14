import {readFileSync,statSync} from 'node:fs';
import {strict as a} from 'node:assert';
const read=p=>readFileSync(new URL('../'+p,import.meta.url));
const s=read('v2-source/docs/assets/index-Cam3Integrated.js').toString('utf8');
const entry=read('v2-source/docs/index.html').toString('utf8');
const sql=read('db/20261114_fragment_scope_guard.sql').toString('utf8');
let n=0;
function test(name,fn){fn();console.log('PASS',name);n++}
test('production V2 index points to inspected build',()=>a.ok(entry.includes('./assets/index-Cam3Integrated.js')));
test('V2 gameplay identifies normal car by frag_common',()=>a.ok(s.includes('id:`frag_common`')));
test('V2 gameplay identifies rare car by frag_rare',()=>a.ok(s.includes('id:`frag_rare`')));
test('V2 normal model loader is in live game chunk',()=>a.ok(s.includes('fragCarCommon-Bj8cS9q_.js')));
test('V2 rare model loader is in live game chunk',()=>a.ok(s.includes('fragCarRare-DrVln18k.js')));
test('V6 normal recipe maps to V2 runtime ID',()=>a.ok(sql.includes("WHEN 'frag_car_common_01' THEN 'frag_common'")));
test('V6 rare recipe maps to V2 runtime ID',()=>a.ok(sql.includes("WHEN 'frag_car_rare_01' THEN 'frag_rare'")));
test('V6 assembly writes alias into shared cloud owned map',()=>a.ok(sql.includes('jsonb_build_object(v_game_vehicle_id,')));
test('V6 assembly audits only one canonical grant event',()=>a.ok(sql.includes("'asm:' || p_vehicle_id, 'grant'") && !sql.includes("'asm:' || v_game_vehicle_id, 'grant'")));
for(const [id,filename] of [
 ['normal','v2-source/docs/assets/frag-car-common-01-D7R-vU1J.glb'],
 ['rare','v2-source/docs/assets/frag-car-rare-01-D0r3sz47.glb']
])test('V2 '+id+' GLB is a valid nonempty binary',()=>{
 const b=read(filename);a.equal(b.toString('ascii',0,4),'glTF');a.equal(b.readUInt32LE(4),2);a.equal(b.readUInt32LE(8),b.length);a.ok(b.length>500000);
});
test('V2 model builders expose correct car models',()=>{
 const common=read('v2-source/docs/assets/fragCarCommon-Bj8cS9q_.js').toString('utf8');
 const rare=read('v2-source/docs/assets/fragCarRare-DrVln18k.js').toString('utf8');
 a.ok(common.includes('createFragCommonModel')&&rare.includes('createFragRareModel'));
});
console.log('ALL '+n+' V2 FRAGMENT VEHICLE CONTRACT CHECKS PASSED');
