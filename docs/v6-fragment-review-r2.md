# PR #3 第二轮安全审查 · 四条阻断项的处理

日期：2026-11-14 ｜ 分支 `feat/v6-garage-restore-20261114` ｜ **仍未合并 main，未执行任何正式 SQL**

审查意见原文见 PR #3 的评论（2026-11-14）。四条阻断项逐条对应到代码，行为证据在
`db/isolated/run-authority.mjs`（54 项，真实 Postgres / PGlite）。

---

## 0. 先回答「赛车网关到底用什么身份连库」

这决定了守卫能不能收紧。核实路径（只读，不改任何东西）：

| 环节 | 事实 | 依据 |
|---|---|---|
| 浏览器 | 只带 `x-r5-device: r5dev_…` | `v6/r5/fragment-client.mjs` |
| `r5-gateway` | 服务端自己查 `r5_device` 反查家庭，签 `r5_identity`（HMAC），再用 `app.callFunction` 调下游 | `services/r5-gateway/index.js`：`racingSaveCall()`、`sqlAs()` |
| `r5-gateway` 自己执行 SQL | 走**云 API `ExecutePGSql`**，用函数进程内的账号级凭据 | 同文件 `runSql()` → `getClient().ExecutePGSql({EnvId, Sql})` |
| `r5-racing-save` | 被网关以服务端身份调用（`app.callFunction`），不是浏览器直连 | 同上 |
| 数据库角色 | 迁移、DDL、`pg_get_functiondef` 都是同一个通道做成的 → 该通道是**库属主**级别，不是 `anon` | 线上 11 条 `schema_migrations` 即由该通道写入 |

**结论**：赛车从来不走「匿名 PostgREST + 设备 UID」这条路。所以把匿名设备路径关掉，
赛车不受影响；真正要保的是「服务端连接（库属主 / service_role）照常能领取和组装」。

这条结论有一个**落地前必须跑的确认**（见第 6 节），因为它决定 `r5_backend_role` 白名单里要有哪些值。

---

## 1. 阻断 1：空 JWT claims 不能直接获得特权

**旧实现（被否）**

```sql
IF v_claims IS NULL OR v_claims = '{}'::jsonb THEN RETURN true;   -- 没带身份 = 可信服务端
```

审查意见指出两点，都成立：
① 「没有 claims」不是「可信」的证明，能清 claims 的人就自动变成特权；
② `SECURITY DEFINER` 内 `current_user` 会变成函数属主，所以也不能拿它当调用方身份。

**新实现**

```sql
v_privileged := public.r5_fragment_is_privileged();   -- 只看数据库角色
IF NOT v_privileged THEN
  IF v_claims IS NULL OR v_claims = '{}'::jsonb THEN RETURN false;  -- 没身份就是没身份
  ...
```

`r5_fragment_caller_role()`：

```sql
SELECT CASE WHEN COALESCE(current_setting('role', true), 'none') IN ('', 'none')
            THEN session_user
            ELSE current_setting('role', true) END;
```

为什么用 GUC `role` 而不是 `current_user`：隔离库实测（`role-probe2.mjs` 的操作，结论写进测试 F8）

```
anon 连接调用 SECURITY DEFINER 函数 → current_user = postgres（属主）, role GUC = anon
库属主连接调用同一函数             → current_user = postgres,            role GUC = none
```

`role` GUC 不被 `SECURITY DEFINER` 改写，正好是审查意见要的那个「独立于函数属主的连接身份」。

特权判定 = 在白名单 `r5_backend_role` 里 **或** `rolsuper` **或** `rolbypassrls`。
`claims.role = 'service_role'` **不再有任何授权效力**（伪造无效，F3/F4/F10 证明）。

对应的否定性测试：`F1` anon+空 claims、`F2` authenticated+空 claims、`F3/F4` 伪造 service_role、
`F5` 伪造 service_role 不产生额外权力、`F6` 真实服务端连接、`F7` service_role、`F8` definer 内识别原调用者。

---

## 2. 阻断 2：设备 UID 不等于已验证认证

**旧实现（被否）**：`anon` 只要知道某个 `device_uid`，就能以那个设备的身份读写。

**新实现**：非特权连接**完全不能走设备路径**（代码里只有 `IF v_privileged` 之后才有 `r5_device` 分支）。
设备领取只走已鉴权的网关：

```
浏览器 ──x-r5-device──▶ r5-gateway ──(服务端查 r5_device、签 HMAC)──▶ r5-racing-save ──▶ ExecutePGSql
```

