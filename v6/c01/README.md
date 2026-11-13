# C0.1 — 权威学习日（authoritative day）候选包

**这是评审分支，不是发布源。** 本分支不合并 `main`、不改 Pages 发布源、未触碰任何正式数据库对象。

第二轮：修复复审提出的两个上线阻碍（初始化、SECURITY DEFINER 权限）。

## 一句话

修复「学习日会被设备本地日期、跨日补交、多设备进度不一致带偏」的缺陷，把「今天是第几天」的唯一权威放到云端 `r5_family_progress.authoritative_day`，并保证 1800 秒限额、家长豁免、73 条历史学习记录、赛车（R5）站点零改动。

## 复现测试（唯一命令）

```bash
cd v6/c01
npm install        # 唯一依赖 @electric-sql/pglite@0.5.16（真实 PostgreSQL 18.6 / WASM）
npm test           # = node tests/run-all.mjs
```

预期输出（272 项，PASS）：

```
PASS     pre-s2       23/23 passed, 0 failed
PASS     bridge       71/71 passed, 0 failed
PASS     sw-cache     30/30 passed, 0 failed
PASS     sql-e2e      90/90 passed, 0 failed
PASS     init-day     18/18 passed, 0 failed
PASS     security     27/27 passed, 0 failed
PASS     live-assets  13/13 passed, 0 failed, 9 skipped*
TOTAL    272/272 passed, 0 failed
```

`live-assets` 实时核验赛车仓库 pin 提交的 blob SHA。匿名 `api.github.com` 配额耗尽时该套件
标记 `SKIPPED` / `UNVERIFIED`，**不会**用缓存冒充；本轮另用已授权连接器在同一 pin 上完成
6/6 核验，记录在 `evidence/live-assets-mcp.json`。

## 阻碍一：初始化不再猜（010）

- 迁移**一条 progress 记录都不插**。旧写法 `authoritative_day = MAX(r5_daily_plan.day_index)`
  会把正式家庭（历史最大 day2、家长已在 day3）错误地定到 2，从而重开 day2。
- 唯一入口 `r5_initialize_authoritative_day(family, day, by, snapshot_fingerprint)`：
  1. 运行时只读快照 `r5_initialization_snapshot()`（计划 max day、最新计划日、该日记录携带的
     learning_day、阻断原因）——不缓存、不落库；
  2. 快照指纹必须在调用时**重算一致**，否则 `R5_INIT_SNAPSHOT_STALE`；
  3. 快照有阻断原因（`DEVICE_DAY_DISAGREEMENT` / `PLAN_NOT_MONOTONIC` /
     `RECORD_DAY_AHEAD_OF_PLAN` / `NO_PUBLISHED_PLAN_BUT_RECORDS`）→ `R5_INIT_BLOCKED`；
  4. 确认值必须落在 `[plan_max, plan_max+1]`：小于 → `R5_INIT_REGRESSION_REJECTED`
     （禁止写回 day1/day2），大于 → `R5_INIT_JUMP_REJECTED`（禁止跳到 day4）；
  5. 已初始化 → `already_initialized`，永不覆盖。
- `r5_progress_ensure()` 只为**全无历史**的新家庭建 day1；有历史却未初始化 → 抛
  `R5_DAY_NOT_INITIALIZED`，发布路径失败关闭。桥接把该状态显示为 `day_not_initialized`，
  一条成绩都不上传。

## 阻碍二：SECURITY DEFINER 收紧（010 + 020）

- 4 张新表：`REVOKE ALL FROM PUBLIC` + `ENABLE ROW LEVEL SECURITY`（无 policy），
  只有 owner 可访问，客户端一律走函数。
- 所有新函数 `REVOKE ALL FROM PUBLIC`。仅 5 个客户端 API `GRANT EXECUTE TO authenticated`：
  `r5_publish_today`、`r5_gate_status_core`、`r5_advance_day`、`r5_credential_derive`、
  `r5_initialization_snapshot`。`anon` 一个都没有。
