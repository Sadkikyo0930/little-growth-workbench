# C0.1 — 权威学习日（authoritative day）候选包

**这是评审分支，不是发布源。** 本分支不合并 `main`、不改 Pages 发布源、未触碰任何正式数据库对象。

- 第一轮：桥接 + SW + SQL 候选（提交 `8b4ff68`）
- 第二轮：修复复审提出的初始化与 SECURITY DEFINER 两个阻碍（提交 `9bac99b`）
- 第三轮：修复**正式家庭真实计划历史**导致初始化被永久阻断的问题（本提交）

## 一句话

修复「学习日会被设备本地日期、跨日补交、多设备进度不一致带偏」的缺陷，把「今天是第几天」的唯一权威放到云端 `r5_family_progress.authoritative_day`，并保证 1800 秒限额、家长豁免、73 条历史学习记录、赛车（R5）站点零改动。

## 复现测试（唯一命令）

```bash
cd v6/c01
npm install        # 唯一依赖 @electric-sql/pglite@0.5.16（真实 PostgreSQL 18.6 / WASM）
npm test           # = node tests/run-all.mjs
```

预期输出（320 项，PASS）：

```
PASS     pre-s2       26/26 passed, 0 failed
PASS     bridge       71/71 passed, 0 failed
PASS     sw-cache     30/30 passed, 0 failed
PASS     sql-e2e      90/90 passed, 0 failed
PASS     init-day     18/18 passed, 0 failed
PASS     real-history 45/45 passed, 0 failed
PASS     security     27/27 passed, 0 failed
PASS     live-assets  13/13 passed, 0 failed
TOTAL    320/320 passed, 0 failed
```

`live-assets` 实时核验赛车仓库 pin 提交的 blob SHA。匿名 `api.github.com` 配额耗尽时该套件标记 `SKIPPED` / `UNVERIFIED`，**不会**用缓存冒充。

## 阻碍一：初始化不再猜（010）

- 迁移**一条 progress 记录都不插**。旧写法 `authoritative_day = MAX(r5_daily_plan.day_index)` 会把正式家庭错误地定到 2，从而重开 day2。
- 唯一入口 `r5_initialize_authoritative_day(family, day, by, snapshot_fingerprint, correction?)`：
  1. 运行时只读快照 `r5_initialization_snapshot()`（完整计划历史、max day、high-water 日期、最新计划日、该日记录携带的 learning_day、`blocking`、`corrections_required`）——不缓存、不落库；
  2. 快照指纹必须在调用时**重算一致**，否则 `R5_INIT_SNAPSHOT_STALE`；
  3. 快照有**硬阻断** → `R5_INIT_BLOCKED`（详见下节，纠错确认也无法绕过）；
  4. 有**待纠错项**却没有acknowledge → `R5_INIT_CORRECTION_REQUIRED`；
  5. 确认值必须落在 `[plan_max, plan_max+1]`：小于 → `R5_INIT_REGRESSION_REJECTED`（禁止写回 day1/day2），大于 → `R5_INIT_JUMP_REJECTED`（禁止跳到 day4）；
  6. 已初始化 → `already_initialized`，永不覆盖。
- `r5_progress_ensure()` 只为**全无历史**的新家庭建 day1；有历史却未初始化 → 抛 `R5_DAY_NOT_INITIALIZED`，发布路径失败关闭。桥接把该状态显示为 `day_not_initialized`，一条成绩都不上传。

## 阻碍三：正式家庭真实历史（C0.1.2）

正式家庭的计划历史不是「最大 day2」，而是：

| 日期 | day_index |
| --- | --- |
| 2026-11-11 | 2 |
| 2026-11-12 | 2 |
| 2026-11-13 | **1** ← 较新的日期写了较旧的 day |

C0.1.1 把它判为 `PLAN_NOT_MONOTONIC` 并直接 `R5_INIT_BLOCKED`，导致正式家庭**永远无法初始化**。现在把判据拆成两类：

| 类别 | 代码 | 处理 |
| --- | --- | --- |
| **硬阻断** | `DEVICE_DAY_DISAGREEMENT`、`RECORD_DAY_AHEAD_OF_PLAN`、`NO_PUBLISHED_PLAN_BUT_RECORDS`、`PLAN_DAY_OUT_OF_RANGE` | 一律 `R5_INIT_BLOCKED`，**任何确认都无法绕过** |
| **可纠错** | `PLAN_HISTORY_ROLLBACK`：最新计划日低于家庭 high-water 计划日 | 必须显式 acknowledge + 写明原因 |

纠错流程（不改任何历史数据）：

1. 家长/运维复核快照：`plan_history`、`plan_high_water_date`、`rollback_plan_rows` 逐行可见；
2. 以 owner 会话调用，带上 `{"acknowledged":["PLAN_HISTORY_ROLLBACK"],"reason":"..."}`；
3. 校验：`acknowledged` 里多出未要求的代码 → `R5_INIT_CORRECTION_UNKNOWN`；漏掉要求的 → `R5_INIT_CORRECTION_INCOMPLETE`；`reason` 少于 8 字 → `R5_INIT_CORRECTION_REASON_REQUIRED`；**快照干净时传纠错** → `R5_INIT_CORRECTION_NOT_NEEDED`（防止变成万能开关）；
4. 通过后写入 `r5_day_confirmation`（含 `corrections_applied`、`correction_reason`、完整快照与指纹）与 `r5_plan_audit`（事件 `initialize_authoritative_day_corrected`）；
5. **计划行与学习记录一个字节都不改**（P24 静态闸门 + R19/R20 字节比对）；
6. 权威日仍只来自调用方给出的确认值，不会自动变成 3 或 4。

