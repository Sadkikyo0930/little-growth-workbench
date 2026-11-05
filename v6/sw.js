/* V6-only service worker. Does NOT read or mutate localStorage or other project versions. */
const VERSION='20261105-family-sync-2';
const PREFIX='little-growth-v6-pwa-';
const CORE=PREFIX+'core-'+VERSION;
const RUNTIME=PREFIX+'runtime-'+VERSION;
const ROOT=new URL(self.registration.scope);
const CORE_FILES=[
'./','./index.html','./manifest.webmanifest','./app-icon.svg',
'./weekly-exam.js','./clean-art.js','./chinese-classroom.js','./family-auto-sync.js',
'./chinese-classroom.css','./v6-home-clean.jpg','./v6-assessment-clean.jpg',
'./growth_background.png','./english-classroom-fixed.html',
'./science-classroom.html','./math-calendar-preview.html',
'./english-monthly-assessment.html','./phonics-v4-original.html'
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
  await Promise.all(names.filter(name=>name.startsWith(PREFIX)&&name!==CORE&&name!==RUNTIME).map(name=>caches.delete(name)));
  await self.clients.claim();
 })());
});
const inScope=url=>url.origin===ROOT.origin&&url.pathname.startsWith(ROOT.pathname);
async function store(cacheName,request,response){
 if(!response||!response.ok||response.type==='opaque')return;
 const cache=await caches.open(cacheName);
 await cache.put(request,response.clone());
 if(cacheName===RUNTIME){
  const keys=await cache.keys();
  if(keys.length>120)await Promise.all(keys.slice(0,keys.length-120).map(k=>cache.delete(k)));
 }
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
