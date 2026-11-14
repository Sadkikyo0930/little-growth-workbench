/**
 * V6 family cloud progress restore: additive, explicit user-approved, no server writes.
 * This does NOT advance authoritative learning day or modify quiz/course answers.
 * Input must already be verified for family membership and authorized row scope.
 */
export const STATE_KEY = 'growth-workbench-v6-adaptive-2';
const SUBJECTS = new Set(['语文','数学','英语','科学']);
const VALID_TIME = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) &&
  Date.parse(v) >= Date.parse('2026-01-01T00:00:00Z') &&
  Date.parse(v) <= Date.now() + 86400000;
const DAY = x => Number.isInteger(Number(x)) && Number(x)>=1 && Number(x)<=30 ? Number(x) : null;
const plain = x => x && typeof x === 'object' && !Array.isArray(x);

export function planMerge(localState, remoteRows, familyId) {
  if(!plain(localState) || !Array.isArray(localState.records) ||
    !Array.isArray(remoteRows) || typeof familyId !== 'string' || !familyId) {
    throw new Error('本机数据或云端列表格式异常，停止合并');
  }
  if(remoteRows.some(r=>!plain(r) || r.family_id!==familyId)) {
    throw new Error('云端返回其他家庭的数据，拒绝恢复');
  }
  const completed=(plain(localState.v6Course) && plain(localState.v6Course.subjects))
    ? localState.v6Course.subjects : {};
  const additions = [], skipped=[];
  for(const row of remoteRows) {
    if(row.record_type!=='course-complete' || row.record_type==='sync-test')continue;
    const d=DAY(row.learning_day);
    const subject=String(row.subject||'');
    let payload=row.record_data;
    if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload=null}}
    const at=plain(payload) && payload.completed_at;
    if(!d || !SUBJECTS.has(subject) || !VALID_TIME(at) ||
      !plain(payload) || payload.source!=='v6' || Number(payload.day)!==d){
      skipped.push(row.record_id);continue;
    }
    if(completed[d] && completed[d][subject])continue;
    if(!additions.some(x=>x.day===d && x.subject===subject)) {
      additions.push({day:d,subject,completed_at:at,record_id:String(row.record_id||'')});
    }
  }
  additions.sort((a,b)=>a.day-b.day||a.subject.localeCompare(b.subject));
  return {additions,skipped,localCount:localState.records.length,remoteCount:remoteRows.length};
}

export function applyMerge(localState, plan) {
  if(!plain(localState)||!Array.isArray(localState.records)||!plain(plan)||!Array.isArray(plan.additions))
    throw new Error('恢复计划无效');
  const next=structuredClone(localState);
  if(!plain(next.v6Course))next.v6Course={};
  if(!plain(next.v6Course.subjects))next.v6Course.subjects={};
  if(!plain(next.v6Course.completedDays))next.v6Course.completedDays={};
  let count=0;
  for(const item of plan.additions){
    const d=DAY(item.day);
    if(!d||!SUBJECTS.has(item.subject)||!VALID_TIME(item.completed_at))continue;
    if(!plain(next.v6Course.subjects[d]))next.v6Course.subjects[d]={};
    if(!next.v6Course.subjects[d][item.subject]){
      next.v6Course.subjects[d][item.subject]=item.completed_at;count++;
    }
  }
  // Do not import answer rows or completedDays. Those require authoritative
  // server reconciliation and must not advance local curriculum/day counters.
  return {state:next,added:count};
}
