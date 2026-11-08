/* V6 clean art: fixed 768x1024 artwork coordinates, rendered in the SAME scalable SVG viewport.
   No loose CSS sticker positioning, no extra result panels.  Original saved data untouched. */
(function(){
'use strict';
const NS='http://www.w3.org/2000/svg';
const $=id=>document.getElementById(id);
const style=document.createElement('style');
style.textContent=[
'#home.clean-art-ready .home-artwork{aspect-ratio:3/4!important;background-size:100% 100%!important}',
'#home .home-actual-overlay{display:none!important}',
'#home #homeRealProgress{display:none!important}',
'#home.clean-art-ready #goAssessment{left:51%!important;top:49%!important;width:43%!important;height:13%!important}',
'#home.clean-art-ready #goLearning{left:5%!important;top:49%!important;width:44%!important;height:13%!important}',
'#home.clean-art-ready #goRace{left:4%!important;top:71%!important;width:44%!important;height:13%!important}',
'#home.clean-art-ready #goGarage{left:51%!important;top:71%!important;width:44%!important;height:13%!important}',
'#home.clean-art-ready .image-tab{top:85%!important;height:14%!important}',
'.v6-native-live{position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;overflow:visible}',
'#assessment .clean-assessment{display:none;position:relative;width:100%;max-width:768px;margin:0 auto;aspect-ratio:3/4;overflow:hidden}',
'#assessment.clean-art-ready .clean-assessment{display:block}',
'#assessment.clean-art-ready>.main{display:none!important}',
'#assessment .clean-assessment>img{display:block;width:100%;height:100%}',
'#assessment .clean-assessment>button{position:absolute;z-index:3;border:0;background:transparent;color:transparent;font-size:0;cursor:pointer}',
'#assessment .clean-assessment>button:focus-visible{outline:3px solid #ffdc36;outline-offset:-3px}'
].join('\n');
document.head.appendChild(style);
function load(path,run){const i=new Image();i.onload=run;i.onerror=()=>{};i.src=path+'?v=clean-art-viewport3'}
function svg(tag,attrs,parent){
 const node=document.createElementNS(NS,tag);
 Object.entries(attrs||{}).forEach(([k,v])=>node.setAttribute(k,String(v)));
 if(parent)parent.appendChild(node);
 return node;
}
function surface(parent){return svg('svg',{viewBox:'0 0 768 1024',preserveAspectRatio:'none',class:'v6-native-live','aria-hidden':'true'},parent)}
function bar(surface,x,y,w,h,stroke){
 svg('rect',{x,y,width:w,height:h,rx:h/2,fill:'#06408b',opacity:'.92'},surface);
 const fill=svg('rect',{x,y,width:0,height:h,rx:h/2,fill:'#ffc83c'},surface);
 return percentage=>fill.setAttribute('width',String(Math.max(0,Math.min(100,percentage))*w/100));
}
function label(surface,x,y,size,initial){
 const el=svg('text',{x,y,'text-anchor':'middle','dominant-baseline':'middle','font-size':size,'font-weight':900,fill:'#ffffff',stroke:'#16528b','stroke-width':2,'paint-order':'stroke',style:'font-family:system-ui,-apple-system,"PingFang SC",sans-serif'},surface);
 el.textContent=initial;return el;
}
function baseline(id){
 if(typeof baselineSubjectDone==='function')return !!baselineSubjectDone(id);
 return id==='cn'?['py','hz','gs'].every(k=>state.finished&&state.finished['cn_'+k]):!!(state.finished&&state.finished[id]);
}
function records(id){return (state.records||[]).filter(r=>r.subject===id&&!r.learningDay&&!r.week&&!r.weeklyExam)}
const refreshCallbacks=[];
window.v6CleanArtRefresh=function(){refreshCallbacks.forEach(fn=>fn())};
// v6-home-no-overlays-v1: preserve original clean illustration and transparent hit targets.
load('./v6-home-clean.jpg',()=>{
 const home=$('home');
 const artwork=document.querySelector('#home .home-artwork');
 if(!home||!artwork)return;
 artwork.style.setProperty('background-image','url("./v6-home-clean.jpg")','important');
 artwork.querySelectorAll('.home-actual-overlay').forEach(node=>node.remove());
 artwork.querySelectorAll('.v6-native-live').forEach(node=>node.remove());
 home.classList.add('clean-art-ready');
});
load('./v6-assessment-clean.jpg',()=>{
 const section=$('assessment');if(!section)return;
 const holder=document.createElement('div');holder.className='clean-assessment';
 const img=document.createElement('img');img.src='./v6-assessment-clean.jpg';img.alt='语文、数学、英语、科学四座学习岛';holder.appendChild(img);
 const overlay=surface(holder);
 const entries=[
  {id:'cn',name:'语文',hit:[8,12,35,19],label:[240,272]},
  {id:'ma',name:'数学',hit:[57,12,36,19],label:[605,272]},
  {id:'en',name:'英语',hit:[8,35,35,19],label:[240,488]},
  {id:'sc',name:'科学',hit:[57,35,36,19],label:[605,488]}
 ];
 const metrics={};
 entries.forEach(item=>{metrics[item.id]=label(overlay,item.label[0],item.label[1],18,'未测评')});
 // Bottom bar x=184-555, bottom-right star value.
 const totalFill=bar(overlay,187,916,367,22);
 const total=label(overlay,666,925,23,'0/4');
 const launch=id=>{
  if(baseline(id)){alert('该学科摸底已完成，原有成绩保留。');return}
  if(typeof start==='function')start(id);
 };
 entries.forEach((item,i)=>{
  const btn=document.createElement('button');btn.type='button';
  btn.style.cssText='left:'+item.hit[0]+'%;top:'+item.hit[1]+'%;width:'+item.hit[2]+'%;height:'+item.hit[3]+'%';
  btn.setAttribute('aria-label','进入'+item.name+'摸底');btn.onclick=()=>launch(item.id);holder.appendChild(btn);
  const low=document.createElement('button');low.type='button';
  low.style.cssText='left:'+(7+i*23.5)+'%;top:69%;width:20%;height:14%';
  low.setAttribute('aria-label','开始'+item.name+'摸底');low.onclick=()=>launch(item.id);holder.appendChild(low);
 });
 function update(){
  let completed=0;
  entries.forEach(item=>{
   const done=baseline(item.id),recs=records(item.id);if(done)completed++;
   const percent=recs.length?Math.round(100*recs.filter(r=>r.correct===true).length/recs.length):null;
   metrics[item.id].textContent=done?(percent===null?'已完成':percent+'%'):recs.length?'进行中':'未测评';
  });
  total.textContent=completed+'/4';totalFill(completed*25);
 }
 refreshCallbacks.push(update);
 section.insertBefore(holder,section.firstChild);section.classList.add('clean-art-ready');update();
});
})();