- 内部函数（`*_impl`、`r5_day_passed`、`r5_progress_ensure`、`r5_progress_maybe_advance`、
  `r5_refresh_credential_snapshot`、两个 `_legacy`、`r5_guard_plan_day`、
  `r5_initialize_authoritative_day`）owner-only。
- 每个客户端函数自己做身份校验：`r5_credential_derive` / `r5_initialization_snapshot` 调
  `r5_assert_member`；`r5_advance_day` 要求 **owner/parent**（祖辈/孩子不能再推进学习日）；
  `r5_publish_today` / `r5_gate_status_core` 保持原判据。
- 初始化函数额外拒绝 `role=authenticated` 的会话（`R5_ADMIN_ONLY`），即使将来误授权也无效。
- 没有删除认证、没有关闭 RLS、没有放宽任何权限；1800 秒与旧签名逐字未动。

## 目录

| 路径 | 说明 |
| --- | --- |
| `v6/r5-bridge.js` | 候选桥接（权威学习日、三道 stale 闸门、待同步、未初始化状态） |
| `v6/sw.js`、`v6-selftest/sw.js` | 正式 / 自测 Service Worker（独立 cache PREFIX） |
| `v6/sql/c01/010_*` | 进度表 + 确认表 + 快照/初始化 + 凭证派生 + 权限块 |
| `v6/sql/c01/020_*` | 闸门包装、发布、推进、防回退触发器、权限块 |
| `v6/sql/c01/900_*` | 回滚（先删触发器 → 逐字节恢复生产函数体 → 删表 → 恢复 PUBLIC 默认授权） |
| `v6/sql/c01/legacy/*` | 生产函数体副本（仅改函数名，供 md5 校验） |
| `v6/c01/tests/` | 七套测试（23 + 71 + 30 + 90 + 18 + 27 + 13） |
| `v6/c01/fixtures/` | 生产形状 schema、只读基线、赛车资源 pin 清单 |
| `v6/c01/evidence/` | 最近一次运行的 JSON 证据 |

`v6/c01/candidate/**` 与部署路径上的 8 个文件 **blob SHA 完全相同**——被测字节就是发布字节。

## 明确未验证（不要当成已验证）

1. 未在任何共享 CloudBase 实例执行 DDL、加列、替换公共函数或改动权限；全部 SQL 验证在
   PGlite（真实 PostgreSQL 18.6/WASM）上完成，`request.jwt.claims` 由测试注入，
   `authenticated` / `anon` 角色由测试创建，使 GRANT/REVOKE 断言真实生效。
2. 未用真实云端凭据调用 `r5_claim_answers`，未做真机（两日边界、旧设备重开、五设备）联调。
3. 未发布 Service Worker；旧缓存升级只在模拟 SW 环境验证。
4. 未改动：1800 秒限额、家长豁免入口、赛车（R5）站点与存档、配额、73 条历史学习记录。

## 正式家庭初始化（需单独批准，由数据库 owner 执行）

```sql
-- 1) 只读复核（需该家庭成员身份）
SELECT public.r5_initialization_snapshot('little-growth-family-001');
-- 2) 用上一步返回的 snapshot_fingerprint，以 owner 身份（无 JWT claims 的会话）执行
SELECT public.r5_initialize_authoritative_day(
         'little-growth-family-001', 3, '<家长确认人>', '<snapshot_fingerprint>');
```

## 回滚

`v6/sql/c01/900_rollback.sql`：删触发器 → 逐字节恢复 `r5_gate_status_core` /
`r5_publish_today` → DROP 新增函数与表 → 恢复两函数的 PUBLIC 默认授权。不触碰任何 child 表。
代码侧：`git checkout main -- v6/r5-bridge.js v6/sw.js v6-selftest/sw.js`。

`.gitattributes` 对本分支文件强制 `text eol=lf`，否则 Windows 检出会把 CRLF 带进 `prosrc`，
使 md5 断言失效。
