# V6 碎片车库 · 发布前安全收尾（第三轮）

日期：2026-11-14 ｜ 分支：`feat/v6-garage-restore-20261114` ｜ **未合并、未部署、未执行任何正式库变更**

---

## 1. 这一轮只做两件事

| # | 事项 | 结论 |
|---|---|---|
| 1 | 前端真正切到 `r5_fragment_member_snapshot()` / `r5_fragment_member_assemble()` | ✅ 已切换，浏览器不再有任何 `p_family` 调用 |
| 2 | 旧三个函数的 `p_family` 口子（anon 可执行） | ✅ 已写出**兼容赛车网关**的封堵方案，并在隔离库验证；⚠️ **未 apply**，需批准 |

## 2. 旧接口到底漏在哪（实测，不是推测）

`pg_proc` 只读查询（2026-11-14）：

```
r5_fragment_snapshot | secdef=true | search_path=public, pg_temp | anon=X authenticated=X service_role=X
r5_fragment_claim    | secdef=true | …                            | anon=X authenticated=X service_role=X
r5_fragment_assemble | secdef=true | …                            | anon=X authenticated=X service_role=X
```

三个函数都 `SECURITY DEFINER`、都接受 `p_family`、都对 `anon` 开放执行权。
在隔离库（PGlite/WASM Postgres）里照原样重建后复现：

| 复现 | 结果 |
|---|---|
| anon 调 `r5_fragment_snapshot('r5-selftest-family')` | 读到别人家完整快照，返回里连拒绝字段都没有 |
| anon 调 `r5_fragment_claim('r5-selftest-family', …)` | **写成功**，别家 `r5_fragment_drops` +1 行 |
| 登录家长（妈妈）读别人家 | 成功 |
| anon 直接 `SELECT r5_fragment_drops` | 成功（表级 RLS 未开启，anon 有 SELECT） |

所以「只新增两个安全封装」**不等于**堵住漏洞 —— 旧路依旧敞开。

## 3. 封堵方案（`db/20261114_fragment_scope_guard.sql`，未执行）

### 3.1 一个统一判定入口

```sql
r5_fragment_scope_ok(p_family text, p_device text) → boolean
  ① 没有 request.jwt.claims（云函数直连 / 迁移 / psql）→ true
  ② claims.role = service_role                        → true
  ③ claims.sub 是该家庭的 owner/parent/grandparent    → true
  ④ 否则：p_device 必须等于 r5_device.device_uid，
        且 device.family_id = p_family、revoked_at IS NULL
  ⑤ 其余一律 false
```

### 3.2 三个旧函数各加一行守卫（读写之前）

```sql
IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
  RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
END IF;
```

函数签名、返回结构、业务逻辑**一字未改** —— 调用方（网关、云函数、老客户端）不需要改代码。

### 3.3 为什么不是直接 `REVOKE anon`

因为**拿不到「云函数一定用 service_role 连库」的运行时证据**。如果贸然收回 anon 执行权，
而云函数恰好是以低权限身份连的，孩子的赛车会在线上直接 403。
所以这一轮选择「保留 EXECUTE + 入口判定」：效果等价于收紧，但不会因为身份没对上而误伤。
拿到运行时证据后再补一刀 REVOKE 也不迟（脚本第 8 节写了自检 SQL）。

### 3.4 为什么内部快照要拆出来

旧函数里有多处 `RETURN public.r5_fragment_snapshot(p_family) || …`（组装/领取成功后回传余额）。
如果只给对外快照加守卫，这些内部调用会被自己的守卫再拦一次，导致「组装成功但返回 FORBIDDEN」。
所以把原始 SQL 体原样搬进 `r5_fragment_snapshot_internal(p_family)`（只对特权角色开放），
三个函数内部改调它，对外那个继续带守卫。

## 4. 与赛车网关的兼容性（这是能不能上线的前提）

```
浏览器/家庭设备
   │  POST /r5/racing/fragment/claim   （x-r5-device: r5dev_…）
   ▼
r5-gateway ── 从 public.r5_device 反查 family_id（不采信 body.family_id）
   │          → 云函数 r5-racing-save（服务端身份连库）
   ▼
r5_fragment_claim(p_family, p_device=…, …)  → 守卫：① 特权放行
```

另一条（万一云函数改成低权限连接）：

