# V6 身份直连碎片：家长登录 → 家庭成员资格 → 真实碎片（2026-11-14 第二轮）

状态：**隔离候选**。已部署到隔离预览，**未合并 main、未部署正式 V6、未改数据库/云函数**。

---

## 1. 这一轮解决的到底是什么

上一轮把「我的车库」接回了 V6 首页，但孩子点进去看到的还是：

> 还没有连接家庭 —— 请从赛车游戏车库点「去组装」进来

原因：碎片接口的鉴权是**设备令牌**（`r5_device.device_uid`，`r5dev_` + 32 hex），
只有赛车游戏那侧才有。V6 首页没有，所以永远进不来。

这一轮把这条路换成**家长登录身份**：

```
V6 家长登录（已有的 CloudBase 会话，family-sync.html 同一个账号）
   ↓
growth_family_members  ← RLS: user_id = auth.jwt()->>'sub'（数据库决定能读哪一行）
   ↓  family_id 只从这里取
r5_fragment_snapshot(p_family)   ← 只读，不发碎片
   ↓
页面：普通碎片 0/12、专属碎片 0/8、两辆车、进度条、缩略图
   ↓  碎片够了
r5_fragment_assemble(family, device, vehicle, cost)  ← 既有函数，扣片+授予同事务
```

孩子**不需要**重新注册、不需要第二套账号、不需要手工配设备令牌。

## 2. 为什么要复用 `growth_family_members`

它本来就在线上，而且**已经有 RLS**：

| 表 | 策略 | 效果 |
|---|---|---|
| `growth_family_members` | `growth_members_self_select`（authenticated，SELECT） | `user_id = auth.jwt()->>'sub'` —— 只能读自己那一行 |

实测（2026-11-14，正式环境）：

```
GET /v1/rdb/rest/growth_family_members?select=family_id      → 401 MISSING_CREDENTIALS
GET 同上 + Authorization: Bearer <假 token>                  → 401 INVALID_CREDENTIALS
```

也就是说：**没有有效家长会话，连成员表都读不到**，更拿不到任何 family_id。
这一层的安全性不靠前端自觉，靠数据库策略。

## 3. 前端做了什么（`v6/r5/`）

| 文件 | 作用 |
|---|---|
| `identity.mjs` | 载入 CloudBase SDK → 取会话与 access token → 读自己的成员行 → `family_id`；角色只认 `owner/parent/grandparent`；一个账号挂多个家庭直接拒绝（不替用户选）；家庭 ID 有形状校验 |
| `catalog.mjs` | 两辆碎片车的只读目录（名称/成本/缩略图），与云函数 `FRAGMENT_PROGRAM` 同源，逐字段比对（`evidence/catalog-source.json`） |
| `member-fragments.mjs` | 身份模式的两个调用：`r5_fragment_snapshot` / `r5_fragment_assemble`；组装成本只从目录取，不接受调用方传 |
| `assemble-center.html` | 有 `?d=` 走设备模式（老路不退化），没有就走身份模式；未登录/不是成员/SDK 失败三种情况各有授权入口与文案 |

三条硬约束（有测试钉住）：

1. **页面不读 `?family=`**：上一轮首页入口会透传 `family`，这一轮删掉了；`assemble-center.html`
   里也没有任何「换一个家庭」的入口。
2. **读取是只读的**：身份模式只调 `r5_fragment_snapshot`，一次 GET 级 RPC，不发碎片、不写本地余额。
3. **组装成本不由客户端决定**：`p_cost` 取自 `catalog.mjs` 的固定目录；生日车/金币车在客户端
   就不会发请求（`NOT_IN_CATALOG`），即使发出去数据库也会拒绝。

## 4. 设备模式没有退化

`r5-gateway` 那边早就写死了「不采信 body.family_id」：

```
x-r5-device -> sqlAs 注入服务端 claims -> r5_assert_member -> public.r5_device 反查真实 family_id
```

所以赛车游戏那条路（`?d=r5dev_…`）保持原样，本分支一个字都没动它的逻辑。

## 5. 还差一步：服务端封装（**未执行，等批准**）

前端这一轮做到的是「不给入口」；要把「谁能指定 family_id」这件事从**协议层**关掉，
需要一个按 JWT 推家庭的函数。脚本已经写好、测过、但没有 apply：

`db/20261114_fragment_member_scope.sql`

- `r5_fragment_member_snapshot()` —— 不接受任何 family 参数，`auth.jwt()->>'sub'` → 成员行 → 家庭
- `r5_fragment_member_assemble(vehicle_id)` —— 成本白名单写在函数里（12 / 8），客户端不能自带价格
- `REVOKE ALL ... FROM PUBLIC` + 只 `GRANT EXECUTE ... TO authenticated`
- 纯新增，不改任何既有表/函数/数据；回滚就是 `DROP FUNCTION` 两个新函数

**现状风险（如实说）**：线上三个碎片函数仍是 `SECURITY DEFINER` 且 `anon` 可执行，参数带 `p_family`。
也就是说，**绕过我们的页面、直接调 REST 的人仍然可以传任意 family_id**。
这不是本轮引入的，但只有 apply 上面这个脚本（并把旧函数的 anon 权限收掉）才算真正关死。
该操作会改变正式数据库权限，属于「必须家长批准」的范围。

## 6. 怎么验

```bash
node tests/run-all.mjs            # 230 项
node tools/shot.mjs <url> out.png 390 844 3   # 真机尺寸截图 + 横向溢出检查
```

- `tests/member-identity.test.mjs`（59 项）：没登录 / 不是成员 / 角色不对 / uid 不符 / 一个账号两个家庭
  五种拒绝路径；家庭只来自成员行（URL 里的 `?family=` 完全无效）；只读；组装成本来自目录；
  生日车金币车在客户端就拒；目录与源码逐字段一致；加固脚本的鉴权形状。
- 截图：`evidence/screenshots/`
  - `s2-garage-unauth.png` 真实未登录状态（授权入口）
  - `s3-garage-data-3of12.png` 有碎片时的布局（演示数据，横幅已标注）
  - `s4-garage-assemble-sheet.png` 可组装 + 确认弹层（演示数据，横幅已标注）

## 7. 隔离预览地址

```
https://normal-goose-d5g4qyzr8bb389a4a-1526110019.tcloudbaseapp.com/garage-preview/
```

- 托管在 CloudBase 静态托管的 `garage-preview/` 目录（与正式 V6 的 GitHub Pages **不同源**，
  也不影响根目录的赛车游戏）；
- 该域名在环境安全域名白名单里，家长登录（`family-sync.html`）可以直接用；
- 页面读的是**正式家庭真实数据**：正式家庭目前 0 片，所以显示 `0 / 12`、`0 / 8` 是对的。

## 8. 上线前仍需要的批准

1. 合并本分支到 main（GitHub Pages 一合并即对外）；
2. apply `db/20261114_fragment_member_scope.sql`（正式库权限变更）；
3. 发布 `r5-racing-save` 的车辆目录（`placeholder:false` + 真车图四视角），否则设备模式那侧仍是占位卡；
4. 定稿碎片掉落比例（现 60%，`pending-parent-confirmation`，本轮**没有**改它）；
5. 真机三设备走一遍（iPhone / 外婆手机 / iPad）。
