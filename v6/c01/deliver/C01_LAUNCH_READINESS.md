# C0.1.5 — 正式上线前最后四项阻碍核实

生成时间：2026-11-14 10:05 (+08:00) · 全部操作只读
候选：`e4afc8c` + 本轮增量 · 分支 `c01/authoritative-day-candidate` · main 未动（`1a593fc9`）

本轮没有执行：正式库 DDL/DML、云函数替换、静态站点发布、main 合并、任何账号或额度变更。

---

## 0. 结论先行

| 问题 | 答案 |
| --- | --- |
| 是否可申请正式部署授权 | **不可以**。1 项必须你决策，3 项必须书面接受 |
| 阻碍已解决几项 | A（备份恢复）已解决并实测；B（day3 兼容）已解决并彩排 31/31；C 只完成只读事实，真实调用未做 |
| 新发现的硬阻碍 | **线上 V6 加载的是 `r5-bridge.test.js`，不是 `r5-bridge.js`；`v6/sw.js` 目前 404** |

---

## 1. 正式上线前还有哪些真实阻碍

### R1（新发现，硬阻碍，需你决策）Web 层部署目标与文件名不一致

线上实际状态（2026-11-14 10:01 逐一探测）：

| 路径 | 状态 |
| --- | --- |
| `/v6/index.html` | 200，1,139,535 B |
| `/v6/r5-bridge.test.js` | **200，34,265 B** ← 页面真正加载的桥接 |
| `/v6/r5-bridge.js` | **404** ← 候选文件名 |
| `/v6/sw.js` | **404** ← `pwa.js` 却在 `register('./sw.js')` |
| `/v6/pwa.js` | 200，5,461 B（第 68 行注册 `./sw.js`） |
| `/v6/november-subject-schedule.js` | 200，2,429 B |

线上桥接里没有 `BRIDGE_BUILD`、没有 `authoritative_day`、没有 `stale_device_day`，只调用 `r5_publish_today` 和 `r5_status` —— 是**没有权威学习日逻辑的旧版**。

后果：

1. 只上传 `v6/r5-bridge.js` **不会生效**，`index.html` 根本不引用它。必须二选一：
   - **方案 A**：用候选桥接内容覆盖 `v6/r5-bridge.test.js`（文件名不变，`index.html` 零改动，回滚就是还原这个文件）；
   - **方案 B**：改 `index.html` 加一行 `<script src="./r5-bridge.js">`（改动面更大，要动 1.1 MB 的主页面）。
2. `pwa.js` 注册的 `./sw.js` 今天 404 → **生产当前没有任何 Service Worker 在生效**。上传候选 `sw.js` 等于**首次激活**，而不是"替换旧 SW"。候选 SW 里是 `skipWaiting()` + `clients.claim()`，安装即接管已打开的标签页。
3. 候选 SW **没有** `unregister` 兜底。一旦激活，删除 `sw.js` 不会让它消失，必须再发布一个"自杀版本"。这是**单向操作**。

> 这三条我都不替你选。方案 A 风险最低，但要你确认"覆盖一个名字里带 `.test` 的文件"是否可以接受。

### R2（流程，必须执行日做）day3 的确认证据不能今天定稿

家长已确认 day1 完成、day2 完成、day3 正在学数学+英语 —— 这个结论已被三份独立证据交叉印证（见 §2.B），可以定案。但**快照必须在执行当天重算**：家庭计划随时可能被旧设备再写一行，`RECORD_DAY_AHEAD_OF_PLAN` 的判据只看"记录日期 = 最新计划日"那一天的记录，脆性很高（彩排 B8 已证它今天不触发，但不保证明天）。

### R3（排期）B 与 F 必须同一窗口

彩排实测（B0/B1）：010+020 部署完成后、初始化之前，

- `r5_publish_today` 抛 `R5_DAY_NOT_INITIALIZED` → 家里**发不出当天计划**；
- `r5_status` 仍返回合法 `allowed`（闸门降级可用，不是 500）。