特权连接如果**声称**了设备，设备必须确实绑定在该家庭且 `revoked_at IS NULL` —— 这是纵深防御，
防止网关有 bug 时跨家庭。`v6:<uid>` 这种家长审计标记要求 uid 确实是该家庭家长。

对应的否定性测试：`G1` anon + 真实设备 UID（旧实现 CLAIMED，现在 FORBIDDEN 且零写入）、
`G2` 家长 + 别家设备、`G3` 服务端 + 别家设备、`G4` 服务端 + 自家设备（通）、
`G5` 已撤销设备、`G6/G7` `v6:` 标记的成员校验、`G8` 低熵设备 UID、`G9` 特权连接里 claims 是垃圾也不影响判定。

---

## 3. 阻断 3：奖励配置 / 学习记录 / 车辆白名单 / 组装成本由服务端决定

**旧实现（被否）**

```sql
r5_fragment_claim(p_family, p_device, p_record_id, p_cfg)      -- p_cfg 决定 want / daily_cap / pity_target / record_day / fragment_id
r5_fragment_assemble(p_family, p_device, p_vehicle_id, p_cost)  -- p_cost 决定花几片
```

也就是说：谁拿到调用权，谁就能自己定掉落概率、每日上限、结算日期，以及用 1 片装 12 片的车。

**新实现**：两个参数保留只为签名兼容，函数体**一个字都不读**（静态断言 S20/S21 钉住）。

| 决策 | 现在由谁决定 |
|---|---|
| 这条记录是否真实存在 / 属于哪个家庭 / 哪一天 / 什么类型 | `growth_learning_records`（`record_id` + `family_id` + `created_at`） |
| 掉落概率 / 每日上限 / 保底次数 / 稀有上限 / 碎片 id | `r5_reward_config`（`family_id='*'` 为全局默认） |
| 车辆能不能用碎片装 / 要几片 | `r5_vehicle_recipe.obtainable_via` + `cost` |
| 前端目录 | `r5_fragment_program_json()`（与上面两张表同源，`member_snapshot` 直接带回） |

新增的拒绝原因：`RECORD_NOT_FOUND`（捏造或别家记录）、`NOT_TODAY`（拿昨天的记录重置今天额度）、
`CONFIG_MISSING`、`UNKNOWN_VEHICLE`、`VEHICLE_DISABLED`。

既有语义一个没丢：`CLAIMED / ALREADY_CLAIMED / capped / pity / drop / none`、
`ASSEMBLED / INSUFFICIENT_FRAGMENTS / ALREADY_OWNED / ALREADY_ASSEMBLED`、
`BIRTHDAY_VEHICLE_FORBIDDEN / COIN_VEHICLE_FORBIDDEN / LEGACY_SLOT_RETIRED / BAD_VEHICLE_ID`。

对应的测试：`H1` 伪造 `p_cfg` 无效、`H2` 每日上限只认服务端、`H3/H4` 捏造/别家记录、`H5` 昨天的记录、
`H6` `record_day/record_kind/subject` 取自真实记录、`H7/H8/H9` `p_cost` 无效（1 片装不了 12 片的车，
凑够 12 片时按 12 扣）、`H10–H13` 白名单、`H14` 改配置立即生效。

**60% 没有改。** `r5_reward_config.drop_percent` 默认 60、`status = pending-parent-confirmation`，
只是从「云函数里的临时常量」搬到了「服务端表里的一行」。

---

## 4. 阻断 4：底层表不能再绕过 RPC

`r5_fragment_state` / `r5_fragment_drops` / `r5_racing_events` / `r5_racing_saves` / `r5_device`：

```sql
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.<table> FROM PUBLIC;
REVOKE ALL ON public.<table> FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO service_role;
```

不再是注释。`growth_learning_records` **没有**动（V6 页面本来就用登录会话读自己的学习记录，收权会打断学习进度）——
`I11` 专门验这一点。

测试：`I1–I8` anon/authenticated 对五张表的读、写、删、自己绑设备全部 42501；
`I9` service_role 仍可写（没误伤服务端）；`I10` RLS 五张全开；
`I12` anon 读学习记录被拒；`I13` 删不掉 → 同一条记录再领仍 `ALREADY_CLAIMED`（幂等没被绕过）。

---

## 5. 赛车兼容（用真实网关形态验证）

