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
// Retire the temporary English inspection page; formal English course and monthly exam remain intact.
if($('englishPreviewMenu'))$('englishPreviewMenu').remove();
if($('englishPreviewHomeBtn'))$('englishPreviewHomeBtn').parentElement.remove();

/* 2026-11-22 第二次周测：四科各6题，区别于首周题库。 */
const WEEK2_QUESTIONS={
cn:[
['听故事：小鹿看见乌云，先把晒着的衣服收回家。后来下雨了。小鹿为什么收衣服？',['因为快下雨了','因为要睡觉','因为衣服太新'],0,'乌云可能预示下雨，所以小鹿提前收好衣服。'],
['“河”和“海”都有哪个偏旁？',['三点水','提手旁','口字旁'],0,'河、海都与水有关，偏旁是三点水。'],
['“一去二三里”中的“三”一共有几画？',['两画','三画','四画'],1,'“三”是三条横线，共三画。'],
['“举头望明月”中的“望”最接近哪个意思？',['看','跑','听'],0,'望明月，就是抬头看月亮。'],
['下列哪个词语更适合形容秋天？',['落叶飘飘','烈日炎炎','冰天雪地'],0,'秋天树叶常变黄并飘落。'],
['句子“小猫躲在桌子下面”，小猫在哪里？',['桌子下面','桌子上面','窗户外面'],0,'“下面”表示位置在桌子底下。']
],
ma:[
['小明有9颗糖，妈妈又给他7颗，一共有几颗？',['15颗','16颗','17颗'],1,'9＋7＝16，可以先凑十。'],
['14－6＝？',['7','8','9'],1,'14－4＝10，再减2，得8。'],
['一个盒子里有12块积木，拿走3块又放回2块，现在有几块？',['10块','11块','12块'],1,'12－3＋2＝11。'],
['从左往右数，小蓝排第4，从右往左数排第3，队伍一共有几人？',['6人','7人','8人'],0,'4＋3－1＝6，自己只能数一次。'],
['哪个数比15大2？',['13','16','17'],2,'15＋2＝17。'],
['桌上有4个三角形和3个圆形，一共有几个图形？',['6个','7个','8个'],1,'4＋3＝7。']
],
en:[
['Which word means “小船”？',['ship','shop','sheep'],0,'ship 是船，shop 是商店，sheep 是羊。'],
['选择与“我们的”意思相同的英文词。',['out','our','are'],1,'our 的意思是我们的，out 是出去。'],
['Which word has the “ight” sound?',['light','lake','look'],0,'light 含固定拼读块 ight。'],
['选择“她有一只猫”的正确英文句子。',['She has a cat.','He can run.','I see a dog.'],0,'She has a cat. 表示她有一只猫。'],
['根据句意选词：I can ___ a kite.',['fly','apple','book'],0,'fly a kite 表示放风筝。'],
['Choose the word for “夜晚”。',['night','right','bright'],0,'night 是夜晚，right 是正确或右边。']
],
sc:[
['洗过的衣服晾在通风处更容易干，主要因为什么？',['水分蒸发得更快','衣服变成空气','风把衣服吃掉'],0,'空气流动可加快水的蒸发。'],
['下列哪种材料通常更容易被磁铁吸住？',['铁回形针','塑料尺','纸杯'],0,'磁铁可以吸引许多铁制物品。'],
['种子发芽后，通常先向下生长的是哪一部分？',['根','花朵','果实'],0,'根通常向下生长，帮助植物吸水。'],
['看到闪电后才听到雷声，主要是因为什么？',['光传播得比声音快','闪电没有声音','雷声从地里长出来'],0,'光传播得比声音快，所以往往先看见闪电。'],
['为什么雨后有时会出现彩虹？',['阳光经过空气中的小水滴','云变成七彩颜料','树叶发出彩光'],0,'阳光经过水滴发生折射和色散，能形成彩虹。'],
['下面哪个做法更有利于保护环境？',['把可回收物分类','随手乱扔电池','把垃圾倒入河里'],0,'分类回收可以减少资源浪费和环境污染。']
]};


