import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {strict as assert} from 'node:assert';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=p=>fs.readFileSync(path.join(root,p),'utf8');
const classroom=file('v6/chinese-classroom.js');
const garage=file('v6/assemble-center.html');
const reward=file('v6/r5/fragment-reward.mjs');
const client=file('v6/r5/fragment-client.mjs');
const checks=[
 ['original quiz audio function still present',classroom.includes('function audio(s,next,mode)')],
 ['quiz uses audio in quiz mode',classroom.includes("audio(s,null,'quiz')")],
 ['listen status never concatenates revealed answer',!/正在播放[^'"\x60\n]{0,12}['"\x60]\s*\+\s*[A-Za-z_$]|\x60正在播放[^\x60]*\$\{/.test(classroom)],
 ['garage imports shared server-based fragment client',garage.includes("from './r5/fragment-client.mjs'")],
 ['garage uses shared progress calculator',garage.includes('buildProgress')],
 ['garage assembly uses server RPC',garage.includes('assembleVehicle')],
 ['garage does not write local fragment balance',!/localStorage\.setItem\s*\(/.test(garage)],
 ['garage excludes birthday car from fragment assembly',garage.includes('BIRTHDAY_VEHICLE_FORBIDDEN')],
 ['garage excludes coin cars from fragment assembly',garage.includes('COIN_VEHICLE_FORBIDDEN')],
 ['client has exactly three trusted gateway POST operations',(client.match(/post\('/g)||[]).length===3],
 ['client has no local fragment balance write',!/localStorage\.setItem\s*\(/.test(client)],
 ['reward refuses unapproved issuance',reward.includes('REWARD_NOT_ACTIVE')],
 ['reward rejects unknown status',reward.includes("FUTURE_UNKNOWN_CODE")===false && reward.includes('if (!decision.accepted)')],
];
let count=0;
for(const [name,ok] of checks){
 assert.ok(ok,name);
 console.log('PASS V6 candidate',name);count++;
}
// Parse V6 script syntax from the actual candidate (not a copied implementation).
new vm.Script(classroom,{filename:'v6/chinese-classroom.js'});
console.log('PASS V6 Chinese classroom syntax');
count++;
console.log(`ALL ${count} V6 CANDIDATE SMOKE CHECKS PASSED`);