今天 11-14 计划表 0 行、用量 0 行 —— 现在是最干净的窗口。必须在孩子开始第三日学习之前完成 F。

### R4（不变）共享实例

只有一个环境 `normal-goose-d5g4qyzr8bb389a4a`（TenantType=SHARED）。迁移是共享的，不能称为隔离灰度。

### R5（已查明，需书面接受）没有原生备份/PITR 可自助使用

见 §2.A 的实测结果。结论是"能做出可恢复的逻辑备份"，但**没有平台级一键恢复**。

### R6（需书面接受）验证引擎与正式库主版本不同

正式库是 **PostgreSQL 17.11**（`server_version` 实测），独立验证用的是 PGlite（PG 18.6 WASM）。我把候选 SQL 全量扫了一遍，没有 18-only 语法（`MERGE` / `ANY_VALUE` / `uuidv7` / `WITHOUT OVERLAPS` 一律未使用），用到的 `jsonb_agg(... ORDER BY ...)`、`acldefault`、`aclexplode`、`oidvectortypes`、`pg_get_function_identity_arguments` 在 17 都存在。但"没有在 17 上真跑过"是事实。

---

## 2. 哪些阻碍已解决（附验证证据）

### A. 备份与恢复能力 —— 已解决，且做了真实还原

只读实测的四条硬事实：

| 检查 | 结果 | 含义 |
| --- | --- | --- |
| `current_user` | `cloudbase_postgres_postgres_130fh140`，`rolsuper=false`，`rolreplication=false` | 无法 `pg_basebackup` |
| `archive_mode` / `archive_command` | `on` / `pg_xlog_archive.sh` | 平台配了 WAL 归档 |
| `pg_stat_archiver` | 全 NULL（`archived_count` 也为 NULL） | **无法确认存在可用还原点** |
| `pg_stat_replication` | 0 行 | 无物理备库 |
| TCP | `inet_server_addr=28.248.135.70:50967`（VPC 内网） | 外部 `pg_dump` 连不上 |
| MCP/API 面 | 只有 SQL + migration，无 backup/restore 动作 | 无一键恢复入口 |

但当前角色对全部 20 张表都有 `INSERT/DELETE/UPDATE/SELECT` → **逻辑备份是可还原的**。

实测（`tests/isolated/restore-drill.mjs`，19/19 PASS）：

1. 6 张关键表的真实字节导出（read-only，`jsonb_agg(to_jsonb(x) ORDER BY key)`）：`r5_parent_settings` 2 行、`r5_daily_plan` 10 行、`r5_subject_template` 30 行、`r5_racing_saves` 1 行、`r5_daily_usage` 2 行、`growth_family_members` 10 行 = **55 行**。
2. 灌进一个**从未见过这些数据**的全新 PG 实例，按生产列类型建表后逐行插入。
3. 用生产同一算法 `md5(jsonb_agg(to_jsonb(x) ORDER BY key))`（时区强制 `Asia/Shanghai`）重算 → **6/6 与生产完全一致**，含 `timestamptz` 偏移、`jsonb` 嵌套、`bigint`。
4. 再把 6 张表清空，仅凭 dump 重新插入 → **再次 6/6 一致**（这才是"恢复"而不是"插入"）。

**未闭环项（诚实说明）**：`growth_learning_records` 126 行（其中正式家庭 73 行）本轮**没有做字节级还原演练**。它的导出、插入路径同上，但我没跑。73 行另外有独立可复算指纹 `eb29dabf6924badc84457397613eeb26`（`md5(string_agg(record_id|subject|learning_day|record_type|md5(record_data::text)))`），可用于执行日前后比对。**这一项必须在维护窗口里补做，覆盖全 20 张表。**

### B. 第三学习日与真实历史完全兼容 —— 已解决，彩排 31/31

`tests/isolated/rehearsal.mjs`：用**正式家庭的真实形态**（6 行计划 `[1,1,1,2,2,1]`、73 条记录的真实分组与对错比、3 名成员、1800 秒）在全新实例里跑完整链路。