`J` 组：服务端连接 + 老设备令牌 `r5-demo-device-0001` → `CLAIMED`（J1）、连续领取（J2）、
12 片组装 `ASSEMBLED`（J3）、事件 `device` 列仍是原设备 UID（J4）、
`save.get` 需要的字段齐全（J5）、不带设备也能领（J6）、三个旧函数签名一字未改（J7）、
设备被撤销后立刻停用（J8）。

---

## 6. 正式部署还需要什么

1. **先跑角色探针**（只读）。通过云 API `ExecutePGSql` 执行：

   ```sql
   SELECT public.r5_fragment_caller_role() AS role_name,
          public.r5_fragment_is_privileged() AS is_privileged;
   ```

   期望 `postgres / true`。**如果不是**，先把它加进白名单再继续：

   ```sql
   INSERT INTO public.r5_backend_role(role_name, note) VALUES ('<探针结果>', 'r5-racing-save 实际角色');
   ```

2. **按序 apply 三个文件**（缺一步就是假安全）：
   1) `db/20261114_fragment_server_authority.sql`
   2) `db/20261114_fragment_scope_guard.sql`
   3) `db/20261114_fragment_member_scope.sql`

3. **apply 后立刻验**：`db/20261114_fragment_scope_guard.sql` 第 7 节四条自检；
   再用 anon key 打一次 `r5_fragment_snapshot`，应当拿到 `FORBIDDEN_SCOPE`。

4. **回滚**：三个函数按 `db/isolated/functions-before.sql` 原文重建；表权限按第 8 节反向语句恢复。
   数据一行都不会动。

> 今天没有执行任何一条正式 SQL，没有改正式家庭数据、60% 概率、生日车或学习进度。

---

## 7. 正式库实测（本轮新增，全部只读 `SELECT`）

隔离库只证明「逻辑对」，不证明「列名对」。所以本轮直接对生产库核了一遍结构与角色，结论如下。

### 7.1 `growth_learning_records`（164 行）

实际九列：`record_id text PK · family_id text NN · record_type text NN · subject text ·
learning_day integer · record_data jsonb NN default '{}' · created_by text ·
created_at timestamptz NN default now() · updated_at timestamptz NN`

与 `db/isolated/schema.sql` 的同名建表语句**逐列同类同默认值**。

**关键口径（差点写错）**：`learning_day` **不是日历日期**，是「课程第几天」。
实测取值只有 `1 / 2 / 3 / 6 / 9 / null`（46 / 28 / 38 / 2 / 47 / 3 行）。
因此守卫里判「今天」只能取 `(created_at AT TIME ZONE 'Asia/Shanghai')::date`，
**不能**拿 `learning_day` 与日期比。当前实现正是前者。

`record_type` 实际分布：`answer 135 / course-complete 24 / sync-test 3 / weekly-goal 2`。
守卫默认可用类型 `ARRAY['answer','course-complete']` 恰好覆盖真实学习数据。
北京时间今天新建的记录：answer 35 条、course-complete 3 条 —— 不会把今天可领的奖励误判成不可领。

### 7.2 三张被引用 / 被收权的表

| 表 | 关键列（实测） | 与隔离库 |
|---|---|---|
| `r5_fragment_state` | `family_id` PK / `pity_points` / `pity_total` / `daily_day date` / `daily_normal_count` / `daily_rare_count` / `updated_at` | 一致 |
| `r5_fragment_drops` | PK `(family_id, source_record_id)` / `record_day date` / `record_kind` / `subject` / `outcome` / `fragment_id` / `fragment_count` / `rare_fragment_id` / `rare_count` / `pity_before` / `pity_after` / `daily_index` / `device` / `created_at` | 一致 |
| `r5_device` | `device_uid` PK / `family_id` / `label` / `bound_by` / `bound_at` / `revoked_at` / `last_seen` | 一致 |

`growth_family_members` = `family_id / user_id / member_role / joined_at`；
`auth.jwt()`、`auth.uid()`、`auth.role()`、`public.growth_is_family_member(text)` 均存在。

### 7.3 正式网关的真实数据库角色

这是必须实测的一步：判错角色，要么放太宽，要么把赛车挡在门外。

```sql
SELECT current_user, session_user, current_setting('role', true);
-- cloudbase_postgres_postgres_130fh140 | 同名 | 同名

SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
 WHERE rolname IN ('cloudbase_postgres_postgres_130fh140','service_role','anon','authenticated');
-- cloudbase_postgres_postgres_130fh140 | f | t     ← 平台通道（网关 / 云函数 / 迁移）
-- service_role                        | f | t
-- anon / authenticated                | f | f
```

