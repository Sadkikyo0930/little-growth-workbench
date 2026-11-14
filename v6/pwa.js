/* V6 PWA registration and explicit learning-record migration.
 * Does not erase localStorage during install, update, or cache cleanup.
 */
(function(){
'use strict';
// C0.1 multi-device repair: the real curriculum day comes from an authenticated
// R5 status read, NOT from this browser's completedDays. No learning records,
// course completion flags, or quiz scores are changed here.
const CLOUD_BRIDGE_STATUS = 'v6-r5-bridge-status';
const VALID_DAY_STATES = new Set([
  'stale_device_day', 'device_ahead', 'ok', 'partial',
  'unverified', 'no_local_records'
]);
const todayShanghai = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
function confirmedCloudDay() {
  try {
    const v = JSON.parse(localStorage.getItem(CLOUD_BRIDGE_STATUS) || 'null');
    if (!v || !VALID_DAY_STATES.has(v.state)) return null;
    // Do not trust yesterday's cached plan, or an in-progress/error state that
    // retained an old cloud_day through Object.assign in the bridge.
    if (new Date(new Date(v.at).getTime()+8*3600000).toISOString().slice(0,10) !== todayShanghai()) return null;
    const day = Number(v.cloud_day);
    if (!Number.isInteger(day) || day < 1 || day > 30) return null;
    return day;
  } catch (_) { return null; }
}
const localCourseDay = typeof window.v6CourseDay === 'function' ? window.v6CourseDay : null;
if (localCourseDay) {
  window.v6CourseDay = function() {
    // Cloud value changes the currently selected lesson only. It does not
    // backfill completedDays or silently advance the server's plan.
    return confirmedCloudDay() || localCourseDay();
  };
  let seenDay = null;
  function refreshDayView() {
    const day = confirmedCloudDay();
    if (day === null || day === seenDay || document.hidden) return;
    seenDay = day;
    try {
      if (typeof novSelected !== 'undefined') novSelected = day;
      if (typeof novRender === 'function') novRender();
      if (typeof refreshHomeMode === 'function') refreshHomeMode();
    } catch (_) { /* Learning data is never mutated on a visual refresh. */ }
  }
  window.addEventListener('pageshow', refreshDayView);
  window.addEventListener('online', refreshDayView);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDayView(); });
  // The R5 bridge refreshes asynchronously, typically 3s after page opening.
  setInterval(refreshDayView, 2000);
}

const MAIN='growth-workbench-v6-adaptive-2';
const belongs=k=>{const syncInternal=k.startsWith('v6-family-sync-')||k.startsWith('v6-family-auto-sync-');return !syncInternal&&(k===MAIN||k.startsWith('v6_')||k.startsWith('v6-'))};
function snapshot(){
 const items={};
 try{for(let i=0;i<localStorage.length;i++){
  const key=localStorage.key(i);if(key&&belongs(key))items[key]=localStorage.getItem(key);
 }}catch(e){}
 return {format:'little-growth-v6-backup',version:1,exportedAt:new Date().toISOString(),items};
}
function saveFile(data,filename){
 const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),15000);
}
function exportRecords(){
 const data=snapshot();
 if(!Object.keys(data.items).length){alert('当前浏览器还没有找到 V6 学习记录。');return}
 saveFile(data,'V6-完整学习档案-'+new Date().toISOString().slice(0,10)+'.json');
}
async function importRecords(file){
 if(!file)return;
 let data;
 try{data=JSON.parse(await file.text())}catch(e){alert('文件不是有效的 JSON，请选择 V6 完整学习档案。');return}
 if(!data||data.format!=='little-growth-v6-backup'||data.version!==1||!data.items||typeof data.items!=='object'||Array.isArray(data.items)){alert('文件格式不匹配。请使用“导出完整学习档案”生成的备份。');return}
 const keys=Object.keys(data.items);
 if(!keys.length||keys.some(k=>!belongs(k)||typeof data.items[k]!=='string')){alert('备份内容校验不通过，未修改学习数据。');return}
 if(MAIN in data.items){
  try{const main=JSON.parse(data.items[MAIN]);if(!main||!Array.isArray(main.records)||!main.finished||typeof main.finished!=='object'||!main.sessions||typeof main.sessions!=='object')throw Error('invalid main state')}
  catch(e){alert('主学习档案损坏，已停止导入。');return}
 }
 const before=snapshot();
 const note='将导入 '+keys.length+' 项 V6 记录。当前设备上这些同名记录会被替换，其他项目的数据不会修改。导入前会自动下载当前 V6 备份。是否继续？';
 if(!confirm(note))return;
 try{
  if(Object.keys(before.items).length)saveFile(before,'V6-导入前备份-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  keys.forEach(k=>localStorage.setItem(k,data.items[k]));
  alert('学习档案已恢复。页面将刷新，以读取导入的数据。');
  location.reload();
 }catch(e){
  try{keys.forEach(k=>{if(k in before.items)localStorage.setItem(k,before.items[k]);else localStorage.removeItem(k)})}catch(_){}
  alert('恢复失败，已尝试回滚原有记录。请检查设备存储空间。');
 }
}
function addControls(){
 const anchor=document.getElementById('exportAssessment');if(!anchor||document.getElementById('v6PwaBackup'))return;
 const container=document.createElement('div');container.id='v6PwaBackup';
 container.style.cssText='margin:10px auto 20px;max-width:650px;padding:16px;border:2px solid #b5dcee;border-radius:18px;background:#f2fbff;color:#174c77;text-align:center';
 const title=document.createElement('div');title.textContent='📱 桌面版学习记录备份与恢复';title.style.cssText='font-weight:900;font-size:16px;margin-bottom:8px';container.appendChild(title);
 const text=document.createElement('p');text.textContent='首次从 Safari 转到桌面 App 时，建议先在原网页导出完整档案，再从桌面版导入。';text.style.cssText='margin:5px 0 12px;line-height:1.7;font-size:13px';container.appendChild(text);
 const out=document.createElement('button');out.type='button';out.textContent='导出完整学习档案';
 const inp=document.createElement('input');inp.type='file';inp.accept='.json,application/json';inp.style.display='none';
 const restore=document.createElement('button');restore.type='button';restore.textContent='从备份恢复';
 [out,restore].forEach(b=>b.style.cssText='margin:5px;padding:12px 15px;border-radius:12px;border:1px solid #78bfe5;background:white;color:#155486;font-weight:850;font-size:14px');
 out.onclick=exportRecords;restore.onclick=()=>inp.click();inp.onchange=()=>{const file=inp.files&&inp.files[0];inp.value='';importRecords(file)};
 container.append(out,restore,inp);
 anchor.parentElement.insertAdjacentElement('afterend',container);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addControls,{once:true});else addControls();
if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
 window.addEventListener('load',async()=>{
  try{
   const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
   const refresh=()=>{if(registration.waiting)console.info('V6 PWA update available; open again to load the latest version.')};
   registration.addEventListener('updatefound',refresh);
   // Refresh service-worker registration when user returns after deployment.
   document.addEventListener('visibilitychange',()=>{if(!document.hidden)registration.update().catch(()=>{})});
  }catch(e){console.warn('V6 offline cache not available:',e)}
 });
}
})();
