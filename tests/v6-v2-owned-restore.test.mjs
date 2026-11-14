import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {createSyncController,TEST_FAMILY} from '../v2-source/docs/r5/family-sync-controller.mjs';
const store=()=>{
  const m=new Map();
  return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};
};
const save={
 family_id:TEST_FAMILY,revision:25,coins_balance:357,
 current_vehicle:'frag_common',
 owned:{
  frag_car_common_01:{source:'fragment-assembly'},
  frag_common:{source:'fragment-assembly'},
  frag_car_rare_01:{source:'fragment-assembly'},
  frag_rare:{source:'fragment-assembly'},
  'birthday-star-6':{source:'birthday'},
 },
 chapter1_state:'done',chapter2_state:'playing',
 fragments:{frag_common:0,frag_scholar:0},
};
let fetches=0;
const mock=async(url,init)=>{
 fetches++;
 assert.ok(url.startsWith('https://v2-test.invalid/'));
 assert.equal(init.headers['x-r5-device'],'fake-device-only');
 return Response.json({api:'r5_racing_save',status:'OK',save,revision:25,applied_events:[],duplicate_events:[]});
};
const storage=store();
const controller=createSyncController({storage,expectedFamily:TEST_FAMILY,deviceToken:'fake-device-only',baseUrl:'https://v2-test.invalid',fetchImpl:mock});
let n=0;
function check(label,fn){fn();n++;console.log('PASS',label)}
const first=await controller.join();
check('V2 family cloud restore succeeds',()=>assert.equal(first.status,'RESTORED'));
const owned=JSON.parse(storage.getItem('lrv2.garage.owned'));
check('V2 normal racing ID is drivable-owned',()=>assert.ok(owned.frag_common));
check('V2 rare racing ID is drivable-owned',()=>assert.ok(owned.frag_rare));
check('both canonical V6 IDs remain available for V6 garage',()=>assert.ok(owned.frag_car_common_01&&owned.frag_car_rare_01));
check('birthday car is not injected into normal owned map',()=>assert.ok(!owned['birthday-star-6']));
check('coin balance was not charged a second time',()=>assert.equal(JSON.parse(storage.getItem('lrv2.garage.coins')).coins,357));
check('story chapter progress restored',()=>{
 assert.equal(JSON.parse(storage.getItem('littleRacingV2.story.chapter1')).state,'done');
 assert.equal(JSON.parse(storage.getItem('littleRacingV2.story.chapter2')).state,'playing');
});
check('real production entry imports the tested sync controller',()=>{
 const entry=readFileSync(new URL('../v2-source/docs/r5/family-preview.mjs',import.meta.url),'utf8');
 assert.ok(entry.includes('createSyncController'));
 assert.ok(fetches>0);
});
console.log('ALL '+n+' V2 FRAGMENT RESTORE TESTS PASSED');