结论：

1. 线上既不是 `postgres` 也不是 `none`，而是**环境专属角色** `cloudbase_postgres_postgres_130fh140`，且带 **BYPASSRLS**。
2. `r5_fragment_is_privileged()` 因此走 `rolbypassrls = true` 分支返回 true ——
   赛车网关、云函数、迁移通道**全部照常放行**，不依赖白名单表里有这一行。
3. `r5_backend_role` 里的 `postgres` / `service_role` 只是给「非 BYPASSRLS 的部署」做补充；
   换环境时先跑第 6 节的探针。
4. 线上三个旧函数的 `proowner` 就是这个角色，`proacl` 实测
   `anon=X / authenticated=X / service_role=X` —— **漏洞今天在正式库是活的**。
5. 三个旧函数签名与守卫 `CREATE OR REPLACE` 的目标签名完全一致，不会新建重载、不会失效旧调用方：
   `r5_fragment_snapshot(text)`、`r5_fragment_claim(text,text,text,jsonb)`、`r5_fragment_assemble(text,text,text,jsonb)`。

---

## 8. 执行顺序与回滚（正式发布用）

### 8.1 顺序（必须同批、按序）

| 序 | 文件 | 做了什么 | 漏了会怎样 |
|---|---|---|---|
| 1 | `db/20261114_fragment_server_authority.sql` | 三张权威表 + `r5_fragment_caller_role()` / `r5_fragment_is_privileged()` / `r5_fragment_program_json()` | 第 2 份引用的函数不存在，直接报错 |
| 2 | `db/20261114_fragment_scope_guard.sql` | 三个旧函数改写（角色判定 + 服务端权威）+ `snapshot_internal` + 五张表收权 | 旧函数仍信任客户端 `p_cfg` / `p_cost`，漏洞照旧 |
| 3 | `db/20261114_fragment_member_scope.sql` | 家长身份 RPC（0 参数 / 只收 `vehicle_id`），快照带回 `program` | V6「我的车库」读不到数据（前端退回本地兜底目录，不白屏） |

apply 前先跑只读探针：

```sql
SELECT public.r5_fragment_caller_role(), public.r5_fragment_is_privileged();
-- 期望 cloudbase_postgres_postgres_130fh140 / true
```

apply 后立刻验四条：

1. `anon` 调 `r5_fragment_snapshot('little-growth-family-001')` → `FORBIDDEN_SCOPE`；
2. `anon` 直接 `SELECT * FROM r5_fragment_state` → `42501`；
3. 家长会话调 `r5_fragment_member_snapshot()` → `OK`；
4. 赛车进站 → `CLAIMED`（不是 `FORBIDDEN_SCOPE`）。

### 8.2 回滚（逐层可退，数据一行不动）

1. **表权限**：`GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_{fragment_state,fragment_drops,racing_events,racing_saves,device} TO anon, authenticated;`
2. **三个旧函数**：用 `db/isolated/functions-before.sql` 原文重新 `CREATE OR REPLACE`（签名一致，直接覆盖）。
3. **成员 RPC**：`REVOKE EXECUTE ON FUNCTION public.r5_fragment_member_snapshot(), public.r5_fragment_member_assemble(text) FROM authenticated;`
   （或直接 `DROP`；前端会自动退回本地兜底目录，不白屏。）
4. **新表**：`r5_reward_config` / `r5_vehicle_recipe` / `r5_backend_role` 不被旧函数引用，
   留着或 `DROP` 都不影响回滚正确性；建议保留，便于下次重上。

`r5_fragment_state` / `r5_fragment_drops` 的既有行在回滚过程中**不删、不改**。

---

## 9. 本轮上线状态

| 项 | 状态 |
|---|---|
| 远程分支 head | `5db9167`（在 `b260a49` 上 fast-forward，未 force） |
| PR #3 | 仍为 Draft，未合并 |
| `main` | `ea09745`，未动；GitHub Pages 仍是旧版 |
| 正式 SQL | **未执行**（线上匿名越权仍然存在，直到 apply） |
| 正式家庭数据 / 碎片数量 | 零写入（只读过结构与聚合计数） |
| 60% 掉落概率 | 未定稿，`status = pending-parent-confirmation` |
| 生日车 / 金币车 / 赛车 V2 | 未动 |