关键实测结果：

| 编号 | 断言 | 结果 |
| --- | --- | --- |
| B2–B3 | `plan_days=[1,1,1,2,2,1]`、`plan_max=2`、`latest=1`、high-water `11-11` | ✅ |
| B4–B5 | 回退行恰好 1 条（`11-13 day1`），只产生 `PLAN_HISTORY_ROLLBACK`，`blocking=[]` | ✅ |
| B6 | 窗口收敛为 `[3,3]` —— **唯一可接受值就是 day3** | ✅ |
| B7–B8 | 记录日集合 `[1,6,9]`，最新计划日当天 0 条记录 → 不触发 `DEVICE_DAY_DISAGREEMENT` / `RECORD_DAY_AHEAD_OF_PLAN` | ✅ |
| B9–B11 | 确认 day2 被拒、day4 被拒、不承认回退直接确认 day3 被拒 | ✅ |
| B12–B15 | 带 `PLAN_HISTORY_ROLLBACK` + 家长理由确认 day3 成功；进度行 `initialized_from=parent_confirmed`；`last_advanced_on` 仍为 NULL；审计行存下 day3 / 纠错码 / 理由 | ✅ |
| B16–B17 | 初始化**零写入**：计划与记录指纹不变，**没有一条 day3 记录被造出来** | ✅ |
| B18 | 旧设备想写"今天的 day1 计划"→ 触发器 `R5_PLAN_DAY_REGRESSION` 拒绝 | ✅ |
| B19–B20 | 客户端仍报 day1 时，服务端发布 **day3 + 数学/英语** 并回 `stale_client=true` | ✅ |
| B21–B22 | 无 day3 证据闸门关闭；**day1 英语记录没有被借作 day3 英语**（`evidence≠CREDENTIAL_FROM_HISTORY`） | ✅ |
| B23–B24 | 只完成数学 → 关闭；英语 60% → 仍关闭 | ✅ |
| B25 | 两科完成且 ≥80% → `allowed=true`（赛车解锁信号） | ✅ |
| B26 | **完成 day3 不自动跳 day4**（`authoritative_day` 仍 3） | ✅ |
| B28 | 跑完整套后 73 条历史记录逐字节不变 | ✅ |
| B29 | 1800 秒 / 奖励 0 / 家长开关不变 | ✅ |

**三方交叉印证 day3 = 数学+英语**：家长口述、`r5_subject_template` day3、线上 `november-subject-schedule.js`（`version 2026-11-04`）day3，三处完全一致。家长说的"第二学习日 语文+数学"也与模板 day2 一致 —— 说明家长的日次编号与系统日次编号是同一套。

**注意 day2**：云端 day2（11-11 / 11-12）**一条成绩记录都没有**。彩排证明这不影响 day3 初始化、不影响闸门、不需要补课、也不需要补写任何历史成绩。B16/B17 就是"没有伪造"的证据。

### C. 网关联调 —— 只读事实已定，真实调用未做

| 事实 | 值 |
| --- | --- |
| 网关路由 | `/r5` → SCF `r5-gateway`，`EnableAuth=false`（鉴权在函数内） |
| `r5-gateway` 代码 SHA256 | `c95c3d4b961f9441bf6dcb9b0947f4ba29095ca63f15538734a4abc26e22636c`（我下载 zip 复算一致） |
| 函数内建连方式 | `sqlAs({sub, role:'authenticated'})` 只 `set_config('request.jwt.claims')`；`ExecutePGSql` **不传 Role** → 走平台默认角色 |
| 客户端真实路径 | `https://normal-goose-...api.tcloudbasegateway.com/v1/rdb/rest`（PostgREST 兼容） |
| 未授权探测 | `GET /growth_learning_records` → **401 MISSING_CREDENTIALS**；`POST /rpc/r5_status` → **401** |
| 线上桥接用到的 RPC | `r5_status`、`r5_publish_today` |

