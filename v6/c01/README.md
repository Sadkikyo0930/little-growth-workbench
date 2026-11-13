# C0.1 — 权威学习日（authoritative day）候选包

**这是评审分支，不是发布源。** 本分支不合并 `main`、不改 Pages 发布源、未触碰任何正式数据库对象。

## 一句话

修复「学习日会被设备本地日期、跨日补交、多设备进度不一致带偏」的缺陷，把「今天是第几天」的唯一权威放到云端 `r5_family_progress.authoritative_day`，并保证 1800 秒限额、家长豁免、73 条历史学习记录、赛车（R5）站点零改动。

## 复现测试（唯一命令）

```bash
cd v6/c01
npm install        # 唯一依赖 @electric-sql/pglite@0.5.16（真实 PostgreSQL 18.6 / WASM）
npm test           # = node tests/run-all.mjs
```

预期输出（210 项，PASS）：

```
PASS     pre-s2       15/15 passed, 0 failed, 0 skipped
PASS     bridge       65/65 passed, 0 failed, 0 skipped
PASS     sw-cache     30/30 passed, 0 failed, 0 skipped
PASS     sql-e2e      87/87 passed, 0 failed, 0 skipped
PASS     live-assets  13/13 passed, 0 failed, 0 skipped
TOTAL    210/210 passed, 0 failed, 0 skipped
VERDICT  PASS
```

`live-assets` 需要联网（实时核验赛车仓库 pin 提交的 blob SHA）。断网时会 `SKIPPED` 并把 `verdict` 降为 `INCOMPLETE`，**不会**用缓存结果冒充实时验证；离线降级路径由 `node tests/offline-proof.mjs` 单独证明。

## 目录

| 路径 | 说明 |
| --- | --- |
| `candidate/v6/r5-bridge.js` | 候选桥接（权威学习日同步、三道 stale 闸门、待同步/待核实状态） |
| `candidate/v6/sw.js` | 正式 Service Worker（缓存修复） |
| `candidate/v6-selftest/sw.js` | 自测 Service Worker（独立 cache PREFIX） |
| `candidate/sql/010_authoritative_day.sql` | 新建 `r5_family_progress` / 凭证派生引擎 |
| `candidate/sql/020_gate_and_publish.sql` | 闸门包装、发布、推进、防回退触发器 |
| `candidate/sql/900_rollback.sql` | 逐字节回滚（先删触发器，再恢复原函数体） |
| `candidate/sql/legacy/*.sql` | 生产函数体副本，仅改函数名，供 md5 校验 |
| `tests/` | 五套测试（15 + 65 + 30 + 87 + 13） |
| `fixtures/` | 生产形状 schema、只读基线、赛车资源 pin 清单 |
| `evidence/` | 最近一次运行的 JSON 证据 |

## 与实际部署路径的关系

`candidate/` 下是**被测字节**。同一份内容也放在浏览器真正加载的路径上，两份 blob SHA 完全相同（内容寻址，可直接核对）：

| 部署路径 | 被测路径 | blob SHA |
| --- | --- | --- |
| `v6/r5-bridge.js` | `v6/c01/candidate/v6/r5-bridge.js` | `dc06f6dd2ecefbe814f5fbe2855601d57551705c` |
| `v6/sw.js` | `v6/c01/candidate/v6/sw.js` | `55a16a1f70878ebb8d43b6e218a55285ea8cab30` |
| `v6-selftest/sw.js` | `v6/c01/candidate/v6-selftest/sw.js` | `897169926983dc735e9ad96412d52e3a21fa464d` |
| `v6/sql/c01/010_authoritative_day.sql` | `v6/c01/candidate/sql/010_authoritative_day.sql` | `1cdcf0d3086d695fceaa1c6b77a5753d14470843` |
| `v6/sql/c01/020_gate_and_publish.sql` | `v6/c01/candidate/sql/020_gate_and_publish.sql` | `3458cf8c305cd1ef21fb264b1cc6d44874f01440` |
| `v6/sql/c01/900_rollback.sql` | `v6/c01/candidate/sql/900_rollback.sql` | `48f8a1ddfd099cff3729a4004617165cf450b50b` |
| `v6/sql/c01/legacy/r5_gate_status_core.production.sql` | 同名 | `d4cbcee072ccf2630639bd6a118003c84a971ebd` |
| `v6/sql/c01/legacy/r5_publish_today.production.sql` | 同名 | `062cfd7aa46e2de24cf1bd58e7c3fe1b8e3b619b` |

`tests/pre-s2.test.mjs` 的 P4 / P6 用 md5 锁住「生产函数体逐字节未改」：

- `r5_gate_status_core` → `f78aceeba9c934fa8f4b5c754daba101`
- `r5_publish_today` → `b0d8d2deb58ab5240c9207e6b5081ea3`
- `r5_claim_answers` → `45ef62312ed179f299700946c9c7863d`

`.gitattributes` 对本分支涉及的文件强制 `text eol=lf`，否则 Windows 检出会把 CRLF 带进 `prosrc`，使上面的 md5 断言失效。

## 明确未验证（不要当成已验证）

1. **未在任何共享 CloudBase 实例执行 DDL、加列、替换公共函数或改动权限。** 全部 SQL 验证在 PGlite（真实 PostgreSQL 18.6/WASM）上完成，`request.jwt.claims` 由测试注入。
2. **未用真实云端凭证调用 `r5_claim_answers`**，未做真机（第二日→第三日、旧设备次日重开、五设备）联调。
3. **未发布 Service Worker**，旧缓存升级只在模拟 SW 环境验证。
4. 未改动：`1800` 秒限额、家长豁免入口、赛车（R5）站点与存档、配额、73 条历史学习记录。

## 回滚

`v6/sql/c01/900_rollback.sql` 顺序：删触发器 → 用 `legacy/` 逐字节恢复 `r5_gate_status_core` 与 `r5_publish_today` → DROP 新增函数/表。不触碰任何 child 表。代码侧回滚 = 把 `v6/r5-bridge.js`、`v6/sw.js`、`v6-selftest/sw.js` 三个 blob 退回 `main` 版本（`git checkout main -- <path>`）。
