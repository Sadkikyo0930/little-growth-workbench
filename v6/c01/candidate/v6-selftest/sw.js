/* V6-SELFTEST-only service worker. Does NOT read or mutate localStorage or other project versions.
 *
 * C0.1 candidate (branch c01/authoritative-day-candidate, NOT deployed):
 *  - Own PREFIX so the formal v6 SW can never delete selftest caches
 *    (both previously used 'little-growth-v6-pwa-', so a VERSION bump on one
 *    scope silently purged the other scope's CORE/RUNTIME caches).
 *  - Own VERSION, schedule in CORE_FILES, network-first no-store schedule.
 *  - Cleanup limited to SELFTEST_PREFIX, plus two explicitly named legacy keys.
 */
const VERSION='20261114-c01-authoritative-day-selftest';
const PREFIX='little-growth-v6-selftest-pwa-';
const FORMAL_PREFIX='little-growth-v6-pwa-';
const CORE=PREFIX+'core-'+VERSION;
const RUNTIME=PREFIX+'runtime-'+VERSION;
const LEGACY_SELFTEST_KEYS=[
 'little-growth-v6-pwa-core-20261106-sync-live-2',
 'little-growth-v6-pwa-runtime-20261106-sync-live-2'
];
const ROOT=new URL(self.registration.scope);
const SCHEDULE_FILES=['./november-subject-schedule.js'];
const BRIDGE_FILES=['./family-auto-sync.js','./r5-bridge.js'];
const CORE_FILES=[
'./','./index.html','./manifest.webmanifest','./app-icon.svg',
'./weekly-exam.js','./clean-art.js','./chinese-classroom.js','./family-auto-sync.js',
'./chinese-classroom.css','./v6-home-clean.jpg','./v6-assessment-clean.jpg',
'./growth_background.png','./english-classroom-fixed.html',
'./science-classroom.html','./math-calendar-preview.html',
'./english-monthly-assessment.html','./phonics-v4-original.html',
'./november-subject-schedule.js'
];
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CORE);
  await Promise.allSettled(CORE_FILES.map(async file=>{
   const url=new URL(file,ROOT);
   const response=await fetch(url,{cache:'reload'});
   if(response.ok)await cache.put(url,response);
  }));
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const names=await caches.keys();
  await Promise.all(names.filter(name=>
    (name.startsWith(PREFIX)&&name!==CORE&&name!==RUNTIME)
    || LEGACY_SELFTEST_KEYS.indexOf(name)>=0
  ).map(name=>caches.delete(name)));
  await self.clients.claim();
 })());
});
const inScope=url=>url.origin===ROOT.origin&&url.pathname.startsWith(ROOT.pathname);
const isNamed=(url,files)=>files.some(file=>url.pathname===new URL(file,ROOT).pathname);
async function store(cacheName,request,response){
 if(!response||!response.ok||response.type==='opaque')return;
 const cache=await caches.open(cacheName);
 await cache.put(request,response.clone());
 if(cacheName===RUNTIME){
  const keys=await cache.keys();
  if(keys.length>120)await Promise.all(keys.slice(0,keys.length-120).map(k=>cache.delete(k)));
 }
}
function withStaleMarker(response,header){
 if(!response)return null;
 const headers=new Headers(response.headers);
 headers.set(header,'1');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
async function networkFirstNoStore(req,key,cacheName,marker,offlineText){
 try{
  const fresh=await fetch(req,{cache:'no-store'});
  if(fresh.ok){await store(cacheName,key,fresh);return fresh}
 }catch(e){}
 return withStaleMarker(await caches.match(key,{ignoreSearch:true}),marker)
   || new Response(offlineText,{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
}
async function navigation(req){
 const path=new URL(req.url).pathname;
 const key=new URL(path,ROOT.origin);
 try{
  const response=await fetch(req);
  if(response.ok)await store(CORE,key,response);
  return response;
 }catch(e){
  const cached=await caches.match(key,{ignoreSearch:true});
  if(cached)return cached;
  if(path===ROOT.pathname||path===ROOT.pathname+'index.html'){
   const fallback=await caches.match(new URL('./index.html',ROOT));
   if(fallback)return fallback;
  }
  return new Response('当前离线且本页尚未缓存。请联网打开一次课程后再尝试。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
 }
}
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||!inScope(url))return;
 if(req.mode==='navigate'){
  event.respondWith(navigation(req));
  return;
 }
 if(isNamed(url,SCHEDULE_FILES)){
  event.respondWith(networkFirstNoStore(req,new URL(url.pathname,ROOT.origin),CORE,
    'X-R5-Schedule-Stale','课程表离线不可用，请联网后重试'));
  return;
 }
 if(isNamed(url,BRIDGE_FILES)){
  event.respondWith(networkFirstNoStore(req,new URL(url.pathname,ROOT.origin),RUNTIME,
    'X-R5-Bridge-Stale','同步脚本离线不可用'));
  return;
 }
 event.respondWith((async()=>{
  const cacheKey=new URL(url.pathname,ROOT.origin);
  const cached=await caches.match(cacheKey,{ignoreSearch:true});
  const fetchAndCache=async()=>{
   const response=await fetch(req);
   if(response.ok)await store(RUNTIME,cacheKey,response);
   return response;
  };
  if(cached){
   event.waitUntil(fetchAndCache().catch(()=>{}));
   return cached;
  }
  try{return await fetchAndCache()}
  catch(e){return new Response('离线资源尚未缓存',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})}
 })());
});
