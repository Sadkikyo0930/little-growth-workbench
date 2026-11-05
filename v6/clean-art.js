/* V6 clean illustrated screens — no floating status overlays on images.
   Real results are displayed in responsive blocks below each artwork.
   Preserves the existing localStorage keys, assessments and course progress. */
(function(){
'use strict';
const byId=id=>document.getElementById(id);
const styles=document.createElement('style');
styles.textContent=[
 '#home.clean-art-ready .home-artwork{aspect-ratio:3/4!important;background-size:100% 100%!important}',
 '#home.clean-art-ready .home-actual-overlay{display:none!important}',
 '#home.clean-art-ready #homeRealProgress{display:block!important;margin:10px 14px 18px!important}',
 '#home.clean-art-ready #goAssessment{left:4%!important;top:49%!important;width:44%!important;height:13%!important}',
 '#home.clean-art-ready #goLearning{left:51%!important;top:49%!important;width:45%!important;height:13%!important}',
 '#home.clean-art-ready #goRace{left:4%!important;top:71%!important;width:44%!important;height:13%!important}',
 '#home.clean-art-ready #goGarage{left:51%!important;top:71%!important;width:44%!important;height:13%!important}',
 '#home.clean-art-ready .image-tab{top:85%!important;height:14%!important}',
 '#assessment .clean-assessment{display:none;position:relative;width:100%;max-width:768px;margin:0 auto;aspect-ratio:3/4;overflow:hidden}',
 '#assessment.clean-art-ready .clean-assessment{display:block}',
 '#assessment.clean-art-ready>.main{display:none!important}',
 '#assessment .clean-assessment>img{display:block;width:100%;height:100%}',
 '#assessment .clean-assessment>button{position:absolute;border:0;background:transparent;color:transparent;font-size:0;cursor:pointer}',
 '#assessment .clean-assessment>button:focus-visible{outline:3px solid #ffda36;outline-offset:-3px}',
 '.clean-status-panel{margin:10px 14px 16px;padding:14px;border:2px solid #a5d5ef;border-radius:18px;background:linear-gradient(140deg,#e7f8ff,#fff);color:#184f82;box-shadow:0 5px 14px #1d73b51f}',
 '.clean-status-head{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:16px;font-weight:900}',
 '.clean-status-track{height:13px;border-radius:20px;background:#c7e3f6;overflow:hidden;margin:10px 0 12px}',
 '.clean-status-track>i{display:block;width:0;height:100%;background:linear-gradient(90deg,#ffdb54,#ffad24);border-radius:20px;transition:width .2s}',
 '.clean-subject-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
 '.clean-subject-grid button{padding:12px 8px;min-width:0;min-height:58px;border:1px solid #9ecce7;border-radius:13px;background:white;color:#145284;font-size:14px;font-weight:850;white-space:normal}',
 '.clean-subject-grid button:focus-visible{outline:3px solid #fdc948}',
 '@media(max-width:360px){.clean-subject-grid button{font-size:12px}}'
].join('\n');
document.head.appendChild(styles);
function load(path,onload){
 const img=new Image();img.onload=onload;img.onerror=()=>{};img.src=path+'?v=clean-assets-2';
}
load('./v6-home-clean.jpg',()=>{
 const art=document.querySelector('#home .home-artwork');
 if(!art)return;
 art.style.setProperty('background-image','url("./v6-home-clean.jpg")','important');
 // All transient chips and bars are deliberately removed from the art.
 art.querySelectorAll('.home-actual-overlay').forEach(el=>el.remove());
 byId('home').classList.add('clean-art-ready');
 if(typeof refreshHomeMode==='function')refreshHomeMode();
});
load('./v6-assessment-clean.jpg',()=>{
 const section=byId('assessment');if(!section)return;
 const holder=document.createElement('div');holder.className='clean-assessment';
 const img=document.createElement('img');img.src='./v6-assessment-clean.jpg';img.alt='四科知识探索地图';holder.appendChild(img);
 const subjects=[
  {id:'cn',name:'语文',x:8,y:12,w:35,h:19},
  {id:'ma',name:'数学',x:57,y:12,w:36,h:19},
  {id:'en',name:'英语',x:8,y:35,w:35,h:19},
  {id:'sc',name:'科学',x:57,y:35,w:36,h:19}
 ];
 function launch(id){
  if(typeof baselineSubjectDone==='function'&&baselineSubjectDone(id)){
   alert('该学科摸底已完成，成绩已保留。');return;
  }
  if(typeof start==='function')start(id);
 }
 subjects.forEach(sub=>{
  const hit=document.createElement('button');hit.type='button';
  hit.style.cssText='left:'+sub.x+'%;top:'+sub.y+'%;width:'+sub.w+'%;height:'+sub.h+'%';
  hit.setAttribute('aria-label','进入'+sub.name+'学科摸底');
  hit.onclick=()=>launch(sub.id);holder.appendChild(hit);
 });
 subjects.forEach((sub,i)=>{
  const hit=document.createElement('button');hit.type='button';
  hit.style.cssText='left:'+(7+i*23.5)+'%;top:69%;width:20%;height:14%';
  hit.setAttribute('aria-label','开始'+sub.name+'学科摸底');
  hit.onclick=()=>launch(sub.id);holder.appendChild(hit);
 });
 const panel=document.createElement('div');panel.className='clean-status-panel';
 panel.innerHTML='<div class="clean-status-head"><span>📚 四科学科摸底进度</span><span class="clean-total">0 / 4</span></div><div class="clean-status-track"><i class="clean-fill"></i></div><div class="clean-subject-grid"></div>';
 const grid=panel.querySelector('.clean-subject-grid');
 subjects.forEach(sub=>{
  const btn=document.createElement('button');btn.type='button';btn.dataset.subject=sub.id;
  btn.onclick=()=>launch(sub.id);grid.appendChild(btn);
 });
 function update(){
  let completed=0;
  subjects.forEach(sub=>{
   const done=typeof baselineSubjectDone==='function'&&baselineSubjectDone(sub.id);
   if(done)completed++;
   const records=(state.records||[]).filter(r=>r.subject===sub.id&&!r.learningDay&&!r.week&&!r.weeklyExam);
   const rate=records.length?Math.round(100*records.filter(r=>r.correct===true).length/records.length)+'%':null;
   const status=done?(rate?'已完成 · '+rate:'已完成'):records.length?'进行中':'未测评';
   const btn=grid.querySelector('[data-subject="'+sub.id+'"]');
   btn.textContent=sub.name+' · '+status;
  });
  panel.querySelector('.clean-total').textContent=completed+' / 4';
  panel.querySelector('.clean-fill').style.width=(completed*25)+'%';
 }
 section.insertBefore(holder,section.firstChild);
 holder.insertAdjacentElement('afterend',panel);
 section.classList.add('clean-art-ready');
 const oldHome=window.home;
 if(typeof oldHome==='function')window.home=function(){oldHome();update()};
 update();
});
})();