/* V6 family auto sync (opt-in, same-origin localStorage, no passwords). */
(function(){"use strict";
var KEY="growth-workbench-v6-adaptive-2",BASELINE="v6-family-sync-baseline-20261105",ENABLED="v6-family-auto-sync-enabled",STATUS="v6-family-auto-sync-status",FAMILY="little-growth-family-001";
var SDK=["https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js","https://static.cloudbase.net/cloudbase-js-sdk/3.0.1/cloudbase.full.js","https://imgcache.qq.com/qcloud/cloudbase-js-sdk/latest/cloudbase.full.js"];
var running=false,app=null,auth=null,db=null,lastFingerprint="",lastAttempt=0,lastOffNotice=0;
var RESTORE_OPT_IN="v6-family-auto-restore-enabled",RESTORE_STATUS="v6-family-auto-restore-status",restoreRunning=false,lastRestoreAttempt=0;
function restoreStatus(message,state,added){try{localStorage.setItem(RESTORE_STATUS,JSON.stringify({message:message,state:state,added:added||0,at:new Date().toISOString()}))}catch(e){}}
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
// 上海本地日期：逐题答案的 date 必须与同一轮摘要的答题日一致，否则云端会判为跨轮混用。
function shDate(iso){try{var t=Date.parse(iso);if(!Number.isFinite(t))return '';return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(t))}catch(e){return ''}}
function build(s,b){
 var prefix=deviceId();
 var arr=[],subjectNames={cn:"语文",ma:"数学",en:"英语",sc:"科学"},map={"语文":"cn","数学":"ma","英语":"en","科学":"sc"};
 (s.records||[]).forEach(function(r,i){if(i<b.answerCount||!r||typeof r!=="object")return;
  arr.push({record_id:"v6-"+prefix+"-answer-"+String(i).padStart(9,"0"),record_type:"answer",subject:subjectNames[r.subject]||String(r.subject||"综合"),learning_day:Number.isInteger(Number(r.learningDay))?Number(r.learningDay):dayIndex(r.date),record_data:{version:1,source:"v6",index:i,answer:r}});
 });
 // Every completed attempt is uploaded, including scores below 80%.
 // IDs include a stable device ID and immutable attempt ID; retries never overwrite history.
 try{
  var history=JSON.parse(localStorage.getItem("v6-attempt-history-v1")||"{}");
  if(history&&typeof history==="object"){
   Object.keys(history).forEach(function(k){
    var attempts=history[k];if(!Array.isArray(attempts))return;
    attempts.forEach(function(a){
     if(!a||!map[a.subject]||!a.id||!/^[a-zA-Z0-9-]{8,100}$/.test(String(a.id)))return;
     var ld=Number(a.learningDay),correct=Number(a.correct),total=Number(a.total);
     if(!Number.isInteger(ld)||ld<1||ld>30||!Number.isInteger(total)||total<1||
        !Number.isInteger(correct)||correct<0||correct>total)return;
     if(!Number.isFinite(Date.parse(a.at))||Date.parse(a.at)<Date.parse(b.start))return;
     arr.push({record_id:"v6-"+prefix+"-attempt-"+a.id,record_type:"course-attempt",
       subject:a.subject,learning_day:ld,
       record_data:{version:1,source:"v6-attempt-history-v1",device_id:prefix,
        attempt_id:a.id,lesson:Number(a.lesson),correct:correct,wrong:total-correct,
        total:total,accuracy_pct:Math.round(correct/total*1000)/10,
        passed:correct*5>=total*4,at:a.at}});
     // 同一轮的逐题答案：与摘要共用 attempt_id，云端据此校验整轮一致性。
     // 条数必须等于 total，任何缺失都不上传，绝不补齐或臆造题序。
     if(Array.isArray(a.answers)&&a.answers.length===total){
      var ad=shDate(a.at);
      if(ad){
       a.answers.forEach(function(ans){
        var ai=Number(ans&&ans.index);
        if(!Number.isInteger(ai)||ai<0||ai>=total)return;
        arr.push({record_id:"v6-"+prefix+"-a-"+a.id+"-"+String(ai).padStart(3,"0"),
          record_type:"answer",subject:a.subject,learning_day:ld,
          record_data:{version:1,source:"v6-attempt-history-v1",index:ai,
            attempt_id:a.id,device_id:prefix,
            answer:{date:ad,index:ai,level:1,skill:"完整交卷",track:"完整交卷",
              choice:(ans&&ans.choice!==undefined)?ans.choice:null,
              lesson:Number(a.lesson)||null,correct:!!(ans&&ans.correct===true),
              subject:map[a.subject],learningDay:ld,source:"v6-attempt-history-v1"}}});
       });
      }
     }
    });
   });
  }
 }catch(e){saveStatus("成绩历史读取异常，保留本机记录",{state:"warning"})}
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
// Upload policy: first completed attempt always; subsequently only a STRICT improvement
// on the best verified cloud accuracy for the same family + learning day + subject.
// This preserves all original records, including previously uploaded non-passing attempts.
// Equal/worse scores stay on the device, but never downgrade cloud's effective best.
//
// 2026-11-17：策略本身搬到 ./r5/attempt-upload-policy.mjs，由 run() 动态 import。
// 这样同一条规则既能被自动同步调用，也能被单元测试直接覆盖，
// 而且「旧成绩（逐题 + course-complete 整轮证据）」与「新 course-attempt」
// 会用同一套整数比较取历史最高，不再只认 course-attempt。
function loadSdk(i){return new Promise(function(resolve,reject){
 if(window.cloudbase&&typeof window.cloudbase.init==="function"){resolve();return}
 if(i>=SDK.length){reject(Error("CloudBase SDK 加载失败"));return}
 var s=document.createElement("script");s.src=SDK[i];s.async=true;s.onload=function(){if(window.cloudbase&&typeof window.cloudbase.init==="function")resolve();else loadSdk(i+1).then(resolve,reject)};
 s.onerror=function(){loadSdk(i+1).then(resolve,reject)};document.head.appendChild(s)
})}
async function connect(){
 if(app)return;
 await loadSdk(0);
 app=window.cloudbase.init({env:"normal-goose-d5g4qyzr8bb389a4a",region:"ap-shanghai"});auth=app.auth;
 if(!auth||typeof auth.getSession!=="function")throw Error("CloudBase SDK 接口不可用");
 // app.rdb() 把请求代理给本环境不存在的云函数 httpOverCallFunction，
 // 而且那条链路不带家长身份，网关会按匿名角色执行并报
 // "permission denied for table growth_family_members"。
 // 这里改用显式带家长 JWT 的客户端，授权仍由服务端 RLS 判定。
 var rdb=await import("./r5/rdb-client.mjs");db=rdb.makeRdb(auth);
 if(!db||typeof db.from!=="function")throw Error("RDB 客户端初始化失败")
}
async function run(){
 if(running||!navigator.onLine)return;
 if(localStorage.getItem(ENABLED)!=="yes"){
  // 开关没开时不能一声不响：妈妈端要能分清「孩子没答题」和「这台设备没开同步」。
  if(Date.now()-lastOffNotice>300000){lastOffNotice=Date.now();saveStatus("自动同步未开启：本机成绩只保存在这台设备上，云端不会收到",{state:"off"})}
  return;
 }
 var s=readState(),b=baseline();if(!s||!b){saveStatus("未设置正式同步起点，已暂停自动同步",{state:"paused"});return}
 var rows=build(s,b);
 // 本机补救：attempt-history 偶尔会缺一轮（课程页没加载 attempt-history.js，
 // 或者手机还在跑旧缓存的课程页）。这时把课程进度里已经记下的同一轮真实分数
 // 补成一条 course-attempt，否则「本机 15/15、云端 0 条」会一直卡住闸门。
 // 只搬运本机已记录的真实分数，不推算、不补题。
 try{
  var recovery=await import("./r5/attempt-recovery.mjs");
  var extra=recovery.recoverAttempts({
   history:JSON.parse(localStorage.getItem("v6-attempt-history-v1")||"{}"),
   getItem:function(k){return localStorage.getItem(k)},
   deviceId:deviceId(),
   since:b.start
  });
  if(extra.length){
   var seenIds={};rows.forEach(function(r){seenIds[r.record_id]=1});
   extra.forEach(function(r){if(!seenIds[r.record_id]){rows.push(r);seenIds[r.record_id]=1}});
  }
 }catch(e){saveStatus("成绩补救检查失败，本机记录未改动："+error(e),{state:"warning"})}
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
  var existing=await db.from("growth_learning_records").select("record_id,family_id,record_type,subject,learning_day,record_data");
  if(existing&&existing.error)throw existing.error;
  if(!existing||!Array.isArray(existing.data))throw Error("云端读取结果异常");
  if(existing.data.some(x=>x.family_id!==FAMILY))throw Error("检测到其他家庭数据，已停止同步");
  // 上传策略（外部模块，与单元测试同一份实现）：
  //   · 首次完整交卷必传，即使低于 80%
  //   · 之后只有严格高于云端历史最高有效成绩才传
  //   · 云端最高分同时包含已整轮验证通过的旧成绩与新 course-attempt
  // 云端这次读取失败/为空时，绝不退化成「当作没有历史」把低分全传上去。
  var policy=await import("./r5/attempt-upload-policy.mjs");
  var decision=policy.selectUploads(rows,existing.data);
  rows=policy.rowsToInsert(rows,decision);
  var diag={selected:decision.selected.length,skipped:decision.skipped.length,
            cloud_rows:existing.data.length,reasons:decision.reason};
  var ids=new Set(existing.data.filter(x=>x.record_type!=="sync-test").map(x=>String(x.record_id))),count=0;
  for(var j=0;j<rows.length;j++){
   var item=rows[j];if(ids.has(item.record_id))continue;
   // Recheck consent while uploading in case user disables autosync.
   if(localStorage.getItem(ENABLED)!=="yes")break;
   var row={record_id:item.record_id,family_id:FAMILY,record_type:item.record_type,subject:item.subject,learning_day:item.learning_day,record_data:item.record_data,created_by:members[0].user_id};
   var out=await db.from("growth_learning_records").insert(row);
   if(out&&out.error)throw out.error;
   ids.add(item.record_id);count++;
   if(item.record_type==="course-complete"){
    import("./r5/reward-hook.mjs").then(function(m){
      m.enqueueVerifiedCourse(item.record_id);return m.resumeRewardQueue();
    }).catch(function(){});
   }
  }
  lastFingerprint=fp;
  // 云端学习记录写入成功后，再询问服务器是否已完成本周目标。
  import("./r5/weekly-goal.mjs").then(function(m){return m.resumeWeeklyGoal()}).catch(function(){});
  saveStatus("同步成功：云端已确认 "+ids.size+" 条，本次新增 "+count+" 条",Object.assign({state:"success",remote:ids.size,pending:0,syncedAt:new Date().toISOString()},diag));
 }catch(e){
  // 身份类失败必须和「网络失败」分开：它既不代表孩子没达标，也不代表本机数据坏了，
  // 更不允许因此清空或重写本机档案。
  var code=String(e&&(e.code||e.message)||"");
  if(/NO_SESSION/.test(code)){
   saveStatus("家长登录已失效，请在「家长登录云端」重新登录；本机成绩已保留",{state:"auth_required",pending:rows.length});return
  }
  if(/PERMISSION_DENIED/.test(code)){
   saveStatus("云端没有识别到家长身份，这次读取被当作匿名访问拒绝；请重新登录家长账号。本机成绩已保留",{state:"auth_required",pending:rows.length,error:"PERMISSION_DENIED_NO_IDENTITY"});return
  }
  // Never discard local records; next online/foreground trigger will retry.
  saveStatus("上传失败，本机成绩已保留："+error(e),{state:"error",pending:rows.length});
 }finally{running=false}
}
async function restoreMissing(){
 // Family members who are already authenticated can safely pull *verified*
// course completion marks; no local records are replaced or erased.
 if(restoreRunning||!navigator.onLine)return;
 if(Date.now()-lastRestoreAttempt<60000)return;
 // 自动补全会写本机学习档案，必须先拿到家长的显式同意
 // （family-dashboard.html 的「开启本机课程自动补全」会写入这个键）。
 // 没有同意时一个字都不改，只报告状态。
 if(localStorage.getItem(RESTORE_OPT_IN)!=="yes"){
  restoreStatus("本机未开启自动补全，学习档案未做任何改动","off");return
 }
 restoreRunning=true;lastRestoreAttempt=Date.now();
 try{
  var original=localStorage.getItem(KEY);
  if(!original){restoreStatus("本机尚无学习档案，没有创建空档案","idle");return}
  var local=readState();
  if(!local){restoreStatus("本机学习档案格式异常，拒绝恢复","blocked");return}
  await connect();
  var sr=await auth.getSession();
  if(sr&&sr.error)throw sr.error;
  var user=sr&&sr.data&&sr.data.session&&sr.data.session.user;
  if(!user||!user.id){restoreStatus("本机家长登录已失效，需重新授权","auth_required");return}
  var membership=await db.from("growth_family_members").select("family_id,user_id,member_role")
   .eq("family_id",FAMILY).eq("user_id",user.id);
  if(membership&&membership.error)throw membership.error;
  var members=membership&&membership.data;
  if(!Array.isArray(members)||members.length!==1||members[0].family_id!==FAMILY||
   String(members[0].user_id)!==String(user.id)||
   !["owner","parent","grandparent"].includes(members[0].member_role)){
   restoreStatus("家庭成员未通过验证，禁止补全","forbidden");return
  }
  var response=await db.from("growth_learning_records")
   .select("record_id,family_id,record_type,subject,learning_day,record_data")
   .eq("family_id",FAMILY).eq("record_type","course-complete");
  if(response&&response.error)throw response.error;
  var rows=response&&response.data;
  if(!Array.isArray(rows))throw Error("云端课程记录格式异常");
  var mod=await import("./family-progress-merge.mjs");
  var plan=mod.planMerge(local,rows,FAMILY);
  if(!plan.additions.length){restoreStatus("已与当前读取到的云端课程完成标记对齐","synced");return}
  // Never write on session changes, revocation of opt-in, or concurrent learning.
  if(!navigator.onLine)return;
  var verifiedAgain=await auth.getSession();
  var activeUser=verifiedAgain&&verifiedAgain.data&&verifiedAgain.data.session&&verifiedAgain.data.session.user;
  if(!activeUser||String(activeUser.id)!==String(user.id)){
   restoreStatus("家庭登录会话已变化，本次未恢复","auth_required");return
  }
  if(localStorage.getItem(KEY)!==original){restoreStatus("本机数据刚变化，下次检查再补全","retry");return}
  var merged=mod.applyMerge(local,plan);
  var backupKey="v6-family-restore-backup-"+new Date().toISOString();
  localStorage.setItem(backupKey,original);
  if(localStorage.getItem(backupKey)!==original)throw Error("本机备份失败，拒绝修改原档");
  localStorage.setItem(KEY,JSON.stringify(merged.state));
  // Keep the running V6 page's in-memory state consistent with the restored
  // persisted state. Otherwise the next save() could overwrite the merge.
  try {
   if(typeof state!=="undefined"&&state&&Array.isArray(state.records)){
    state=merged.state;
    if(typeof refreshHomeMode==="function")refreshHomeMode();
    if(typeof novRender==="function")novRender();
   }
  }catch(_){/* Persisted backup remains valid even if UI redraw fails. */}
  restoreStatus("已补全 "+merged.added+" 个缺失的课程完成标记，并保留原始备份","synced",merged.added);
 }catch(e){
  var rcode=String(e&&(e.code||e.message)||"");
  if(/NO_SESSION/.test(rcode)){restoreStatus("家长登录已失效，本次未改动本机档案","auth_required");return}
  if(/PERMISSION_DENIED/.test(rcode)){restoreStatus("云端没有识别到家长身份，本次未改动本机档案","forbidden");return}
  restoreStatus("补全失败，本机原始记录保留："+error(e),"error")
 }
 finally{restoreRunning=false}
}
function schedule(){
 try{
  // 已达标的家庭在重新打开工作台时也能自动补领本周唯一奖励。
  // 只有服务端返回 CLAIMED 才弹奖；客户端不自行生成碎片。
  if(localStorage.getItem(ENABLED)==="yes")
   import("./r5/weekly-goal.mjs").then(function(m){return m.resumeWeeklyGoal()}).catch(function(){});
  try{if(localStorage.getItem("v6-fragment-pending-v1"))
   import("./r5/reward-hook.mjs").then(function(m){return m.resumeRewardQueue()}).catch(function(){});
  }catch(e){}
  if(localStorage.getItem(ENABLED)==="yes")Promise.resolve(run()).catch(function(e){saveStatus("自动上传执行异常："+error(e),{state:"error"})});
  Promise.resolve(restoreMissing()).catch(function(e){restoreStatus("自动补全异常："+error(e),"error")});
 }catch(e){saveStatus("同步初始化异常："+error(e),{state:"error"})}
}
window.addEventListener("online",schedule);document.addEventListener("visibilitychange",function(){if(!document.hidden)schedule()});
window.addEventListener("pageshow",schedule);window.setInterval(schedule,20000);
try{if(localStorage.getItem(ENABLED)==="yes")saveStatus(navigator.onLine?"同步脚本已启动，正在检查记录与会话":"同步脚本已启动；当前离线，记录留在本机",{state:"started",version:"20261106-sync-live-2"})}catch(e){}
schedule();
})();
