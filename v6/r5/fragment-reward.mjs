/**
 * v6/r5/fragment-reward.mjs — 学习完成后的碎片奖励展示（V6 学习平台版）
 *
 * 用法（V6 在「今日学习真正完成」后调用，不改动课程 / 题目 / 语音 / 测评逻辑）：
 *   import { showFragmentReward } from './r5/fragment-reward.mjs';
 *   await showFragmentReward({ recordId: '<稳定唯一的学习记录 ID>' });
 *
 * 语义：
 *   · 只展示服务端确认的结果；网络失败一律提示「再试一次」，绝不显示已获得；
 *   · 同一个 recordId 重复调用返回 ALREADY_CLAIMED，不重复发奖；
 *   · 不做本地余额累加，所有数字都来自服务端返回的快照。
 */

import { claimFragment, loadState, deviceToken, buildProgress, FragmentError, messageOf } from './fragment-client.mjs';
import {memberState} from './member-fragments.mjs';

/**
 * Fail-closed reward status policy.
 * Only the two explicitly acknowledged server outcomes are accepted.
 * Never treat a new/unknown failure code as a successful reward.
 */
export function rewardClaimDecision(code) {
  const status = String(code || '');
  if (status === 'CLAIMED' || status === 'ALREADY_CLAIMED') {
    return { accepted: true, status, message: '' };
  }
  const reasons = {
    REWARD_NOT_ACTIVE: '碎片奖励还没有启用，今天不会扣次数或发放碎片',
    FORBIDDEN_SCOPE: '当前设备或家庭没有领取权限',
    RECORD_NOT_FOUND: '云端没有找到这条学习记录',
    BAD_RECORD_ID: '学习记录编号不正确',
    NOT_TODAY: '这不是今天完成的学习记录',
    CONFIG_MISSING: '奖励配置尚未准备好',
    SAVE_NOT_INITIALIZED: '赛车云端存档还没有准备好',
    LEARNING_RECORD_NOT_FOUND: '云端没有找到今天的这条学习记录',
    LEARNING_RECORD_NOT_REWARDABLE: '这条记录不是「学习完成」记录',
    LEARNING_RECORD_SUBJECT_INVALID: '这条记录的科目不在四科之内',
    LEARNING_RECORD_NOT_EFFECTIVE: '这条记录不算有效完成',
    LEARNING_RECORD_NO_DAY: '这条记录里没有完成时间',
    LEARNING_RECORD_NOT_TODAY: '这是以前的学习记录，今天不结算',
    SYNC_DISABLED_PROD: '这个家庭还没有开通赛车奖励',
    R5_BAD_LEARNING_RECORD: '学习记录编号看起来不对',
  };
  return { accepted: false, status, message: reasons[status] || '云端没有确认成功结算，这次不会显示已领取' };
}