/* 11月29日第三周：考察应用与理解，不与前两次重复试题。 */
const WEEK3_QUESTIONS={
cn:[
['听故事：小兔把一把伞借给忘记带伞的小熊，自己在屋檐下等雨停。小兔为什么等在屋檐下？',['因为把伞借给了小熊','因为要晒太阳','因为找不到书包'],0,'小兔把伞借走给朋友，所以自己先到屋檐下避雨。'],
['“清晨，树叶上挂满了露珠。”这句话中的“清晨”指什么时候？',['早上','中午','晚上'],0,'清晨就是一天刚开始的早晨。'],
['“远看山有色，近听水无声”出自哪首古诗？',['画','咏鹅','静夜思'],0,'这两句出自古诗《画》。'],
['“暖和”的反义词是哪一个？',['寒冷','温暖','舒服'],0,'暖和和寒冷表示相反的感觉。'],
['下面哪个字有“木”字旁？',['树','河','问'],0,'“树”左边是木字旁，通常和树木有关。'],
['故事中小猴先洗苹果，接着切苹果，最后和朋友分享。小猴第二步做什么？',['切苹果','洗苹果','分享苹果'],0,'按顺序听故事：先洗，再切，最后分享。']
],
ma:[
['有6辆红色玩具车和8辆蓝色玩具车，送走5辆后还剩几辆？',['8辆','9辆','10辆'],1,'先算6＋8＝14，再算14－5＝9。'],
['盒子里有16支彩笔，拿出7支，还剩几支？',['8支','9支','10支'],1,'16－7＝9。'],
['小朋友排队，小林前面有5人，后面有3人，一共有几人？',['8人','9人','10人'],1,'5＋1＋3＝9，别忘了算小林自己。'],
['先算9＋4，再减去3，结果是多少？',['9','10','11'],1,'9＋4＝13，再减去3是10。'],
['一根绳子比另一根长4厘米，短绳长7厘米，长绳有多长？',['10厘米','11厘米','12厘米'],1,'7＋4＝11厘米。'],
['有3个杯子，每个杯子里放2颗糖，一共有几颗糖？',['5颗','6颗','7颗'],1,'2＋2＋2＝6，数一数也可以。']
],
en:[
['Which word means “书”？',['book','look','cook'],0,'book 是书；look 是看；cook 是烹饪。'],
['选出“她可以跳”的正确英文句子。',['She can jump.','She has a pen.','He can run.'],0,'She can jump. 表示她可以跳。'],
['哪个词包含拼读块“ake”？',['cake','cat','cup'],0,'cake 是 c 加 ake，结尾 e 不单独发音。'],
['根据句意选择：We ___ happy.',['am','is','are'],2,'We are happy. 表示我们很开心。'],
['Which word means “明亮的”？',['bright','night','right'],0,'bright 表示明亮的，night 是夜晚。'],
['选出句子“I see a fish.”的正确中文意思。',['我看见一条鱼。','我有一只猫。','我想要一杯水。'],0,'I see a fish. 表示我看见一条鱼。']
],
sc:[
['杯子外壁出现小水珠，最可能是因为？',['空气里的水蒸气遇冷凝结','杯子在漏水','玻璃变成了水'],0,'空气中的水蒸气遇到冷杯壁，会凝结成水滴。'],
['同样一块湿布，放在阳光下和阴凉处，通常哪处干得更快？',['阳光下','阴凉处','完全一样'],0,'阳光提供热量，通常有利于水分蒸发。'],
['给植物浇水时，哪一种做法比较合适？',['按需要浇水，避免长期积水','每天让花盆装满水','永远不浇水'],0,'不同植物需水不同，积水也可能伤害根。'],
['用手电筒照积木，积木后面出现影子，影子为什么形成？',['积木挡住了光','积木发出了黑光','空气消失了'],0,'光沿直线传播，积木挡住一部分光形成影子。'],
['下面哪一种行为更安全？',['雷雨时进入室内','雷雨时摸金属栏杆','雷雨时站在孤立大树下'],0,'雷雨时进入安全建筑物内，远离树下和金属设施。'],
['从冰块变成液态水，水经历了什么变化？',['融化','凝结','燃烧'],0,'固态冰吸热转成液态水，称为融化。']
]};

