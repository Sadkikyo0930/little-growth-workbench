import test from 'node:test';
import assert from 'node:assert/strict';
import {makeR5Client, createR5GameClock} from '../client/r5-client.mjs';

function mock(responses) {
 const calls=[];
 const db={rpc:async (name,args)=>{calls.push({name,args});
   return {data:responses[name] || {allowed:true,remaining_seconds:1700,active:true}};}};
 return {client:makeR5Client(db),calls};
}
test('status invokes role-checked server RPC, not localStorage', async()=>{
 const {client,calls}=mock({r5_status:{allowed:false,reason:'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED'}});
 const result=await client.status();
 assert.equal(result.allowed,false);
 assert.equal(calls[0].name,'r5_status');
 assert.equal(calls[0].args.p_family_id,'little-growth-family-001');
});
test('game starts charging on homepage and stops on exit',async()=>{
 const {client,calls}=mock({r5_game_action:{allowed:true,remaining_seconds:1700,active:true}});
 const game=createR5GameClock(client);
 try{ await game.enter();await game.leave();
 assert.deepEqual(calls.map(x=>x.args.p_action),['start','stop']);}
 finally{game.dispose();}
});
test('game remains blocked when study incomplete',async()=>{
 let denied=false;const {client}=mock({r5_game_action:{allowed:false,reason:'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED',remaining_seconds:1800,active:false}});
 const game=createR5GameClock(client,{onDenied:()=>denied=true});
 try{await game.enter();assert.equal(denied,true);}finally{game.dispose();}
});
test('network failure blocks game without permitting offline time',async()=>{
 let denied=false;const db={rpc:async()=>{throw new Error('offline')}};
 const game=createR5GameClock(makeR5Client(db),{onDenied:()=>denied=true});
 await assert.rejects(()=>game.enter(),/offline/);assert.equal(denied,true);game.dispose();
});
test('day-plan publisher rejects impossible day numbers',()=>{
 const {client}=mock({});
 assert.throws(()=>client.publishToday({dayIndex:31}),/R5_INVALID_DAY/);
});
test('parent settings validate inputs before RPC',()=>{
 const {client}=mock({});
 assert.throws(()=>client.parentUpdate({enabled:false,dailySeconds:7.5}),/R5_INVALID_SETTINGS/);
});
test('duplicate client results are treated as error',async()=>{
 const db={rpc:async()=>({data:[{},{}]})};
 await assert.rejects(()=>makeR5Client(db).status(),/R5_UNEXPECTED_RESULT/);
});