const CSS = `
.vfr{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;
  background:radial-gradient(circle at 50% 28%,rgba(88,185,255,.55),rgba(9,32,58,.9) 64%);
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#153963;
  opacity:0;transition:opacity .26s}
.vfr,.vfr *{box-sizing:border-box}
.vfr.show{opacity:1}
.vfr .card{width:min(420px,100%);max-width:100%;background:linear-gradient(175deg,#ffffff,#eef7ff);
  border:5px solid #fff;border-radius:28px;padding:20px 18px 16px;text-align:center;
  box-shadow:0 14px 0 rgba(21,79,145,.22), 0 26px 60px rgba(0,0,0,.42);
  transform:translateY(18px) scale(.95);transition:.36s cubic-bezier(.2,1.2,.4,1);overflow-wrap:anywhere}
.vfr.show .card{transform:none}
.vfr .star{width:88px;height:88px;margin:0 auto 6px;display:block;filter:drop-shadow(0 8px 16px rgba(240,164,0,.45));
  animation:vfrPop .68s cubic-bezier(.2,1.5,.4,1)}
@keyframes vfrPop{0%{transform:scale(.2) rotate(-40deg);opacity:0}62%{transform:scale(1.14) rotate(8deg)}100%{transform:scale(1) rotate(0);opacity:1}}
.vfr h3{margin:0 0 4px;font-size:20px;font-weight:1000;color:#0d3f74}
.vfr .sub{margin:0 0 13px;font-size:12.5px;font-weight:800;color:#5c7fa3;line-height:1.6}
.vfr .gain{display:flex;justify-content:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.vfr .chip{display:flex;align-items:center;gap:6px;background:#fff6d9;border:2px solid #ffdf8a;
  border-radius:999px;padding:7px 13px;font-size:13px;font-weight:1000;color:#8a6a12}
.vfr .chip.rare{background:#efe7ff;border-color:#c9b6ff;color:#5c39c9}
.vfr .chip b{font-size:17px}
.vfr .prog{text-align:left;background:#eaf3fd;border-radius:16px;padding:11px 12px;margin-bottom:8px}
.vfr .prog .row{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;font-weight:1000;color:#2c5b8c;margin-bottom:7px}
.vfr .bar{height:10px;border-radius:999px;background:#d8e7f7;overflow:hidden;box-shadow:inset 0 -2px #c7dbef}
.vfr .bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#ffb703,#ffd447);
  width:0;transition:width .9s cubic-bezier(.2,.9,.2,1)}
.vfr .prog.rare .bar i{background:linear-gradient(90deg,#7b5cff,#b9a6ff)}
.vfr .pity{display:flex;align-items:center;justify-content:center;gap:6px;font-size:11.5px;font-weight:900;color:#5c7fa3;margin:8px 0 4px}
.vfr .dot{width:12px;height:12px;border-radius:50%;background:#e2ecf8;box-shadow:inset 0 -2px #cfdcee}
.vfr .dot.on{background:linear-gradient(180deg,#ffd85c,#f5a800);box-shadow:0 0 7px rgba(255,190,40,.7)}
.vfr .line{font-size:11.5px;font-weight:900;color:#0f63b7;margin:2px 0 13px}
.vfr .btn{border:0;border-radius:15px;padding:13px 18px;font:inherit;font-size:14.5px;font-weight:1000;width:100%;
  background:linear-gradient(180deg,#ffd447,#f2ae06);color:#4a3000;box-shadow:0 5px 0 #c9860b;cursor:pointer}
.vfr .btn:active{transform:translateY(2px);box-shadow:0 3px 0 #c9860b}
.vfr .btn.ghost{background:#eaf3fd;color:#2c5b8c;box-shadow:0 5px 0 #c6dcf0;margin-top:8px}
.vfr .err{color:#c23a2b;font-size:12.5px;font-weight:900;background:#ffece9;border-radius:12px;padding:9px 12px;margin:4px 0 12px}
`;