## 阻碍二：SECURITY DEFINER 收紧（010 + 020）

- 4 张新表：`REVOKE ALL FROM PUBLIC` + `ENABLE ROW LEVEL SECURITY`（无 policy），只有 owner 可访问，客户端一律走函数。
- 所有新函数 `REVOKE ALL FROM PUBLIC`。仅 5 个客户端 API `GRANT EXECUTE TO authenticated`：`r5_publish_today`、`r5_gate_status_core`、`r5_advance_day`、`r5_credential_derive`、`r5_initialization_snapshot`。`anon` 一个都没有。
- 内部函数（`*_impl`、`r5_day_passed`、`r5_progress_ensure`、`r5_progress_maybe_advance`、`r5_refresh_credential_snapshot`、两个 `_legacy`、`r5_guard_plan_day`、`r5_initialize_authoritative_day`）owner-only。
- 每个客户端函数自己做身份校验：`r5_credential_derive` / `r5_initialization_snapshot` 调 `r5_assert_member`；`r5_advance_day` 要求 **owner/parent**；`r5_publish_today` / `r5_gate_status_core` 保持原判据。
- 初始化函数额外拒绝 `role=authenticated` 的会话（`R5_ADMIN_ONLY`），即使将来误授权也无效。
- 没有删除认证、没有关闭 RLS、没有放宽任何权限；1800 秒与旧签名逐字未动。

## 目录

| 路径 | 说明 |
| --- | --- |
| `v6/r5-bridge.js` | 候选桥接（权威学习日、三道 stale 闸门、待同步、未初始化状态） |
| `v6/sw.js`、`v6-selftest/sw.js` | 正式 / 自测 Service Worker（独立 cache PREFIX） |
| `v6/sql/c01/010_*` | 进度表 + 确认表 + 快照/初始化（含纠错）+ 凭证派生 + 权限块 |
| `v6/sql/c01/020_*` | 闸门包装、发布、推进、防回退触发器、权限块 |
| `v6/sql/c01/900_*` | 回滚（先删触发器 → 逐字节恢复生产函数体 → 删表 → 恢复 PUBLIC 默认授权） |
| `v6/sql/c01/legacy/*` | 生产函数体副本（仅改函数名，供 md5 校验） |
| `v6/c01/tests/` | 八套测试（26 + 71 + 30 + 90 + 18 + 45 + 27 + 13） |
| `v6/c01/fixtures/` | 生产形状 schema、只读基线、赛车资源 pin 清单 |
| `v6/c01/evidence/` | 最近一次运行的 JSON 证据 |

`v6/c01/candidate/**` 与部署路径上的 8 个文件 **blob SHA 完全相同**——被测字节就是发布字节。

## 明确未验证（不要当成已验证）

1. 未在任何共享 CloudBase 实例执行 DDL、加列、替换公共函数或改动权限；全部 SQL 验证在 PGlite（真实 PostgreSQL 18.6/WASM）上完成，`request.jwt.claims` 由测试注入，`authenticated` / `anon` 角色由测试创建，使 GRANT/REVOKE 断言真实生效。
2. 未用真实云端凭据调用 `r5_claim_answers`，未做真机（两日边界、旧设备重开、五设备）联调。
3. 未发布 Service Worker；旧缓存升级只在模拟 SW 环境验证。
4. 未读取、未改动正式家庭的任何一行数据（含 73 条历史学习记录）。真实历史形态来自脱敏后的日期/日序，在独立 PostgreSQL 中重建。
5. 未改动：1800 秒限额、家长豁免入口、赛车（R5）站点与存档、配额。

## 正式家庭初始化（需单独批准，由数据库 owner 执行）

```sql
-- 1) 只读复核（需该家庭成员身份）：看清 blocking / corrections_required
SELECT public.r5_initialization_snapshot('little-growth-family-001');
-- 2) 用上一步返回的 snapshot_fingerprint，以 owner 身份（无 JWT claims 的会话）执行。
--    正式家庭真实历史会要求纠错确认，原因必须写清楚：
SELECT public.r5_initialize_authoritative_day(
         'little-growth-family-001', 3, '<家长确认人>', '<snapshot_fingerprint>',
         '{"acknowledged":["PLAN_HISTORY_ROLLBACK"],"reason":"11-13 旧缓存把 day1 计划写回，家长确认继续 day3"}'::jsonb);
```

## 回滚

`v6/sql/c01/900_rollback.sql`：删触发器 → 逐字节恢复 `r5_gate_status_core` / `r5_publish_today` → DROP 新增函数（含两个 `r5_initialize_authoritative_day` 重载）与表 → 恢复两函数的 PUBLIC 默认授权。不触碰任何 child 表。
代码侧：`git checkout main -- v6/r5-bridge.js v6/sw.js v6-selftest/sw.js`。

`.gitattributes` 对本分支文件强制 `text eol=lf`，否则 Windows 检出会把 CRLF 带进 `prosrc`，使 md5 断言失效。
