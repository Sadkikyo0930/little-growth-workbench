# 小小赛车 V2 R5 × V6 CloudBase | 第一阶段

当前状态：已提交 GitHub 独立分支；尚未部署到 CloudBase。
环境 ID normal-goose-d5g4qyzr8bb389a4a；时区 Asia/Shanghai (UTC+8)。
不得把该文档中的示例结果描述为真实云端返回。

## 核查结论
基于现有 V6 程序及此前实机云端测试：
- growth_family_members 包含 family_id/user_id/member_role，owner/parent/grandparent。
- growth_learning_records 包含 record_id/family_id/record_type/subject/learning_day/record_data/created_by 等。
- answer: record_data.answer.correct、date、learningDay 等；course-complete: record_data.completed_at。
- 英语/科学的正式课程将逐题记录放入 V6 state.records；数学只确认完成通知，尚未确认十五道题成绩进入该数组；语文完成按钮可直接记录完成，故事题成绩不统一进入 state.records。
- V6 学习第 N 天按“前一个完成再推进”，不是 N 个自然日。因此当天计划必须依据实际学习日发布，不能按 11 月 9 日直接累加。
- V6 自动同步由每 20 秒或页面恢复触发，曾遇 credentials not found；已有上传成功样例但不是长期稳定性证明。
- 尚无腾讯云数据库直接授权连接，无法核实当下实际记录数量、真实 SQL 权限或直接执行迁移。

## 数据结构（仅添加，均未在真实库创建）
1. r5_subject_template(day_index, subjects)：原 V6 30 天双科计划，只读模板。
2. r5_daily_plan(family_id, study_date, day_index, subjects, published)：当天任务快照。无数据不等于无任务。
3. r5_parent_settings(family_id, enabled DEFAULT true, daily_seconds DEFAULT 1800, bonus_seconds DEFAULT 0, updated_by, updated_at)。
4. r5_daily_usage(family_id, play_date, used_ms, active, last_beat)：每天累计游戏时间；不清零旧数据。

## 真实 RPC 端点名称（执行 SQL 迁移以后才可调用）
POST https://normal-goose-d5g4qyzr8bb389a4a.api.tcloudbasegateway.com/v1/rdb/rest/rpc/FUNCTION_NAME
Header Authorization: Bearer [CloudBase 已登录家庭成员的用户 access token]
Header Content-Type: application/json
或 Web SDK: app.rdb().rpc(functionName,params)。
所有 DEFINER 接口显式检查 JWT role=authenticated 与家庭成员归属；不用管理 API Key。

- r5_publish_today
  请求 {"p_family_id":"little-growth-family-001","p_day_index":1,"p_no_tasks":false}
  示例响应 {"date":"2026-11-09","study_day":1,"subjects":["英语","科学"],"published":true}
  按 V6 实际学习日发布，冲突不覆盖。无任务日只能 owner/parent 明确发布 p_no_tasks=true。

- r5_status
  请求 {"p_family_id":"little-growth-family-001"}
  示例响应 {"api":"r5_status","date":"2026-11-09","allowed":false,
  "reason":"STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED","parent_control":true,
  "daily_seconds":1800,"bonus_seconds":0,"used_seconds":0,"remaining_seconds":1800,
  "active":false,"schedule_published":true,"study_day":1,
  "modules":[{"subject":"英语","completed":true,"correct":8,"total":10,"accuracy_pct":80,"passed":true},
  {"subject":"科学","completed":false,"correct":3,"total":5,"accuracy_pct":60,"passed":false}]}
  有当日两科计划时，每科需同一天的 course-complete 和实际 scored answer，
  且 correct/total >= 80%。证据不足锁定。计划缺失锁定；经家长明确发布空计划时允许直接玩。
  无家长令牌/其他家庭请求拒绝。

- r5_game_action
  请求 {"p_family_id":"little-growth-family-001","p_action":"start"}
  action 可为 start/tick/stop/status。返回 r5_status 字段，并增加 action、charged_ms。
  示例 {"allowed":true,"active":true,"used_seconds":600,"remaining_seconds":1200,
  "action":"tick","charged_ms":10006}
  在赛车首页进入即 start，每约 10 秒 tick，退出 stop；剧情/比赛/探索都计时。
  按数据库 clock_timestamp 计费，单次补记最多 20 秒，网络/账号失效时默认锁定。

- r5_parent_update
  请求 {"p_family_id":"little-growth-family-001","p_enabled":true,
  "p_daily_seconds":1800,"p_bonus_seconds":900}
  返回 r5_status 结构，仅 owner/parent 允许；改额度不会降低 already-used 时间。

## 赛车接入
使用 r5-cloudbase/client/r5-client.mjs 的 makeR5Client(db) 与
createR5GameClock(client)，首页进入调用 enter()，退出调用 leave()，
绑定 attachLifecycle()，onDenied 必须禁止进入比赛、剧情和探索。
赛车 GitHub Pages 与 V6 是不同 origin，登录状态不会天然互通；必须有
安全的用户登录或受控令牌桥接，不能硬编码家长账号/密码或管理密钥。
目前仅 staged bridge，未接入正式赛车站，保证第二章与已有存档原封不动。

## 阶段验收
已完成：GitHub 分支和 SQL/JS 文件、JS mock 单元测试、SQL 禁用破坏语句的静态测试。
未完成：真实 CloudBase preflight、迁移、RLS/JWT 权限实测、接口真实 HTTP 调用、
V6 数学/语文准确率事件补齐、自动同步长稳态、手机跨页计时、跨域身份桥接、
游戏 R5 UI/正式发布。没有真实数据库测试不能宣称功能上线。

## 部署准则
先运行 000_readonly_preflight.sql，并核对结构和权限。
只有通过审核后才允许执行 001_additive_r5_gate.sql。
不得运行任何删除/覆盖历史 V6 学习记录、存档及家长资料的操作。
