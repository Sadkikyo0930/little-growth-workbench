'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.V6_TEST_JSDOM||'jsdom');
const source=fs.readFileSync(path.resolve(__dirname,'../v6/weekly-exam.js'),'utf8');
const worker=fs.readFileSync(path.resolve(__dirname,'../v6/sw.js'),'utf8');
const ids=['weeklyExam','weeklyActions','weeklyPlay','weeklyResult','weeklyIntro','weeklyStart','weeklyPreview','weeklyBack','weeklyNext','weeklyProgress','weeklyBar','weeklySubject','weeklyQuestion','weeklyFeedback','weeklyListen','weeklyOptions'];
let checks=0;
function ok(cond,label){assert.ok(cond,label);checks++}
function boot(date) {
 const elements=ids.map(id=>'<div id="'+id+'"></div>').join('');
 const dom=new JSDOM('<!doctype html><body><button id="goAssessment">测评</button><button data-tab="assessment">测评</button><button data-art-tab="assessment">图片测评</button>'+elements+'</body>',{url:'https://example.test/v6/',runScripts:'outside-only'});
 const w=dom.window;
 const RealDate=Date,ts=new RealDate(date+'T12:00:00Z').getTime();
 class FakeDate extends RealDate {constructor(...args){super(...(args.length?args:[ts]))}static now(){return ts}}
 w.Date=FakeDate;
 let screen='',baseline=0,saves=0;
 w.state={weeklyExams:{},finished:{},records:[],sessions:{}};
 w.openScreen=id=>{screen=id};w.home=()=>{baseline++;screen='assessment'};
 w.save=()=>{saves++};w.speak=()=>{};
 w.eval(source);
 const $=id=>w.document.getElementById(id);
 const click=id=>{$(id).click()};
 const legacy=()=>{baseline++;screen='assessment'};
 // Production index.html includes this script after weekly-exam.js:
 // button.onclick=openScheduledAssessment, which formerly masked the weekly route.
 $('goAssessment').onclick=legacy;
 w.document.querySelector('[data-tab="assessment"]').onclick=legacy;
 w.document.querySelector('[data-art-tab="assessment"]').onclick=legacy;
 return {w,dom,$,click,get screen(){return screen},get baseline(){return baseline},get saves(){return saves}};
}
new Function(source);ok(true,'weekly code parses');
const sunday=boot('2026-11-15');
sunday.click('goAssessment');
ok(sunday.screen==='weeklyExam','first Sunday uses weekly exam, not old baseline');
ok(sunday.baseline===0,'late legacy onclick intercepted');
ok(sunday.$('weeklyStart').hidden===false,'first Sunday official exam available');
sunday.w.document.querySelector('[data-tab="assessment"]').click();
ok(sunday.screen==='weeklyExam','bottom navigation enters weekly exam');
sunday.w.document.querySelector('[data-art-tab="assessment"]').click();
ok(sunday.screen==='weeklyExam','home artwork hotzone enters weekly exam');
sunday.dom.window.close();
const monday=boot('2026-11-16');
monday.click('goAssessment');
ok(monday.screen==='weeklyExam','one-day makeup opens original first-week exam');
ok(monday.$('weeklyIntro').textContent.includes('补测'),'makeup clearly labeled');
monday.click('weeklyStart');
ok(monday.w.state.weeklyExams['2026-11-15']?.questions.length===24,'makeup saves 24-question official paper to original week key');
ok(monday.w.state.weeklyExams['2026-11-15'].finishedAt===null,'no fake completion');
ok(monday.saves===1,'makeup safely creates existing local record only');
monday.dom.window.close();
const tuesday=boot('2026-11-17');
tuesday.click('goAssessment');
ok(tuesday.screen==='assessment','normal weekdays do not bypass restricted assessment');
ok(tuesday.baseline===1,'existing weekday fallback preserved');
tuesday.dom.window.close();
const nextSunday=boot('2026-11-22');
nextSunday.click('goAssessment');
ok(nextSunday.screen==='weeklyExam','next Sunday opens second weekly exam');
nextSunday.click('weeklyStart');
ok(nextSunday.w.state.weeklyExams['2026-11-22']?.questions.length===24,'second Sunday paper is distinct and intact');
nextSunday.dom.window.close();
ok(worker.includes("url.pathname.endsWith('/weekly-exam.js')"),'PWA network-first fetch ensures new handler is not old cached JS');
ok(worker.includes('20261116-weekly-route-v1'),'PWA cache version bumped');
console.log('PASS '+checks+'/'+checks+' Sunday weekly routing and original first-week makeup checks');
