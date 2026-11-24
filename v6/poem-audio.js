/* Shared V6 poetry controls. No microphone; no cloud writes. */
(function(){
'use strict';if(window.V6PoemAudio)return;
const catalog=[
['画','远看山有色，近听水无声。春去花还在，人来鸟不惊。','画里的山水花鸟不会像真的一样随季节和声音变化。'],
['池上','小娃撑小艇，偷采白莲回。不解藏踪迹，浮萍一道开。','小娃不知道掩藏踪迹，小船把浮萍分开，留下了一道痕迹。'],
['赠汪伦','李白乘舟将欲行，忽闻岸上踏歌声。桃花潭水深千尺，不及汪伦送我情。','桃花潭水很深，也比不上汪伦送别的情谊。'],
['悯农','锄禾日当午，汗滴禾下土。谁知盘中餐，粒粒皆辛苦。','每一粒粮食都来自辛勤劳动，我们要珍惜粮食。'],
['古朗月行','小时不识月，呼作白玉盘。又疑瑶台镜，飞在青云端。','诗人把月亮想象成白玉盘和天上的明镜。'],
['咏鹅','鹅鹅鹅，曲项向天歌。白毛浮绿水，红掌拨清波。','白鹅弯着脖子歌唱，在水中划动红色的脚掌。'],
['江南','江南可采莲，莲叶何田田。鱼戏莲叶间，鱼戏莲叶东。鱼戏莲叶西，鱼戏莲叶南。鱼戏莲叶北。','莲叶长得茂盛，鱼儿在莲叶间游来游去。'],
['风','解落三秋叶，能开二月花。过江千尺浪，入竹万竿斜。','风能吹落秋叶，也能让江水起浪、竹子倾斜。'],
['春晓','春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。','春天早晨听见鸟叫，诗人想起夜里的风雨和落花。'],
['静夜思','床前明月光，疑是地上霜。举头望明月，低头思故乡。','月光像地上的霜，诗人望着月亮思念故乡。'],
['寻隐者不遇','松下问童子，言师采药去。只在此山中，云深不知处。','老师去山中采药了，云雾很深，不知道他在哪里。'],
['小池','泉眼无声惜细流，树阴照水爱晴柔。小荷才露尖尖角，早有蜻蜓立上头。','荷叶刚露尖角，蜻蜓已经停在上面。'],
['画鸡','头上红冠不用裁，满身雪白走将来。平生不敢轻言语，一叫千门万户开。','公鸡有红冠和雪白的羽毛，清晨鸣叫唤醒人们。']
].map(([title,text,explain])=>({title,text,explain,lines:text.split(/[，。]/).filter(Boolean)}));
const lines=[...new Set(catalog.flatMap(p=>p.lines))];
const audioFiles={"远看山有色":"./audio/poems/7477d96223a66a43.mp3","近听水无声":"./audio/poems/af461d26824f1c43.mp3","春去花还在":"./audio/poems/14acb22fccce410f.mp3","人来鸟不惊":"./audio/poems/d66870ab7dfd8a4a.mp3","小娃撑小艇":"./audio/poems/7cd103d153684d4d.mp3","偷采白莲回":"./audio/poems/c1ce7446dc2cacc5.mp3","不解藏踪迹":"./audio/poems/e8c85e213c49ce54.mp3","浮萍一道开":"./audio/poems/0dd0650261330626.mp3","李白乘舟将欲行":"./audio/poems/e89f65bd2d460729.mp3","忽闻岸上踏歌声":"./audio/poems/201236de0ff80f2d.mp3","桃花潭水深千尺":"./audio/poems/0bf249a581151c4d.mp3","不及汪伦送我情":"./audio/poems/d7e6b39ef670a72e.mp3","锄禾日当午":"./audio/poems/c8c0156821e22b7c.mp3","汗滴禾下土":"./audio/poems/9ee0dbfdb3233eaa.mp3","谁知盘中餐":"./audio/poems/c8dc6a5859fa3868.mp3","粒粒皆辛苦":"./audio/poems/8dc75d902d9859a6.mp3","小时不识月":"./audio/poems/9bbee45a60846cd2.mp3","呼作白玉盘":"./audio/poems/64875f96ff13244c.mp3","又疑瑶台镜":"./audio/poems/6f55323f1bb5f5e1.mp3","飞在青云端":"./audio/poems/b19db8f8c6854bfc.mp3","鹅鹅鹅":"./audio/poems/f1eaabf417230d7b.mp3","曲项向天歌":"./audio/poems/0b65071f533342d9.mp3","白毛浮绿水":"./audio/poems/167676f87a1b0b0a.mp3","红掌拨清波":"./audio/poems/0590bc848396e5bb.mp3","江南可采莲":"./audio/poems/52cc5a225b7d785e.mp3","莲叶何田田":"./audio/poems/ccc30c4d9787a47f.mp3","鱼戏莲叶间":"./audio/poems/254d46d5655a5456.mp3","鱼戏莲叶东":"./audio/poems/76610367725c201d.mp3","鱼戏莲叶西":"./audio/poems/af07583a94e5407d.mp3","鱼戏莲叶南":"./audio/poems/595deab96237cec4.mp3","鱼戏莲叶北":"./audio/poems/996c5ce09c94097e.mp3","解落三秋叶":"./audio/poems/d763cd87b318e6ce.mp3","能开二月花":"./audio/poems/c3021754d8777f1d.mp3","过江千尺浪":"./audio/poems/7bf48b65a5154bf3.mp3","入竹万竿斜":"./audio/poems/cbbe4453b7cea21a.mp3","春眠不觉晓":"./audio/poems/4a87350d5b0b8e90.mp3","处处闻啼鸟":"./audio/poems/90be87318d74235c.mp3","夜来风雨声":"./audio/poems/b2782cb2ecc1818a.mp3","花落知多少":"./audio/poems/730f5f17d7cd3f97.mp3","床前明月光":"./audio/poems/c9dd2e405589750a.mp3","疑是地上霜":"./audio/poems/5aecbf5892bb864a.mp3","举头望明月":"./audio/poems/51e275afc4e5d343.mp3","低头思故乡":"./audio/poems/4ba35e953a311c55.mp3","松下问童子":"./audio/poems/b52277b09109600c.mp3","言师采药去":"./audio/poems/75e8212fd7d17866.mp3","只在此山中":"./audio/poems/b111af6da3993f58.mp3","云深不知处":"./audio/poems/ff76f13737008d1b.mp3","泉眼无声惜细流":"./audio/poems/4d8b977a2d2125f4.mp3","树阴照水爱晴柔":"./audio/poems/ba7ac43b0655ef5d.mp3","小荷才露尖尖角":"./audio/poems/976528dc42eab66b.mp3","早有蜻蜓立上头":"./audio/poems/ee843f99edf300ec.mp3","头上红冠不用裁":"./audio/poems/56db8b7bd3c61256.mp3","满身雪白走将来":"./audio/poems/612fbcd7ff4769de.mp3","平生不敢轻言语":"./audio/poems/418e236d7c6f058a.mp3","一叫千门万户开":"./audio/poems/048d295f08382d47.mp3","画里的山水花鸟不会像真的一样随季节和声音变化。":"./audio/poems/99b7e14b7c93453a.mp3","小娃不知道掩藏踪迹，小船把浮萍分开，留下了一道痕迹。":"./audio/poems/bb8ba28f89a84648.mp3","桃花潭水很深，也比不上汪伦送别的情谊。":"./audio/poems/65d6cbcce7d570dd.mp3","每一粒粮食都来自辛勤劳动，我们要珍惜粮食。":"./audio/poems/858cc84be92bf820.mp3","诗人把月亮想象成白玉盘和天上的明镜。":"./audio/poems/19dbacbbf6566acc.mp3","白鹅弯着脖子歌唱，在水中划动红色的脚掌。":"./audio/poems/a1591c27c608c56e.mp3","莲叶长得茂盛，鱼儿在莲叶间游来游去。":"./audio/poems/463a16cc824f2903.mp3","风能吹落秋叶，也能让江水起浪、竹子倾斜。":"./audio/poems/d3691ab7b5f81ee3.mp3","春天早晨听见鸟叫，诗人想起夜里的风雨和落花。":"./audio/poems/98bd272eca464110.mp3","月光像地上的霜，诗人望着月亮思念故乡。":"./audio/poems/7a49589ce44d4e02.mp3","老师去山中采药了，云雾很深，不知道他在哪里。":"./audio/poems/672d41a58e3113cf.mp3","荷叶刚露尖角，蜻蜓已经停在上面。":"./audio/poems/1247eafe5bf8d8c6.mp3","公鸡有红冠和雪白的羽毛，清晨鸣叫唤醒人们。":"./audio/poems/4a67c65aecf7f084.mp3"};
const audioBase=new URL('.',document.currentScript.src);
let generation=0,active=false,currentPlayer=null;
function stop(broadcast=true){
 generation++;const was=active;active=false;
 if(was){try{window.speechSynthesis?.cancel()}catch(e){}}
 if(currentPlayer){try{currentPlayer.pause()}catch(e){}currentPlayer=null}
 if(was)status('已停止朗读。');
 if(broadcast&&was)document.querySelectorAll('iframe').forEach(f=>{try{f.contentWindow?.postMessage({type:'v6-poem-audio-stop'},location.origin)}catch(e){}});
}
function status(t){const el=document.getElementById('v6PoemAudioStatus');if(el)el.textContent=t;if(window.V6Voice)window.V6Voice.setStatus(t)}
function playKnown(text){
 if(/[？?]|选项/.test(text))return false;
 const exact=text.replace(/[，。！？\s]/g,''),explanation=catalog.find(p=>p.explain.replace(/[，。！？\s]/g,'')===exact);
 const chunks=explanation?[explanation.explain]:Array.from(text.matchAll(new RegExp(lines.slice().sort((a,b)=>b.length-a.length).join('|'),'g')),m=>m[0]);
 if(!chunks.length||chunks.some(t=>!audioFiles[t]))return false;
 stop(false);const token=generation;let i=0,failed=false;
 let player=document.getElementById('v6PoemPlayer');
 if(!player){player=document.createElement('audio');player.id='v6PoemPlayer';player.hidden=true;player.preload='auto';document.body.append(player)}
 function fallback(line){
  if(failed||token!==generation)return;failed=true;active=true;
  status('录音不可用，已改用本机语音朗读：'+line);
  const done=()=>{if(token===generation)next()};
  if(window.V6Voice)window.V6Voice.tts(line,'zh-CN',{silent:true}).then(done);
  else{const u=new SpeechSynthesisUtterance(line);u.lang='zh-CN';u.rate=.75;u.onend=done;u.onerror=done;speechSynthesis.speak(u)}
 }
 function next(){
  if(token!==generation)return;failed=false;
  if(i>=chunks.length){active=false;status('朗读结束，可以再听一遍。');return}
  const line=chunks[i++];active=true;currentPlayer=player;
  player.src=new URL(audioFiles[line],audioBase).href;
  player.onplaying=()=>{if(token===generation&&!failed)status('正在朗读：'+line)};
  player.onended=()=>{if(token===generation&&!failed)next()};
  player.onerror=()=>fallback(line);
  try{player.load()}catch(e){}
  const p=player.play();if(p&&typeof p.catch==='function')p.catch(()=>fallback(line));
 }
 next();return true;
}
function say(text){
 if(playKnown(text))return;
 stop(false);
 if(!window.V6Voice){status('此设备没有可用的语音功能。');return}
 window.V6Voice.tts(text);
}
function speaker(text){const b=document.createElement('button');b.type='button';b.className='v6-poem-speaker';b.textContent='🔊';b.setAttribute('aria-label','朗读：'+text);b.dataset.poemSpeak=text;b.onclick=e=>{e.preventDefault();e.stopPropagation();say(text)};return b}
function shuffle(values){const a=[...values];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
const pattern=new RegExp('('+lines.slice().sort((a,b)=>b.length-a.length).join('|')+')([，。！？]?)','g');
function enhance(){
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),nodes=[];let n;
 while((n=walker.nextNode())){if(!n.parentElement||n.parentElement.closest('script,style,button,a,textarea,select,.v6-poem-line,[role="status"],#v6PoemAudioStatus,[data-poem-options],#options,#dialogControls,.v6PoemPractice'))continue;pattern.lastIndex=0;if(pattern.test(n.textContent))nodes.push(n)}
 for(const node of nodes){const text=node.textContent,frag=document.createDocumentFragment();let last=0;pattern.lastIndex=0;for(const m of text.matchAll(pattern)){frag.append(document.createTextNode(text.slice(last,m.index)));const row=document.createElement('span');row.className='v6-poem-line';row.append(document.createTextNode(m[0]),speaker(m[1]+'。'));frag.append(row);last=m.index+m[0].length}frag.append(document.createTextNode(text.slice(last)));node.replaceWith(frag)}
 for(const b of document.querySelectorAll('button[data-choice],button[data-answer],button.option')){if(b.dataset.poemAudioAdded||b.parentElement.querySelector('[data-voice],.speakOption'))continue;const verse=lines.find(l=>b.textContent.includes(l));if(!verse)continue;b.dataset.poemAudioAdded='1';b.insertAdjacentElement('afterend',speaker(verse+'。'))}
}
const style=document.createElement('style');style.textContent='.v6-poem-line{display:inline-flex;align-items:center;gap:6px;max-width:100%;flex-wrap:wrap}.v6-poem-speaker{display:inline-flex!important;align-items:center;justify-content:center;min-width:46px!important;min-height:46px!important;width:46px!important;padding:5px!important;margin:3px!important;border:1px solid #91c9c6!important;border-radius:12px!important;background:#eaf8f5!important;color:#135d67!important;font-size:21px!important;line-height:1!important;vertical-align:middle;touch-action:manipulation;cursor:pointer}.v6-poem-speaker:focus-visible{outline:3px solid #e5ad32}';document.head.append(style);
window.V6PoemAudio={catalog,lines,say,stop,speaker,shuffle,enhance,playKnown};
document.addEventListener('click',e=>{if(active&&e.target.closest('button')&&!e.target.closest('.v6-poem-speaker'))stop()},true);
window.addEventListener('pagehide',()=>{if(active)stop(false)});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)stop(false)});
window.addEventListener('message',e=>{if(active&&e.origin===location.origin&&e.source===parent&&e.data?.type==='v6-poem-audio-stop')stop(false)});
let queued=false;new MutationObserver(()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;enhance()})}}).observe(document.body,{childList:true,subtree:true});enhance();
})();
