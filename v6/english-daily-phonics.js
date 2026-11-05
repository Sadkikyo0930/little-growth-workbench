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
const css=document.createElement('style');css.textContent=`
.phonics-panel{background:linear-gradient(130deg,#f3faff,#fff7eb);border:2px solid #bedcf7;border-radius:20px;padding:17px;margin:8px 0}
.phonics-chunk{font-size:70px;color:#1375c6;letter-spacing:2px;text-align:center;font-weight:900;margin:8px auto}
.phonics-hint{font-size:14px;color:#486c8e;line-height:1.65}
.phonics-word{font-size:27px;font-weight:850;color:#285878;padding:13px;border-radius:15px;background:white;text-align:center;margin:8px 0}
.phonics-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.phonics-choices button{min-height:62px;border:2px solid #a8cfe9;border-radius:14px;background:#effaff;color:#215781;font-size:22px;font-weight:900}
.phonics-choices button:disabled{opacity:.75}
.phonics-panel button:focus-visible{outline:3px solid #efb333}
`;document.head.append(css);
function make(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined)e.textContent=txt;if(cls)e.className=cls;return e}
function action(label,click,cls='button soft'){const e=make('button',label,cls);e.type='button';e.onclick=click;return e}
function mount(n,host,speech,done){const [chunk,examples,transfer,hint]=lessons[n-1];let step=0;const answers=[];
const speak=w=>speech(w,'en-US');
const panel=make('div',undefined,'phonics-panel');host.replaceChildren(panel);
function render(){panel.replaceChildren();panel.append(make('span','🔤 今日固定字母组合 · 第 '+n+' / 17 课','pill'));
 if(step===0){panel.append(make('div',chunk,'phonics-chunk'),make('p',hint,'phonics-hint'));panel.append(make('p','先听三个完整单词，观察它们共同的字母组合。','muted'));
 examples.forEach(w=>{const row=make('div',w,'phonics-word');const a=action('🔊 听 '+w,()=>speak(w));panel.append(row,a)});
 panel.append(action('我听好了，进入听音辨组合 →',()=>{step=1;render()},'button'));return}
 if(step===1){panel.append(make('h2','听单词，找出共同拼读块','question'));panel.append(action('🔊 听示范词：'+examples[0],()=>speak(examples[0])));
 const opts=[chunk,chunk==='ing'?'ang':chunk==='ight'?'eight':chunk==='sh'?'ch':chunk==='th'?'sh':chunk==='ake'?'ack':chunk==='at'?'et':chunk==='an'?'en':'eg',chunk==='ing'?'ong':chunk==='ight'?'ite':chunk==='sh'?'th':chunk==='th'?'ch':chunk==='ake'?'ike':chunk==='at'?'ot':chunk==='an'?'in':'ig'];
 const order=[opts[1],opts[0],opts[2]];const grid=make('div',undefined,'phonics-choices');let answered=false;
 order.forEach(opt=>grid.append(action(opt,()=>{if(answered)return;answered=true;const ok=opt===chunk;answers.push({mode:'phonics-chunk',correct:ok,selected:opt,expected:chunk});grid.querySelectorAll('button').forEach(b=>b.disabled=true);panel.append(make('p',ok?'🌟 选对了！':'正确组合是 '+chunk,'feedback'));panel.append(action('下一步：自己读新词 →',()=>{step=2;render()},'button'))},'')));
 panel.append(grid);return}
 panel.append(make('h2','迁移拼读：先自己读，不提前播放答案','question'));panel.append(make('div',transfer,'phonics-word'));panel.append(make('p','试着把开头字母和 '+chunk+' 组合起来读，读完再点击听答案。','phonics-hint'));
 const reveal=action('🔊 我读完了，听标准单词',()=>{speak(transfer);reveal.disabled=true;const buttons=make('div',undefined,'grid');buttons.append(action('✅ 我读对了',()=>complete(true),'button'),action('🔁 还要练习',()=>complete(false),'button soft'));panel.append(buttons)},'button');
 panel.append(reveal);
}
function complete(ok){answers.push({mode:'phonics-transfer',correct:ok,selected:ok?'self-correct':'needs-practice',expected:transfer});done({chunk,examples,transfer,answers});}
render();
}
window.V6PhonicsLesson={open:mount,has:n=>n>=1&&n<=17};
})();