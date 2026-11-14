/**
 * A learning record is only eligible to *request* fragment settlement after
 * an existing V6 uploader confirms the cloud write. Database RPC is authoritative.
 * The local queue is a retry hint, not a local currency or completion record.
 */
import {memberState,memberClaim} from './member-fragments.mjs';
import {showFragmentReward} from './fragment-reward.mjs';

export const QUEUE_KEY='v6-fragment-pending-v1';
export const SEEN_KEY='v6-fragment-claim-seen-v1';
const RECORD=/^v6-[a-f0-9]{16}-course-(?:[1-9]|[12][0-9]|30)-(?:cn|ma|en|sc)$/;
const take=(key)=>{try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v.filter(x=>typeof x==='string').slice(-160):[]}catch{return []}};
const put=(key,values)=>localStorage.setItem(key,JSON.stringify(values.slice(-160)));
let busy=false,lastTry=0;

export function enqueueVerifiedCourse(recordId) {
  const id=String(recordId||'');
  if(!RECORD.test(id))return false;
  try {
    if(take(SEEN_KEY).includes(id))return false;
    const q=take(QUEUE_KEY);
    if(!q.includes(id)){q.push(id);put(QUEUE_KEY,q)}
    return true;
  } catch {return false}
}

export async function resumeRewardQueue() {
  if(busy || !navigator.onLine)return {status:'OFFLINE_OR_BUSY'};
  const items=take(QUEUE_KEY);
  if(!items.length)return {status:'EMPTY'};
  if(Date.now()-lastTry<60000)return {status:'THROTTLED'};
  busy=true;lastTry=Date.now();
  try {
    const state=await memberState();
    // 60% probability is approved, but this flag remains inactive until
    // separately authorized CloudBase migration and activation.
    if(state.program?.drop_percent_status !== 'active')return {status:'INACTIVE'};
    const recordId=items[0];
    const response=await memberClaim(recordId);
    const status=String(response?.status||'');
    if(['CLAIMED','ALREADY_CLAIMED'].includes(status)){
      const seen=take(SEEN_KEY);
      if(!seen.includes(recordId)){seen.push(recordId);put(SEEN_KEY,seen)}
      put(QUEUE_KEY,take(QUEUE_KEY).filter(x=>x!==recordId));
      await showFragmentReward({
        recordId,
        claimImpl:async()=>response, // do not re-issue a second claim
        loadStateImpl:memberState,
      });
      return {status,recordId};
    }
    if(['NOT_TODAY','RECORD_NOT_FOUND','BAD_RECORD_ID'].includes(status)){
      put(QUEUE_KEY,take(QUEUE_KEY).filter(x=>x!==recordId));
      return {status:'EXPIRED_OR_INVALID'};
    }
    return {status:status||'NOT_CONFIRMED'};
  }catch{return {status:'RETRY_LATER'}}
  finally{busy=false}
}
