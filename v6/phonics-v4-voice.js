(()=>{'use strict';
const $=id=>document.getElementById(id);
const c=$('cPanel'),word=$('transferWord'),next=$('nextTransfer');
if(!c||!word||!next)return;
const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
const block=document.createElement('section');block.id='voiceReadPanel';
block.style.cssText='border:2px solid #b9d7ea;border-radius:18px;padding:15px;margin:15px 0;background:#f2f9ff';
block.innerHTML='<p style="margin:3px 0 9px;font-weight:800">🎤 先自己读，我来听你读</p><p class="muted" style="margin:4px 0 10px">第一次点击开始收听，读完后第二次点击结束并判断。不会提前播放答案。</p><button type="button" id="voiceReadStart" class="primary">🎤 点一下开始读</button><p id="voiceReadStatus" role="status" aria-live="polite" style="font-weight:750;line-height:1.7;color:#265476">点一下开始读，再点一下结束读。</p><p class="muted">使用设备语音识别，只有识别出目标单词时才自动标记“识别正确”。识别不清不代表发音错误；普通识别无法精确评测 th、ing 等具体音素。</p>';
$('revealAudio').parentNode.insertBefore(block,$('revealAudio'));
const start=$('voiceReadStart'),status=$('voiceReadStatus');
const key='v6_phonics_v4_voice_read_v1';
const ratings={};
try{Object.assign(ratings,JSON.parse(localStorage.getItem(key)||'{}'))}catch(e){}
let active=null,session=0,listening=false,finishing=false,heard=[],targetWord='';
function current(){return TRANSFER[transferIndex]?.word||''}
function normalize(x){return String(x||'').toLowerCase().trim().replace(/[^a-z\s'-]/g,'').replace(/\s+/g,' ')}
function setStart(){start.disabled=false;start.textContent='🎤 点一下开始读'}
function setStop(){start.disabled=false;start.textContent='⏹️ 点一下结束读并判断'}
function cancel(){session++;listening=false;finishing=false;heard=[];targetWord='';if(active){try{active.abort()}catch(e){}active=null}setStart()}
function save(word,result,transcript){ratings[word]={result,heard:transcript,at:new Date().toISOString()};try{localStorage.setItem(key,JSON.stringify(ratings))}catch(e){}}
function show(msg){status.textContent=msg}
function reset(){cancel();show('点一下开始读，再点一下结束读，我来判断。')}
function matchTranscript(text,target){return normalize(text)===normalize(target)}
function judge(){
 if(!finishing)return;
 finishing=false;listening=false;active=null;setStart();
 const target=targetWord,alts=[...new Set(heard.map(normalize).filter(Boolean))];
 if(alts.some(x=>matchTranscript(x,target))){
  save(target,'matched',alts[0]);show('🌟 我听到了「'+alts[0]+'」，目标词是「'+target+'」，识别正确！');
  const yes=$('selfYes');if(yes)yes.click();
 }else if(alts.length){
  save(target,'uncertain',alts[0]);show('🔎 我听到的是「'+alts[0]+'」，还不能确认读的是「'+target+'」。可以再读一次，或听示范核对；这不代表发音错误。');
 }else{show('没有收到清晰的英语识别结果，请再试一次。')}
}
start.onclick=()=>{
 if(listening){
  listening=false;finishing=true;start.disabled=true;start.textContent='🔎 正在判断…';
  show('录音已结束，正在核对读出的单词…');
  if(active){try{active.stop()}catch(e){judge()}}else judge();
  return;
 }
 const target=current();
 if(!Speech){show('当前浏览器不支持语音识别，请在 iPhone Safari 的 HTTPS 网页尝试。也可以播放原版示范。');return}
 cancel();const seq=session;targetWord=target;listening=true;finishing=false;heard=[];
 let recog;try{recog=new Speech()}catch(e){cancel();show('语音识别无法启动，请稍后再试。');return}
 active=recog;recog.lang='en-US';recog.interimResults=true;recog.maxAlternatives=5;recog.continuous=true;
 setStop();show('🎙️ 正在听你读「'+target+'」。读完请再点一次按钮结束并判断。');
 recog.onresult=e=>{
  if(seq!==session||current()!==target)return;
  for(let i=e.resultIndex||0;i<e.results.length;i++){
   const options=Array.from(e.results[i]||[]).map(x=>x.transcript).filter(Boolean);
   for(const t of options){if(!heard.includes(t))heard.push(t)}
  }
  if(listening)show('🎙️ 正在收听… 读完请点「结束读并判断」。');
 };
 recog.onerror=e=>{
  if(seq!==session)return;
  const map={'not-allowed':'没有麦克风权限，请在 Safari 中允许麦克风。','service-not-allowed':'设备不允许使用语音识别服务。','network':'语音识别网络不可用，请稍后重试。','no-speech':'没有听到声音，请靠近麦克风再读一次。','audio-capture':'无法访问麦克风，请检查权限。','language-not-supported':'设备不支持英语语音识别。'};
  cancel();show(map[e.error]||'识别出错：'+e.error+'。请重试。');
 };
 recog.onend=()=>{
  if(seq!==session)return;
  active=null;
  if(finishing){judge();return}
  if(listening){listening=false;setStart();show('浏览器提前结束了收听，尚未评分。请再次点击开始读；部分 iPhone 浏览器会自动停止语音识别。')}
 };
 try{recog.start()}catch(e){cancel();show('无法启动麦克风：'+(e.message||'请检查权限'))}
};
const oldNext=next.onclick;next.onclick=function(e){cancel();if(typeof oldNext==='function')oldNext.call(this,e);reset()};
const originalModeC=$('modeC').onclick;$('modeC').onclick=function(e){if(typeof originalModeC==='function')originalModeC.call(this,e);reset()};
['modeA','modeB'].forEach(id=>{const b=$(id),prior=b.onclick;b.onclick=function(e){cancel();if(typeof prior==='function')prior.call(this,e)}});
const title=c.querySelector('.row b');if(title)title.textContent='迁移挑战 · 麦克风听读新单词';
const intro=c.querySelector('.row + p');if(intro)intro.textContent='先看新词，点一下开始读，再点一下结束读进行判断；听不清可以重试，最后可听原版示范。';
const foot=document.querySelector('.panel.foot');
if(foot){const note=document.createElement('p');note.textContent='V6 语音听读增强版：麦克风识别需要设备支持、授权及可能的网络服务；原版离线示范音频仍可播放。识别结果只用于单词级提示，不是儿童发音音素评分。';foot.append(note)}
window.addEventListener('pagehide',cancel);
})();