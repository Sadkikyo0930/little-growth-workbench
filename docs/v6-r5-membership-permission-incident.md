# V6 家庭成员权限错误：结论与修复（2026-11-15）

错误证据：妈妈在 iPhone 桌面 PWA 打开「自动同步」相关页面后，界面显示

```
permission denied for table growth_family_members   (SQLSTATE 42501)
```

## 一、结论：不是家庭成员没授权，也不是数据库少了 GRANT

在正式库 `normal-goose-d5g4qyzr8bb389a4a` 上逐项只读核对后，服务端权限是**正确**的：

| 对象 | 所有者 | SECURITY DEFINER | owner 可读成员表 | authenticated EXECUTE | anon EXECUTE |
|---|---|---|---|---|---|
| `r5_assert_member(text,boolean)` | cloudbase_postgres | 是 | 是 | 是 | 否 |
| `r5_auto_rollover_day(text)` | cloudbase_postgres | 是 | 是 | 是 | 否 |
| `r5_status(text)` | cloudbase_postgres | 是 | —（经 `r5_assert_member`） | 是 | 否 |
| `growth_is_family_member(text)` | cloudbase_postgres | 是 | 是 | 是 | 否 |
| `r5_gate_status_core(text,boolean,boolean)` | cloudbase_postgres | 是 | 是 | 否（内部） | 否 |
| `r5_next_day_state_impl(text)` | cloudbase_postgres | 是 | 是 | 否（内部） | 否 |

- `growth_family_members`：RLS 已启用、未 FORCE；`authenticated` 有 SELECT；`anon` 没有。
- 以真实成员身份（`SET LOCAL ROLE authenticated` + 真实 `sub`）读取，返回**恰好 1 行**（自己那一行），符合 `growth_members_self_select` 策略。
- 也就是说：**只要请求带上了家长身份，这条查询本来就是通的**。

## 二、真正的成因：请求根本没带家长身份

`permission denied for table ...` 在 PostgreSQL 里只有一个含义：当前执行角色对该表没有权限。
匿名角色 `anon` 对成员表没有任何权限（这是对的，不能放开），所以报错文本只可能来自匿名执行。

问题出在客户端的传输层。`v6/family-auto-sync.js`、`family-sync.html`、`family-dashboard.html`、
`family-login-test.html` 读成员表用的是 `app.rdb()`：

```js
app = cloudbase.init({env, region}); db = app.rdb();
db.from('growth_family_members').select(...)
```

`app.rdb()` **不是浏览器直连 PostgREST**。CloudBase JS SDK（`cloudbase.full.js`）里它的 fetch 实现是：

```js
e.callFunction({ name: 'httpOverCallFunction', data: { url, method, headers, body } })
```

即每个 RDB 请求都被代理给一个名为 `httpOverCallFunction` 的云函数，由那个函数替浏览器发 HTTP。
本环境只有 3 个云函数（`r5-racing-save`、`r5-birthday-claim`、`r5-gateway`），**没有 `httpOverCallFunction`**。
在无头浏览器里实测，`app.rdb().from('growth_family_members').select(...)` 直接返回：

```json
{ "message": "FetchError: undefined", "status": 0 }
```

这条链路要么发不出去，要么（在代理存在的环境里）以匿名身份发出——两种情况下都不会带家长 JWT。
于是网关按 `anon` 执行，撞上成员表的表级权限检查，得到 `42501`。

**这同时解释了为什么同一次故障里「跨日调用失败」「云端只读查询失败」，但数据库里的学习日其实已经推进到第 4 日**：
`r5-bridge.js` 和 `r5/identity.mjs` 用的是「自己拿 access token + 显式 `Authorization: Bearer`」的直连方式，
这条路是通的；只有依赖 `app.rdb()` 的那几个页面失败。

## 三、修复：换掉传输层，而不是放开表权限

新增 `v6/r5/rdb-client.mjs`：一个和 `app.rdb()` **调用形状一致**、但显式携带家长 JWT 的 RDB 客户端。

