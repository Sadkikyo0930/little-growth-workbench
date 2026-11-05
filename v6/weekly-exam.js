(function(){
'use strict';
const SUBJECTS={cn:'语文',ma:'数学',en:'英语',sc:'科学'};
const QUESTIONS={
cn:[
['“春眠不觉晓”的下一句是什么？',['处处闻啼鸟','低头思故乡','白日依山尽'],0,'《春晓》描写春天，下一句是“处处闻啼鸟”。'],
['哪一个字表示河流的“河”？',['何','河','可'],1,'“河”有三点水，通常与水有关。'],
['“山”字一共有几画？',['三画','四画','五画'],0,'山：竖、竖折、竖，一共三画。'],
['“床前明月光”的下一句是？',['疑是地上霜','举头望明月','处处闻啼鸟'],0,'这是李白《静夜思》中的句子。'],
['下面哪一组都是整体认读音节？',['zhi、chi、shi','ba、pa、ma','ai、ei、ui'],0,'zhi、chi、shi 都是整体认读音节。'],
['哪一个词描写的是天气？',['晴朗','书包','铅笔'],0,'晴朗是天空晴好、云少的天气。'],
['小松鼠把松果藏起来，是为了冬天有食物。它为什么藏松果？',['为冬天准备食物','为了装饰房子','为了送给河流'],0,'阅读时要找到表示原因的句子。'],
['“日”字加上一横可以变成哪个字？',['目','月','木'],0,'“目”比“日”多一条内部横线。'],
['“白日依山尽”出自哪首古诗？',['登鹳雀楼','咏鹅','春晓'],0,'这是王之涣的《登鹳雀楼》。'],
['“小明先穿鞋，再出门。”他先做什么？',['穿鞋','出门','吃饭'],0,'“先”表示第一步，“再”表示下一步。'],
['拼音“ong”属于哪一类韵母？',['后鼻韵母','单韵母','前鼻韵母'],0,'ong 是后鼻韵母。'],
['哪个词和“高兴”的意思最接近？',['开心','难过','害怕'],0,'高兴和开心都表示愉快。']
],
ma:[
['8＋5＝？',['12','13','14'],1,'先算8＋2＝10，再加3＝13。'],
['15－7＝？',['7','8','9'],1,'15－5＝10，再减2＝8。'],
['下面哪个数最大？',['17','19','16'],1,'十位相同时比较个位，9最大。'],
['5个苹果分给小红2个，还剩几个？',['2','3','4'],1,'用减法：5－2＝3。'],
['9＋6＝？',['14','15','16'],1,'9＋1凑成10，再加5是15。'],
['20比17多几？',['2','3','4'],1,'20－17＝3。'],
['一个正方形有几条边？',['3条','4条','5条'],1,'正方形有四条相等的边。'],
['10里面有几个一？',['1个','10个','100个'],1,'10个一组成一个十。'],
['排队时小红前面有3人，后面有4人，一共有几人？',['7人','8人','9人'],1,'前面3人＋自己1人＋后面4人＝8人。'],
['12＋4＝？',['15','16','17'],1,'12再往后数4个数是16。'],
['18－9＝？',['8','9','10'],1,'18减去9等于9。'],
['哪个算式结果等于11？',['6＋5','7＋5','8＋5'],0,'6＋5＝11。']
],
en:[
['选出“苹果”的英语单词。',['apple','table','pencil'],0,'apple 表示苹果，读作 apple。'],
['选出“我”的英语单词。',['you','I','we'],1,'I 表示“我”，是常见高频词。'],
['选出“太阳”的英语单词。',['sun','cat','run'],0,'sun 是太阳；cat 是猫；run 是跑。'],
['选出句子“I can run.”的中文意思。',['我会跑。','我有一支笔。','我喜欢苹果。'],0,'I can run. 表示“我会跑”。'],
['哪一个单词包含拼读块“at”？',['cat','cup','dog'],0,'cat 可以拆成 c + at。'],
['选出“我们”的英语单词。',['they','we','he'],1,'we 表示我们。'],
['选出“夜晚”的英语单词。',['night','light','right'],0,'night 是夜晚，含 ight 拼读块。'],
['选择正确的短句：我有一只猫。',['I have a cat.','I am a cat.','You can run.'],0,'I have a cat. 表示“我有一只猫”。'],
['选出“出去”的英语单词。',['out','our','on'],0,'out 表示出去；our 表示我们的。'],
['选出“我们的”的英语单词。',['out','our','are'],1,'our 表示“我们的”，不能与 out 混淆。'],
['选出含有“sh”拼读块的单词。',['ship','thin','cat'],0,'ship 中 sh 发 /ʃ/ 音。'],
['哪个单词的意思是“好的”？',['good','get','go'],0,'good 表示好的；get 表示得到。']
],
sc:[
['植物生长通常需要什么？',['阳光和水','塑料袋','遥控器'],0,'植物通常需要水、阳光、空气等。'],
['冰放在温暖的屋里会怎样？',['融化成水','变成木头','永远不变'],0,'冰吸热后会融化。'],
['我们用什么器官听声音？',['耳朵','鼻子','眼睛'],0,'耳朵主要帮助我们听见声音。'],
['白天照亮地球的主要自然光源是什么？',['太阳','月亮','电灯'],0,'太阳是地球最主要的自然光源。'],
['水烧开后冒出的水蒸气属于什么状态？',['气态','固态','粉末'],0,'水蒸气是气态水。'],
['哪种行为更节约水？',['刷牙时关水龙头','让水一直流','用水玩一整天'],0,'不需要用水时及时关水龙头。'],
['植物的根通常有什么作用？',['吸收水和固定植物','产生灯光','发出音乐'],0,'根帮助吸收水分并固定植物。'],
['雨后地面上的小水洼逐渐消失，主要因为什么？',['蒸发','变成石头','被太阳吃掉'],0,'液态水可以蒸发进入空气。'],
['磁铁通常能吸住哪一种东西？',['铁钉','纸片','木块'],0,'常见铁钉可被磁铁吸引。'],
['影子通常出现在什么情况下？',['有光且光被物体挡住','没有任何光','物体透明时一定有'],0,'光被不透明物体挡住后可形成影子。'],
['下雨时怎样做更安全？',['远离积水中的电线','触碰掉落电线','站在大树下避雷'],0,'远离电线与危险积水。'],
['哪一种动物通常是卵生？',['小鸡','小猫','小狗'],0,'鸡由卵孵化出来。']
]};
const $=id=>document.getElementById(id);
const screen=$('weeklyExam');if(!screen)return;
const ids=['cn','ma','en','sc'];
let practice=false,current=null;
function sunday(){const d=new Date();return d.getDay()===0}
function key(){const d=new Date();const day=d.getDay();d.setDate(d.getDate()-day);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function store(){return state.weeklyExams||(state.weeklyExams={})}
function exam(){return practice?current:store()[key()]}
function saveExam(){if(!practice){store()[key()]=current;save()}}
function build(){
 const week=key(),weekSeed=Number(week.replace(/-/g,'')),picked={};
 ids.forEach((id,index)=>{const pool=QUESTIONS[id];const start=(weekSeed+index*3)%pool.length;picked[id]=Array.from({length:6},(_,i)=>({id,idx:(start+i*2)%pool.length}));});
 const ordered=[];for(let r=0;r<6;r++)ids.forEach(id=>ordered.push(picked[id][r]));
 return {week,createdAt:new Date().toISOString(),questions:ordered,answers:{},finishedAt:null};
}
function open(){openScreen('weeklyExam');const completed=store()[key()];$('weeklyActions').hidden=false;$('weeklyPlay').hidden=true;$('weeklyResult').hidden=true;$('weeklyIntro').textContent=sunday()?'今天是周日！四科学习成果，一张卷子来挑战。每科6题，共24题。':'四科合卷 · 共24题 · 每科6题。周日正式作答，其他时间可以家长试做。';
 $('weeklyStart').hidden=!sunday();$('weeklyStart').textContent=completed?(completed.finishedAt?'查看本周成绩':'继续本周测评'):'开始本周测评';
 if(sunday()&&completed&&completed.finishedAt){current=completed;practice=false;renderResult()}
}
function enter(preview){practice=preview;current=preview?build():(store()[key()]||build());saveExam();$('weeklyActions').hidden=true;current.finishedAt?renderResult():render()}
function question(i){const ref=current.questions[i];return {ref,row:QUESTIONS[ref.id][ref.idx]}}
function answeredCount(){return Object.keys(current.answers).length}
function render(){const n=answeredCount();if(n>=current.questions.length){finish();return}
 const {ref,row}=question(n),answer=current.answers[n];$('weeklyPlay').hidden=false;$('weeklyResult').hidden=true;
 $('weeklyProgress').textContent='第 '+(n+1)+' / '+current.questions.length+' 题'+(practice?' · 家长试做':' · 本周正式测评');
 $('weeklyBar').style.width=Math.round(n/current.questions.length*100)+'%';$('weeklySubject').textContent=SUBJECTS[ref.id]+' · 知识挑战';$('weeklyQuestion').textContent=row[0];
 $('weeklyFeedback').textContent='';$('weeklyNext').hidden=true;
 $('weeklyListen').style.display='inline-block';$('weeklyListen').onclick=()=>speakPrompt(row[0],ref.id);
 const order=[0,1,2].sort((a,b)=>((a+n*7+ref.idx*3)%3)-((b+n*7+ref.idx*3)%3));
 $('weeklyOptions').innerHTML='';
 order.forEach(choice=>{const b=document.createElement('button');b.type='button';b.className='opt';b.style.cssText='text-align:left;min-height:56px;border:2px solid #b7d8ef;background:#f5fbff;border-radius:14px;padding:12px 16px;font-size:18px;color:#174d78';b.textContent=row[1][choice];b.onclick=()=>answerQuestion(n,choice);$('weeklyOptions').appendChild(b)});
}
function speakPrompt(message,id){if(!('speechSynthesis' in window))return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(message);u.lang='zh-CN';u.rate=.82;window.speechSynthesis.speak(u)}
function answerQuestion(index,choice){if(current.answers[index])return;const {ref,row}=question(index),ok=choice===row[2];
 current.answers[index]={subject:ref.id,selected:choice,correct:ok,question:row[0],chosen:row[1][choice],answer:row[1][row[2]],explanation:row[3]};
 saveExam();$('weeklyOptions').querySelectorAll('button').forEach(b=>{b.disabled=true;if(b.textContent===row[1][row[2]])b.style.background='#e2f7e9';else if(b.textContent===row[1][choice]&&!ok)b.style.background='#fff0e9'});
 $('weeklyFeedback').textContent=(ok?'🌟 恭喜你回答正确！ ':'💡 这道题再记住：')+row[3];
 const u=new SpeechSynthesisUtterance(ok?'恭喜你回答正确':'哦哦，正确答案是：'+row[1][row[2]]);u.lang=ref.id==='en'&&!ok?'en-US':'zh-CN';u.rate=.78;if('speechSynthesis' in window){window.speechSynthesis.cancel();window.speechSynthesis.speak(u)}
 $('weeklyNext').hidden=false;$('weeklyNext').textContent=index+1===24?'查看四科成绩':'下一题 →';
}
function finish(){current.finishedAt=current.finishedAt||new Date().toISOString();saveExam();renderResult()}
function renderResult(){const ans=Object.values(current.answers),score=ans.filter(a=>a.correct).length;
 $('weeklyActions').hidden=true;$('weeklyPlay').hidden=true;$('weeklyResult').hidden=false;
 const el=$('weeklyResult');el.replaceChildren();
 const h=document.createElement('h2');h.textContent='🏆 '+(practice?'家长试做结果':'本周四科测评报告');el.appendChild(h);
 const p=document.createElement('p');p.style.fontSize='23px';p.style.fontWeight='900';p.textContent='总成绩：'+score+' / 24（'+Math.round(score/24*100)+'分）';el.appendChild(p);
 ids.forEach(id=>{const a=ans.filter(x=>x.subject===id),c=a.filter(x=>x.correct).length;const line=document.createElement('p');line.textContent=SUBJECTS[id]+'：'+c+' / 6 · '+Math.round(c/6*100)+'%';el.appendChild(line)});
 const wrong=ans.filter(x=>!x.correct);const sub=document.createElement('h3');sub.textContent='错题回顾（'+wrong.length+'题）';el.appendChild(sub);
 if(!wrong.length){const p=document.createElement('p');p.textContent='全部答对！继续保持！';el.appendChild(p)}
 wrong.forEach((x,i)=>{const p=document.createElement('p');p.style.cssText='padding:12px;border-bottom:1px solid #d6eaf6;line-height:1.8';p.textContent=(i+1)+'. 【'+SUBJECTS[x.subject]+'】'+x.question+'  你选：'+x.chosen+'。正确：'+x.answer+'。'+x.explanation;el.appendChild(p)});
 const b=document.createElement('button');b.type='button';b.className='primary';b.textContent='返回学习台';b.onclick=()=>openScreen('home');el.appendChild(b);
}
$('weeklyStart').onclick=()=>enter(false);$('weeklyPreview').onclick=()=>enter(true);$('weeklyBack').onclick=()=>{if(practice&&current)current=null;openScreen('home')};$('weeklyNext').onclick=()=>render();
const former=$('goAssessment').onclick;$('goAssessment').onclick=()=>{if(sunday())open();else if(former)former()};
const nav=document.querySelector('[data-tab="assessment"]');if(nav)nav.onclick=()=>{if(sunday())open();else open()};
const extra=document.createElement('button');extra.id='weeklyExamAccess';extra.type='button';extra.textContent='🏆 周日四科合卷'+(sunday()?' · 开始测评':' · 家长预览');extra.style.cssText='display:block;margin:12px auto;padding:12px 20px;border:2px solid #98d2ee;border-radius:16px;background:#f1faff;color:#12548f;font-size:16px;font-weight:900';extra.onclick=open;
$('home').prepend(extra);
})();