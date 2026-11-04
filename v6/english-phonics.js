(()=>{'use strict';
const qs=new URLSearchParams(location.search),lesson=Number(qs.get('lesson')||1);
if(!Number.isInteger(lesson)||lesson<1||lesson>17)return;
// A letter team (th, sh, ch) is not itself a syllable; -ing and -ight are useful word chunks.
const units=[
{title:'th 两种声音',label:'辅音字母组合',focus:'th',note:'舌尖轻触上下牙之间，轻轻送气。thin 里的 th 不振动声带，this 里的 th 会振动。不要把 th 读成字母 t 加 h。',words:[['thin','th','in','细的'],['this','th','is','这个'],['that','th','at','那个']],target:'this',others:['tin','this','sit'],prompt:'听一听，选出含有 th 的 this'},
{title:'-ing 一起读',label:'词尾拼读块',focus:'ing',note:'先听 sing 的整体发音，再看 s + ing。结尾的 ng 是一个鼻音，不要在末尾额外加“哥”。',words:[['sing','s','ing','唱歌'],['ring','r','ing','铃声'],['king','k','ing','国王']],target:'sing',others:['sin','sing','sun'],prompt:'听一听，找出 sing'},
{title:'-ight 一起读',label:'韵尾拼读块',focus:'ight',note:'night、light、right 里的 igh 通常发长元音 /aɪ/；末尾 t 要轻收住，不把 ight 念成四个字母名。',words:[['night','n','ight','夜晚'],['light','l','ight','灯光'],['right','r','ight','右边']],target:'night',others:['net','night','not'],prompt:'听一听，找出 night'},
{title:'sh 一起读',label:'辅音字母组合',focus:'sh',note:'sh 通常发一个 /ʃ/ 音，嘴唇微微向前。',words:[['ship','sh','ip','船'],['shop','sh','op','商店'],['fish','fi','sh','鱼']],target:'ship',others:['sip','ship','chip'],prompt:'听一听，找出 ship'},
{title:'ch 一起读',label:'辅音字母组合',focus:'ch',note:'在 chip、chat 等词里 ch 常发 /tʃ/。',words:[['chip','ch','ip','碎片'],['chat','ch','at','聊天'],['chin','ch','in','下巴']],target:'chip',others:['ship','chip','tip'],prompt:'听一听，找出 chip'},
{title:'ee 长元音',label:'元音字母组合',focus:'ee',note:'see、tree、feet 的 ee 常读长元音 /iː/。',words:[['see','s','ee','看见'],['tree','tr','ee','树'],['feet','f','eet','脚（复数）']],target:'see',others:['say','see','sit'],prompt:'听一听，找出 see'},
{title:'ai 长元音',label:'元音字母组合',focus:'ai',note:'rain、train 中 ai 常发 /eɪ/。注意 rain 是一个音节。',words:[['rain','r','ain','雨'],['train','tr','ain','火车'],['mail','m','ail','邮件']],target:'rain',others:['run','rain','ran'],prompt:'听一听，找出 rain'},
{title:'oa 长元音',label:'元音字母组合',focus:'oa',note:'boat、coat 中 oa 常发 /oʊ/（美式）。',words:[['boat','b','oat','船'],['coat','c','oat','外套'],['road','r','oad','道路']],target:'boat',others:['boot','boat','bat'],prompt:'听一听，找出 boat'},
{title:'ar 字母组合',label:'r 控制元音',focus:'ar',note:'car、star 里的 ar 通常发 /ɑr/（美式）。',words:[['car','c','ar','汽车'],['star','st','ar','星星'],['park','p','ark','公园']],target:'car',others:['care','car','core'],prompt:'听一听，找出 car'},
{title:'or 字母组合',label:'r 控制元音',focus:'or',note:'for、corn 里的 or 常发 /ɔr/（美式）。',words:[['for','f','or','为了'],['corn','c','orn','玉米'],['short','sh','ort','短的']],target:'corn',others:['can','corn','coin'],prompt:'听一听，找出 corn'},
{title:'oo 两种读法',label:'元音字母组合',focus:'oo',note:'moon 的 oo 读 /uː/，book 的 oo 常读 /ʊ/。同样字母组合也可能有不同声音。',words:[['moon','m','oon','月亮'],['book','b','ook','书'],['food','f','ood','食物']],target:'book',others:['back','book','bike'],prompt:'听一听，找出 book'},
{title:'ck 词尾',label:'辅音字母组合',focus:'ck',note:'back、duck 中 ck 一般一起发 /k/，而不是两个 /k/。',words:[['back','ba','ck','背后'],['duck','du','ck','鸭子'],['sock','so','ck','袜子']],target:'duck',others:['dog','duck','dig'],prompt:'听一听，找出 duck'},
{title:'wh 常见读法',label:'辅音字母组合',focus:'wh',note:'在 what、when、where 中，wh 在多数现代英语口音里接近 /w/；who 读音不同。',words:[['what','wh','at','什么'],['when','wh','en','何时'],['where','wh','ere','哪里']],target:'what',others:['hat','what','wet'],prompt:'听一听，找出 what'},
{title:'-ake 词族',label:'词尾拼读块',focus:'ake',note:'make、take、cake 都带有长元音 /eɪ/，末尾 e 不单独读出来。',words:[['make','m','ake','制作'],['take','t','ake','拿走'],['cake','c','ake','蛋糕']],target:'make',others:['mack','make','mike'],prompt:'听一听，找出 make'},
{title:'-all 词族',label:'词尾拼读块',focus:'all',note:'ball、call、small 中 all 常读 /ɔːl/ 或相近的美式发音。',words:[['ball','b','all','球'],['call','c','all','打电话'],['small','sm','all','小的']],target:'ball',others:['bell','ball','bill'],prompt:'听一听，找出 ball'},
{title:'ow 的不同读法',label:'元音字母组合',focus:'ow',note:'snow 的 ow 常读 /oʊ/，cow 的 ow 常读 /aʊ/。用整词对比，不死记一个读音。',words:[['snow','sn','ow','雪'],['cow','c','ow','奶牛'],['show','sh','ow','展示']],target:'snow',others:['snow','snaw','sun'],prompt:'听一听，找出 snow'},
{title:'ng 鼻音复习',label:'辅音字母组合',focus:'ng',note:'sing、long、ring 末尾 ng 常发 /ŋ/，不能拆成字母 n 和 g 的名字。',words:[['sing','si','ng','唱歌'],['long','lo','ng','长的'],['ring','ri','ng','戒指']],target:'long',others:['land','long','line'],prompt:'听一听，找出 long'}];
const data=units[lesson-1],wrap=document.createElement('section');
wrap.className='card hidden';wrap.id='phonicsModule';wrap.setAttribute('aria-label','自然拼读实验室');
const game=document.getElementById('game'),finish=document.getElementById('finish');
if(!game||!finish)return;
finish.parentNode.insertBefore(wrap,finish);
let doneCallback=null,step=0,results=[],locked=false,utterance=null;
function speak(text,lang='en-US'){if(!window.speechSynthesis)return;try{speechSynthesis.cancel();utterance=new SpeechSynthesisUtterance(text);utterance.lang=lang;utterance.rate=lang==='en-US'?.74:.9;const voices=speechSynthesis.getVoices();utterance.voice=voices.find(v=>v.lang.toLowerCase()===lang.toLowerCase())||voices.find(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2)))||null;speechSynthesis.speak(utterance)}catch(e){}}
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el}
function btn(text,click,cls='button'){const b=node('button',cls,text);b.type='button';b.onclick=click;return b}
function clear(){wrap.replaceChildren()}
function header(label){wrap.append(node('span','pill','🔤 拼读训练 · '+label),node('h2','',data.title))}
function next(){step++;render()}
function render(){locked=false;clear();wrap.classList.remove('hidden');
 if(step===0){header('观察发音');wrap.append(node('p','muted','今天认识：'+data.focus+'（'+data.label+'）。不同的字母组合不一定是完整音节。'));
 wrap.append(node('div','big',data.words.map(w=>w[0]).join('　')));
 wrap.append(node('p','muted',data.note));
 wrap.append(btn('🔊 听老师讲拼读方法',()=>speak(data.note,'zh-CN'),'button soft'));
 wrap.append(btn('🔊 听这三个英语单词',()=>speak(data.words.map(w=>w[0]).join('. ')),'button soft'));
 wrap.append(btn('我准备好了，开始拆分 →',next));return}
 if(step===1){header('看组合，读整词');wrap.append(node('p','muted','点每个单词，听正确整词发音。观察字母块怎样组合，不能把字母名称当成拼读发音。'));
 data.words.forEach(w=>{const line=node('div','steps');line.style.margin='12px 0';const parts=node('div','pyramid');parts.style.flex='1';parts.textContent=w[1]+' + '+w[2]+'  →  '+w[0];line.append(parts,btn('🔊 '+w[0],()=>speak(w[0]),'chip'));wrap.append(line)});
 wrap.append(btn('下一步：听辨挑战 →',next));return}
 if(step>=2&&step<=3){header('听辨挑战 '+(step-1)+' / 2');const target=step===2?data.target:data.words[2][0];
 const opts=step===2?data.others:[data.words[1][0],data.words[2][0],data.words[0][0]];
 wrap.append(node('p','question','听整词，选择听到的英语单词。'));
 wrap.append(btn('🔊 听题目（可重听）',()=>speak(target),'button soft'));
 const grid=node('div','grid'),feedback=node('p','feedback');const control=btn(step===3?'完成拼读训练 🏅':'继续下一题 →',next);control.disabled=true;
 opts.forEach(w=>{const b=btn(w,()=>{if(locked)return;locked=true;const ok=w===target;results.push({mode:'phonics',pattern:data.focus,word:target,selected:w,expected:target,correct:ok});if(ok)b.classList.add('correct');else b.classList.add('wrong');grid.querySelectorAll('button').forEach(x=>x.disabled=true);feedback.textContent=ok?'🌟 恭喜你，回答正确！':'💡 正确答案：'+target;
 speak(ok?'恭喜你回答正确':'哦哦，正确答案是','zh-CN');control.disabled=false},'word');grid.append(b)});
 wrap.append(grid,feedback,control);return}
 window.v6PhonicsResult={pattern:data.focus,title:data.title,answers:results.slice(),correct:results.filter(r=>r.correct).length,total:results.length,at:new Date().toISOString()};
 wrap.classList.add('hidden');if(typeof doneCallback==='function'){const cb=doneCallback;doneCallback=null;cb()}
}
window.v6PhonicsStart=function(callback){doneCallback=callback;step=0;results=[];window.v6PhonicsResult=null;game.classList.add('hidden');finish.classList.add('hidden');render();wrap.scrollIntoView({block:'start',behavior:'smooth'})};
})();