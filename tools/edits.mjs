/**
 * tools/edits.mjs — 三个 V6 文件相对 main 的**全部**文本改动，集中放一处。
 *
 * 为什么单独拆出来：
 *   1. 三个补丁工具（tools/patch-*.mjs）从这里取 old/new，不再各自复制一份；
 *   2. tests/garage.test.mjs 用同一份数据做**反向替换**校验 —— 把 new 换回 old
 *      之后与 main 逐字节相等，就等价于证明「整个文件只动了这几处」，
 *      不需要对 1.1 MB 单行 bundle 做 diff。
 *
 * 注意：字符串必须逐字节准确（V6 是单行压缩产物，一个空格都会对不上）。
 */

/* ---------------- v6/index.html：「我的车库」入口 ---------------- */
const INDEX_OLD = "$('goGarage').onclick=()=>alert('车库功能即将开放');";
const INDEX_NEW = [
  "$('goGarage').onclick=()=>{",
  'const p=new URLSearchParams();',
  "const d=new URLSearchParams(location.search).get('d');",
  "if(d)p.set('d',d);",
  "try{const dev=localStorage.getItem('r5_device');if(!p.get('d')&&dev&&/^r5dev_[0-9a-f]{32}$/.test(dev))p.set('d',dev)}catch(e){}",
  "const s=p.toString();location.href='./assemble-center.html'+(s?'?'+s:'')",
  '};',
].join('');

/* ---------------- v6/chinese-classroom.js：听音挑战不再念答案 ---------------- */
const AUDIO_OLD = "function audio(s,next){if(!Object.prototype.hasOwnProperty.call(PINYIN_FIXED_AUDIO,s))return;serial++;let t=serial;if(player)player.pause();window.speechSynthesis?.cancel();player=new Audio(PINYIN_FIXED_AUDIO[s]);let status=$('lionAudioState');if(status)status.textContent='正在播放 '+s;player.onended=()=>{if(serial===t&&next)setTimeout(()=>{if(serial===t)next()},280)};player.onerror=()=>{if(serial===t&&status)status.textContent=s+' 音频未能载入，请检查网络。不会使用其他拼音代替。'};player.play().catch(()=>{if(status)status.textContent='请再次点击播放'})}";

const AUDIO_NEW = [
  'function audio(s,next,mode){',
  "if(!Object.prototype.hasOwnProperty.call(PINYIN_FIXED_AUDIO,s))return;",
  'serial++;let t=serial;',
  'if(player)player.pause();window.speechSynthesis?.cancel();',
  'player=new Audio(PINYIN_FIXED_AUDIO[s]);',
  "let status=$('lionAudioState');",
  '/* 挑战模式下，播放前/中/后都不出现目标拼音：那是答案本身。 */',
  "const quiz=mode==='quiz';",
  "if(status)status.textContent=quiz?'正在播放题目…':'正在播放…';",
  'player.onended=()=>{',
  'if(serial!==t)return;',
  "if(status)status.textContent=quiz?'请选出听到的拼音':'播放结束，可以再听一遍';",
  'if(next)setTimeout(()=>{if(serial===t)next()},280)',
  '};',
  'player.onerror=()=>{',
  'if(serial!==t)return;',
  "if(status)status.textContent=quiz?'题目音频没能载入，请检查网络后再点一次播放。':'这段录音没能载入，请检查网络后再试一次。'",
  '};',
  "player.play().catch(()=>{if(serial===t&&status)status.textContent='还没开始播放，请再点一次播放'})",
  '}',
].join('');

const CALL_OLD = "$('lionListen').onclick=()=>audio(s);";
const CALL_NEW = "$('lionListen').onclick=()=>audio(s,null,'quiz');";

/* ---------------- v6/chinese-day2-day3-preview.html：同型状态栏 ---------------- */
const SYLLABLE_OLD = "v.textContent='正在播放 '+s;";
const SYLLABLE_NEW = "v.textContent='正在播放…';";

/** 文件名 → 该文件相对 main 的改动列表（顺序即套用顺序） */
export const EDITS = {
  'index.html': [
    { label: '车库入口', old: INDEX_OLD, new: INDEX_NEW },
  ],
  'chinese-classroom.js': [
    { label: 'audio() 状态文案', old: AUDIO_OLD, new: AUDIO_NEW },
    { label: '听音挑战调用点', old: CALL_OLD, new: CALL_NEW },
  ],
  'chinese-day2-day3-preview.html': [
    { label: '音节卡状态栏', old: SYLLABLE_OLD, new: SYLLABLE_NEW },
  ],
};

/** main 侧的基准文件名（本地快照 _repo/ 里的命名） */
export const MAIN_NAMES = {
  'index.html': 'index.main.html',
  'chinese-classroom.js': 'chinese-classroom.main.js',
  'chinese-day2-day3-preview.html': 'day23.main.html',
};

/** 只允许出现一次的精确替换；返回替换后的文本 */
export function replaceOnce(haystack, needle, replacement, label) {
  const parts = haystack.split(needle);
  if (parts.length !== 2) {
    throw new Error(`${label}: expected exactly 1 occurrence, found ${parts.length - 1}`);
  }
  return parts[0] + replacement + parts[1];
}