这条链很重要：客户端能**直连 REST 的 `/rpc/`**，所以 `authenticated` 的 EXECUTE 授权是**真实边界**，不是装饰。把 `r5_gate_status_core` 从 `authenticated` 收回，确实堵住了 `POST /rpc/r5_gate_status_core {p_ignore_override:true}` 这条家长 override 旁路。

**未验证**：带真实 JWT 的 RPC 往返、`r5_claim_answers` 去重、`r5_advance_day` 在新旧云端的行为差异、赛车入口的真实返回。

### 正式环境基线复核（与上一轮一致，无漂移）

| 项 | 值 |
| --- | --- |
| 正式家庭记录 | 73 条，指纹 `eb29dabf6924badc84457397613eeb26` |
| 计划历史 | 6 行 `[1,1,1,2,2,1]`（另有 selftest 4 行） |
| 冻结函数 md5 | 9/9 与已知值一致（`r5_gate_status_core` `f78aceeb…`、`r5_publish_today` `b0d8d2de…`、`r5_claim_answers` `45ef6231…`） |
| ACL | `r5_gate_status_core` / `r5_gate_status` / `r5_override_active` = **service_role + owner**；其余客户端 API = authenticated + service_role + owner；**无任何 PUBLIC** |
| C0.1 五张表 | 全部不存在 |
| 迁移历史 | 11 条，最新 `20261113111500 session_binding_guard`，无 C0.1 登记 |
| 1800 秒 | `daily_seconds=1800`、`bonus_seconds=0`、`enabled=true` |

---

## 3. 是否可以申请正式部署授权

**不可以。** 需要你先处理这三类，没有一项能靠继续写测试解决：

1. **决策（必选其一）**：R1 —— 覆盖 `r5-bridge.test.js`（方案 A，推荐）还是改 `index.html`（方案 B）；以及是否接受"首次激活 Service Worker"这件不可逆的事。
2. **书面接受**：共享实例风险、无平台级恢复入口（只有逻辑备份 + 900 回滚）、PG 17 未同版本验证。
3. **窗口内执行**：全 20 表备份（补上 learning_records 的还原演练）、执行日快照复核、初始化。

三项齐备后可申请，**B（迁移+函数切换）与 F（正式家庭初始化）仍需各自单独授权**。

---

## 4. 正式部署会改动哪些对象

### 数据库（B 阶段，`applyMigration`）

**新建**

- 5 张表：`r5_family_progress`、`r5_plan_audit`、`r5_credential_snapshot`、`r5_day_confirmation`、`r5_acl_baseline` + 2 个序列
- 新函数（约 15 个）：`r5_initialization_snapshot(_impl)`、`r5_initialize_authoritative_day`、`r5_credential_derive(_impl)`、`r5_subject_canonical`、`r5_day_passed`、`r5_progress_ensure`、`r5_progress_maybe_advance`、`r5_advance_day`、`r5_guard_plan_day`、`r5_refresh_credential_snapshot`、两个 `_legacy`
- 1 个触发器：`r5_daily_plan_day_guard` on `r5_daily_plan`（BEFORE INSERT OR UPDATE，只对"今天"的计划生效，历史行不拦）

**替换（同名同签名，旧客户端不受影响）**

- `r5_gate_status_core(text,boolean,boolean)`
- `r5_publish_today(text,integer,boolean)`

**权限变化（只收紧，不扩大）**

- `r5_gate_status_core`：保持"仅 service_role + owner"，**不给 authenticated**
- `r5_publish_today`：保持 authenticated + service_role + owner
- 新增函数：5 个客户端 API 授 `authenticated`，其余 owner-only；**任何对象都不新增 PUBLIC**
- 4 张业务新表：`REVOKE ALL FROM PUBLIC` + RLS 开启 + 零 policy

**登记**

- `cloudbase_migrations.schema_migrations` +1 行（`applyMigration` 自动写，同时把 `rollbackSql` 一起登记）

**运行后才会产生的数据**

- `r5_family_progress` 正式家庭 1 行（day3）
- `r5_day_confirmation` 1 行（含纠错码与家长理由）
- `r5_plan_audit` 若干行（初始化、发布、陈旧设备拒绝）
- `r5_daily_plan` 今天 1 行（day3，数学+英语）

