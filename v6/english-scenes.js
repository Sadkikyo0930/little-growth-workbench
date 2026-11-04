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
]};
const styles=document.createElement('style');styles.textContent=`
.scene-art{min-height:180px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;border-radius:22px;background:linear-gradient(145deg,#e1f8ff,#fff6d9);border:3px solid #fff;box-shadow:0 6px 15px #2c75a51b;margin:12px 0;padding:15px}
.scene-emoji{font-size:76px;line-height:1.5}.scene-choice{width:100%;border:2px solid #acd3eb;background:#f5fbff;color:#204c76;border-radius:15px;padding:15px;margin:5px 0;font-size:18px;font-weight:800;text-align:left}
.scene-choice:disabled{opacity:.8}.scene-choice.good{background:#d5f6e4;border-color:#3cbb85}.scene-choice.bad{background:#fff0e8;border-color:#ef9779}
.scene-message{font-size:17px;font-weight:800;line-height:1.65;color:#285b80;min-height:30px;margin:10px 0}
.scene-route{display:grid;grid-template-columns:repeat(3,68px);gap:6px;justify-content:center;margin:15px auto}.scene-route div{height:62px;border-radius:13px;background:#e8f5ff;display:flex;align-items:center;justify-content:center;font-size:34px;border:2px solid #c5e0f3}
.scene-actions{display:flex;flex-wrap:wrap;gap:9px;justify-content:center}.scene-actions button{border:0;border-radius:13px;background:#dbeeff;color:#174e83;font-size:23px;font-weight:800;padding:12px 16px}
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
function init(lesson,index,host,say,done){const task=(activities[lesson]||[])[index];if(!task){done({mode:'scene',correct:true,selected:'skip'});return}
const msg=add(host,'div','','scene-message');let resolved=false;
function complete(ok,selected){if(resolved)return;resolved=true;msg.textContent=(ok?'🌟 恭喜你回答正确！ ':'💡 再记住这一句： ')+task.explain;say(task.explain.split('.')[0]+'.');host.append(button('继续下一关 →',()=>done({mode:'scene-'+task.type,correct:ok,selected,expected:task.explain}),'button'))}
if(task.type==='picture'||task.type==='listen'){
 if(task.type==='picture')art(host,task.emoji,task.caption);
 else host.append(button('🔊 听英语指令',()=>say(task.say),'button soft'));
 const choices=add(host,'div');task.options.forEach((item,i)=>{const label=Array.isArray(item)?item[0]+' '+item[1]:item;const b=button(label,()=>{if(resolved)return;choices.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(i===task.correct?'good':'bad');complete(i===task.correct,label)});choices.append(b);if(Array.isArray(item)){const hear=button('🔊 听选项',()=>say(item[1],'zh-CN'),'button soft');hear.style.fontSize='14px';hear.style.padding='8px';choices.append(hear)}});
 if(task.type==='listen')say(task.say);
}else if(task.type==='order'){
 const tokens=task.tokens,chosen=[],chosenBox=add(host,'div',undefined,'steps'),pool=add(host,'div',undefined,'steps');add(host,'p','点词块组成句子，再点击检查。','muted');
 const submit=button('检查句子',()=>{if(chosen.length!==tokens.length||resolved)return;complete(chosen.every((x,i)=>x===i),chosen.map(i=>tokens[i]).join(' '))},'button');submit.disabled=true;
 tokens.map((_,i)=>i).reverse().forEach(i=>{const b=button(tokens[i],()=>{if(resolved)return;b.disabled=true;chosen.push(i);const c=button(tokens[i],()=>{if(resolved)return;chosen.splice(chosen.indexOf(i),1);c.remove();b.disabled=false;submit.disabled=chosen.length!==tokens.length},'chip selected');chosenBox.append(c);submit.disabled=chosen.length!==tokens.length},'chip');pool.append(b)});host.append(submit);
}else if(task.type==='route'){
 art(host,'🏎️ 🏁','听清方向，帮助赛车到达终点');host.append(button('🔊 再听指令',()=>say(task.say),'button soft'));
 const route=add(host,'div',undefined,'scene-route');for(let i=0;i<9;i++)add(route,'div',i===0?'🏎️':i===7?'🏁':'·');
 const moves=[],arrows=add(host,'div',undefined,'scene-actions');[['up','⬆️'],['left','⬅️'],['down','⬇️'],['right','➡️']].forEach(([d,e])=>arrows.append(button(e,()=>{if(resolved)return;moves.push(d);msg.textContent='已走 '+moves.length+' 步';if(moves.length===task.moves.length){const ok=moves.every((x,i)=>x===task.moves[i]);complete(ok,moves.join(' → '))}},'chip')));say(task.say);
}
}
window.V6EnglishScenes={has:lesson=>!!activities[lesson],render:init};
})();