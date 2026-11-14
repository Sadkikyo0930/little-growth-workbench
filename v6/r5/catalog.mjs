/**
 * v6/r5/catalog.mjs — 碎片赛车目录（与云函数 r5-racing-save 的 FRAGMENT_PROGRAM 同源）
 *
 * 为什么前端也留一份：
 *   走「家长身份」这条路时，页面读到的是 `r5_fragment_snapshot`（余额 + 已拥有 + 保底），
 *   车辆目录（车名 / 成本 / 缩略图）在云函数 `POST /v1/racing/save/get` 里，而那个接口
 *   要设备令牌。身份模式拿不到，所以这里放一份**只读展示用**的目录快照。
 *
 * 三条纪律：
 *   1. 只影响「显示什么车、目标几片、用哪张图」，不影响任何余额与规则；
 *      真正的进度只来自 service 端 snapshot；
 *   2. 组装时把 `cost` 原样交给数据库函数，由数据库校验余额、拒绝生日车/金币车；
 *   3. 这份目录必须与 `r5_frag/code/r5-racing-save/index.js` 的 FRAGMENT_PROGRAM 一致
 *      （测试 tools/catalog-check 会逐字段比对）。
 *
 * 外观与命名取自既有设计（11-12 交付），本文件不新增车辆、不改成本。
 */

export const CATALOG_SOURCE = 'r5-racing-save/FRAGMENT_PROGRAM (v2, 2026-11-12 交付)';

export const FRAGMENT_PROGRAM = Object.freeze({
  version: 'v2',
  /* 这份目录是离线展示兜底。概率 60% 已确认并已正式启用。 */
  catalog_only: true,
  common_fragment_id: 'frag_common',
  common_fragment_name: '星星碎片',
  rare_fragment_id: 'frag_scholar',
  rare_fragment_name: '学习徽章碎片',
  daily_cap: 2,
  rare_daily_cap: 1,
  pity_target: 5,
  /* 家长已确认并正式启用 60% 基础概率。真实规则仍由服务端 r5_reward_config 决定，
   * 这里只是离线兜底展示。 */
  drop_percent: 60,
  drop_percent_status: 'active',
  vehicles: Object.freeze([
    Object.freeze({
      vehicle_id: 'frag_car_common_01',
      name: '雷霆破晓',
      codename: 'THUNDER X',
      tier: 'normal',
      cost: Object.freeze({ frag_common: 12 }),
      drivable: true,
      placeholder: false,
      display_name_pending: false,
      note: '紫金火箭赛车，开放式单人驾驶舱，尾部大型推进器 + 青蓝光辅助喷口',
      art: Object.freeze({
        thumb: './assets/cars/frag_common_01-thumb.png',
        model: './assets/karts/frag-car-common-01.glb',
      }),
    }),
    Object.freeze({
      vehicle_id: 'frag_car_rare_01',
      name: '秋名疾影',
      codename: 'DRIFT 86',
      tier: 'rare',
      cost: Object.freeze({ frag_scholar: 8 }),
      drivable: true,
      placeholder: false,
      display_name_pending: false,
      note: '黑白 AE86 双门掀背，封闭车厢，专属碎片 8 片',
      art: Object.freeze({
        thumb: './assets/cars/frag_rare_01-thumb.png',
        model: './assets/karts/frag-car-rare-01.glb',
      }),
    }),
  ]),
  /* 明确不参与碎片组装的既有车辆（金币购买 / 剧情解锁 / v1 遗留槽位） */
  non_fragment_vehicles: Object.freeze(['moto', 'turtle', 'scholar']),
  legacy_slots: Object.freeze(['scholar']),
  /* 生日 / 限定车：永久隔离，仅用于展示说明，数据库侧同样硬拒绝 */
  excluded_vehicles: Object.freeze(['birthday-star-6', 'six-star-supercar-2026']),
  excluded_prefixes: Object.freeze(['pink-newyear', 'pink-new-year']),
});

/** 目录内的车（身份模式唯一允许提交组装的范围） */
export function vehicleOf(id) {
  return FRAGMENT_PROGRAM.vehicles.find(v => v.vehicle_id === String(id || '')) || null;
}

/** 给页面用的目录副本（深拷贝，避免调用方改到冻结对象） */
export function programForUI() {
  return JSON.parse(JSON.stringify(FRAGMENT_PROGRAM));
}
