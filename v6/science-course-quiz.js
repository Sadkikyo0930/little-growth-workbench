(()=>{'use strict';
const qs=new URLSearchParams(location.search),lesson=Number(qs.get('lesson')||1);
const root=document.querySelector('main');
if(!root||!Number.isInteger(lesson)||lesson<1||lesson>9)return;
let quizStarted=false,idx=0,score=0,answers=[],locked=false;
const panel=document.createElement('section');
panel.className='panel hidden';panel.id='scienceFinalQuiz';
panel.style.cssText='border:3px solid #8bcbd8;box-shadow:0 8px 22px #3c7a8a19';
root.insertBefore(panel,root.querySelector('main > .muted'));
function voice(t){if(!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.lang='zh-CN';u.rate=.86;window.speechSynthesis.speak(u);}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function key(){return qs.get('cohort')==='20261109'?'v6_science_course_20261109_progress_v1':'v6_science_preview_progress_v1';}
window.scienceExperimentFinished=function(n){
 if(Number(n)!==lesson)return;
 quizStarted=true;idx=0;score=0;answers=[];locked=false;
 panel.classList.remove('hidden');render();
 panel.scrollIntoView({behavior:'smooth',block:'start'});
 voice('实验完成啦！现在来挑战五道科学观察题。点击听题目，也可以点击选项旁的喇叭。');
};
function render(){
 const data=window.V6_SCIENCE_LESSONS;
 if(!Array.isArray(data)||!data[lesson-1]){panel.innerHTML='<p>科学题库加载失败，请刷新课程再试。</p>';return;}
 const questions=data[lesson-1][5],q=questions[idx];
 if(!q){finish();return;}
 locked=false;
 panel.innerHTML='<span class="pill">实验完成 · 科学闯关 '+(idx+1)+' / '+questions.length+'</span><div class="progress" style="margin:13px 0"><i style="width:'+(idx/questions.length*100)+'%"></i></div><h2>🔬 '+esc(q[0])+'</h2><button class="action" id="sqRead">🔊 听题目</button><div class="answers" id="sqAnswers"></div><div class="feedback" id="sqFeedback" aria-live="polite"></div><button class="action next hidden" id="sqNext">'+(idx===questions.length-1?'🏆 查看科学成绩':'下一题 →')+'</button>';
 panel.querySelector('#sqRead').onclick=()=>voice(q[0]);
 const box=panel.querySelector('#sqAnswers');
 q.slice(1,4).forEach((v,i)=>{
 const row=document.createElement('div');row.style.cssText='display:flex;gap:7px;align-items:stretch';
 const btn=document.createElement('button');btn.textContent=String.fromCharCode(65+i)+' · '+v;btn.style.flex='1';btn.onclick=()=>choose(i);
 const hear=document.createElement('button');hear.textContent='🔊';hear.setAttribute('aria-label','朗读选项'+(i+1));hear.style.cssText='flex:0 0 56px;padding:8px';hear.onclick=()=>voice(v);
 row.append(btn,hear);box.append(row);
 });
 panel.querySelector('#sqNext').onclick=()=>{idx++;render();};
 function choose(i){if(locked)return;locked=true;const ok=i===q[4];score+=ok?1:0;answers.push({question:q[0],selected:i,correctIndex:q[4],correct:ok});
 box.querySelectorAll('div').forEach((r,k)=>{const b=r.querySelector('button');b.disabled=true;if(k===q[4])b.classList.add('correct');else if(k===i)b.classList.add('wrong')});
 const right=q[1+q[4]];
 panel.querySelector('#sqFeedback').textContent=ok?'🌟 恭喜你回答正确！':'💡 哦哦，正确答案是：'+right;
 panel.querySelector('#sqNext').classList.remove('hidden');voice(ok?'恭喜你回答正确':'哦哦，正确答案是'+right);
 }
}
function finish(){
 const at=new Date().toISOString(),payload={experiment:true,quizComplete:true,correct:score,total:answers.length,answers,at};
 try{const old=JSON.parse(localStorage.getItem(key())||'{}');old[lesson]={...(old[lesson]||{}),...payload};localStorage.setItem(key(),JSON.stringify(old))}catch(e){}
 if(qs.get('cohort')==='20261109'&&window.parent!==window){
 window.parent.postMessage({type:'v6-science-lesson-complete',cohort:'20261109',lesson,quizComplete:true,correct:score,total:answers.length,answers},location.origin);
 }
 panel.innerHTML='<h2>🏆 科学探索完成！</h2><p style="font-size:22px">答对 '+score+' / '+answers.length+' 题</p><p>今天做到了：大胆猜想、动手观察、认真回答。答错也能从实验中学到新发现！</p><button class="action" id="sqReplay">🔁 再练习五道题</button>';
 panel.querySelector('#sqReplay').onclick=()=>window.scienceExperimentFinished(lesson);
 voice('今天的科学探索完成啦！你答对了'+score+'道题，真棒！');
}
})();