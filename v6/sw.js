/* V6-only service worker. Does NOT read or mutate localStorage or other project versions. */
const VERSION='20261124-v6chinese-voice-d1';
const PREFIX='little-growth-v6-pwa-';
const CORE=PREFIX+'core-'+VERSION;
const RUNTIME=PREFIX+'runtime-'+VERSION;
const ROOT=new URL(self.registration.scope);
const CORE_FILES=[
'./','./index.html','./manifest.webmanifest','./app-icon.svg',
'./weekly-exam.js','./clean-art.js','./chinese-classroom.js','./family-auto-sync.js','./pwa.js',
'./chinese-classroom.css','./v6-home-clean.jpg','./v6-assessment-clean.jpg','./family-grades.html',
'./growth_background.png','./english-classroom-fixed.html',
'./science-classroom.html','./math-calendar-preview.html','./attempt-history.js','./science-course-quiz.js','./science-labs.js',
'./english-monthly-assessment.html','./phonics-v4-original.html',
/* 碎片车库：新页面与模块。缺文件由 Promise.allSettled 容忍，不会阻断安装。 */
'./assemble-center.html','./fragment-reward.html',
'./r5/config.mjs','./r5/catalog.mjs','./r5/identity.mjs','./r5/rdb-client.mjs','./r5/fragment-client.mjs',
'./r5/fragment-contract.mjs','./r5/fragment-reward.mjs','./r5/member-fragments.mjs','./r5/reward-hook.mjs','./r5/weekly-goal.mjs',
/* 成绩上传策略与本机补救：必须和 family-auto-sync.js 一起更新，不能落后一个版本。 */
'./r5/attempt-upload-policy.mjs','./r5/attempt-recovery.mjs','./r5/sync-health.mjs',
'./assets/cars/frag_common_01-thumb.png','./assets/cars/frag_rare_01-thumb.png'
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
 // Lessons and the question bank must refresh before the next quiz, not
 // after serving an old cached script or iframe from the previous deployment.
 // Preserve cached versions only as offline fallbacks.
 const freshLesson = url.pathname.endsWith('/attempt-history.js')
   || url.pathname.endsWith('/math-calendar-preview.html')
   || url.pathname.endsWith('/english-classroom-fixed.html')
   || url.pathname.endsWith('/science-course-quiz.js')
   || url.pathname.endsWith('/science-labs.js')
   || url.pathname.endsWith('/science-classroom.html')
   || url.pathname.endsWith('/weekly-exam.js')
   || /\/chinese-day[\w-]*-preview\.html$/.test(url.pathname)
   || url.pathname.endsWith('/chinese-day2-day3-preview.html')
   || url.pathname.endsWith('/chinese-daily-questions.js')
   || url.pathname.endsWith('/chinese-classroom.js')
   || url.pathname.endsWith('/v6-voice.js')
   || url.pathname.endsWith('/poem-audio.js')
   || url.pathname.endsWith('/poem-speech-check.js');
 // Cloud sync code must not be stuck behind an old cache-first script.
 // 上传策略与补救模块同理：它们决定「这条成绩要不要传」，落后一个版本就会
 // 用旧规则把新的高分挡在外面。
 const freshSync = url.pathname.endsWith('/family-auto-sync.js')
   || url.pathname.endsWith('/r5-bridge.js')
   || url.pathname.endsWith('/pwa.js')
   || url.pathname.endsWith('/r5-parent-check.html')
   || /\/r5\/(attempt-upload-policy|attempt-recovery|sync-health)\.mjs$/.test(url.pathname)
   || /\/r5\/(reward-hook|weekly-goal)\.mjs$/.test(url.pathname);
 if(freshLesson || freshSync){
  event.respondWith((async()=>{
   const key=new URL(url.pathname,ROOT.origin);
   try{const fresh=await fetch(req,{cache:'no-store'});if(fresh.ok){await store(RUNTIME,key,fresh);return fresh}}
   catch(e){}
   return await caches.match(key,{ignoreSearch:true}) || new Response('同步脚本离线不可用',{status:503});
  })());
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