**明确不改**

`growth_learning_records`（0 写 0 改）、`growth_families`、`growth_family_members`、`r5_parent_settings`、`r5_parent_waiver`、`r5_racing_saves`、`r5_racing_events`、`r5_device`、`r5_subject_template`、`r5_daily_usage`、`auth.*`

### 静态托管（D 阶段）

- 新增或覆盖 **1 个桥接文件**（文件名取决于 R1 决策）
- 新增 `v6/sw.js`（首次激活）
- 如选方案 B，还要改 `v6/index.html`

---

## 5. 一旦失败如何恢复

| 失败点 | 恢复动作 | 是否可逆 |
| --- | --- | --- |
| 迁移中途失败 | `applyMigration` 整体失败即无残留；若部分对象已建，跑 `900_rollback.sql`（末尾自校验 ACL，不一致直接抛 `R5_ROLLBACK_ACL_MISMATCH` 让回滚失败而不是静默通过） | 可逆 |
| 函数替换后行为异常 | `900` 逐字节恢复两个生产函数体（md5 `f78aceeb…` / `b0d8d2de…`），逐函数逐签名恢复 ACL，**不恢复 PUBLIC** | 可逆，已实测 60/60 |
| 初始化写错日 | `r5_family_progress` 只有 1 行 → 删除该行即回到"未初始化"；`r5_day_confirmation` / `r5_plan_audit` 的留痕可查。**不触碰任何学习记录** | 可逆（需授权一次 DELETE） |
| 正式家庭新数据不可用 | 用窗口前导出的全表 dump 回填；`r5_racing_saves.revision` 单调，可与 dump 比对确认未回退 | 可逆 |
| **Service Worker 已激活** | **删除 `sw.js` 无效**。必须再发布一个 `sw.js`，内容为 `self.registration.unregister()` + `caches.keys()` 全清 | **单向，需要额外一次发布** |

最后一行是本轮唯一"不可逆"的操作，也是 R1 里建议选方案 A（不动 index.html）、并把 SW 放到最后一步单独做的原因。

---

## 6. 建议的执行顺序（每条都有停止条件）

| 阶段 | 内容 | 停止条件 |
| --- | --- | --- |
| A | 只读基线复核：73 条指纹 `eb29dabf…`、计划 6 行、函数 md5 9/9、ACL、5 表不存在、迁移 11 条 | 任一不符即停，不进 B |
| 备份 | 全 20 表逻辑导出 + 函数体 + `proacl`/`relacl` + 迁移历史；立刻做一次 6 表还原演练（补上 learning_records） | 任一表还原后指纹不一致即停 |
| B | `applyMigration` 上 010+020（**单独授权**） | 迁移失败 / 迁移后 `pg_proc` md5 与基线不符 / 出现任何 PUBLIC 授权 → 停，跑 900 |
| F | 执行日重算快照 → 家长确认 day3 → 带 `PLAN_HISTORY_ROLLBACK` 初始化（**单独授权**） | 窗口不是 `[3,3]` / 出现 `blocking` / 指纹与刚读到的不一致 → 停，重新确认，**不硬写 day3** |
| C | 用真实 JWT 打 `r5_status` → `r5_publish_today`（客户端报 day1，须回 day3）→ 上传一道 day3 题 → 再查闸门 | 任一步与彩排不符即停 |
| D | 上传桥接与 `v6/sw.js`，iPhone 开自测页 | 页面显示的天数与云端不一致即停 |
| E | 家长在页面上确认第一天/第二天已完成、第三天正在学 | 家长改口 → 停，回到 F 重新确认 |
| G | 清理 `r5-selftest-family` 里 3 个误加的正式账号（先用独立测试账号验证不锁死） | 独立账号登录失败即停 |

**C/D/E 顺序不能颠倒**：D 上线前必须先证明云端已经回到 day3，否则旧页面会拿着 day1 继续写。
