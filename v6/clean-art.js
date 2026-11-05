(function(){
"use strict";
const $=id=>document.getElementById(id);
const css=[
'#home.clean-art-ready .home-artwork{aspect-ratio:3/4!important;background-size:100% 100%!important}',
'#home.clean-art-ready .home-actual-overlay{display:none!important}',
'#home.clean-art-ready .home-progress-mask{display:flex!important;left:25.5%!important;top:64.5%!important;width:38.5%!important;height:2.6%!important;border:0!important;background:transparent!important}',
'#home.clean-art-ready .home-progress-mask i{background:linear-gradient(90deg,#ffda49,#ffaa25)!important}',
'#home.clean-art-ready #homeArtLearning{display:flex!important;left:28%!important;top:55.3%!important;width:21%!important;height:2.6%!important}',
'#home.clean-art-ready #homeArtStar{display:flex!important;left:74%!important;top:64.4%!important;width:12%!important;height:2.8%!important}',
'#home.clean-art-ready #goAssessment{left:5%!important;top:49%!important;width:43%!important;height:14%!important}',
'#home.clean-art-ready #goLearning{left:51%!important;top:49%!important;width:44%!important;height:14%!important}',
'#home.clean-art-ready #goRace{left:4%!important;top:71%!important;width:44%!important;height:13%!important}',
'#home.clean-art-ready #goGarage{left:51%!important;top:71%!important;width:44%!important;height:13%!important}',
'#home.clean-art-ready .image-tab{top:85%!important;height:14%!important}',
'#assessment .clean-assessment{display:none;position:relative;width:100%;max-width:768px;margin:0 auto;aspect-ratio:3/4;overflow:hidden}',
'#assessment.clean-art-ready .clean-assessment{display:block}',
'#assessment.clean-art-ready>.main{display:none!important}',
'#assessment .clean-assessment img{display:block;width:100%;height:100%}',
'#assessment .clean-assessment button{position:absolute;border:0;background:transparent;color:transparent;font-size:0;cursor:pointer}',
'#assessment .clean-assessment button:focus-visible{outline:3px solid #ffda36}',
'#assessment .clean-status{position:absolute;pointer-events:none;color:white;font-size:clamp(10px,2.5vw,18px);font-weight:900;text-shadow:0 1px 3px #124477;transform:translate(-50%,-50%);white-space:nowrap}'
].join('\n');
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
function load(src,done){const img=new Image();img.onload=()=>done(img);img.onerror=()=>{};img.src=src+'?v=clean-assets-1'}
load('./v6-home-clean.jpg',()=>{
 const art=document.querySelector('#home .home-artwork');if(!art)return;
 art.style.setProperty('background-image','url("./v6-home-clean.jpg")','important');
 $('home').classList.add('clean-art-ready');
 if(typeof refreshHomeMode==='function')refreshHomeMode();
});
load('./v6-assessment-clean.jpg',()=>{
 const section=$('assessment');if(!section)return;
 const holder=document.createElement('div');holder.className='clean-assessment';
 const img=document.createElement('img');img.src='./v6-assessment-clean.jpg';img.alt='四科知识探索地图';holder.appendChild(img);
 const positions={cn:[8,12,35,19,29,26],ma:[57,12,36,19,77,26],en:[8,35,35,19,29,48],sc:[57,35,36,19,77,48]};
 function update(){
  let finished=0;
  Object.entries(positions).forEach(([id])=>{
   const done=typeof baselineSubjectDone==='function'&&baselineSubjectDone(id);if(done)finished++;
   const records=(state.records||[]).filter(r=>r.subject===id&&!r.learningDay&&!r.week&&!r.weeklyExam);
   const rate=records.length?Math.round(100*records.filter(r=>r.correct===true).length/records.length)+'%':null;
   const span=holder.querySelector('[data-status="'+id+'"]');
   span.textContent=done?(rate||'已完成'):records.length?'进行中':'未测评';
  });
  holder.querySelector('.clean-total').textContent=finished+'/4';
  holder.querySelector('.clean-fill').style.width=finished*25+'%';
 }
 Object.entries(positions).forEach(([id,p])=>{
  const button=document.createElement('button');button.type='button';
  button.style.cssText='left:'+p[0]+'%;top:'+p[1]+'%;width:'+p[2]+'%;height:'+p[3]+'%';
  button.setAttribute('aria-label','进入'+id+'学科摸底');
  button.onclick=()=>{if(baselineSubjectDone(id))alert('该学科摸底已完成，成绩保留');else start(id)};
  holder.appendChild(button);
  const label=document.createElement('span');label.className='clean-status';label.dataset.status=id;
  label.style.cssText='left:'+p[4]+'%;top:'+p[5]+'%';holder.appendChild(label);
 });
 ['cn','ma','en','sc'].forEach((id,i)=>{
  const button=document.createElement('button');button.type='button';
  button.style.cssText='left:'+(7+i*23.5)+'%;top:69%;width:20%;height:14%';
  button.setAttribute('aria-label','开始'+id+'摸底');
  button.onclick=()=>{if(baselineSubjectDone(id))alert('该学科摸底已完成，成绩保留');else start(id)};
  holder.appendChild(button);
 });
 const total=document.createElement('span');total.className='clean-status clean-total';
 total.style.cssText='left:92%;top:88%';holder.appendChild(total);
 const track=document.createElement('div');track.style.cssText='position:absolute;left:25%;top:87%;width:58%;height:2.1%;pointer-events:none';
 const fill=document.createElement('div');fill.className='clean-fill';fill.style.cssText='height:100%;width:0;background:linear-gradient(90deg,#ffda4d,#ffb223);border-radius:20px';
 track.appendChild(fill);holder.appendChild(track);
 section.insertBefore(holder,section.firstChild);section.classList.add('clean-art-ready');
 const old=window.home;if(typeof old==='function')window.home=function(){old();update()};
 update();
});
})();