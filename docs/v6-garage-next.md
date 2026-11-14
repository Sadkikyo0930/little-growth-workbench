# 提案（未实施）：让 V6 首页直接读到碎片，不需要设备令牌

状态：**仅设计，未写一行代码、未改数据库**。等待家长决定后再排期。

## 问题

现在碎片接口只认设备令牌（`x-r5-device`，值形如 `r5dev_` + 32 hex，必须先在 `r5_device` 里绑定）。
V6 首页没有这个令牌 —— V6 自己的设备号是 `v6-family-sync-device-id`（16 位 hex），两者格式与含义都不同。
结果是：从 V6 首页点「我的车库」能进页面，但读不到数据，只显示「还没有连接家庭」。

## 三条可选路（按改动面从小到大）

| 方案 | 做法 | 改动面 | 代价 |
|---|---|---|---|
| A. 绑定 V6 设备 | 家长在 V6 侧把当前设备绑到 `r5_device`（`r5_bind_device`，owner/parent），V6 设备号加 `r5dev_` 前缀后再存 | 一条已有 RPC + 一个家长入口 | 每台设备要绑一次；`r5_device` 会同时存在两种来源的 id，需要约定前缀含义 |
| B. 成员身份读接口 | 新网关路由 `POST /v1/racing/fragment/summary`，用 V6 的登录会话（成员）而不是设备令牌换 family_id，只读快照 | 网关新增 1 条只读路由 + 1 个 `authenticated` 函数 | 需要一次后端发布；要防止用别人的 family_id 读别人家 |
| C. 服务端页面 | 组装中心改成云函数渲染（或带服务端会话的中转页），令牌不出服务端 | 最大 | 与现有纯静态站结构冲突，不建议 |

推荐 **B**，理由：只读、幂等、不改任何既有写入路径；失败也不影响「从赛车车库进来」这条主路。

## B 的最小实现草图（仅供评审）

```sql
-- 只读，SECURITY DEFINER，鉴权用 r5_assert_member，不信任入参 family
create or replace function public.r5_fragment_summary_for_member()
returns jsonb language plpgsql security definer set search_path = public as $$
declare fam text;
begin
  fam := public.r5_current_family();          -- 已有：按 JWT 取当前家庭
  perform public.r5_assert_member(fam, false); -- 孩子/家长都可读
  return public.r5_fragment_snapshot(fam);
end $$;
revoke all on function public.r5_fragment_summary_for_member() from public, anon;
grant execute on function public.r5_fragment_summary_for_member() to authenticated;
```

要点：

1. **不接受 `p_family` 入参** —— 家庭只从 JWT 推出，避免「传别人家 id 就能读」；
2. 只读快照，**不返回**任何可写能力；组装仍然只能走设备令牌那条路（有 `FOR UPDATE` 与幂等事件）；
3. 前端在 `fragment-client.mjs` 里加一个 `loadStateAsMember()`，只在「没有设备令牌」时兜底；
4. 回滚＝删这一个函数 + 前端那个分支，不动任何表。

## 不做的事

- 不给 `anon` 任何新权限（现状 `r5_fragment_*` 三个函数对 `anon` 可执行，是历史配置，建议单独一轮收紧）；
- 不改 `r5_fragment_drops` / `r5_fragment_state` 的结构；
- 不让成员接口具备发奖或组装能力。
