import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {FRAGMENT_PROGRAM} from '../v6/r5/catalog.mjs';
const html=readFileSync(new URL('../v6/assemble-center.html',import.meta.url),'utf8');
const ids=['frag_car_common_01','frag_car_rare_01'];
for(const id of ids){
 const card=FRAGMENT_PROGRAM.vehicles.find(v=>v.vehicle_id===id);
 assert.ok(card && card.art?.thumb && card.placeholder===false,id+' must have curated thumbnail');
 assert.ok(html.includes(id+': '),id+' must be whitelisted in page');
 console.log('PASS curated thumbnail exists for',id);
}
assert.ok(html.includes('thumbById[p.vehicle_id] || !p.placeholder'),'whitelisted models must override stale placeholder flag');
console.log('PASS outdated server placeholder cannot hide validated car artwork');
assert.ok(html.includes('if (art.thumb && (thumbById[p.vehicle_id] || !p.placeholder))'));
console.log('PASS other vehicles remain subject to server placeholder setting');
assert.ok(!html.includes('if (!p.placeholder && art.thumb)'));
console.log('PASS obsolete placeholder predicate removed');
console.log('ALL 5 GARAGE THUMBNAIL PRIORITY CHECKS PASSED');