- `readAccessToken(auth)`：先 `auth.getAccessToken()`（顺手续期），失败退回会话里的 `access_token`；
  两者都没有就抛 `NO_SESSION`，**绝不退回匿名请求**。
- 每个请求都带 `Authorization: Bearer <家长 token>`；URL、`select`、`eq` 与原来一致。
- 服务端 42501 被翻译成 `PERMISSION_DENIED_NO_IDENTITY`，并给出中文说明
  「云端没有收到已登录的家长身份……本机学习记录不会丢失」——
  这样家长看到的是可操作的提示，而不是一段 PostgreSQL 原文。
- RLS 为空（不是这家人）仍然是「返回 0 行」，不是错误。

四处调用点只改一行：

| 文件 | 改动 |
|---|---|
| `v6/family-auto-sync.js` | `db=app.rdb()` → 动态 `import('./r5/rdb-client.mjs')` + `makeRdb(auth)`；新增按错误码区分 `auth_required` 的提示 |
| `v6/family-sync.html` | 同上（初始化回调改为 async） |
| `v6/family-dashboard.html` | 同上 |
| `v6/family-login-test.html` | 同上 |

`v6/sw.js`：`VERSION` 提升为 `20261115-rdb-identity-v1`，并把 `./r5/rdb-client.mjs` 加进预缓存，
保证已安装的 PWA 下次联网时换到新代码。

### 明确没有做的事

- 没有 `GRANT SELECT ON growth_family_members TO authenticated / anon / PUBLIC`；
- 没有关闭或放宽任何 RLS；
- 没有把任何函数从 SECURITY INVOKER 改成 SECURITY DEFINER；
- 没有改学习日、成绩、课程计划、碎片、赛车存档；
- 没有为验证而向正式家庭写入任何虚假记录（全部在事务内 `ROLLBACK`）。

## 四、附带的最小权限收口

审计时发现 C0.1 的 010 建表时执行了 `REVOKE ALL FROM PUBLIC`，但 CloudBase 的默认权限把这些表的
SELECT 同时给了 `anon`：`r5_family_progress`、`r5_plan_audit`、`r5_credential_snapshot`、
`r5_day_confirmation`、`r5_acl_baseline`。这些表都启用了 RLS 且没有任何 policy，所以今天匿名读到的仍是 0 行；
但「默认有权、靠 RLS 挡住」随时会被一条新 policy 击穿，和 010 的 deny-by-default 设计意图相反。

`db/20261115_r5_anon_privilege_hardening.sql` 收回这 5 张表的 anon 授权（只减不增）。
回滚脚本：`db/20261115_r5_anon_privilege_hardening_rollback.sql`。
`authenticated` / `service_role` / owner 的权限一字未改。

## 五、验收要点（详见 db/20261115_r5_member_permission_acceptance.sql）

| 场景 | 期望 | 实测 |
|---|---|---|
| 妈妈（owner）读 `r5_status` | 第 4 日、已发布 | 第 4 日、published=true、1800s |
| 外婆（grandparent）读同一家庭 | 与妈妈一致，不依赖妈妈先登录 | 第 4 日、published=true、语文+英语 |
| 匿名 | 不能读成员表、不能调 RPC | 全部 false |
| 跨家庭（妈妈读 selftest 家庭） | 拒绝 | `R5_MEMBER_DENIED` |
| 已是第 4 日再调跨日 | 不推进 | `already_published` |
| 旧设备把今天的作答记成第 3 日 | 拒绝 | `R5_RECORD_DAY_MISMATCH` |
| 补传 11-14 的第 3 日历史记录 | 允许，且不影响今日判定 | 写入成功（回滚） |

## 六、回滚

本次是纯客户端改动：回退合并提交即可，数据库侧唯一改动是上面那 5 条 REVOKE，
用 `20261115_r5_anon_privilege_hardening_rollback.sql` 还原。
