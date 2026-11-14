/**
 * v6/r5/config.mjs — 学习平台侧（V6）碎片 / 组装中心配置
 *
 * 只放公开信息：网关地址、默认家庭、超时。
 * 绝不能放：SecretId / SecretKey、数据库口令、service_role、家长密钥、设备令牌。
 *
 * 家庭 ID 的取值顺序：
 *   1) URL ?family=<id>       —— 联调 / 家长验收用，不写死测试家庭
 *   2) localStorage r5_family —— 家长链接首次带入后记住
 *   3) 默认正式家庭
 * 设备令牌永远只在运行时从 ?d= / localStorage 读取，本文件不含任何令牌。
 */
export const V6_FRAG_BUILD = 'v1.0.0';

const DEFAULT_FAMILY = 'little-growth-family-001';

function query(name) {
  try { return new URLSearchParams(location.search).get(name) || ''; } catch { return ''; }
}

function familyId() {
  const q = query('family');
  if (q) {
    try { localStorage.setItem('r5_family', q); } catch { /* 隐私模式 */ }
    return q;
  }
  try {
    const saved = localStorage.getItem('r5_family');
    if (saved) return saved;
  } catch { /* 隐私模式 */ }
  return DEFAULT_FAMILY;
}

export const R5_CONFIG = {
  base: 'https://normal-goose-d5g4qyzr8bb389a4a.service.tcloudbase.com/r5',
  familyId: familyId(),
  /** 返回学习平台首页 */
  homeUrl: './index.html',
  timeoutMs: 15000,
};

export function isDebug() {
  return query('debug') === '1';
}
