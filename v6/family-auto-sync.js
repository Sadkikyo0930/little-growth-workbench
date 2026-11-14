/* V6 family auto sync (opt-in, same-origin localStorage, no passwords). */
(function(){"use strict";
var KEY="growth-workbench-v6-adaptive-2",BASELINE="v6-family-sync-baseline-20261105",ENABLED="v6-family-auto-sync-enabled",STATUS="v6-family-auto-sync-status",FAMILY="little-growth-family-001";
var SDK=["https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js","https://static.cloudbase.net/cloudbase-js-sdk/3.0.1/cloudbase.full.js","https://imgcache.qq.com/qcloud/cloudbase-js-sdk/latest/cloudbase.full.js"];
var running=false,app=null,auth=null,db=null,lastFingerprint="",lastAttempt=0;
function saveStatus(message,meta){try{localStorage.setItem(STATUS,JSON.stringify(Object.assign({at:new Date().toISOString(),message:message},meta||{})));}catch(e){}}
function readState(){try{var s=JSON.parse(localStorage.getItem(KEY)||"null");return s&&Array.isArray(s.records)?s:null}catch(e){return null}}
function baseline(){try{var x=JSON.parse(localStorage.getItem(BASELINE)||"null");return x&&Number.isInteger(x.answerCount)&&x.answerCount>=0&&Number.isFinite(Date.parse(x.start))?x:null}catch(e){return null}}
function error(e){return String(e&&(e.message||e.code||e.error_description)||e||"未知错误")}
function deviceId(){
 var key="v6-family-sync-device-id",v=localStorage.getItem(key);
 if(v&&/^[a-f0-9]{16}$/.test(v))return v;
 var bytes=new Uint8Array(8);if(!window.crypto||!crypto.getRandomValues)throw Error("设备不支持安全随机数");
 crypto.getRandomValues(bytes);v=Array.from(bytes).map(x=>x.toString(16).padStart(2,"0")).join("");
 localStorage.setItem(key,v);if(localStorage.getItem(key)!==v)throw Error("无法保存设备编号，已停止同步");return v
}

function dayIndex(d){var x=Number(String(d||"").slice(-2));return Number.isInteger(x)&&x>=1&&x<=31?x:0}
function build(s,b){
 var prefix=deviceId();
 var arr=[],subjectNames={cn:"语文",ma:"数学",en:"英语",sc:"科学"},map={"语文":"cn","数学":"ma","英语":"en","科学":"sc"};
 (s.records||[]).forEach(function(r,i){if(i<b.answerCount||!r||typeof r!=="object")return;
  arr.push({record_id:"v6-"+prefix+"-answer-"+String(i).padStart(9,"0"),record_type:"answer",subject:subjectNames[r.subject]||String(r.subject||"综合"),learning_day:Number.isInteger(Number(r.learningDay))?Number(r.learningDay):dayIndex(r.date),record_data:{version:1,source:"v6",index:i,answer:r}})
 });
 var course=s.v6Course||{},subjs=course.subjects||{};
 Object.keys(subjs).forEach(function(day){var n=Number(day);if(!Number.isInteger(n)||n<1||n>30)return;
  var m=subjs[day];if(!m||typeof m!=="object")return;
  Object.keys(m).forEach(function(name){
   // Do not upload records previously restored from this family's cloud.
   if(course.remoteRestored&&course.remoteRestored[day]&&course.remoteRestored[day][name])return;
   if(!m[name]||!Number.isFinite(Date.parse(m[name]))||Date.parse(m[name])<Date.parse(b.start))return;
   arr.push({record_id:"v6-"+prefix+"-course-"+n+"-"+(map[name]||encodeURIComponent(name)),record_type:"course-complete",subject:name,learning_day:n,record_data:{version:1,source:"v6",day:n,completed_at:m[name]}})
  })
 });
 Object.keys(s.weeklyExams||{}).forEach(function(week){var exam=s.weeklyExams[week];
  if(!exam||!exam.finishedAt||!Number.isFinite(Date.parse(exam.finishedAt))||Date.parse(exam.finishedAt)<Date.parse(b.start))return;
  arr.push({record_id:"v6-"+prefix+"-weekly-"+week,record_type:"weekly-exam",subject:"四科周测",learning_day:dayIndex(week),record_data:{version:1,source:"v6",week:week,finished_at:exam.finishedAt,answers:exam.answers||{}}})
 });
 if(course.englishMonthlyExam&&course.englishMonthlyExam.finishedAt&&Date.parse(course.englishMonthlyExam.finishedAt)>=Date.parse(b.start)){
  arr.push({record_id:"v6-"+prefix+"-monthly-english",record_type:"monthly-exam",subject:"英语",learning_day:30,record_data:{version:1,source:"v6",exam:course.englishMonthlyExam}})
 }
 return arr;
}
function loadSdk(i){return new Promise(function(resolve,reject){
 if(window.cloudbase&&typeof window.cloudbase.init==="function"){resolve();return}
 if(i>=SDK.length){reject(Error("CloudBase SDK 加载失败"));return}
 var s=document.createElement("script");s.src=SDK[i];s.async=true;s.onload=function(){if(window.cloudbase&&typeof window.cloudbase.init==="function")resolve();else loadSdk(i+1).then(resolve,reject)};
 s.onerror=function(){loadSdk(i+1).then(resolve,reject)};document.head.appendChild(s)
})}
async function connect(){
 if(app)return;
 await loadSdk(0);
 app=window.cloudbase.init({env:"normal-goose-d5g4qyzr8bb389a4a",region:"ap-shanghai"});auth=app.auth;db=app.rdb();
 if(!auth||typeof auth.getSession!=="function"||!db)throw Error("CloudBase SDK 接口不可用")
}
async function run(){
 if(running||localStorage.getItem(ENABLED)!=="yes"||!navigator.onLine)return;
 var s=readState(),b=baseline();if(!s||!b){saveStatus("未设置正式同步起点，已暂停自动同步",{state:"paused"});return}
 var rows=build(s,b);
 if(!rows.length){saveStatus("已启用，等待孩子产生第一条正式学习记录",{state:"idle",pending:0});return}
 var fp=rows.map(x=>x.record_id).join("|");
 // Avoid repeating requests on idle pages and avoid tight retry loops after network failures.
 if(fp===lastFingerprint&&Date.now()-lastAttempt<60000)return;
 running=true;lastAttempt=Date.now();
 try{
  await connect();
  var sessionResult;try{sessionResult=await auth.getSession()}catch(e){if(/credentials not found|session not found|not authenticated|invalid.refresh.token/i.test(error(e))){saveStatus("当前浏览器没有有效的 CloudBase 登录凭证，请到家庭同步中心重新登录。学习成绩已保存在本机",{state:"auth_required",pending:rows.length});return}throw e}if(sessionResult&&sessionResult.error){if(/credentials not found|session not found|not authenticated|invalid.refresh.token/i.test(error(sessionResult.error))){saveStatus("当前浏览器没有有效的 CloudBase 登录凭证，请到家庭同步中心重新登录。学习成绩已保存在本机",{state:"auth_required",pending:rows.length});return}throw sessionResult.error}
  var session=sessionResult&&sessionResult.data&&sessionResult.data.session;
  if(!session||!session.user||!session.user.id){saveStatus("需要家长重新登录授权；本机成绩安全保留",{state:"auth_required",pending:rows.length});return}
  var membersResult=await db.from("growth_family_members").select("family_id,user_id,member_role").eq("family_id",FAMILY).eq("user_id",session.user.id);
  if(membersResult&&membersResult.error)throw membersResult.error;
  var members=membersResult&&membersResult.data;
  if(!Array.isArray(members)||members.length!==1||members[0].family_id!==FAMILY||!["owner","parent","grandparent"].includes(members[0].member_role)||String(members[0].user_id)!==String(session.user.id)){
   saveStatus("当前会话不是该家庭的授权成员，已暂停；本机成绩安全保留",{state:"auth_required",pending:rows.length});return
  }
  var existing=await db.from("growth_learning_records").select("record_id,family_id,record_type");
  if(existing&&existing.error)throw existing.error;
  if(!existing||!Array.isArray(existing.data))throw Error("云端读取结果异常");
  if(existing.data.some(x=>x.family_id!==FAMILY))throw Error("检测到其他家庭数据，已停止同步");
  var ids=new Set(existing.data.filter(x=>x.record_type!=="sync-test").map(x=>String(x.record_id))),count=0;
  for(var j=0;j<rows.length;j++){
   var item=rows[j];if(ids.has(item.record_id))continue;
   // Recheck consent while uploading in case user disables autosync.
   if(localStorage.getItem(ENABLED)!=="yes")break;
   var row={record_id:item.record_id,family_id:FAMILY,record_type:item.record_type,subject:item.subject,learning_day:item.learning_day,record_data:item.record_data,created_by:members[0].user_id};
   var out=await db.from("growth_learning_records").insert(row);
   if(out&&out.error)throw out.error;
   ids.add(item.record_id);count++;
  }
  lastFingerprint=fp;
  saveStatus("同步成功：云端已确认 "+ids.size+" 条，本次新增 "+count+" 条",{state:"success",remote:ids.size,pending:0,syncedAt:new Date().toISOString()});
 }catch(e){
  // Never discard local records; next online/foreground trigger will retry.
  saveStatus("上传失败，本机成绩已保留："+error(e),{state:"error",pending:rows.length});
 }finally{running=false}
}
function schedule(){try{if(localStorage.getItem(ENABLED)==="yes")Promise.resolve(run()).catch(function(e){saveStatus("自动同步执行异常："+error(e),{state:"error"})})}catch(e){saveStatus("自动同步初始化异常："+error(e),{state:"error"})}}
window.addEventListener("online",schedule);document.addEventListener("visibilitychange",function(){if(!document.hidden)schedule()});
window.addEventListener("pageshow",schedule);window.setInterval(schedule,20000);
try{if(localStorage.getItem(ENABLED)==="yes")saveStatus(navigator.onLine?"同步脚本已启动，正在检查记录与会话":"同步脚本已启动；当前离线，记录留在本机",{state:"started",version:"20261106-sync-live-2"})}catch(e){}
schedule();
})();