const ids=['cn','ma','en','sc'];
let practice=false,current=null;
const FIRST_SUNDAY='2026-11-15',SECOND_SUNDAY='2026-11-22',THIRD_SUNDAY='2026-11-29';
function dayString(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function sunday(){return new Date().getDay()===0}
function key(){const d=new Date();d.setDate(d.getDate()-d.getDay());return dayString(d)}
function officialAllowed(){return sunday()&&key()>=FIRST_SUNDAY}
function store(){return state.weeklyExams||(state.weeklyExams={})}
function saveExam(){if(!practice){store()[current.week]=current;save()}}
function build(week){
 const isSecond=week===SECOND_SUNDAY,isThird=week===THIRD_SUNDAY,picked={};
 if(isThird){ids.forEach(id=>{picked[id]=WEEK3_QUESTIONS[id].map((_,i)=>({id,idx:i,bank:'week3'}))});}
 else if(isSecond){
  ids.forEach(id=>{picked[id]=WEEK2_QUESTIONS[id].map((_,i)=>({id,idx:i,bank:'week2'}))});
 }else{
  const weekSeed=Number(week.replace(/-/g,''));
  ids.forEach((id,index)=>{const pool=QUESTIONS[id];const start=(weekSeed+index*3)%pool.length;picked[id]=Array.from({length:6},(_,i)=>({id,idx:(start+i*2)%pool.length}))});
 }
 const ordered=[];for(let r=0;r<6;r++)ids.forEach(id=>ordered.push(picked[id][r]));
 return {week,createdAt:new Date().toISOString(),questions:ordered,answers:{},finishedAt:null};
}
function open(){
 openScreen('weeklyExam');
 const week=key(),completed=store()[week],canStart=officialAllowed();
 $('weeklyActions').hidden=false;$('weeklyPlay').hidden=true;$('weeklyResult').hidden=true;
 $('weeklyIntro').textContent=canStart?'今天是'+week+'，正式四科合卷，每科6题，共24题。':'正式测评在周日开放。三周试卷都可以提前由家长试做，不计入正式成绩。';
 $('weeklyStart').hidden=!canStart;
 $('weeklyStart').textContent=completed?(completed.finishedAt?'查看本周成绩':'继续本周测评'):'开始本周测评';
 $('weeklyPreview').textContent='🔎 试做 11月15日（第一周）';
 $('weeklyPreviewSecond').textContent='🔎 试做 11月22日（第二周）';
 $('weeklyPreviewThird').textContent='🔎 试做 11月29日（第三周）';
 if(canStart&&completed&&completed.finishedAt){current=completed;practice=false;renderResult()}
}
function enter(preview,requestedWeek){
 if(!preview&&!officialAllowed()){open();return}
 practice=preview;const week=preview?(requestedWeek||THIRD_SUNDAY):key();
 current=preview?build(week):(store()[week]||build(week));
 saveExam();$('weeklyActions').hidden=true;
 current.finishedAt?renderResult():render();
}
function question(i){const ref=current.questions[i],pool=ref.bank==='week3'?WEEK3_QUESTIONS:ref.bank==='week2'?WEEK2_QUESTIONS:QUESTIONS;return {ref,row:pool[ref.id][ref.idx]}}
function answeredCount(){return Object.keys(current.answers).length}
function render(){const n=answeredCount();if(n>=current.questions.length){finish();return}
 const {ref,row}=question(n);$('weeklyPlay').hidden=false;$('weeklyResult').hidden=true;
 $('weeklyProgress').textContent=(current.week===THIRD_SUNDAY?'11月29日 · 第三周':current.week===SECOND_SUNDAY?'11月22日 · 第二周':'11月15日 · 第一周')+' · 第 '+(n+1)+' / '+current.questions.length+' 题'+(practice?' · 家长试做':' · 本周正式测评');
 $('weeklyBar').style.width=Math.round(n/current.questions.length*100)+'%';$('weeklySubject').textContent=SUBJECTS[ref.id]+' · 知识挑战';$('weeklyQuestion').textContent=row[0];
 $('weeklyFeedback').textContent='';$('weeklyNext').hidden=true;
 $('weeklyListen').style.display='inline-block';$('weeklyListen').onclick=()=>speakPrompt(row[0],ref.id);
 const order=[0,1,2].sort((a,b)=>((a+n*7+ref.idx*3+Number(current.week.replace(/-/g,'')))%3)-((b+n*7+ref.idx*3+Number(current.week.replace(/-/g,'')))%3));
 $('weeklyOptions').innerHTML='';
 order.forEach(choice=>{
 const text=row[1][choice],wrap=document.createElement('div');
 wrap.style.cssText='display:flex;align-items:stretch;gap:8px;min-width:0';
 const option=document.createElement('button');option.type='button';option.className='opt weekly-choice';option.dataset.choice=String(choice);
 option.style.cssText='flex:1;min-width:0;text-align:left;min-height:56px;border:2px solid #b7d8ef;background:#f5fbff;border-radius:14px;padding:12px 16px;font-size:18px;color:#174d78;white-space:normal';
 option.textContent=text;option.onclick=()=>answerQuestion(n,choice);wrap.appendChild(option);
 const voice=document.createElement('button');voice.type='button';voice.className='weekly-option-audio';
 voice.setAttribute('aria-label','朗读选项：'+text);voice.title='朗读这个选项（不会提交答案）';voice.textContent='🔊';
 voice.style.cssText='flex:0 0 52px;min-height:56px;border:2px solid #b7d8ef;background:#ecf8ff;border-radius:14px;font-size:22px;touch-action:manipulation';
 voice.onclick=()=>speakOption(text,ref.id);wrap.appendChild(voice);
 $('weeklyOptions').appendChild(wrap);
});
}
// Play mixed Chinese/English prompts in language-specific utterances.
// iOS Safari can make crackling/garbled sounds when the Mandarin voice reads English words.
function speakOption(message,id){
 if(!('speechSynthesis' in window))return;
 const synth=window.speechSynthesis;
 synth.cancel();
 const input=String(message||'');
 const hasChinese=/[\u3400-\u9fff]/.test(input);
 // Preserve whole natural English sentences as one utterance, so "means" is pronounced normally.
 let parts;
 if(!hasChinese){parts=[{text:input,lang:id==='en'?'en-US':'zh-CN'}]}
 else{
  const english=/[A-Za-z]+(?:[ \t'-]+[A-Za-z]+)*/g;
  parts=[];let pos=0,match;
  while((match=english.exec(input))!==null){
   if(match.index>pos)parts.push({text:input.slice(pos,match.index),lang:'zh-CN'});
   parts.push({text:match[0],lang:'en-US'});
   pos=match.index+match[0].length;
  }
  if(pos<input.length)parts.push({text:input.slice(pos),lang:'zh-CN'});
 }
 parts.filter(p=>p.text.trim()).forEach(p=>{
  const u=new SpeechSynthesisUtterance(p.text);
  u.lang=p.lang;
  u.rate=p.lang==='en-US'?.75:.82;
  synth.speak(u);
 });
}
function speakPrompt(message,id){speakOption(message,id)}
function answerQuestion(index,choice){if(current.answers[index])return;const {ref,row}=question(index),ok=choice===row[2];
 current.answers[index]={subject:ref.id,selected:choice,correct:ok,question:row[0],chosen:row[1][choice],answer:row[1][row[2]],explanation:row[3]};
 saveExam();$('weeklyOptions').querySelectorAll('.weekly-choice').forEach(b=>{b.disabled=true;if(Number(b.dataset.choice)===row[2])b.style.background='#e2f7e9';else if(Number(b.dataset.choice)===choice&&!ok)b.style.background='#fff0e9'});
 $('weeklyFeedback').textContent=(ok?'🌟 恭喜你回答正确！ ':'💡 这道题再记住：')+row[3];
 speakOption(ok?'恭喜你回答正确':'哦哦，正确答案是：'+row[1][row[2]],ref.id);
 $('weeklyNext').hidden=false;$('weeklyNext').textContent=index+1===24?'查看四科成绩':'下一题 →';
}
function finish(){current.finishedAt=current.finishedAt||new Date().toISOString();saveExam();renderResult()}
function renderResult(){const ans=Object.values(current.answers),score=ans.filter(a=>a.correct).length;
 $('weeklyActions').hidden=true;$('weeklyPlay').hidden=true;$('weeklyResult').hidden=false;
 const el=$('weeklyResult');el.replaceChildren();
 const h=document.createElement('h2');h.textContent='🏆 '+current.week+' · '+(practice?'家长试做结果':'本周四科测评报告');el.appendChild(h);
 const p=document.createElement('p');p.style.fontSize='23px';p.style.fontWeight='900';p.textContent='总成绩：'+score+' / 24（'+Math.round(score/24*100)+'分）';el.appendChild(p);
 ids.forEach(id=>{const a=ans.filter(x=>x.subject===id),c=a.filter(x=>x.correct).length;const line=document.createElement('p');line.textContent=SUBJECTS[id]+'：'+c+' / 6 · '+Math.round(c/6*100)+'%';el.appendChild(line)});
 const wrong=ans.filter(x=>!x.correct);const sub=document.createElement('h3');sub.textContent='错题回顾（'+wrong.length+'题）';el.appendChild(sub);
 if(!wrong.length){const p=document.createElement('p');p.textContent='全部答对！继续保持！';el.appendChild(p)}
 wrong.forEach((x,i)=>{const p=document.createElement('p');p.style.cssText='padding:12px;border-bottom:1px solid #d6eaf6;line-height:1.8';p.textContent=(i+1)+'. 【'+SUBJECTS[x.subject]+'】'+x.question+'  你选：'+x.chosen+'。正确：'+x.answer+'。'+x.explanation;el.appendChild(p)});
 const b=document.createElement('button');b.type='button';b.className='primary';b.textContent='返回学习台';b.onclick=()=>openScreen('home');el.appendChild(b);
}
const secondPreview=document.createElement('button');secondPreview.id='weeklyPreviewSecond';secondPreview.type='button';secondPreview.style.cssText='margin:8px;padding:10px 14px;border:1px solid #9bc9e4;border-radius:12px;background:white;color:#174d78;font-weight:800';
$('weeklyPreview').insertAdjacentElement('afterend',secondPreview);
const thirdPreview=document.createElement('button');thirdPreview.id='weeklyPreviewThird';thirdPreview.type='button';thirdPreview.style.cssText=secondPreview.style.cssText;
secondPreview.insertAdjacentElement('afterend',thirdPreview);
$('weeklyStart').onclick=()=>enter(false);$('weeklyPreview').onclick=()=>enter(true,FIRST_SUNDAY);secondPreview.onclick=()=>enter(true,SECOND_SUNDAY);thirdPreview.onclick=()=>enter(true,THIRD_SUNDAY);$('weeklyBack').onclick=()=>{if(practice&&current)current=null;openScreen('home')};$('weeklyNext').onclick=()=>render();
const former=$('goAssessment').onclick;$('goAssessment').onclick=()=>{open()};
const nav=document.querySelector('[data-tab="assessment"]');if(nav)nav.onclick=()=>{if(sunday())open();else open()};
const extra=document.createElement('button');extra.id='weeklyExamAccess';extra.type='button';extra.textContent='🏆 周日四科合卷 · 第一周 / 第二周 / 第三周'+(officialAllowed()?' · 正式测评':' · 家长预览');extra.style.cssText='display:block;margin:12px auto;padding:12px 20px;border:2px solid #98d2ee;border-radius:16px;background:#f1faff;color:#12548f;font-size:16px;font-weight:900';extra.onclick=open;
$('home').prepend(extra);
})();