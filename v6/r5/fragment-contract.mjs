const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const valid = x => x !== undefined && x !== null && Number.isSafeInteger(Number(x)) && Number(x)>=0;
export function normalizeClaimResponse(raw) {
  if (!isObject(raw)) throw Error('BAD_CLAIM_RESPONSE');
  const status=String(raw.status||'');
  if(status!=='CLAIMED' && status!=='ALREADY_CLAIMED') return raw;
  const g=isObject(raw.granted)?raw.granted:null;
  const normal=g?.normal ?? raw.granted_normal;
  const rare=g?.rare ?? raw.granted_rare;
  if(!valid(normal)||!valid(rare)) throw Error('BAD_CLAIM_COUNTS');
  const frag=isObject(raw.fragment) ? raw.fragment : {fragments:isObject(raw.fragments)?raw.fragments:{}};
  return {...raw,granted:{normal:Number(normal),rare:Number(rare)},fragment:frag};
}
export function validateFragmentSnapshot(raw) {
  if (!isObject(raw) || !isObject(raw.fragment) || !isObject(raw.fragment.fragments) ||
      !(isObject(raw.fragment.owned) || isObject(raw.save?.owned)))
    throw Error('INVALID_FRAGMENT_SNAPSHOT');
  if(raw.status && raw.status !== 'OK') throw Error('FRAGMENT_SNAPSHOT_NOT_OK');
  return raw;
}
