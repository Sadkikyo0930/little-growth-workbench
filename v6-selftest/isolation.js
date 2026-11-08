/* Test-only client boundary. Does not clear or read production storage. */
(function(){'use strict';
 const family='r5-selftest-family',prefix='r5-selftest.v1:';
 if(!location.pathname.startsWith('/little-growth-workbench/v6-selftest/')&&!location.pathname.startsWith('/little-racing-v2-test/'))throw Error('R5_TEST_PATH_REQUIRED');
 const originals={};
 for(const name of ['localStorage','sessionStorage']){
  const raw=window[name]; originals[name]=raw;
  const keys=()=>Array.from({length:raw.length},(_,i)=>raw.key(i)).filter(k=>k&&k.startsWith(prefix)).map(k=>k.slice(prefix.length));
  const api={getItem:k=>raw.getItem(prefix+String(k)),setItem:(k,v)=>raw.setItem(prefix+String(k),String(v)),removeItem:k=>raw.removeItem(prefix+String(k)),clear:()=>keys().forEach(k=>raw.removeItem(prefix+k)),key:i=>keys()[i]??null};
  const proxy=new Proxy(api,{get:(t,k)=>k==='length'?keys().length:k in t?t[k]:typeof k==='string'?api.getItem(k):undefined,set:(t,k,v)=>{api.setItem(k,v);return true},ownKeys:keys,getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
  Object.defineProperty(window,name,{value:proxy,configurable:false});
 }
 if(window.indexedDB){const db=window.indexedDB;const open=db.open.bind(db),del=db.deleteDatabase.bind(db);db.open=(n,v)=>v===undefined?open(prefix+n):open(prefix+n,v);db.deleteDatabase=n=>del(prefix+n);}
 // No service worker is installed from test pages. Existing production workers are untouched.
 function inspect(url,method,body){
  const u=new URL(url,location.href);method=(method||'GET').toUpperCase();
  if(u.hostname.endsWith('tcloudbasegateway.com')&&u.pathname.includes('/rdb/rest')){
   const tail=u.pathname.split('/rdb/rest')[1];
   let data=null;if(body){try{data=JSON.parse(body)}catch{throw Error('R5_TEST_BAD_BODY')}}
   if(tail==='/growth_family_members'&&method==='GET'&&u.searchParams.has('user_id'))return;
   if(tail.startsWith('/rpc/')){
    if(!['r5_status','r5_publish_today','r5_bind_device','r5_list_devices'].includes(tail.split('/').pop())||data?.p_family_id!==family)throw Error('R5_TEST_RPC_BLOCKED');return;
   }
   if(tail==='/growth_learning_records'){
    if(method==='GET'&&u.searchParams.get('family_id')==='eq.'+family)return;
    if(method==='POST'&&data&&(Array.isArray(data)?data:[data]).length&&(Array.isArray(data)?data:[data]).every(r=>r.family_id===family))return;
   }
   throw Error('R5_TEST_DATABASE_BLOCKED');
  }
  if(u.hostname.endsWith('service.tcloudbase.com')&&u.pathname.includes('/r5/')){
   if(u.pathname.endsWith('/health'))return;
   let data;try{data=JSON.parse(body||'{}')}catch{throw Error('R5_TEST_BAD_BODY')}
   if(!['/r5/v1/child/entry','/r5/v1/game/action'].includes(u.pathname)||data.family_id!==family)throw Error('R5_TEST_GATE_BLOCKED');
  }
 }
 const realFetch=window.fetch.bind(window);
 window.fetch=async(input,init={})=>{const req=input instanceof Request?input:null;const body=init.body??(req&&req.method!=='GET'?await req.clone().text():undefined);inspect(req?req.url:input,init.method||req?.method,body);return realFetch(input,init)};
 const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(m,u,...args){this.__r5Request={m,u};return open.call(this,m,u,...args)};
 XMLHttpRequest.prototype.send=function(body){const r=this.__r5Request;inspect(r.u,r.m,body);return send.call(this,body)};
 async function clearLocal(){window.localStorage.clear();window.sessionStorage.clear();if(window.indexedDB && indexedDB.databases){const dbs=await indexedDB.databases();for(const d of dbs)if(d.name&&d.name.startsWith(prefix))await new Promise((ok,no)=>{const req=indexedDB.deleteDatabase(d.name.slice(prefix.length));req.onsuccess=ok;req.onerror=()=>no(Error('TEST_DB_CLEAR_FAILED'));req.onblocked=()=>no(Error('请先关闭其他测试页面'));});}}
 window.R5Isolation=Object.freeze({familyId:family,prefix,version:'20261108-isolation1',checkRequest:inspect,clearLocal});
})();
