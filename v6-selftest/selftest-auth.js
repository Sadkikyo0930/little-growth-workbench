/* Explicit test-account login; no production account fallback or cloud logout. */
(function(){'use strict';
 const family='r5-selftest-family',rest='https://normal-goose-d5g4qyzr8bb389a4a.api.tcloudbasegateway.com/v1/rdb/rest';
 let app;
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
 async function connect(){if(!window.R5Isolation||window.R5Isolation.familyId!==family)throw Error('ISOLATION_REQUIRED');if(app)return app;if(!window.cloudbase)await new Promise((ok,no)=>{const s=document.createElement('script');s.src='https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js';s.onload=ok;s.onerror=()=>no(Error('SDK_LOAD_FAILED'));document.head.append(s)});return app=cloudbase.init({env:'normal-goose-d5g4qyzr8bb389a4a',region:'ap-shanghai'});}
 async function request(path,who,body){const r=await fetch(rest+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+who.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok||d?.error)throw Error(d.message||d.error||'HTTP_'+r.status);return d;}
 async function verify(){const a=await connect();const sr=await a.auth.getSession();const s=sr?.data?.session;if(sr?.error||!s?.user?.id)throw Error('TEST_LOGIN_REQUIRED');const tok=await a.auth.getAccessToken();const who={uid:String(s.user.id),token:tok?.accessToken||tok?.access_token||s.access_token};if(!who.token)throw Error('TEST_LOGIN_REQUIRED');
  const m=await request('/growth_family_members?select=family_id,user_id,member_role&user_id=eq.'+encodeURIComponent(who.uid),who);
  if(!Array.isArray(m)||m.length!==1||m[0].family_id!==family||m[0].user_id!==who.uid||!['owner','parent'].includes(m[0].member_role))throw Error('TEST_ACCOUNT_MEMBERSHIP_REQUIRED');
  const rows=await request('/growth_learning_records?select=record_id,created_by,record_data&family_id=eq.'+family+'&limit=5000',who);
  if(!Array.isArray(rows)||rows.length>=5000)throw Error('TEST_RECORD_AUDIT_INCOMPLETE');
  const date=today();const polluted=rows.filter(r=>{const d=r.record_data||{};return ((d.answer?.date===date)||String(d.completed_at||'').startsWith(date))&&(r.created_by!==who.uid||String(r.record_id).startsWith('r5-selftest-'));});
  if(polluted.length)throw Error('TEST_FIXTURES_PRESENT_TODAY:'+polluted.length);
  return who;
 }
 async function login(username,password){const a=await connect();const r=await a.auth.signInWithPassword({username,password});if(r?.error)throw Error('TEST_LOGIN_FAILED');return verify();}
 async function createDevice(){const who=await verify();const token='r5dev_'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');await request('/rpc/r5_bind_device',who,{p_family_id:family,p_device_uid:token,p_label:'R5 隔离真实答题验收'});const r=await fetch('https://normal-goose-d5g4qyzr8bb389a4a.service.tcloudbase.com/r5/v1/child/entry',{method:'POST',headers:{'content-type':'application/json','x-r5-device':token},body:JSON.stringify({family_id:family})});const st=await r.json();if(st.error||st.family_id!==family)throw Error('TEST_DEVICE_VERIFY_FAILED');localStorage.setItem('r5_device',token);return {familyId:family,bound:true};}
 window.R5TestAuth=Object.freeze({verify,login,createDevice,familyId:family});
})();
