import {rewardClaimDecision} from '../v6/r5/fragment-reward.mjs';
import {readFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
const cases=[
 ['REWARD_NOT_ACTIVE',false],['FORBIDDEN_SCOPE',false],['CONFIG_MISSING',false],
 ['SAVE_NOT_INITIALIZED',false],['NOT_TODAY',false],['RECORD_NOT_FOUND',false],
 ['BAD_RECORD_ID',false],['LEARNING_RECORD_NOT_REWARDABLE',false],
 ['',false],['FUTURE_UNKNOWN_CODE',false],
 ['CLAIMED',true],['ALREADY_CLAIMED',true]
];
for(const [status,accept] of cases){
  const got=rewardClaimDecision(status);
  assert.equal(got.accepted,accept,`unexpected policy: ${status}`);
  if(!accept) assert.ok(got.message.length>6,`missing user-facing reason: ${status}`);
  console.log('PASS reward UI status',JSON.stringify(status),'accepted',accept);
}
const src=readFileSync(new URL('../v6/r5/fragment-reward.mjs',import.meta.url),'utf8');
assert.ok(src.includes('if (!decision.accepted)'),'UI does not use policy in reward flow');
assert.ok(src.includes('return { ok: false, status };'),'UI does not return failure on denied status');
console.log('PASS reward UI is wired to fail-closed policy');
console.log('ALL 13 REWARD UI STATUS TESTS PASSED');
