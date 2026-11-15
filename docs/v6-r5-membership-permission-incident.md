# V6 家庭成员权限错误处理（2026-11-15）

错误截图：`permission denied for table growth_family_members`。
这属于 PostgreSQL 表级权限失败；**不能据此断言账号不是家庭成员**。

## 操作顺序

1. 在正式 CloudBase 仅执行 `db/20261115_r5_member_permission_readonly.sql`。
2. 重点查看 `r5_assert_member`、`r5_auto_rollover_day`、`r5_status` 的 `security_definer`、`function_owner`、`owner_can_select_family_members`。以及表 RLS 状态与 role 的 EXECUTE 权限。
3. 查看 CloudBase 后端真实的 `42501` 日志和调用栈，区分是 `r5_assert_member`、`growth_is_family_member` 还是其他函数对成员表直接 SELECT。
4. 若某个 SECURITY DEFINER 函数的 owner 不具备目标表 SELECT，只给**经审核的专用函数执行角色**补最小只读权限；如果函数 owner 是 `authenticated`、`anon` 或其他面向客户端的公共角色，不要直接 GRANT SELECT 给它，先设计专用权限隔离与审查函数依赖。另需考虑 RLS 与 FORCE RLS。
5. 若函数是 SECURITY INVOKER，不能简单改成 DEFINER；先核验所有 SQL、固定 search_path、函数体对来访 family_id 的校验及所有可调用路径，避免越权。
6. 保持 `anon`、`PUBLIC` 不可读取成员表；严禁 `GRANT SELECT ON growth_family_members TO authenticated` 当作快捷修复。
7. 在事务内分别模拟已授权 owner、已授权外婆、匿名及跨家庭调用：只有真实授权成员可以读取自身家庭状态；所有拒绝场景不得外泄成员数据。
8. 修复后从**原有桌面 V6 PWA** 重新登录，先验证只读 `r5_status`、再验证幂等 `r5_auto_rollover_day`，严格避免重复推进；核对 2026-11-15 第四日语文＋英语。
9. 修改前后对比学习成绩、家庭成员、碎片、赛车存档、额度行数/指纹，所有不相关业务数据必须不变。

## 交付
报告发现的实际函数 owner、权限缺口、修补 SQL、事务回滚验证、owner/外婆/匿名/跨家庭测试。没有真实数据库登录权限时，不得声称已修复服务器。