function injectStyle() {
  if (document.getElementById('vfr-style')) return;
  const s = document.createElement('style');
  s.id = 'vfr-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const STAR = `<svg class="star" viewBox="0 0 100 100" fill="none">
<defs><linearGradient id="vfrg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#f0a400"/></linearGradient></defs>
<path d="M50 6l12.6 25.8 28.4 4.1-20.6 20 4.9 28.3L50 71l-25.3 13.2 4.9-28.3-20.6-20 28.4-4.1z"
 fill="url(#vfrg)" stroke="#c98a00" stroke-width="3" stroke-linejoin="round"/></svg>`;

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
}

function dotsHTML(pity, target) {
  return Array.from({ length: target })
    .map((_, i) => `<i class="dot${i < pity ? ' on' : ''}"></i>`).join('');
}

/**
 * 结算并展示一条学习记录的碎片奖励。
 * @param {{recordId:string, mount?:HTMLElement, assembleUrl?:string, autoCloseMs?:number}} opts
 */
export async function showFragmentReward(opts = {}) {
  const recordId = String(opts.recordId || '');
  if (!recordId) return { ok: false, error: 'NO_RECORD' };
  injectStyle();

  const host = opts.mount || document.body;
  const overlay = el(`<div class="vfr"><div class="card">
    ${STAR}
    <h3>正在结算今天的碎片…</h3>
    <p class="sub">请稍等，云端在确认你的学习记录</p>
    <button class="btn ghost" data-close>关闭</button>
  </div></div>`);
  host.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };
  overlay.querySelector('[data-close]').addEventListener('click', close);

  let result;
  try {
    result = await claimFragment(recordId);
  } catch (e) {
    const code = (e && e.code) || (e instanceof FragmentError ? e.code : 'SERVER');
    overlay.querySelector('.card').innerHTML = `${STAR}
      <h3>还没结算成功</h3>
      <p class="sub">奖励没有发出去，等网络好一点再来一次也没关系</p>
      <p class="err">${messageOf(code)}</p>
      <button class="btn" data-close>知道了</button>`;
    overlay.querySelector('[data-close]').addEventListener('click', close);
    return { ok: false, error: code };
  }

  const granted = (result && result.granted) || { normal: 0, rare: 0 };
  const frag = (result && result.fragment) || {};
  const status = String((result && result.status) || '');
  const outcome = String((result && result.outcome) || '');

  /* 服务端确认前严禁显示获得碎片；未知状态也必须拒绝。 */
  const decision = rewardClaimDecision(status);
  if (!decision.accepted) {
    overlay.querySelector('.card').innerHTML = `${STAR}
      <h3>这次没能结算</h3>
      <p class="sub">${decision.message}</p>
      <button class="btn" data-close>知道了</button>`;
    overlay.querySelector('[data-close]').addEventListener('click', close);
    return { ok: false, status };
  }

  let state = null;
  try {
    state = deviceToken() ? await loadState().catch(async e => {
      if(e && e.code === 'DEVICE') return memberState();
      throw e;
    }) : await memberState();
  } catch { state = null; }
  const program = (state && state.program) || {};
  const progress = state ? buildProgress(state) : [];
  // 优先展示「还差一点就成」的那辆车；全部集齐时展示第一辆
  const notOwned = progress.filter(p => !p.owned);
  const target = notOwned.slice().sort((a, b) => a.missing - b.missing)[0] || progress[0] || null;
  const pct = target ? Math.round(target.ratio * 100) : 100;

  const already = status === 'ALREADY_CLAIMED';
  const capped = outcome === 'capped';
  const gotCommon = Number(granted.normal || 0);
  const gotRare = Number(granted.rare || 0);
  const gotAny = gotCommon + gotRare > 0;

  let title = gotAny ? '碎片收好啦！' : '结算完成';
  let sub = '继续加油，攒够就能组装新赛车';
  if (already) { title = '这片碎片已经收过啦'; sub = '同一次学习只会发一次奖励'; }
  else if (capped) { title = '今天的碎片拿满啦'; sub = '明天学习完再来领新的碎片'; }
  else if (!gotAny && outcome === 'none') { title = '只差一点点啦'; sub = '这次没掉落，但保底进度 +1，攒满 5 点必出 1 片'; }
  else if (!gotAny && outcome === 'pity') { title = '保底成功！'; sub = '攒够 5 点，这一片稳稳到手'; }
  else if (!gotAny) { title = '结算完成'; sub = '云端已记录这次学习'; }

  const commonName = program.common_fragment_name || '星星碎片';
  const rareName = program.rare_fragment_name || '学习徽章碎片';
  const totalCommon = Number((frag.fragments || {})[program.common_fragment_id || 'frag_common'] || 0);
  const pityTarget = Number(program.pity_target || 5);
  const pityNow = Number(frag.pity_points || 0);

  const progLine = target
    ? (target.missing > 0
        ? `距离组装「${target.name}」还差 ${target.missing} 片`
        : `「${target.name}」已经可以组装啦`)
    : '所有碎片赛车都组装好啦';

  overlay.querySelector('.card').innerHTML = `${STAR}
    <h3>${title}</h3>
    <p class="sub">${sub}</p>
    ${gotAny ? `<div class="gain">
      ${gotCommon ? `<div class="chip">⭐ ${commonName} <b>+${gotCommon}</b></div>` : ''}
      ${gotRare ? `<div class="chip rare">🎖 ${rareName} <b>+${gotRare}</b></div>` : ''}
    </div>` : ''}
    ${target ? `<div class="prog ${target.tier === 'rare' ? 'rare' : ''}">
      <div class="row"><span>${target.name}</span><span>${target.rows.map(r => `${r.have}/${r.need}`).join(' · ')}</span></div>
      <div class="bar"><i data-bar="${pct}"></i></div>
    </div>` : ''}
    <div class="pity">保底 ${dotsHTML(pityNow, pityTarget)} <span>${pityNow}/${pityTarget}</span></div>
    <div class="line">${progLine}${gotCommon ? ` · 现有 ${commonName} ${totalCommon} 片` : ''}</div>
    <button class="btn" data-close>太棒了</button>
    <button class="btn ghost" data-garage>去组装中心看看</button>`;

  requestAnimationFrame(() => {
    const bar = overlay.querySelector('[data-bar]');
    if (bar) bar.style.width = bar.dataset.bar + '%';
  });

  overlay.querySelector('[data-close]').addEventListener('click', close);
  const garage = overlay.querySelector('[data-garage]');
  if (garage) {
    garage.addEventListener('click', () => {
      const url = opts.assembleUrl || './assemble-center.html';
      let d = '';
      try { d = new URLSearchParams(location.search).get('d') || ''; } catch { /* 忽略 */ }
      location.href = d ? url + '?d=' + encodeURIComponent(d) : url;
    });
  }

  if (opts.autoCloseMs) setTimeout(close, opts.autoCloseMs);
  return { ok: !already, status, granted, outcome };
}

export default showFragmentReward;
