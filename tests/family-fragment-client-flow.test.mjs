import {strict as assert} from 'node:assert';
const family='synthetic-family-001';
const calls=[];
const storage=new Map();
let user='test-mom', mode='CLAIMED';
globalThis.location={search:''};
globalThis.localStorage={
  getItem:k=>storage.get(k)||null,
  setItem:(k,v)=>storage.set(k,String(v)),
};
const auth={
  async getSession(){return {data:{session:{user:{id:user},access_token:'synthetic-jwt'}}}},
  async getAccessToken(){return {accessToken:'synthetic-jwt'}},
};
globalThis.window={cloudbase:{init:()=>({auth})}};
globalThis.fetch=async(url,init={})=>{
  const u=String(url);calls.push({url:u,method:init.method||'GET',body:init.body||'',headers:init.headers||{}});
  if(u.includes('/growth_family_members'))return {
    ok:true,status:200,async json(){return user==='test-mom'
      ? [{family_id:family,user_id:user,member_role:'parent'}] : []}
  };
  if(u.includes('/rpc/r5_fragment_member_claim'))return {
    ok:true,status:200,async text(){return JSON.stringify(mode==='CLAIMED'
      ? {status:'CLAIMED',granted_normal:1,granted_rare:0,zero_write:false}
      : {status:mode,granted_normal:1,granted_rare:0,zero_write:true})}
  };
  if(u.includes('/v1/racing/fragment/claim'))return {
    ok:false,status:403,async text(){return '{"error":"bad device"}'}
  };
  throw Error('UNEXPECTED_FETCH:'+u);
};
const {claimFragment}=await import('../v6/r5/fragment-client.mjs');
const {memberClaim}=await import('../v6/r5/member-fragments.mjs');
let count=0;
function check(label,fn){fn();count++;console.log('PASS '+label)}
const result=await claimFragment('learning-synthetic-1');
check('no racing token calls parent-authenticated RPC',()=>assert.equal(result.status,'CLAIMED'));
check('native SQL reward count normalized',()=>assert.deepEqual(result.granted,{normal:1,rare:0}));
check('no unauthenticated gateway call on parent-only device',()=>assert.equal(calls.filter(x=>x.url.includes('/v1/racing/fragment/claim')).length,0));
const first=calls.find(x=>x.url.includes('/rpc/r5_fragment_member_claim'));
check('RPC body includes only record id, not family or probability',()=>{
 assert.deepEqual(JSON.parse(first.body),{p_record_id:'learning-synthetic-1'});
 assert.equal(first.headers.authorization,'Bearer synthetic-jwt');
});
mode='REWARD_NOT_ACTIVE';
const paused=await claimFragment('learning-synthetic-2');
check('inactive status never normalized to a successful claim',()=>assert.equal(paused.status,'REWARD_NOT_ACTIVE'));
mode='ALREADY_CLAIMED';
const dupe=await claimFragment('learning-synthetic-1');
check('duplicate record preserves zero_write',()=>assert.equal(dupe.zero_write,true));
storage.set('r5_device','stale-device-token');mode='CLAIMED';
const oldToken=await claimFragment('learning-synthetic-3');
check('stale racing device token falls back to family membership',()=>assert.equal(oldToken.status,'CLAIMED'));
check('stale token attempts gateway only once',()=>assert.equal(calls.filter(x=>x.url.includes('/v1/racing/fragment/claim')).length,1));
user='stranger';storage.delete('r5_device');
let err=null;try{await memberClaim('learning-synthetic-4')}catch(e){err=e}
check('non-member cannot call claim RPC',()=>assert.equal(err?.code,'NO_MEMBER'));
check('no client-side fragment ledger or local save writes',()=>assert.equal(storage.has('lrv2.garage.fragments'),false));
console.log('ALL '+count+' FAMILY FRAGMENT CLIENT FLOW CHECKS PASSED');
