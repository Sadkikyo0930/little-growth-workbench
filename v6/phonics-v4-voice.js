(()=>{'use strict';
const $=id=>document.getElementById(id);
const c=$('cPanel'),word=$('transferWord'),next=$('nextTransfer');
if(!c||!word||!next)return;
const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
const block=document.createElement('section');block.id='voiceReadPanel';
block.style.cssText='border:2px solid #b9d7ea;border-radius:18px;padding:15px;margin:15px 0;background:#f2f9ff';
block.innerHTML='<p style="margin:3px 0 9px;font-weight:800">🎤 先自己读，我来听你读</p><p class="muted" style="margin:4px 0 10px">点麦克风，对着手机清楚读出上面的英语单词。不会先播放答案。</p><button type="button" id="voiceReadStart" class="primary">🎤 点这里开始朗读</button><p id="voiceReadStatus" role="status" aria-live="polite" style="font-weight:750;line-height:1.7;color:#265476">准备好后点击麦克风。</p><p class="muted">使用设备语音识别，只有识别出目标单词时才自动标记“识别正确”。识别不清不代表发音错误；普通识别无法精确评测 th、ing 等具体音素。</p>';
$('revealAudio').parentNode.insertBefore(block,$('revealAudio'));
const start=$('voiceReadStart'),status=$('voiceReadStatus');
const key='v6_phonics_v4_voice_read_v1';
const ratings={};
try{Object.assign(ratings,JSON.parse(localStorage.getItem(key)||'{}'))}catch(e){}
let active=null,session=0;
function current(){return TRANSFER[transferIndex]?.word||''}
function normalize(x){return String(x||'').toLowerCase().trim().replace(/[^a-z\s'-]/g,'').replace(/\s+/g,' ')}
function stop(){session++;if(active){try{active.abort()}catch(e){}active=null}start.disabled=false;start.textContent='🎤 点这里开始朗读'}
function save(word,result,heard){ratings[word]={result,heard,at:new Date().toISOString()};try{localStorage.setItem(key,JSON.stringify(ratings))}catch(e){}}
function show(msg){status.textContent=msg}
function reset(){stop();show('准备好后点击麦克风，读出屏幕上的单词。')}
function matchTranscript(text,target){return normalize(text)===normalize(target)}
start.onclick=()=>{
 const target=current();
 if(!Speech){show('当前浏览器没有提供语音识别功能。请在 iPhone Safari 的 HTTPS 在线页面尝试；仍不支持时，可听示范并由家长帮助核对。');return}
 stop();const seq=session;let recog;
 try{recog=new Speech()}catch(e){show('无法启动语音识别，请稍后重试。');return}
 active=recog;recog.lang='en-US';recog.interimResults=false;recog.maxAlternatives=5;recog.continuous=false;
 let finished=false;start.disabled=true;start.textContent='🎙️ 正在听你读…';show('请读：'+target+'。读完后稍停一下。');
 recog.onresult=e=>{
  if(seq!==session||current()!==target)return;
  finished=true;
  const alts=Array.from(e.results?.[0]||[]).map(x=>x.transcript).filter(Boolean);
  const primary=alts[0]||'';
  if(alts.some(x=>matchTranscript(x,target))){
    save(target,'matched',primary);
    show('🌟 我听到了「'+primary+'」，与目标单词「'+target+'」一致！恭喜你，识别正确。');
    const yes=$('selfYes');if(yes)yes.click();
  }else if(primary){
    save(target,'uncertain',primary);
    show('🔎 我听到的是「'+primary+'」，还没能确认是「'+target+'」。可以再读一遍，或听示范对照；这不代表你一定读错。');
  }else{show('没有识别到清楚的单词，请再试一次。')}
 };
 recog.onerror=e=>{
  if(seq!==session)return;finished=true;
  const map={'not-allowed':'麦克风权限未开启，请在 Safari 设置中允许麦克风。','service-not-allowed':'设备不允许使用语音识别服务。','network':'语音识别网络不可用，稍后再试。','no-speech':'没有听清，靠近手机麦克风再读一次。','audio-capture':'无法使用麦克风，请检查系统权限。','language-not-supported':'设备不支持英语语音识别。'};
  show(map[e.error]||'暂时无法识别（'+e.error+'），请再试一次。');
 };
 recog.onend=()=>{if(seq!==session)return;active=null;start.disabled=false;start.textContent='🎤 再读一次';if(!finished)show('没有获得识别结果，请再试一次。')};
 try{recog.start()}catch(e){active=null;start.disabled=false;start.textContent='🎤 再试一次';show('麦克风无法启动：'+(e.message||'请检查浏览器权限'))}
};
const oldNext=next.onclick;next.onclick=function(e){stop();if(typeof oldNext==='function')oldNext.call(this,e);reset()};
const originalModeC=$('modeC').onclick;$('modeC').onclick=function(e){if(typeof originalModeC==='function')originalModeC.call(this,e);reset()};
['modeA','modeB'].forEach(id=>{const b=$(id),prior=b.onclick;b.onclick=function(e){stop();if(typeof prior==='function')prior.call(this,e)}});
const title=c.querySelector('.row b');if(title)title.textContent='迁移挑战 · 麦克风听读新单词';
const intro=c.querySelector('.row + p');if(intro)intro.textContent='先看新词，点击麦克风让系统识别孩子读出的单词；听不清可以重试，最后可听原版示范。';
const foot=document.querySelector('.panel.foot');
if(foot){const note=document.createElement('p');note.textContent='V6 语音听读增强版：麦克风识别需要设备支持、授权及可能的网络服务；原版离线示范音频仍可播放。识别结果只用于单词级提示，不是儿童发音音素评分。';foot.append(note)}
window.addEventListener('pagehide',stop);
})();