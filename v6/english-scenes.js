(()=>{'use strict';
const activities={
1:[
 {type:'picture',prompt:'Look at the picture. 选出正确的英语句子。',emoji:'🐱',caption:'小猫坐在这里',options:['A big cat.','A blue car.','Go away!'],correct:0,explain:'A big cat. 一只大猫。'},
 {type:'order',prompt:'把词语排成句子',tokens:['I','see','a','cat'],explain:'I see a cat. 我看到一只猫。'},
 {type:'listen',prompt:'听英语，找到正确的画面',say:'A big cat.',options:[['🐱','大猫'],['🚗','小汽车'],['🦋','蝴蝶']],correct:0,explain:'A big cat. 一只大猫。'}
],
2:[
 {type:'picture',prompt:'Look at the picture. 选出正确的英语句子。',emoji:'🔵🚙',caption:'蓝色小汽车',options:['A blue car.','A red hat.','A little cat.'],correct:0,explain:'A blue car. 一辆蓝色小汽车。'},
 {type:'order',prompt:'把词语排成句子',tokens:['We','can','go'],explain:'We can go. 我们可以出发。'},
 {type:'route',prompt:'听指令，帮赛车走到终点',say:'Go down, then go right.',moves:['down','right'],explain:'Go down, then go right. 先向下，再向右。'}
],
3:[
 {type:'picture',prompt:'Look at the picture. 选出正确的英语句子。',emoji:'🧒🔎🦋',caption:'孩子在寻找蝴蝶',options:['Find the butterfly.','Go to sleep.','A blue car.'],correct:0,explain:'Find the butterfly. 找到蝴蝶。'},
 {type:'listen',prompt:'听英语，选出正确的动作',say:'Go!',options:[['🏃','出发'],['😴','睡觉'],['🍽️','吃饭']],correct:0,explain:'Go! 出发！'},
 {type:'order',prompt:'把词语排成句子',tokens:['I','can','go'],explain:'I can go. 我可以出发。'}
],
4:[
 {type:'picture',prompt:'看图选择小朋友正在做什么',scene:'running',options:['He is running.','He is sleeping.','He is reading.'],correct:0,explain:'He is running. 他正在跑步。'},
 {type:'order',prompt:'听句子，排列词块',tokens:['He','is','running'],explain:'He is running. 他正在跑步。'},
 {type:'listen',prompt:'听英语，选择正确动作',say:'He is jumping.',options:[['🏃','跑步'],['🦘','跳跃'],['😴','睡觉']],correct:1,explain:'He is jumping. 他正在跳跃。'}
],
5:[
 {type:'picture',prompt:'看图选择小朋友正在做什么',scene:'playing',options:['I am eating.','I am playing.','I am sleeping.'],correct:1,explain:'I am playing. 我正在玩耍。'},
 {type:'order',prompt:'听句子，排列词块',tokens:['I','am','playing'],explain:'I am playing. 我正在玩耍。'},
 {type:'route',prompt:'听指令，让小赛车到终点',say:'Go right, then go down.',moves:['right','down'],explain:'Go right, then go down. 先向右，再向下。'}
],
6:[
 {type:'picture',prompt:'看图选择正确英语句子',scene:'night',options:['It is a sunny day.','The light is on at night.','The car is red.'],correct:1,explain:'The light is on at night. 夜晚灯亮着。'},
 {type:'listen',prompt:'听英语，选择正确的画面',say:'The moon is bright.',options:[['☀️','太阳'],['🌙','月亮'],['🌧️','雨天']],correct:1,explain:'The moon is bright. 月亮很明亮。'},
 {type:'order',prompt:'听句子，排列词块',tokens:['I','see','a','light'],explain:'I see a light. 我看到一盏灯。'}
]
,8:[
 {type:'find',prompt:'神奇观察员 · 听英语，找到描述的画面',say:'I see a red car.',options:[['🚗','红色汽车'],['🚙','蓝色汽车'],['🚌','黄色巴士']],correct:0,explain:'I see a red car. 我看见一辆红色汽车。',colors:['#f66b62','#4b91dd','#f5c665']},
 {type:'find',prompt:'观察员 · 谁在跑？',say:'I see a boy run.',options:[['🏃','奔跑的男孩'],['🧑‍🍳','做饭的人'],['😴','睡觉的人']],correct:0,explain:'I see a boy run. 我看到一个男孩在跑。'},
 {type:'choiceAudio',prompt:'听懂情境 · 选择对应的意思',say:'I see the cat.',options:['我看见了那只猫。','我听见了小汽车。','我正在跑步。'],correct:0,explain:'I see the cat. 我看见了那只猫。'}
],
9:[
 {type:'collect',prompt:'玩具整理员 · 按听到的数量收集玩具',say:'Put two cars in the box.',item:'🚗',count:2,max:4,explain:'Put two cars in the box. 把两辆汽车放进盒子里。'},
 {type:'collect',prompt:'数一数 · 给车队准备礼物',say:'Put three stars in the box.',item:'⭐',count:3,max:5,explain:'Put three stars in the box. 把三颗星星放进盒子里。'},
 {type:'choiceAudio',prompt:'听力小侦探 · up 的意思是什么？',say:'Look up!',options:['向上看！','快睡觉！','向下看！'],correct:0,explain:'Look up! 向上看！'}
],
10:[
 {type:'detect',prompt:'寻找好朋友 · 根据英文介绍寻找角色',say:'Find the girl in yellow.',options:[['👧','黄色衣服','yellow'],['👦','蓝色衣服','blue'],['🧑','红色衣服','red']],correct:0,explain:'Find the girl in yellow. 找到穿黄色衣服的女孩。'},
 {type:'detect',prompt:'小伙伴在哪里？',say:'Where is the boy? He is here.',options:[['👧','黄色衣服','yellow'],['👦','蓝色衣服','blue'],['🐶','棕色小狗','brown']],correct:1,explain:'He is here. 他就在这里。'},
 {type:'choiceAudio',prompt:'听对话 · 朋友说了什么？',say:'Where are you? I am here.',options:['你在哪里？我在这里。','你的汽车是什么颜色？','我们要吃什么？'],correct:0,explain:'Where are you? I am here. 你在哪里？我在这里。'}
],
11:[
 {type:'fill',prompt:'句子修理站 · 把正确单词放进空格',say:'I am happy.',template:'I ___ happy.',choices:['are','am','at'],correct:1,explain:'I am happy. 我很开心。',hint:'I 表示我，am 表示是',reasons:{are:'are 通常与 you、we、they 等搭配；主语是 I，不能选 are。',at:'at 通常表示位置或指向，不是这里需要的 be 动词。',am:'I 要搭配 am，正确句子是 I am happy。'}},
 {type:'fill',prompt:'句子修理站 · 多位朋友来了',say:'We are here.',template:'We ___ here.',choices:['am','at','are'],correct:2,explain:'We are here. 我们在这里。',hint:'We 表示我们',reasons:{am:'am 通常跟在 I 后面；主语是 We，应该选 are。',at:'at 表示位置等意思，但句子这里需要表示“是/在”的 are。',are:'We 要搭配 are，正确句子是 We are here。'}},
 {type:'choiceAudio',prompt:'听懂句子 · at 用在什么位置？',say:'Look at the cat.',options:['看看那只猫。','我有一只猫。','所有小猫都在睡觉。'],correct:0,explain:'Look at the cat. 看看那只猫。'}
],
12:[
 {type:'color',prompt:'神奇调色屋 · 听英语选择颜色',say:'The bear is brown.',item:'🐻',options:[['棕色','#9d704a'],['黑色','#303d51'],['黄色','#f4ca56']],correct:0,explain:'The bear is brown. 这只熊是棕色的。'},
 {type:'color',prompt:'神奇调色屋 · 给小汽车选颜色',say:'Make the car black.',item:'🚗',options:[['蓝色','#4e97d5'],['黑色','#303d51'],['棕色','#9d704a']],correct:1,explain:'Make the car black. 把汽车涂成黑色。'},
 {type:'choiceAudio',prompt:'听懂小故事 · 谁吃过苹果？',say:'The boy ate an apple.',options:['男孩吃过一个苹果。','男孩买了一辆汽车。','男孩看见一个苹果。'],correct:0,explain:'The boy ate an apple. 男孩吃过一个苹果。'}
],
13:[
 {type:'sequence',prompt:'故事排序师 · 听故事，把画面按顺序排列',lines:[['The dog came to the park.','🐶','小狗来到公园'],['The dog saw a ball.','⚽','小狗看见一个球'],['The dog ran after the ball.','🐕','小狗追着球跑']],explain:'The dog came to the park. 小狗来到公园，然后看见球并追了过去。'},
 {type:'choiceAudio',prompt:'故事理解 · 小狗最后做了什么？',say:'The dog ran after the ball.',options:['追着球跑。','吃了晚餐。','回家睡觉。'],correct:0,explain:'The dog ran after the ball. 小狗追着球跑。'},
 {type:'fill',prompt:'句子修理 · 谁来到了公园？',say:'The dog came to the park.',template:'The dog ___ to the park.',choices:['did','came','but'],correct:1,explain:'The dog came to the park. 小狗来到了公园。',hint:'came 是 come 的过去式'}
],
14:[
 {type:'collect',prompt:'快乐小超市 · 听数量把苹果放进购物篮',say:'Get four apples.',item:'🍎',count:4,max:6,explain:'Get four apples. 拿四个苹果。'},
 {type:'shop',prompt:'快乐小超市 · 听顾客想买什么',say:'Get a good red apple.',options:[['🍎','红苹果'],['🍌','香蕉'],['🥛','牛奶']],correct:0,explain:'Get a good red apple. 拿一个好的红苹果。'},
 {type:'choiceAudio',prompt:'购物任务 · 听懂完整句子的意思',say:'I want to eat an apple.',options:['我想吃一个苹果。','我有四辆汽车。','我想喝牛奶。'],correct:0,explain:'I want to eat an apple. 我想吃一个苹果。'}
]};
const styles=document.createElement('style');styles.textContent=`
.scene-art{min-height:180px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;border-radius:22px;background:linear-gradient(145deg,#e1f8ff,#fff6d9);border:3px solid #fff;box-shadow:0 6px 15px #2c75a51b;margin:12px 0;padding:15px}
.scene-emoji{font-size:76px;line-height:1.5}.scene-choice{width:100%;border:2px solid #acd3eb;background:#f5fbff;color:#204c76;border-radius:15px;padding:15px;margin:5px 0;font-size:18px;font-weight:800;text-align:left}
.scene-choice:disabled{opacity:.8}.scene-choice.good{background:#d5f6e4;border-color:#3cbb85}.scene-choice.bad{background:#fff0e8;border-color:#ef9779}
.scene-message{font-size:17px;font-weight:800;line-height:1.65;color:#285b80;min-height:30px;margin:10px 0}
.scene-route{display:grid;grid-template-columns:repeat(3,68px);gap:6px;justify-content:center;margin:15px auto}.scene-route div{height:62px;border-radius:13px;background:#e8f5ff;display:flex;align-items:center;justify-content:center;font-size:34px;border:2px solid #c5e0f3}
.scene-actions{display:flex;flex-wrap:wrap;gap:9px;justify-content:center}.scene-actions button{border:0;border-radius:13px;background:#dbeeff;color:#174e83;font-size:23px;font-weight:800;padding:12px 16px}
.new-scene-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:14px 0}.new-scene-card{border:2px solid #b1d9f3;border-radius:17px;background:#f5fbff;color:#205881;padding:12px 4px;min-height:132px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;font-weight:800;font-size:13px}.new-scene-card .visual{font-size:52px;line-height:1.3}.new-scene-card:disabled{opacity:.75}.new-scene-card.good{border-color:#40bc83;background:#dcf8e9}.new-scene-card.bad{border-color:#e5928c;background:#fff0eb}.collection-tray{min-height:100px;border:3px dashed #8ac5eb;border-radius:18px;background:#eff9ff;padding:15px;text-align:center;display:flex;flex-direction:column;gap:7px;justify-content:center}.collection-items{font-size:35px;min-height:45px;letter-spacing:6px}.collection-controls{display:flex;gap:10px;margin:12px 0}.collection-controls button{flex:1;min-width:0}.scene-audio-play{background:#fff4ce!important;color:#694e17!important}
.scene-tile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}.scene-tile{border:2px solid #9bcae7;background:#f1f9ff;border-radius:16px;padding:13px 5px;color:#235277;min-height:110px;font-size:17px;font-weight:850;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center}.scene-tile .symbol{font-size:40px}.scene-tile.correct{background:#d9f8e9;border-color:#4ab888}.scene-tile.incorrect{background:#fff0eb;border-color:#e38c7d}.scene-template{text-align:center;font-size:25px;font-weight:850;background:#f2faff;border-radius:16px;padding:18px 8px;margin:12px 0}.scene-sequence-slots{display:flex;flex-direction:column;gap:8px;margin:12px 0}.scene-sequence-slots button{width:100%;border:2px dashed #91c6e9;border-radius:12px;min-height:49px;background:#f8fdff;color:#205982;font-size:15px}.scene-tile button{font-size:13px}.scene-translation-option{min-width:0}
`;document.head.append(styles);
function button(label,click,cls='scene-choice'){const b=document.createElement('button');b.type='button';b.className=cls;b.textContent=label;b.onclick=click;return b}
function add(parent,tag,text,cls){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;parent.append(e);return e}

function pictureSvg(kind){
const sky='<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#b7e9ff"/><stop offset="1" stop-color="#f5fcff"/></linearGradient><linearGradient id="ground" x2="0" y2="1"><stop stop-color="#9de5b2"/><stop offset="1" stop-color="#52b986"/></linearGradient></defs><rect width="640" height="360" rx="24" fill="url(#sky)"/><circle cx="534" cy="66" r="34" fill="#ffdd79"/><path d="M0 256Q160 216 320 256T640 244V360H0Z" fill="url(#ground)"/><path d="M0 292Q220 265 420 300T640 285" fill="none" stroke="#fff" stroke-width="6" opacity=".6"/><g fill="#fff" opacity=".85"><ellipse cx="98" cy="78" rx="65" ry="23"/><ellipse cx="132" cy="62" rx="36" ry="27"/><ellipse cx="380" cy="99" rx="58" ry="20"/></g>';
const cat='<g transform="translate(194 98)"><ellipse cx="150" cy="178" rx="125" ry="60" fill="#d6a27d"/><path d="M238 176Q328 132 294 90" stroke="#b17b59" stroke-width="27" stroke-linecap="round" fill="none"/><circle cx="116" cy="100" r="91" fill="#e4b28d"/><path d="M47 39L34 -29 100 7M142 9l66-38-8 85" fill="#e4b28d" stroke="#b57c5b" stroke-width="8" stroke-linejoin="round"/><path d="M53 11l-8-24 25 17M167 4l27-17-5 27" fill="#f4a8a4"/><ellipse cx="81" cy="103" rx="15" ry="24" fill="#293f51"/><ellipse cx="151" cy="103" rx="15" ry="24" fill="#293f51"/><circle cx="85" cy="95" r="6" fill="#fff"/><circle cx="155" cy="95" r="6" fill="#fff"/><path d="M109 127l17 0-9 10z" fill="#d77f7d"/><path d="M117 137q-16 23-32 3m32-3q16 23 32 3" stroke="#704e46" stroke-width="5" fill="none"/><path d="M38 130l-54-12m55 23l-57 10m194-21l58-12m-56 24l58 12" stroke="#805c4c" stroke-width="3"/><path d="M85 174l-5 52m101-51l10 52" stroke="#d6a27d" stroke-width="28" stroke-linecap="round"/></g>';
const car='<g transform="translate(95 114)"><ellipse cx="230" cy="183" rx="237" ry="30" fill="#388c95" opacity=".2"/><path d="M30 113h70l63-75q22-25 70-25h100q38 0 68 40l45 60h28q31 0 31 35v31H0v-34q0-32 30-32" fill="#328bdb" stroke="#1665a9" stroke-width="8"/><path d="M179 44h66v66H125Zm86 0h65l58 66H265Z" fill="#b9edff" stroke="#fff" stroke-width="6"/><circle cx="103" cy="180" r="46" fill="#263f5a"/><circle cx="103" cy="180" r="23" fill="#e4edf4"/><circle cx="394" cy="180" r="46" fill="#263f5a"/><circle cx="394" cy="180" r="23" fill="#e4edf4"/><rect x="23" y="123" width="57" height="21" rx="9" fill="#ffe8a4"/><rect x="440" y="123" width="35" height="21" rx="9" fill="#fca89a"/><path d="M142 135h192" stroke="#91d6ff" stroke-width="8" stroke-linecap="round"/></g>';
const butterfly='<g transform="translate(290 88)"><path d="M0 38Q-112-80-120 28Q-117 115 0 59Q117 115 120 28Q112-80 0 38" fill="#b38af5" stroke="#7655ba" stroke-width="7"/><path d="M0 56Q-92 66-75 133Q-18 158 0 75Q18 158 75 133Q92 66 0 56" fill="#ffbd73" stroke="#e48d55" stroke-width="6"/><ellipse cx="0" cy="57" rx="12" ry="57" fill="#624978"/><path d="M-4 15q-20-35-37-27m45 27q20-35 37-27" fill="none" stroke="#624978" stroke-width="5"/><circle cx="-64" cy="31" r="16" fill="#f6e3ff"/><circle cx="64" cy="31" r="16" fill="#f6e3ff"/></g><g transform="translate(70 165)"><circle cx="65" cy="40" r="40" fill="#f6caa3"/><path d="M23 26Q30-26 89 0l18 31" fill="#684d42"/><path d="M42 93h64l26 100H18Z" fill="#f25858"/><path d="M98 116l90-45" stroke="#f6caa3" stroke-width="20" stroke-linecap="round"/><circle cx="50" cy="41" r="5"/><circle cx="79" cy="41" r="5"/><path d="M50 60q16 17 33 0" fill="none" stroke="#a36555" stroke-width="4"/></g>';
return '<svg viewBox="0 0 640 360" role="img" aria-label="'+({cat:'草地上微笑的小猫',car:'阳光下的蓝色赛车',butterfly:'孩子在花园寻找蝴蝶'}[kind]||'儿童绘本场景')+'" xmlns="http://www.w3.org/2000/svg">'+sky+(kind==='cat'?cat:kind==='car'?car:butterfly)+'</svg>';
}

function art(root,emoji,caption){const a=add(root,'div',undefined,'scene-art');const kind=emoji.includes('🐱')?'cat':emoji.includes('🚙')?'car':emoji.includes('🦋')?'butterfly':null;if(kind){a.innerHTML=pictureSvg(kind);a.querySelector('svg').style.cssText='width:100%;max-height:260px;border-radius:17px;display:block';}else add(a,'div',emoji,'scene-emoji');add(a,'div',caption,'muted')}
function activityIllustration(kind){
 const base='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img"><defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="#99dfff"/><stop offset="1" stop-color="#f6faff"/></linearGradient></defs><rect width="640" height="360" rx="25" fill="url(#bg)"/><circle cx="530" cy="64" r="40" fill="#ffe48f"/><path d="M0 275Q130 238 320 276T640 260V360H0Z" fill="#85d99b"/><path d="M0 320Q260 293 640 324" stroke="#fff" stroke-width="10" fill="none"/>';
 const child='<g><circle cx="286" cy="124" r="51" fill="#f5c498" stroke="#d89472" stroke-width="4"/><path d="M235 121Q229 55 287 59Q349 65 337 121Q322 77 277 86Q255 104 235 121" fill="#70482f"/><circle cx="267" cy="121" r="6" fill="#2d354b"/><circle cx="304" cy="121" r="6" fill="#2d354b"/><path d="M273 146q18 14 32-2" stroke="#b46b61" stroke-width="4" fill="none"/><rect x="242" y="174" width="93" height="85" rx="28" fill="#fa6757"/><path d="M246 190L194 229M331 190l45 35" stroke="#f5c498" stroke-width="22" stroke-linecap="round"/>';
 const end='</svg>';
 if(kind==='running')return base+child+'<path d="M264 250l-67 57m110-57l79 50" stroke="#2a77b4" stroke-width="23" stroke-linecap="round"/><path d="M165 304h75m119 0h75" stroke="#283f54" stroke-width="15" stroke-linecap="round"/><path d="M95 168h85m-68 30h72m-53 32h51" stroke="#fff" stroke-width="12" stroke-linecap="round" opacity=".8"/></g>'+end;
 if(kind==='playing')return base+child+'<path d="M263 253l-28 62m71-62l33 62" stroke="#2a77b4" stroke-width="25" stroke-linecap="round"/></g><circle cx="442" cy="254" r="54" fill="#fff" stroke="#3d6db0" stroke-width="8"/><path d="M423 212l37 5 14 35-32 24-37-16z" fill="#34445e"/><path d="M395 265l30-10m38-8l25 20" stroke="#34445e" stroke-width="6"/>'+end;
 return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img"><rect width="640" height="360" rx="25" fill="#203762"/><circle cx="480" cy="78" r="48" fill="#fff3ba"/><circle cx="498" cy="66" r="41" fill="#203762"/><g fill="#fff8cf"><circle cx="100" cy="60" r="4"/><circle cx="178" cy="105" r="4"/><circle cx="540" cy="176" r="4"/><circle cx="370" cy="46" r="4"/></g><path d="M0 273Q200 235 420 279T640 260V360H0Z" fill="#2d6e77"/><path d="M156 310V134l135-78 137 78v176" fill="#f6b875" stroke="#d37b58" stroke-width="7"/><path d="M148 142l140-87 149 87" stroke="#a85258" stroke-width="22" stroke-linejoin="round" fill="none"/><rect x="257" y="200" width="74" height="110" fill="#704858"/><rect x="181" y="161" width="62" height="63" rx="6" fill="#fff1a3" stroke="#b16d51" stroke-width="8"/><rect x="355" y="161" width="48" height="63" rx="6" fill="#fff1a3" stroke="#b16d51" stroke-width="8"/><path d="M211 160v63m168-63v63" stroke="#b16d51" stroke-width="6"/></svg>';
}

function init(lesson,index,host,say,done){const task=(activities[lesson]||[])[index];if(!task){done({mode:'scene',correct:true,selected:'skip'});return}
add(host,'h3',task.prompt,'question');const msg=add(host,'div','','scene-message');let resolved=false;
function complete(ok,selected){if(resolved)return;resolved=true;msg.textContent=(ok?'🌟 恭喜你回答正确！ ':'💡 再记住这一句： ')+task.explain;if(task.type!=='fill')say(task.explain.split('.')[0]+'.','en-US',.62);if(task.type==='order'){const meaning=task.explain.slice(task.explain.indexOf('.')+1).trim();host.append(button('🔊 听中文句意讲解',()=>say('这句话的意思是：'+meaning,'zh-CN'),'button soft'));try{const u=new SpeechSynthesisUtterance('这句话的意思是：'+meaning);u.lang='zh-CN';u.rate=.85;speechSynthesis.speak(u)}catch(e){}}host.append(button('继续下一关 →',()=>done({mode:'scene-'+task.type,correct:ok,selected,expected:task.explain}),'button'))}
if(task.type==='fill'){
  add(host,'p','先自己读句子，选择缺少的词。提交前不播放完整英文，也不会透露答案。','muted');
  add(host,'div',task.template,'scene-template');
  const grid=add(host,'div',undefined,'scene-tile-grid');
  task.choices.forEach((word,i)=>{
    const b=button(word,()=>{
      if(resolved)return;
      grid.querySelectorAll('button').forEach(x=>x.disabled=true);
      const ok=i===task.correct, right=task.choices[task.correct];
      const reason=task.reasons&&task.reasons[word]?task.reasons[word]:(ok?'选择正确。':'这里应该选 '+right+'。');
      add(host,'p',(ok?'✅ 选对了！':'❌ 选错了，你选的是 '+word+'。正确答案是 '+right+'。')+' '+reason,'scene-message');
      const explanation=(ok?'为什么正确：':'为什么不对：')+reason;
      host.append(button('🔊 听老师讲解为什么',()=>say(explanation,'zh-CN'),'button soft'));
      host.append(button('🔊 听正确的完整英语句子',()=>say(task.say,'en-US',.6),'button soft'));
      host.append(button('🔊 听句子中文意思',()=>say(task.explain.slice(task.explain.indexOf('.')+1).trim(),'zh-CN'),'button soft'));
      // Give the explanation first, then read the now-revealed sentence as separate speech actions.
      say(explanation,'zh-CN');
      complete(ok,word);
    },'scene-tile');grid.append(b)
  });
}else if(task.type==='color'){
  add(host,'p','听英文描述，再挑选正确的颜色。','muted');
  const model=add(host,'div',task.item,'scene-art');model.style.fontSize='70px';
  host.append(button('🔊 听颜色指令',()=>say(task.say,'en-US',.6),'button soft'));
  const grid=add(host,'div',undefined,'scene-tile-grid');
  task.options.forEach((opt,i)=>{
    const cell=add(grid,'div',undefined);cell.style.minWidth='0';
    const choose=button('',()=>{if(resolved)return;grid.querySelectorAll('.scene-color-select').forEach(x=>x.disabled=true);complete(i===task.correct,opt[0])},'scene-tile scene-color-select');
    choose.style.width='100%';
    const swatch=add(choose,'span',' ','symbol');swatch.style.cssText='display:block;border:3px solid #ffffff;border-radius:50%;width:60px;height:60px;background:'+opt[1]+';box-shadow:0 2px 9px #27455d33';
    add(choose,'span',opt[0]);cell.append(choose);
    const hear=button('🔊 听中文',()=>say(opt[0],'zh-CN'),'button soft');hear.style.fontSize='13px';cell.append(hear);
  });
}else if(task.type==='sequence'){
  add(host,'p','先听三句英语，再按故事发生的顺序依次点选图片。','muted');
  host.append(button('🔊 慢速听完整小故事',()=>say(task.lines.map(x=>x[0]).join('  '),'en-US',.58),'button soft'));
  const selected=[],slots=add(host,'div',undefined,'scene-sequence-slots'),tiles=add(host,'div',undefined,'scene-tile-grid');
  const status=add(host,'p','已排列 0 / 3 幅','muted');
  const visualOrder=[1,2,0];
  function refresh(){
    slots.replaceChildren();
    selected.forEach((idx,pos)=>{
      slots.append(button((pos+1)+' · '+task.lines[idx][1]+' '+task.lines[idx][2],()=>{if(resolved)return;selected.splice(pos,1);refresh()},'scene-choice'));
    });
    const available=new Set(selected);
    tiles.querySelectorAll('[data-scene-index]').forEach(b=>b.disabled=available.has(Number(b.dataset.sceneIndex)));
    status.textContent='已排列 '+selected.length+' / 3 幅';
    submit.disabled=selected.length!==task.lines.length;
  }
  visualOrder.forEach(i=>{
    const card=add(tiles,'div',undefined);card.style.minWidth='0';
    const b=button('',()=>{if(resolved||selected.includes(i))return;selected.push(i);refresh()},'scene-tile');b.dataset.sceneIndex=i;
    add(b,'span',task.lines[i][1],'symbol');add(b,'span',task.lines[i][2]);card.append(b);
    card.append(button('🔊 听中文',()=>say(task.lines[i][2],'zh-CN'),'button soft'));
    card.append(button('🔊 慢速听英语',()=>say(task.lines[i][0],'en-US',.64),'button soft'));
  });
  const submit=button('✅ 检查故事顺序',()=>{if(resolved||selected.length!==task.lines.length)return;tiles.querySelectorAll('button').forEach(b=>b.disabled=true);complete(selected.every((x,i)=>x===i),selected.map(i=>task.lines[i][2]).join(' → '))},'button');
  submit.disabled=true;host.append(submit);refresh();
}else if(task.type==='shop'){
  add(host,'p','先听顾客的英文需求，然后从货架选择正确的商品。','muted');
  host.append(button('🔊 听购物需求',()=>say(task.say,'en-US',.6),'button soft'));
  const grid=add(host,'div',undefined,'scene-tile-grid');
  task.options.forEach((opt,i)=>{
    const cell=add(grid,'div',undefined);cell.style.minWidth='0';
    const choose=button('',()=>{if(resolved)return;grid.querySelectorAll('.scene-shop-select').forEach(x=>x.disabled=true);complete(i===task.correct,opt[1])},'scene-tile scene-shop-select');choose.style.width='100%';
    add(choose,'span',opt[0],'symbol');add(choose,'span',opt[1]);cell.append(choose);
    cell.append(button('🔊 听中文',()=>say(opt[1],'zh-CN'),'button soft'));
  });
}else if(task.type==='find'||task.type==='detect'){
 add(host,'p','先听英文，再点击对应的画面。可以重复播放。','muted');
 host.append(button('🔊 听英语线索',()=>say(task.say,'en-US',.6),'button soft scene-audio-play'));
 const grid=add(host,'div',undefined,'new-scene-grid');
 task.options.forEach((opt,i)=>{const label=opt[1],b=button('',()=>{if(resolved)return;grid.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(i===task.correct?'good':'bad');complete(i===task.correct,label)},'new-scene-card');const v=add(b,'span',opt[0],'visual');if(task.colors&&task.colors[i])v.style.filter='drop-shadow(0 4px 4px #0002)';if(task.type==='detect'&&opt[2])b.style.borderTop='8px solid '+({yellow:'#f1c846',blue:'#6dabed',red:'#ef8b7e',brown:'#a77b5b'}[opt[2]]||'#8bd4d9');add(b,'span',label);grid.append(b)});
}else if(task.type==='collect'){
 add(host,'p','听清楚要放进去几个。点「放入一个」收集，完成后检查。','muted');
 host.append(button('🔊 播放英语任务',()=>say(task.say,'en-US',.6),'button soft scene-audio-play'));
 const tray=add(host,'div',undefined,'collection-tray');add(tray,'strong','我的玩具盒');const items=add(tray,'div','（空）','collection-items');let n=0;
 const counter=add(tray,'div','已放入 0 个','muted');const controls=add(host,'div',undefined,'collection-controls');
 const addOne=button('＋ 放入一个',()=>{if(resolved||n>=task.max)return;n++;draw()},'button soft');
 const remove=button('－ 拿出一个',()=>{if(resolved||n<=0)return;n--;draw()},'button soft');
 function draw(){items.textContent=n?task.item.repeat(n):'（空）';counter.textContent='已放入 '+n+' 个';addOne.disabled=n>=task.max;remove.disabled=n===0}
 controls.append(addOne,remove);draw();
 host.append(button('✅ 检查数量',()=>{if(resolved)return;addOne.disabled=true;remove.disabled=true;complete(n===task.count,n+' 个')},'button'));
}else if(task.type==='choiceAudio'){
 add(host,'p','听完整句子，然后选择对应的中文意思。','muted');
 host.append(button('🔊 播放英文句子',()=>say(task.say,'en-US',.6),'button soft scene-audio-play'));
 const grid=add(host,'div');
 task.options.forEach((opt,i)=>{
   const group=add(grid,'div',undefined,'scene-translation-option');
   group.style.cssText='display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin:8px 0';
   const choose=button('选择：'+opt,()=>{if(resolved)return;grid.querySelectorAll('.scene-translation-select').forEach(x=>x.disabled=true);complete(i===task.correct,opt)});
   choose.classList.add('scene-translation-select');
   const hear=button('🔊 听中文',()=>say(opt,'zh-CN'),'button soft');
   hear.style.cssText='width:auto;min-width:103px;margin:0;padding:12px 8px;font-size:14px;background:#fff0bf;color:#6d4b12';
   group.append(choose,hear);
 });
}else if(task.type==='picture'||task.type==='listen'){
 if(task.type==='picture'){if(task.scene){const box=add(host,'div',undefined,'scene-art');box.innerHTML=activityIllustration(task.scene);box.querySelector('svg').style.cssText='width:100%;max-height:280px;border-radius:14px';}else art(host,task.emoji,task.caption);}
 else add(host,'p','请点击下面的英文播放按钮，再选择正确答案。','muted');
 const choices=add(host,'div');task.options.forEach((item,i)=>{const label=Array.isArray(item)?item[0]+' '+item[1]:item;const b=button(label,()=>{if(resolved)return;choices.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(i===task.correct?'good':'bad');complete(i===task.correct,label)});choices.append(b);if(Array.isArray(item)){const hear=button('🔊 听选项',()=>say(item[1],'zh-CN'),'button soft');hear.style.fontSize='14px';hear.style.padding='8px';choices.append(hear)}});
 if(task.type==='listen'){const listen=button('🔊 播放英文原句（点击听）',()=>say(task.say,'en-US',.6),'button soft');host.insertBefore(listen,choices);}
}else if(task.type==='order'){
 const tokens=task.tokens,chosen=[],chosenBox=add(host,'div',undefined,'steps'),pool=add(host,'div',undefined,'steps');add(host,'p','听一听，再点词块组成句子。正确句子会在检查后显示。','muted');host.append(button('🔊 听完整句子',()=>say(tokens.join(' ')+'.','en-US'),'button soft'));
 const submit=button('检查句子',()=>{if(chosen.length!==tokens.length||resolved)return;complete(chosen.every((x,i)=>x===i),chosen.map(i=>tokens[i]).join(' '))},'button');submit.disabled=true;
 tokens.map((_,i)=>i).reverse().forEach(i=>{const b=button(tokens[i],()=>{if(resolved)return;b.disabled=true;chosen.push(i);const c=button(tokens[i],()=>{if(resolved)return;chosen.splice(chosen.indexOf(i),1);c.remove();b.disabled=false;submit.disabled=chosen.length!==tokens.length},'chip selected');chosenBox.append(c);submit.disabled=chosen.length!==tokens.length},'chip');pool.append(b)});host.append(submit);
}else if(task.type==='route'){
 art(host,'🏎️ 🏁','听清方向，帮助赛车到达终点');host.append(button('🔊 再听指令',()=>say(task.say),'button soft'));
 const route=add(host,'div',undefined,'scene-route');const cells=[];for(let i=0;i<9;i++)cells.push(add(route,'div','·'));let pos=0;const target=4;const paint=()=>{cells.forEach((c,i)=>{c.textContent=i===pos?'🏎️':i===target?'🏁':'·';c.style.background=i===pos?'#fff0b0':'#e8f5ff'})};paint();
 const moves=[],arrows=add(host,'div',undefined,'scene-actions');[['up','⬆️'],['left','⬅️'],['down','⬇️'],['right','➡️']].forEach(([d,e])=>arrows.append(button(e,()=>{if(resolved)return;const row=Math.floor(pos/3),col=pos%3;let next=pos;if(d==='up'&&row>0)next-=3;if(d==='down'&&row<2)next+=3;if(d==='left'&&col>0)next--;if(d==='right'&&col<2)next++;moves.push(d);pos=next;paint();msg.textContent='第 '+moves.length+' 步 · 赛车已经移动';if(moves.length===task.moves.length){const ok=pos===target&&moves.every((x,i)=>x===task.moves[i]);arrows.querySelectorAll('button').forEach(b=>b.disabled=true);complete(ok,moves.join(' → '))}},'chip')));say(task.say);
}
}
window.V6EnglishScenes={has:lesson=>!!activities[lesson],render:init};
})();