/* V6 语文语音统一桥接（仅朗读，不改题库/答案/成绩/进度/云端/本地数据）。
   目标：iPhone Safari / PWA 用户手势内可启动；MP3 失败可靠回退；错误可见。 */
(function(){
'use strict';
if(window.V6Voice)return;
const STATUS_IDS=['v6PoemAudioStatus','lionAudioState','soundStatus'];
let noticeTimer=null;
function setStatus(text){
  STATUS_IDS.forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=text});
  document.querySelectorAll('[data-v6-voice-status]').forEach(el=>{el.textContent=text});
}
function toast(text){
  let el=document.getElementById('v6VoiceNotice');
  if(!el){
    el=document.createElement('div');el.id='v6VoiceNotice';el.setAttribute('role','status');
    el.setAttribute('aria-live','polite');
    el.style.cssText='position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:99999;max-width:min(92vw,460px);padding:11px 16px;border-radius:13px;background:#243447;color:#fff;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 8px 26px #0004;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent=text;el.style.display='block';
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{el.style.display='none'},4200);
  setStatus(text);
}
function pickVoice(synth,lang){
  const voices=synth.getVoices?synth.getVoices():[];
  const target=String(lang||'zh-CN').toLowerCase();
  return voices.find(v=>v.lang&&v.lang.toLowerCase()===target)
    ||voices.find(v=>v.lang&&v.lang.toLowerCase().startsWith(target.slice(0,2)))||null;
}
function stop(){
  if(!('speechSynthesis' in window))return;
  try{if(window.speechSynthesis.speaking||window.speechSynthesis.pending)window.speechSynthesis.cancel()}catch(e){}
}
function tts(text,lang,opts){
  opts=opts||{};
  const value=String(text==null?'':text);
  return new Promise(resolve=>{
    if(!value.trim())return resolve(false);
    if(!('speechSynthesis' in window)){toast('这台设备没有可用的语音朗读功能，请检查浏览器设置。');return resolve(false)}
    const syn=window.speechSynthesis;
    const run=()=>{
      let u;
      try{u=new SpeechSynthesisUtterance(value)}catch(e){toast('语音启动失败，请再点一次喇叭。');return resolve(false)}
      u.lang=lang||'zh-CN';u.rate=opts.rate||.8;
      const v=pickVoice(syn,u.lang);if(v)u.voice=v;
      let settled=false;
      const finish=ok=>{if(settled)return;settled=true;resolve(ok)};
      u.onstart=()=>{if(!opts.silent)setStatus('正在朗读：'+value.slice(0,40))};
      u.onend=()=>{if(!opts.silent)setStatus('朗读结束，可以再听一遍。');finish(true)};
      u.onerror=e=>{
        const code=e&&e.error;
        if(code&&!['canceled','interrupted'].includes(code))toast('本机语音朗读失败，请检查设备中文语音后重试。');
        finish(false);
      };
      try{syn.speak(u)}catch(e){toast('语音启动失败，请再点一次喇叭。');return finish(false)}
      setTimeout(()=>{if(!settled&&!syn.speaking&&!syn.pending){toast('语音没有启动，请再点一次喇叭。');finish(false)}},2200);
    };
    if(!opts.noCancel&&(syn.speaking||syn.pending)){
      try{syn.cancel()}catch(e){}
      setTimeout(run,90); // iOS Safari：cancel 后同一次任务内立即 speak 会静默失败
    }else run();
  });
}
function speak(text,lang){
  const value=String(text==null?'':text);
  if(!value.trim())return Promise.resolve(false);
  // 古诗名句优先使用已随包发布的 MP3；题干/选项/反馈必须整段朗读，不能只读其中引用的诗句。
  const quizLike=/[？?！!]|选项|题目|答案|下一句|正确|恭喜|为什么|什么|吗|请选择/.test(value);
  if(!quizLike&&value.length<=120&&window.V6PoemAudio&&typeof window.V6PoemAudio.playKnown==='function'&&window.V6PoemAudio.playKnown(value))return Promise.resolve(true);
  return tts(value,lang||'zh-CN');
}
function speakSequence(parts){
  const list=(parts||[]).filter(p=>p&&String(p.text||'').trim());
  if(!list.length)return Promise.resolve(false);
  stop();
  return new Promise(resolve=>{
    let i=0;
    const next=()=>{
      if(i>=list.length)return resolve(true);
      const item=list[i++];
      tts(item.text,item.lang||'zh-CN',{noCancel:true}).then(next);
    };
    setTimeout(next,40);
  });
}
function speakOption(message,id){
  const input=String(message||'');
  if(!/[\u3400-\u9fff]/.test(input))return tts(input,id==='en'?'en-US':'zh-CN');
  const parts=[];const english=/[A-Za-z]+(?:[ \t'-]+[A-Za-z]+)*/g;let pos=0,m;
  while((m=english.exec(input))!==null){
    if(m.index>pos)parts.push({text:input.slice(pos,m.index),lang:'zh-CN'});
    parts.push({text:m[0],lang:'en-US'});pos=m.index+m[0].length;
  }
  if(pos<input.length)parts.push({text:input.slice(pos),lang:'zh-CN'});
  return speakSequence(parts);
}
function playUrl(url,fallbackText,opts){
  opts=opts||{};
  return new Promise(resolve=>{
    if(!url)return tts(fallbackText).then(resolve);
    let audio;
    try{audio=new Audio(url)}catch(e){return tts(fallbackText).then(resolve)}
    audio.preload='auto';
    let settled=false;
    const fallback=msg=>{
      if(settled)return;settled=true;
      toast(msg);
      tts(fallbackText||'').then(resolve);
    };
    const timer=setTimeout(()=>fallback('录音加载超时，已改用本机语音朗读。'),6000);
    audio.onplaying=()=>{if(!settled)setStatus('正在播放录音…')};
    audio.onended=()=>{if(settled)return;settled=true;clearTimeout(timer);setStatus('播放结束，可以再听一遍。');if(typeof opts.onEnd==='function')opts.onEnd();resolve(true)};
    audio.onerror=()=>fallback('录音无法播放，已改用本机语音朗读。');
    try{
      const p=audio.play();
      if(p&&typeof p.catch==='function')p.catch(()=>fallback('设备没有立即允许播放，已改用本机语音朗读；如仍无声请再点一次。'));
    }catch(e){fallback('设备没有立即允许播放，已改用本机语音朗读；如仍无声请再点一次。')}
  });
}
const PINYIN_FALLBACK={
  zhi:'知，蜘蛛的知',chi:'吃，吃饭的吃',shi:'狮，狮子的狮',ri:'日，日出的日',
  zi:'字，写字的字',ci:'词，词语的词',si:'丝，蚕丝的丝',
  ai:'爱，喜爱的爱',ao:'奥，奥数的奥',ang:'昂，昂起的昂',eng:'灯的韵母，eng',ing:'英，英雄的英',ong:'轰的韵母，ong',
  ma:'妈，妈妈的妈',ba:'八，八个的八',da:'大，大小的大',a:'啊',e:'鹅，白鹅的鹅',i:'衣，衣服的衣',u:'乌，乌云的乌','ü':'鱼，小鱼的鱼'
};
function pinyin(letter,url){
  return playUrl(url,PINYIN_FALLBACK[String(letter).toLowerCase()]||String(letter));
}
window.V6Voice={speak,tts,speakSequence,speakOption,playUrl,pinyin,stop,setStatus,toast};
})();
