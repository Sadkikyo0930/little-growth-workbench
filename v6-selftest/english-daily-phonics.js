(()=>{'use strict';
const lessons=[
 ['at',['cat','hat','bat'],'pat','常见韵尾 at，换开头也能拼读'],
 ['an',['man','fan','pan'],'can','an 常出现在很多短单词结尾'],
 ['ag',['bag','tag','flag'],'rag','看见 ag，尝试拼读新单词'],
 ['ing',['sing','ring','king'],'wing','ing 是一个常见拼读块，注意 ng 的鼻音'],
 ['ing',['king','sing','ring'],'bring','复习 ing，试读没有练过的新词'],
 ['ight',['night','light','bright'],'sight','igh 常读长元音，后面接 t'],
 ['ight',['light','night','bright'],'might','复习 ight，先自己读再听确认'],
 ['ake',['make','cake','lake'],'bake','a_e 常形成长元音 /eɪ/'],
 ['sh',['ship','shop','fish'],'wish','sh 两个字母常对应一个声音'],
 ['th',['thin','three','bath'],'moth','先学清音 th；this 的 th 是另一种读音'],
 ['sh',['shell','ship','wish'],'shop','复习 sh，并与 th 区分'],
 ['ing',['sing','ring','wing'],'bring','组合复习：ing 与 ight'],
 ['ake',['make','cake','lake'],'rake','组合复习：ake 与 ight'],
 ['at',['cat','hat','bat'],'pat','混合拼读练习：at、an、ag'],
 ['an',['man','fan','pan'],'ran','混合拼读练习，先读后听'],
 ['ight',['night','light','bright'],'sight','复习易混淆字母组合'],
 ['sh',['ship','shop','fish'],'shell','本月拼读小测：听、辨、迁移']
];
const transferSets=[["pat","sat","rat","mat"],["can","ran","tan","van"],["rag","sag","wag","drag"],["wing","bring","thing","sting"],["wing","bring","sting","swing"],["sight","might","fight","flight"],["sight","might","fight","flight"],["bake","rake","take","snake"],["wish","shell","shed","shut"],["moth","math","path","cloth"],["ship","fish","shop","shut"],["bring","sting","swing","thing"],["bake","rake","take","shake"],["pat","sat","rat","mat"],["can","ran","tan","van"],["sight","might","fight","flight"],["wish","shell","shed","shut"]];
const css=document.createElement('style');css.textContent=`
.phonics-panel{background:linear-gradient(130deg,#f3faff,#fff7eb);border:2px solid #bedcf7;border-radius:20px;padding:17px;margin:8px 0}
.phonics-chunk{font-size:70px;color:#1375c6;letter-spacing:2px;text-align:center;font-weight:900;margin:8px auto}
.phonics-hint{font-size:14px;color:#486c8e;line-height:1.65}
.phonics-word{font-size:27px;font-weight:850;color:#285878;padding:13px;border-radius:15px;background:white;text-align:center;margin:8px 0}
.phonics-word-play{display:block;width:100%;border:2px solid #b3d8ef;cursor:pointer;touch-action:manipulation}.phonics-word-play:active{background:#d9f0ff;transform:scale(.99)}.phonics-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.phonics-choices button{min-height:62px;border:2px solid #a8cfe9;border-radius:14px;background:#effaff;color:#215781;font-size:22px;font-weight:900}
.phonics-choices button:disabled{opacity:.75}
.phonics-panel button:focus-visible{outline:3px solid #efb333}
.phonics-transfer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
.phonics-transfer-card{border:2px solid #b9dcf2;border-radius:16px;background:#fff;padding:12px 8px;text-align:center;min-width:0}
.phonics-transfer-card .phonics-word{padding:8px 2px;font-size:clamp(23px,5vw,31px);margin:0 0 7px}
.phonics-transfer-card .phonics-small{width:100%;border:1px solid #95c9e6;border-radius:11px;padding:10px 4px;background:#e8f6ff;color:#235a7f;font-weight:800;font-size:13px}
.phonics-transfer-card .phonics-grade{display:flex;gap:5px;margin-top:8px}
.phonics-transfer-card .phonics-grade button{flex:1;min-width:0;border:0;border-radius:9px;padding:10px 3px;font-size:12px;font-weight:850;color:#245674;background:#daf3e8}
.phonics-transfer-card .phonics-grade button:last-child{background:#fff0d6}
.phonics-transfer-card.is-reviewed{border-color:#54ba9f;background:#f1fcf7}
`;document.head.append(css);
function make(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined)e.textContent=txt;if(cls)e.className=cls;return e}
function action(label,click,cls='button soft'){const e=make('button',label,cls);e.type='button';e.onclick=click;return e}
function mount(n,host,speech,done){const [chunk,examples,transfer,hint]=lessons[n-1];const transferWords=transferSets[n-1];let step=0;const answers=[];
const speak=w=>speech(w,'en-US');let chunkPlayer=null;const phonetic={'at':'/æt/','an':'/æn/','ag':'/æɡ/','ing':'/ɪŋ/','ight':'/aɪt/','ake':'/eɪk/','sh':'/ʃ/','th':'/θ/'};let shAudioContext=null;
function playIsolatedSh(){
  // /ʃ/ is a voiceless fricative: filtered airflow noise, without a vowel or final consonant.
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass){panel.append(make('p','当前浏览器不支持单独的 sh 音频，请使用例词发音。','feedback'));return}
  try{
    if(chunkPlayer){chunkPlayer.pause();chunkPlayer=null}
    if(!shAudioContext)shAudioContext=new AudioContextClass();
    const ctx=shAudioContext;
    const resume=ctx.state==='suspended'?ctx.resume():Promise.resolve();
    resume.then(()=>{
      const duration=.72,n=Math.ceil(ctx.sampleRate*duration);
      const buffer=ctx.createBuffer(1,n,ctx.sampleRate);
      const data=buffer.getChannelData(0);
      let prev=0;
      // High-frequency turbulent airflow, reproducible without speech synthesis reading "ship".
      for(let i=0;i<n;i++){const raw=Math.random()*2-1;prev=.83*prev+.17*raw;data[i]=raw-prev}
      const src=ctx.createBufferSource();src.buffer=buffer;
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=1600;
      const peak=ctx.createBiquadFilter();peak.type='peaking';peak.frequency.value=3250;peak.Q.value=.85;peak.gain.value=11;
      const low=ctx.createBiquadFilter();low.type='lowpass';low.frequency.value=6500;
      const gain=ctx.createGain();const t=ctx.currentTime;
      gain.gain.setValueAtTime(.0001,t);
      gain.gain.linearRampToValueAtTime(.48,t+.065);
      gain.gain.setValueAtTime(.48,t+duration-.13);
      gain.gain.linearRampToValueAtTime(.0001,t+duration);
      src.connect(hp);hp.connect(peak);peak.connect(low);low.connect(gain);gain.connect(ctx.destination);
      src.start(t);src.stop(t+duration+.01);
    }).catch(()=>panel.append(make('p','请再次点击播放，允许浏览器播放声音。','feedback')));
  }catch(e){panel.append(make('p','播放失败，请重试。','feedback'))}
}
// Reusable offline WAV sound for /θ/ avoids iPhone Safari AudioContext resume timing.
// Synthesized friction only; it contains no spoken vowel or final consonant.
let thSoundUrl=null;
function buildThWavUrl(){
  if(thSoundUrl)return thSoundUrl;
  const rate=22050,duration=.85,n=Math.round(rate*duration);
  const bytes=new ArrayBuffer(44+n*2),view=new DataView(bytes);
  function textAt(offset,value){for(let j=0;j<value.length;j++)view.setUint8(offset+j,value.charCodeAt(j))}
  textAt(0,'RIFF');view.setUint32(4,36+n*2,true);textAt(8,'WAVE');
  textAt(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,1,true);view.setUint32(24,rate,true);
  view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  textAt(36,'data');view.setUint32(40,n*2,true);
  let smooth=0;
  for(let i=0;i<n;i++){
    const noise=Math.random()*2-1;
    smooth=.79*smooth+.21*noise;
    const friction=noise-smooth;
    const attack=Math.min(1,i/(rate*.09)),release=Math.min(1,(n-i-1)/(rate*.15));
    const envelope=Math.max(0,Math.min(attack,release));
    // More audible than the original 0.17 gain; avoid extreme amplitude.
    const value=Math.max(-1,Math.min(1,friction*1.02*envelope));
    view.setInt16(44+i*2,Math.round(value*30000),true);
  }
  thSoundUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
  return thSoundUrl;
}
function playIsolatedTh(){
  try{
    if(chunkPlayer){chunkPlayer.pause();chunkPlayer.currentTime=0}
    // HTMLMediaElement.play is issued directly inside the button click: Safari gesture-compatible.
    chunkPlayer=new Audio(buildThWavUrl());
    chunkPlayer.volume=1;
    const playing=chunkPlayer.play();
    if(playing&&typeof playing.catch==='function')playing.catch(()=>{
      panel.append(make('p','没有播放成功，请检查手机静音模式与媒体音量，然后再点一次。','feedback'));
    });
  }catch(e){
    panel.append(make('p','th 音频播放失败，请重试或点击 thin 例词试听。','feedback'));
  }
}
function playChunk(){if(chunk==='sh'){playIsolatedSh();return}if(chunk==='th'){playIsolatedTh();return}const key=chunk;const src=window.V6PhonicsAudio&&window.V6PhonicsAudio[key];if(!src){panel.append(make('p','组合音频暂时不可用，请打开原版 V4 练习。','feedback'));return}try{if(chunkPlayer){chunkPlayer.pause();chunkPlayer.currentTime=0}chunkPlayer=new Audio(src);chunkPlayer.play().catch(()=>{panel.append(make('p','请再次点击组合发音按钮，允许浏览器播放音频。','feedback'))})}catch(e){panel.append(make('p','此设备暂时无法播放组合发音。','feedback'))}}
const panel=make('div',undefined,'phonics-panel');host.replaceChildren(panel);
function render(){panel.replaceChildren();panel.append(make('span','🔤 今日固定字母组合 · 第 '+n+' / 17 课','pill'));
 if(step===0){panel.append(make('div',chunk,'phonics-chunk'),make('p','组合读音 '+(phonetic[chunk]||''),'phonics-hint'));panel.append(action((chunk==='sh'?'🔊 单独听 sh 的发音 /ʃ/':chunk==='th'?'🔊 单独听 th 的发音 /θ/':'🔊 先听 '+chunk+' 组合本身怎么读'),playChunk,'button'));panel.append(make('p',chunk==='sh'?'这里只发清晰的 /ʃ/ 气流摩擦音，不带 ship 后面的元音和尾音。例词 ship、shop、fish 可单独点击听完整发音。':chunk==='th'?'只播放不带元音的 /θ/ 摩擦气流音，不再拿 thin 或 thing 充当 th。舌尖轻触上下齿之间，缓缓送气；例词 thin、three、bath 仍可点击听完整单词。':'这里播放 V4 原有的离线组合音频，不是把字母逐个念出来。','muted'));panel.append(make('p',hint,'phonics-hint'));panel.append(make('p','先听组合本身，再听下面三个单词；观察换了开头后，组合的读音如何保留。','muted'));
 examples.forEach(w=>{const row=make('button',undefined,'phonics-word phonics-word-play');row.type='button';row.setAttribute('aria-label','点击听 '+w+' 的发音');row.onclick=()=>speak(w);const p=w.lastIndexOf(chunk);if(p>=0){row.append(document.createTextNode(w.slice(0,p)));const strong=make('span',chunk);strong.style.color='#d4553f';strong.style.textDecoration='underline';row.append(strong,document.createTextNode(w.slice(p+chunk.length)))}else row.textContent=w;const symbol=make('span',' 🔊');symbol.style.cssText='font-size:18px;vertical-align:middle;color:#3383c1';row.append(symbol);panel.append(row)});
 panel.append(action('我听懂组合音了，进入辨音挑战 →',()=>{step=1;render()},'button'));return}
 if(step===1){panel.append(make('h2','听单词，找出共同拼读块','question'));panel.append(action('🔊 重听 '+chunk+' 组合音',playChunk));panel.append(action('🔊 听完整示范词：'+examples[0],()=>speak(examples[0])));
 const opts=[chunk,chunk==='ing'?'ang':chunk==='ight'?'eight':chunk==='sh'?'ch':chunk==='th'?'sh':chunk==='ake'?'ack':chunk==='at'?'et':chunk==='an'?'en':'eg',chunk==='ing'?'ong':chunk==='ight'?'ite':chunk==='sh'?'th':chunk==='th'?'ch':chunk==='ake'?'ike':chunk==='at'?'ot':chunk==='an'?'in':'ig'];
 const order=[opts[1],opts[0],opts[2]];const grid=make('div',undefined,'phonics-choices');let answered=false;
 order.forEach(opt=>grid.append(action(opt,()=>{if(answered)return;answered=true;const ok=opt===chunk;answers.push({mode:'phonics-chunk',correct:ok,selected:opt,expected:chunk});grid.querySelectorAll('button').forEach(b=>b.disabled=true);panel.append(make('p',ok?'🌟 选对了！':'正确组合是 '+chunk,'feedback'));panel.append(action('下一步：自己读新词 →',()=>{step=2;render()},'button'))},'')));
 panel.append(grid);return}
 panel.append(make('h2','举一反三：同一页挑战 4 个新词','question'));
 panel.append(action('🔊 再听 '+chunk+' 组合音',playChunk));
 panel.append(make('p','先自己拼读每个词，再点该词下方的「核对发音」。四个词都核对后才能进入后面的课程。','phonics-hint'));
 const grid=make('div',undefined,'phonics-transfer-grid');panel.append(grid);
 const status=make('p','已核对 0 / '+transferWords.length+' 个','phonics-hint');panel.append(status);
 const finish=action('完成拼读，进入高频词 →',()=>{if(answers.filter(a=>a.mode==='phonics-transfer').length!==transferWords.length)return;if(chunkPlayer){chunkPlayer.pause();chunkPlayer=null}done({chunk,examples,transfer:transferWords,answers})},'button');finish.disabled=true;
 transferWords.forEach((w,i)=>{
   const card=make('div',undefined,'phonics-transfer-card');
   const word=make('div',undefined,'phonics-word');
   const p=w.lastIndexOf(chunk);
   if(p>=0){word.append(document.createTextNode(w.slice(0,p)));const piece=make('span',chunk);piece.style.cssText='color:#d4553f;text-decoration:underline';word.append(piece,document.createTextNode(w.slice(p+chunk.length)))}else word.textContent=w;
   const hear=action('🔊 核对发音',()=>{speak(w);hear.disabled=true;grade.style.display='flex'},'phonics-small');
   const grade=make('div',undefined,'phonics-grade');grade.style.display='none';
   function mark(ok){answers.push({mode:'phonics-transfer',correct:ok,selected:ok?'self-correct':'needs-practice',expected:w});grade.replaceChildren(make('span',ok?'✅ 已掌握':'🔁 待练习','phonics-hint'));card.classList.add('is-reviewed');status.textContent='已核对 '+answers.filter(a=>a.mode==='phonics-transfer').length+' / '+transferWords.length+' 个';finish.disabled=answers.filter(a=>a.mode==='phonics-transfer').length!==transferWords.length}
   grade.append(action('✅ 读对了',()=>mark(true)),action('🔁 再练练',()=>mark(false)));
   card.append(word,hear,grade);grid.append(card);
 });
 panel.append(finish);
}

render();
}
window.V6PhonicsLesson={open:mount,has:n=>n>=1&&n<=17};
})();