```
r5_fragment_claim(…, p_device='r5dev_…')   → 守卫：④ 设备已绑定该家庭且未撤销 → 放行
```

线上事件表里 `device` 列存的就是 `r5dev_…` / `r5-demo-device-0001` 这类 `r5_device.device_uid`，
证明 `p_device` 一路传下来就是设备 UID —— 守卫用的正是这套值，**不需要重新绑定设备、不需要换密钥**。

隔离库里对这条路的验证（D 组）：`anon + 该家庭自己的设备令牌 → CLAIMED`，连续两条记录都通；
`anon + 已撤销设备`、`anon + 别家设备`、`anon + 伪造令牌`、`anon + 空令牌` 全部 `FORBIDDEN_SCOPE` 且零写入。

## 5. 新接口（`db/20261114_fragment_member_scope.sql`）

- `r5_fragment_member_snapshot()`：0 参数；家庭由 `auth.jwt()->>'sub'` 反查成员表得出；
  0 行 → `NOT_MEMBER`；多行（账号挂多个家庭）→ `AMBIGUOUS_MEMBER`，不替家长选；
  返回 `status/family_id/family_source/member_role/member_uid/zero_write` + 原快照字段。
- `r5_fragment_member_assemble(p_vehicle_id)`：成本白名单写死（12 / 8），车辆 ID 先过正则，
  再交给既有 `r5_fragment_assemble` 走原来的余额/幂等/事务逻辑。
- 两个函数都 `REVOKE ALL FROM PUBLIC` + 只 `GRANT EXECUTE TO authenticated`；`search_path` 钉死为 `public`。

成员模型说明（这轮特意核对过）：`growth_family_members` 主键是 `(family_id, user_id)`，
**一个家庭可以有多名成员**（爸爸 owner / 妈妈 parent / 外婆 grandparent 三行都在）；
约束是**每个账号只归属一个家庭**。迁移脚本对成员表只有 SELECT，不写、不删。

## 6. 前端改动（`v6/r5/member-fragments.mjs`）

```js
// 之前
rpc('r5_fragment_snapshot', { p_family: who.family_id })
rpc('r5_fragment_assemble', { p_family, p_device, p_vehicle_id, p_cost })

// 现在
rpc('r5_fragment_member_snapshot', {})                       // 请求体是空对象
rpc('r5_fragment_member_assemble', { p_vehicle_id })         // 只有车辆 ID
```

- 服务端返回 `UNAUTHENTICATED / NOT_MEMBER / AMBIGUOUS_MEMBER` 时映射成页面的
  `NO_SESSION / NO_MEMBER`；未知状态一律报错，**绝不把数字渲染出来**。
- 函数还没 apply 时 PostgREST 返回 404 → `NO_SDK`，页面给「云端连接没准备好，请刷新重试」。
- 页面本身不需要改：它读的是 `state.family_id`，现在这个值来自服务端函数返回。

## 7. 隔离验证（`db/isolated/`）

`npm i && node run.mjs` —— 在 WASM Postgres 17 里建三份**互相独立**的库：

| 组 | 内容 | 结果 |
|---|---|---|
| A | 成员模型：正式家庭 3 行、角色齐全、每账号一个家庭 | 7/7 |
| B | 改之前：anon 跨家庭读/写、家长跨家庭读、表级越权 | 5/5 |
| C | 新接口：anon 无权限、非成员/child/多家庭被拒、只读、成本白名单、组装幂等 | 17/17 |
| D | 守卫：匿名跨家庭全拒、设备路照通、service_role/云函数放行 | 15/15 |
| E | 零写入、签名未变、search_path 钉死、SECURITY DEFINER | 7/7 |

合计 **54/54**。它不连任何正式库、不读任何密钥。

## 8. 还没做（需要新授权）

1. apply `20261114_fragment_member_scope.sql`（新增两个函数 + 授权）。
2. apply `20261114_fragment_scope_guard.sql`（旧函数入口守卫）——**必须与第 1 步同批**，
   否则会出现「新接口已上线、旧口子还在」的假安全。
3. 可选：收紧 `r5_fragment_state` / `r5_fragment_drops` 的表权限
   （现状 anon 可读、authenticated 可写，是另一个独立问题，见脚本第 6 节）。
4. 合并 main / 部署正式 V6 / 真机三设备验收。
