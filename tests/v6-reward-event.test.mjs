import {readFileSync} from 'node:fs';
import {strict as a} from 'node:assert';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hook=read('v6/r5/reward-hook.mjs'),sync=read('v6/family-auto-sync.js'),bridge=read('v6/r5-bridge.js');
const member=read('v6/r5/member-fragments.mjs'),reward=read('v6/r5/fragment-reward.mjs');
const checks=[
 ['reward queue accepts only V6 course record IDs',hook.includes('const RECORD=/^v6-')],
 ['queue keeps only IDs rather than credentials',!hook.includes('authorization:')&&!hook.includes('accessToken')],
 ['queue is deduplicated',hook.includes('!q.includes(id)')],
 ['claimed ledger prevents repeated prompts',hook.includes('take(SEEN_KEY).includes(id)')],
 ['reward remains silent while inactive',hook.includes("!== 'active'")],
 ['claim uses authenticated member route',hook.includes('memberClaim(recordId)')],
 ['reward overlay does not call claim twice',hook.includes('claimImpl:async()=>response')],
 ['rejected old records are discarded',hook.includes("'NOT_TODAY'")&&hook.includes("'RECORD_NOT_FOUND'")],
 ['reward accepts local state override',reward.includes('opts.loadStateImpl')],
 ['member claim uses no client family or cost',member.includes("{p_record_id:id}")],
];
checks.forEach(([name,ok])=>{a.ok(ok,name);console.log('PASS',name)});
console.log('ALL '+checks.length+' REWARD EVENT CONTRACT CHECKS PASSED');
