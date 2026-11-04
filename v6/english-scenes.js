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
function art(root,emoji,caption){const a=add(root,'div',undefined,'scene-art');add(a,'div',emoji,'scene-emoji');add(a,'div',caption,'muted')}
function init(lesson,index,host,say,done){const task=(activities[lesson]||[])[index];if(!task){done({mode:'scene',correct:true,selected:'skip'});return}
const msg=add(host,'div','','scene-message');let resolved=false;
function complete(ok,selected){if(resolved)return;resolved=true;msg.textContent=(ok?'🌟 恭喜你回答正确！ ':'💡 再记住这一句： ')+task.explain;say(task.explain.split('.')[0]+'.');host.append(button('继续下一关 →',()=>done({mode:'scene-'+task.type,correct:ok,selected,expected:task.explain}),'button'))}
if(task.type==='picture'||task.type==='listen'){
 if(task.type==='picture')art(host,task.emoji,task.caption);
 else host.append(button('🔊 听英语指令',()=>say(task.say),'button soft'));
 const choices=add(host,'div');task.options.forEach((item,i)=>{const label=Array.isArray(item)?item[0]+' '+item[1]:item;const b=button(label,()=>{if(resolved)return;choices.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(i===task.correct?'good':'bad');complete(i===task.correct,label)});choices.append(b)});
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