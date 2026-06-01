# 测试计划文档 — 团队即时投票工具

> 版本：v1.1 | 撰写人：寻错 🔍 | 日期：2026-06-01
> 关联 PRD：v1.1 | 关联架构：v1.1

---

## 目录

1. [测试策略](#一测试策略)
2. [单元测试用例](#二单元测试用例)
3. [集成测试用例（API 端点）](#三集成测试用例api-端点)
4. [WebSocket 测试方案](#四websocket-测试方案)
5. [E2E 测试场景](#五e2e-测试场景)
6. [性能测试方案](#六性能测试方案)
7. [测试数据清单](#七测试数据清单)
8. [测试覆盖矩阵](#八测试覆盖矩阵)

---

## 一、测试策略

### 1.1 测试策略概述

| 字段 | 内容 |
|------|------|
| 项目名称 | 团队即时投票工具 |
| 测试版本 | v1.1 |
| 撰写人 | 寻错 |
| 日期 | 2026-06-01 |
| 测试范围 | MVP 全量功能：创建投票、参与投票、实时看板、手动/自动结束、最终结果、投票列表、隐私声明 |

### 1.2 测试金字塔与分层策略

```
            ╱  E2E  ╲           Cypress / Playwright  — 4 个核心用户旅程
           ╱          ╲
          ╱  Integration ╲       Vitest + supertest   — 5 个 API 端点全覆盖
         ╱                ╲
        ╱   Unit Tests     ╲     Vitest               — 状态机、限流Lua、防重
       ╱────────────────────╲
```

### 1.3 各层覆盖范围与工具选型

| 测试层 | 覆盖范围 | 工具 | 覆盖率目标 | 关键验证点 |
|--------|----------|------|-----------|-----------|
| **单元测试** | 状态机（8 个路径）、限流 Lua 脚本（4 个场景）、防重检查、输入校验、工具函数 | Vitest | 状态机 100%、限流 4/4 场景 | 纯逻辑正确性，无 I/O 依赖 |
| **集成测试** | 5 个 REST API 端点 + WS 事件 + 防刷三层联动 | Vitest + supertest + ioredis mock / testcontainers | 33 条 AC 全覆盖 | API 契约正确性、错误码规范、三层防刷串联 |
| **E2E 测试** | 4 个核心用户旅程（匿名×单选、实名×多选、边界条件、异常路径） | Playwright（headless Chromium） | 关键路径 100% | 真实浏览器渲染、WS 实时同步、乐观更新回滚 |
| **性能测试** | 200 并发 WS 连接、投票 API 压测、ECharts 渲染基准 | k6 / Artillery | P99 满足 PRD 指标 | WS 广播延迟 ≤2s、API P99 ≤200ms |

### 1.4 测试环境要求

| 项目 | 说明 |
|------|------|
| Node.js | ≥20 LTS |
| PostgreSQL | 15（含 testcontainers 或独立实例） |
| Redis | 7.x（含 `notify-keyspace-events Ex` 配置） |
| 浏览器 | Chromium 120+（Playwright） |
| 飞书 SSO Mock | 本地 mock 飞书 token 验签服务（或 stub middleware） |
| 团队总人数 | `TEAM_TOTAL_MEMBERS=24`（大写死值，便于验证参与率） |

### 1.5 缺陷流转规则

```
发现缺陷 → Bug 报告（复现步骤/预期实际结果/截图日志）→ EeiMoo
EeiMoo 判定归属 → 转发对应开发（凌霜/流光）
开发修复 → 修复说明 → EeiMoo 转发寻错
寻错回归 → 通过则关闭 / 不通过追加信息退回
```

---

## 二、单元测试用例

> 工具：Vitest | 无外部 I/O 依赖（Redis/PG 均用 mock 或 stub）

### 2.1 状态机单元测试（8 个路径）

**测试对象**：`VoteService` / `BallotService` 状态转换逻辑（mock PG + Redis）

| 编号 | 测试路径 | 初始状态 | 操作 | 预期结果 | 验证方法 |
|------|----------|----------|------|----------|----------|
| UT-SM-01 | 正常创建投票 → active | 无 | `VoteService.create()` | 返回 `status: 'active'`，deadline = now + deadline_minutes，options 数量正确，redis tally 全部初始化为 0 | 断言返回值 status 字段 + mock Redis HSET 调用参数 |
| UT-SM-02 | active → 手动关闭 | `status='active'`，发起者是操作者 | `VoteService.closeVote(voteId, creatorId)` | 返回 `status: 'closed', closed_by: 'manual'`，触发 `DEL vote:{id}:deadline`，WS 广播 `vote:{id}:closed` | 断言 PG UPDATE 参数 + mock Redis DEL 调用 + mock io.to().emit() 调用 |
| UT-SM-03 | active → 自动关闭 | `status='active'`，deadline < now | `DeadlineWorker.closeVoteAutomatically(voteId)` | 返回 `status: 'closed', closed_by: 'auto'`，仅当 UPDATE 影响行数 >0 时广播 | 断言 PG UPDATE WHERE status='active' 影响行数 + mock io.to().emit() |
| UT-SM-04 | 手动结束与自动结束并发 | 两个操作几乎同时到达 | Thread A: `closeVote(manual)`，Thread B: `closeVoteAutomatically(auto)` | 先执行者胜（status 变为 closed），后执行者 `WHERE status='active'` 匹配 0 行，静默跳过不报错 | 模拟事务时序：Thread A 先获取 FOR UPDATE 锁并更新 → Thread B 的 WHERE status='active' 无匹配行 |
| UT-SM-05 | 提交投票时投票被手动结束 | `status='active'`，事务开始时突然变为 `closed` | `BallotService.submitVote()` 内 `FOR UPDATE` 后读到 `status='closed'` | 返回 403，PG 未写入 user_votes，Redis HINCRBY 未执行 | 断言 rollback 调用 + 错误码 40301 |
| UT-SM-06 | 提交投票时投票被自动结束 | 同 UT-SM-05，由自动结束触发 | 同上 | 返回 403，行为与手动结束一致 | 同上 |
| UT-SM-07 | 同一用户并发提交两次投票 | 同一 userId + voteId，两个请求同时到达 | 两次 INSERT INTO user_votes | 第一次成功，第二次触发 UNIQUE(vote_id, user_id) → PG error 23505 → 返回 409 | 模拟 PG unique_violation 错误码 23505 → 断言返回 40901 |
| UT-SM-08 | 服务重启后兜底扫描 | 存在 `status='active' AND deadline < NOW()` 的投票 | `startupRecoveryScan()` 执行 | 全部到期投票被标记为 closed，closed_by='auto' | 断言 db update 调用次数 = 到期投票数，每条含 closed_by='auto' |

### 2.2 限流 Lua 脚本单元测试（4 个场景）

**测试对象**：`RATE_LIMIT_SCRIPT` Lua 脚本（使用 `ioredis` mock 或 `redis-memory-server`）

| 编号 | 测试场景 | 前置条件 | 调用参数 | 预期结果 | 验证方法 |
|------|----------|----------|----------|----------|----------|
| UT-RL-01 | 窗口内第 1 次请求（通过） | 空 Sorted Set | `now=100000, window=60000, max=3` | 返回 0（OK），ZSET 中有 1 条记录 | 断言 `redis.eval` 返回 0，验证 ZADD 被调用 |
| UT-RL-02 | 窗口内第 3 次请求（仍通过） | ZSET 中已有 2 条记录（score=100001, 100002） | `now=100003, window=60000, max=3` | 返回 0（OK），ZSET 中有 3 条记录 | 断言 ZCARD 返回 2 → ZADD 执行 → 最终 3 条 |
| UT-RL-03 | 窗口内第 4 次请求（拒绝） | ZSET 中已有 3 条记录（100001, 100002, 100003） | `now=100004, window=60000, max=3` | 返回 `[最早时间戳, 最早score]`（非 0 = 拒绝），ZSET 仍为 3 条 | 断言返回值非 0，验证 ZCARD=3 后未执行 ZADD |
| UT-RL-04 | 窗口过期清理后通过 | ZSET 中有 4 条记录，其中 3 条在窗口外（score=30000, 31000, 32000），1 条在窗口内（score=99000） | `now=100000, window=60000, max=3` | 先 ZREMRANGEBYSCORE 清理 3 条过期 → ZCARD=1 → 通过 → ZADD 新增 1 条 | 断言 ZREMRANGEBYSCORE 被调用（清理 3 条），ZCARD 返回 1，ZADD 执行 |
| UT-RL-05 | 降级内存 Map 清理 | 内存 Map 中有 20 个 entry，其中 15 个 >1 分钟无新记录 | `setInterval` 触发清理 | 存活 entry ≤5 个（仅保留最近活跃），日志输出 `remaining_entries` | 断言 Map.size 减少，验证 `DEGRADE_ENTRY_MAX_AGE=60000` 过滤 |

### 2.3 防重检查单元测试

| 编号 | 测试场景 | 模拟 PG 行为 | 预期结果 |
|------|----------|-------------|----------|
| UT-DD-01 | 首次投票 → UNIQUE 约束未触发 | mock INSERT 成功（无异常） | `submitVote` 返回成功，继续执行 HINCRBY + WS 广播 |
| UT-DD-02 | 重复投票 → UNIQUE 约束触发 | mock INSERT 抛出 error.code='23505' | 捕获异常 → 返回 40901 '您已投过票'，不执行 HINCRBY |
| UT-DD-03 | FOR UPDATE 锁竞争 | mock `trx('votes')...forUpdate()` 等待超时 | 返回 50000 或超时错误，事务回滚 |
| UT-DD-04 | 事务中 status 已变为 closed | mock `FOR UPDATE` 后读到 `status='closed'` | 抛出 40301 '投票已结束'，事务回滚 |

### 2.4 输入校验单元测试

| 编号 | 测试场景 | 输入 | 预期结果 |
|------|----------|------|----------|
| UT-VL-01 | title 为空字符串 | `title: ''` | 校验失败，返回 'title 不能为空' |
| UT-VL-02 | title 超过 100 字符 | `title: 'x' * 101` | 校验失败，返回 'title 长度须在 1-100 之间' |
| UT-VL-03 | options 为空数组 | `options: []` | 校验失败，返回 'options 数量须在 2-10 之间' |
| UT-VL-04 | options 只有 1 项 | `options: ['A']` | 校验失败 |
| UT-VL-05 | options 有 11 项 | `options: ['A'...'K']` | 校验失败 |
| UT-VL-06 | options 有重复值 | `options: ['A', 'B', 'A']` | 校验失败，返回 '选项不可重复' |
| UT-VL-07 | option 内容超 50 字符 | `options: ['正常', 'x'*51]` | 校验失败 |
| UT-VL-08 | deadline_minutes = 0 | `deadline_minutes: 0` | 校验失败，返回 'deadline_minutes 须在 1-10080 之间' |
| UT-VL-09 | deadline_minutes = 10081 | `deadline_minutes: 10081` | 校验失败 |
| UT-VL-10 | vote_type 不在枚举值 | `vote_type: 'ranked'` | 校验失败 |
| UT-VL-11 | vote_mode 不在枚举值 | `vote_mode: 'hidden'` | 校验失败 |
| UT-VL-12 | option_ids 为空（提交投票） | `option_ids: []` | 校验失败，返回 'option_ids 不能为空' |
| UT-VL-13 | option_ids 中包含不存在的 option | `option_ids: [uuid_not_in_vote]` | 校验失败，返回 'option_ids 中有不属于本投票的选项' |

---

## 三、集成测试用例（API 端点）

> 工具：Vitest + supertest + testcontainers（PG + Redis 真实实例）
> 前置：每个 describe 前执行 DDL 初始化，每个 test 后清理测试数据

### 3.1 POST /api/votes — 创建投票

| 编号 | 关联 AC | 测试场景 | 前置条件 | 请求体 | 预期 HTTP 状态 | 预期响应 body | 验证项 |
|------|---------|----------|----------|--------|---------------|--------------|--------|
| IT-CV-01 | AC-001-1 | 正常：创建单选实名投票 | 有效 token，team_id=2ed263bf32ae1655 | `{title:'团建投票', options:['A','B','C'], vote_type:'single', vote_mode:'public', deadline_minutes:30}` | 201 | `code:0, data.vote.status:'active', data.vote.vote_type:'single', data.vote.vote_mode:'public'` | PG 中 votes/options 写入正确；Redis 中 `vote:{id}:tally` 所有 option 初始化为 0；`vote:{id}:deadline` key 存在且 TTL ≈ 1800s |
| IT-CV-02 | AC-001-2 | 正常：创建多选匿名投票（默认） | 有效 token | `{title:'多选测试', options:['X','Y','Z','W','V'], vote_type:'multi', vote_mode:'anonymous', deadline_minutes:15}` | 201 | `data.vote.vote_mode:'anonymous', data.vote.vote_type:'multi'` | options 数量=5；creator_name 从 token 提取写入 |
| IT-CV-03 | AC-001-3 | 边界：选项数=2（最小值） | 有效 token | `{title:'最少选项', options:['仅此','而已'], vote_type:'single', vote_mode:'anonymous', deadline_minutes:5}` | 201 | 创建成功 | options 数量=2 |
| IT-CV-04 | AC-001-4 | 边界：选项数=10（最大值） | 有效 token | options 数组 10 项 | 201 | 创建成功 | options 数量=10 |
| IT-CV-05 | AC-001-5 | 边界：标题长度 100 字 | 有效 token | title 为 100 字符 | 201 | 创建成功，title 完整存储 | PG 中 title 长度=100 |
| IT-CV-06 | AC-001-6 | 边界：截止时间 1 分钟 | 有效 token | `deadline_minutes:1` | 201 | 创建成功，deadline ≈ now+1min | Redis `vote:{id}:deadline` TTL≈60s |
| IT-CV-07 | AC-001-7 | 异常：标题为空 | 有效 token | `title:''` | 400 | `code:40001, detail:'title 不能为空'` | PG 未写入任何记录 |
| IT-CV-08 | AC-001-8 | 异常：选项有重复 | 有效 token | `options:['A','B','A']` | 400 | `code:40003, detail:'选项不可重复'` | — |
| IT-CV-09 | AC-001-9 | 异常：选项有空值 | 有效 token | `options:['A','']` | 400 | `code:40001`，提示选项非空 | — |
| IT-CV-10 | AC-001-10 | 异常：网络中断（模拟） | mock PG 连接超时 | 正常请求体 | 500 | `code:50000` | 前端表单数据保留（E2E 验证） |
| IT-CV-11 | — | 异常：未认证 | 无 Authorization header | 正常请求体 | 401 | `code:40100` | — |
| IT-CV-12 | — | 边界：deadline_minutes=10080（最大值） | 有效 token | `deadline_minutes:10080` | 201 | 创建成功 | Redis TTL≈604800s |
| IT-CV-13 | — | 异常：deadline_minutes>10080 | 有效 token | `deadline_minutes:10081` | 400 | `code:40004` | — |
| IT-CV-14 | — | 异常：options 数量=11 | 有效 token | 11 个选项 | 400 | `code:40002` | — |

### 3.2 GET /api/votes — 投票列表

| 编号 | 关联 AC | 测试场景 | 前置条件 | 请求参数 | 预期 HTTP 状态 | 预期响应 | 验证项 |
|------|---------|----------|----------|-----------|---------------|----------|--------|
| IT-VL-01 | AC-007-1 | 正常：列表展示进行中投票 | PG 中有 3 个 active 投票，均属于当前 team_id | `?status=active&page=1&size=20` | 200 | `data.items.length:3, data.total:3` | 每项含 title、vote_type、vote_mode、deadline、vote_count；按 team_id 过滤 |
| IT-VL-02 | AC-007-2 | 边界：无进行中投票 | PG 中所有投票均为 closed | `?status=active` | 200 | `data.items:[], data.total:0` | 空数组 |
| IT-VL-03 | AC-007-3 | 正常：切换已结束 Tab | PG 中有 2 个 closed 投票 | `?status=closed` | 200 | `data.items.length:2` | 每项 status 均为 'closed' |
| IT-VL-04 | — | 边界：分页第 2 页 | PG 中有 25 个 active 投票 | `?status=active&page=2&size=20` | 200 | `data.items.length:5, data.total:25, data.page:2` | 仅含第 21-25 条 |
| IT-VL-05 | — | 边界：size=100（最大值） | PG 中有 50 个 active 投票 | `?size=100` | 200 | `data.items.length:50` | — |
| IT-VL-06 | — | 异常：page=0 | — | `?page=0` | 400 | 参数校验失败 | — |
| IT-VL-07 | — | 异常：size=101 | — | `?size=101` | 400 | 参数校验失败 | — |
| IT-VL-08 | — | 安全：跨团队不可见 | team_A 创建 2 个投票，team_B token 请求 | `?status=active` | 200 | `data.items:[]`（仅返回本团队投票） | team_id 过滤生效 |
| IT-VL-09 | — | creator_name 快照验证 | 创建投票后修改 SSO token 中的 name | `?status=active` | 200 | creator_name 仍为创建时的快照值 | 不从 token 重新获取 |

### 3.3 GET /api/votes/:id — 投票详情

| 编号 | 关联 AC | 测试场景 | 前置条件 | 预期 HTTP 状态 | 预期响应 | 验证项 |
|------|---------|----------|----------|---------------|----------|--------|
| IT-VD-01 | AC-003-1 | 正常：匿名模式 voters 为空 | vote_mode='anonymous'，status='active' | 200 | `data.vote.options[*].voters:[]`（所有选项 voters 为空数组） | 字段级过滤生效，无 user_id 泄露 |
| IT-VD-02 | AC-003-2 | 正常：实名模式返回 voters | vote_mode='public'，已有 2 人投票 | 200 | `data.vote.options[*].voters` 含投票人 user_id+user_name | voters 数组非空 |
| IT-VD-03 | AC-003-5 | 边界：无人投票 | 投票刚创建，0 人投票 | 200 | 所有 `options[*].count:0`，百分比为 0% | tally 全为 0 |
| IT-VD-04 | AC-003-6 | 边界：所有人已投票 | 24 人均已投票（单选） | 200 | 各 option count 之和=24 | tally 与 PG user_votes 一致 |
| IT-VD-05 | AC-006-1 | 正常：已结束投票展示最终结果 | status='closed' | 200 | `data.vote.status:'closed'`，options 有票数/百分比 | closed_at/closed_by 存在 |
| IT-VD-06 | AC-006-2 | 正常：实名+已结束显示投票人明细 | vote_mode='public'，status='closed' | 200 | options[*].voters 含完整名单 | 不可折叠（前端验证） |
| IT-VD-07 | AC-006-3 | 正常：匿名+已结束不显示投票人 | vote_mode='anonymous'，status='closed' | 200 | options[*].voters:[] | 仍为空数组 |
| IT-VD-08 | — | 正常：has_voted=true（已投票用户） | 当前用户已投该投票 | 200 | `data.has_voted:true, data.my_selected_options:[...]` | my_selected_options 仅含自己的选项 |
| IT-VD-09 | — | 正常：has_voted=false（未投票用户） | 当前用户未投该投票 | 200 | `data.has_voted:false, data.my_selected_options:[]` | — |
| IT-VD-10 | — | 安全：匿名模式下发起者也不能看到 voters | vote_mode='anonymous'，发起者 token 请求 | 200 | voters:[] | 即使是发起者，匿名模式下也不泄露 |
| IT-VD-11 | — | 安全：实名模式下发起者看到完整 voters | vote_mode='public'，发起者 token | 200 | voters 含所有投票人信息 | — |
| IT-VD-12 | — | 异常：vote_id 不存在 | 随机 UUID | 404 | `code:40400` | — |
| IT-VD-13 | — | 安全：跨团队不可查看详情 | team_B token 请求 team_A 的投票 | 404 或 403 | 不可访问其他团队投票 | team_id 校验 |

### 3.4 POST /api/votes/:id/vote — 提交投票

| 编号 | 关联 AC | 测试场景 | 前置条件 | 请求体 | 预期 HTTP 状态 | 预期响应 | 验证项 |
|------|---------|----------|----------|--------|---------------|----------|--------|
| IT-SV-01 | AC-002-1 | 正常：单选提交 1 个选项 | active 单选投票，用户未投 | `{option_ids:[optA_id]}` | 200 | `code:0` | PG user_votes 写入 1 条；Redis `HINCRBY vote:{id}:tally optA 1` → count +1；WS 广播 `vote:{id}:update` |
| IT-SV-02 | AC-002-2 | 正常：多选提交 3 个选项 | active 多选投票，用户未投 | `{option_ids:[optA_id, optB_id, optC_id]}` | 200 | `code:0` | PG user_votes selected_options 数组长度=3；Redis 3 个 field 各 +1 |
| IT-SV-03 | AC-002-3 | 边界：多选只选 1 项 | active 多选投票 | `{option_ids:[optA_id]}` | 200 | 成功 | 数组长度=1，允许 |
| IT-SV-04 | AC-002-4 | 边界：多选全选（5 项） | active 多选投票，5 个选项 | `{option_ids:[全部5个ID]}` | 200 | 成功 | 5 项全部选上 |
| IT-SV-05 | AC-002-5 | 异常：未选择任何选项 | active 投票 | `{option_ids:[]}` | 400 | `code:40001` | 或按钮置灰（前端验证） |
| IT-SV-06 | AC-002-6 | 异常：已投票用户再次提交 | 用户已投过此投票 | `{option_ids:[optA_id]}` | 409 | `code:40901, message:'您已投过票'` | PG UNIQUE 约束触发 23505 |
| IT-SV-07 | AC-002-7 | 异常：投票已结束后提交 | status='closed' | `{option_ids:[optA_id]}` | 403 | `code:40301, message:'投票已结束'` | — |
| IT-SV-08 | — | 异常：option_ids 含不属于本投票的 ID | 另一投票的 option_id | `{option_ids:[other_opt_id]}` | 400 | `code:40005` | 选项归属校验 |
| IT-SV-09 | — | 异常：速率限制第 4 次请求 | 同一 userId+voteId，60s 内已有 3 次提交（含失败重试） | `{option_ids:[optA_id]}` | 429 | `code:42900` + `Retry-After` 头 | Redis Sorted Set 中该 key 有 3 条记录 |
| IT-SV-10 | — | 并发：5 个用户同时提交 | 5 个不同 userId，同一 vote，同一 option | 并发 5 个 POST | 全部 200 | Redis tally 该 option count=5 | HINCRBY 原子性保证 |
| IT-SV-11 | — | 并发：同一用户并发 2 次提交 | 同一 userId+voteId，几乎同时 | 并发 2 个 POST | 1 个 200 + 1 个 409 | 仅写入 1 条 user_votes，Redis count 仅 +1 | UNIQUE 约束兜底 |
| IT-SV-12 | — | 乐观更新回滚验证 | mock Redis HINCRBY 成功但 WS 广播前 PG 写入已成功 | 正常提交 | 200 | 前端收到 WS 回推时 count 与乐观更新一致，不重复+1 | 需配合前端 E2E 验证 |

### 3.5 POST /api/votes/:id/close — 结束投票

| 编号 | 关联 AC | 测试场景 | 前置条件 | 预期 HTTP 状态 | 预期响应 | 验证项 |
|------|---------|----------|----------|---------------|----------|--------|
| IT-CL-01 | AC-004-1 | 正常：发起者手动结束 | 发起者 token，active 投票 | 200 | `code:0, data.status:'closed', data.closed_by:'manual'` | PG votes.status='closed'；Redis `vote:{id}:deadline` key 被 DEL；WS 广播 `vote:{id}:closed` |
| IT-CL-02 | AC-004-2 | 异常：非发起者尝试结束 | 普通参与者 token | 403 | `code:40302, message:'仅投票发起者可结束投票'` | PG status 未变 |
| IT-CL-03 | AC-004-3 | 异常：发起者取消确认 | — | — | — | 前端验证：弹窗取消 → 状态不变 |
| IT-CL-04 | — | 异常：投票已结束 | status='closed' | 409 | `code:40902, message:'投票已结束'` | — |
| IT-CL-05 | — | 异常：vote_id 不存在 | 随机 UUID | 404 | `code:40400` | — |
| IT-CL-06 | — | 安全：跨团队不可结束 | team_B 成员请求 team_A 的投票 | 403 | 权限拒绝 | team_id 校验 |
| IT-CL-07 | — | 并发：手动结束 vs 自动结束 | 几乎同时触发 | 200（先到者） | 后到者 `WHERE status='active'` 无匹配行，静默不报错 | 条件 UPDATE + 影响行数 |

---

## 四、WebSocket 测试方案

> 工具：自定义 WS 测试脚本（Node.js `socket.io-client` + 多实例并发）或 k6 WebSocket

### 4.1 多客户端实时同步测试

| 编号 | 测试场景 | 前置条件 | 操作步骤 | 预期结果 | 验证方法 |
|------|----------|----------|----------|----------|----------|
| WS-SYNC-01 | 3 客户端同时进入投票页 | 创建 active 匿名单选投票（4 个选项），3 个客户端已认证并 join `vote:{id}` room | Client A 提交投票选中 option_1 → 等待 ≤2s | Client B、Client C 在 ≤2s 内收到 `vote:{id}:update` 事件，option_1 count+=1，图表自动更新 | 监听 3 个客户端的 WS 事件接收时间戳，计算最大延迟 |
| WS-SYNC-02 | 3 客户端分别投不同选项 | 同上 | Client A 投 opt_1，Client B 投 opt_2，Client C 投 opt_3 | 三个客户端最终图表显示 opt_1=1, opt_2=1, opt_3=1（总计 3 票） | 等待所有事件到达后，断言各客户端图表数据一致 |
| WS-SYNC-03 | 发送者不收到自己的 WS 广播 | Client A 已 join room | Client A 提交投票 | Client A 不收到 `vote:{id}:update` 事件（由乐观更新处理），仅 Client B/C 收到 | 断言 Client A 的 WS 监听器未触发 update 事件回调 |
| WS-SYNC-04 | WS 接入层验证（Nginx proxy + ip_hash） | 2 个 app 实例（模拟扩展），同一客户端 2 次连接 | 客户端断开重连 | 2 次连接均路由到同一 app 实例（ip_hash 生效） | 检查 app 日志中同一 client IP 的连接记录 |

### 4.2 断线重连 + 消息补偿测试

| 编号 | 测试场景 | 前置条件 | 操作步骤 | 预期结果 | 验证方法 |
|------|----------|----------|----------|----------|----------|
| WS-RC-01 | 投票页 WS 断开期间有人投票 | Client A、Client B 进入同一投票页 | 1. 中断 Client B 网络（或 kill app 进程触发容器重启）2. Client A 投票 2 次 3. 恢复 Client B 网络 | Client B 重连后：黄色横幅消失 → 全量拉取 GET `/votes/:id` → 图表更新至最新（含 A 的 2 票） | Socket.IO 自动重连 + `refetchVoteDetail()` 触发；验证 tally 与 PG 一致 |
| WS-RC-02 | 投票页 WS 断开期间投票结束 | Client A 在投票页，投票剩余 10s | 1. 中断 Client A 网络 2. 等待投票自动结束 3. 恢复 Client A 网络 | Client A 重连后拉取详情 → 发现 status='closed' → 页面切换为已结束状态 | 验证 `vote:{id}:closed` 事件虽丢失，但全量拉取覆盖 |
| WS-RC-03 | 指数退避重连 | Client 主动断开 | 观察 `reconnectionDelay` 序列 | 第 1 次: 1s, 第 2 次: 2s, 第 3 次: 4s, ... 最大 30s | Socket.IO 配置验证 |
| WS-RC-04 | app 滚动重启时客户端行为 | `docker-compose up -d --no-deps app` | 观察客户端 WS 状态 | 断开 → 自动重连（≤30s）→ 重连后全量拉取数据 → 状态一致 | 验证断开到恢复的端到端时间 ≤35s |

### 4.3 截止时间自动结束测试

| 编号 | 测试场景 | 前置条件 | 操作步骤 | 预期结果 | 验证方法 |
|------|----------|----------|----------|----------|----------|
| WS-AE-01 | 倒计时归零自动结束 | 创建投票 `deadline_minutes=1`（测试用缩短时间） | 等待 60s（或 mock Redis TTL 过期事件更快） | 所有在线客户端收到 `vote:{id}:closed`（closed_by:'auto'）；投票详情 API 返回 status='closed' | 监听 WS 事件 + 查询 PG 状态 |
| WS-AE-02 | 手动结束阻止自动结束重复触发 | 创建投票 deadline=10min | 发起者手动结束 → 手动结束后 Redis deadline key 被删除 → 原始 TTL 到期不触发 | `vote:{id}:closed` 仅触发 1 次（手动结束那次），closed_by='manual' | 确认无重复 closed 事件 |
| WS-AE-03 | 截止前 1 分钟提醒 | 创建投票 `deadline_minutes=2` | 等待到剩余 60s | 所有在线客户端收到 `vote:{id}:reminder {remaining_seconds:60}` | 监听 WS reminder 事件 |
| WS-AE-04 | Redis 不可用时自动结束兜底 | 停止 Redis 容器 | 等待投票 deadline 到期 | 应用层兜底扫描（每 10s）检测到 deadline < NOW() → 执行关闭 → 广播 | 降级模式下自动化结束仍生效 |
| WS-AE-05 | 服务重启后兜底恢复 | kill app 进程，存在 3 个已到期未结束的 active 投票 | `docker restart vote-app` | 启动后 `startupRecoveryScan()` 扫描并结束全部 3 个投票，closed_by='auto' | 检查 PG 中 3 条记录 status 均变为 'closed' |

### 4.4 并发投票原子性测试

| 编号 | 测试场景 | 前置条件 | 操作步骤 | 预期结果 | 验证方法 |
|------|----------|----------|----------|----------|----------|
| WS-CONC-01 | 5 个客户端同时提交同一选项 | 5 个已认证的 socket 客户端，均 join 同一 vote room | 几乎同时 POST `/api/votes/:id/vote`（`Promise.all`） | 全部返回 200；Redis HINCRBY 后该 option count=5；WS 广播 5 次 `vote:{id}:update`，每次 new_count 递增 1 | 断言 Redis tally 最终值 + 监听 WS 广播次数 |
| WS-CONC-02 | 20 个客户端同时提交不同选项 | 20 个客户端，10 个选项，每选项 2 人 | 同时提交 | 每选项 count=2，总计 20 票 | Redis tally 逐项验证 |
| WS-CONC-03 | 并发提交 + WS 广播完整性 | 10 个客户端，1 个监听客户端 | 10 个客户端同时提交，监听客户端记录所有 WS update 事件 | 监听客户端收到的 WS 事件数=10，最终 tally 与 API 一致 | 计数 WS 事件 + 查询 API 对账 |
| WS-CONC-04 | 并发提交 vs 投票结束竞态 | 5 个客户端提交时发起者在另一个线程执行 close | 同时触发 | 提交要么成功（若在 FOR UPDATE 锁获取前）要么返回 403（若在锁之后）；WS 只广播成功的投票 | 验证一致性：PG user_votes count = Redis tally 各 field 之和 |

---

## 五、E2E 测试场景

> 工具：Playwright（headless Chromium） | 完整用户旅程，真实浏览器渲染

### 5.1 完整用户旅程矩阵

| 场景编号 | 旅程描述 | 投票类型 | 投票模式 | 关键验证点 |
|----------|----------|----------|----------|-----------|
| E2E-J1 | 匿名+单选：创建→投票→结束→查看结果 | single | anonymous | 隐私声明展示、实名信息不可见、乐观更新、自动结束 |
| E2E-J2 | 实名+多选：创建→投票→结束→查看结果 | multi | public | 投票人明细可见、多选项提交、手动结束 |
| E2E-J3 | 边界条件：2 选项+100 字标题+1 分钟截止 | single | anonymous | 极值输入通过、快速自动结束 |
| E2E-J4 | 异常路径：乐观更新失败回滚 + 重复投票拒绝 | single | anonymous | 回滚提示、数据恢复正确 |

### 5.2 详细 E2E 用例

#### E2E-J1：匿名单选完整旅程

**测试角色**：Creator（发起者）、VoterA（参与者）、VoterB（参与者）
**浏览器实例**：3 个独立 context（模拟 3 个不同用户）

| 步骤 | 操作者 | 操作 | 预期结果 |
|------|--------|------|----------|
| 1 | Creator | 登录 → 进入 `/votes/new` → 填写标题「团建投票」→ 添加 3 个选项「杭州/苏州/无锡」→ 确认为单选+匿名（默认）→ 设置截止 5 分钟 → 点击发布 | 跳转到 `/votes/:id`，页面显示投票详情（进行中），3 个选项均为 0 票 |
| 2 | VoterA | 登录 → 进入同一投票页 | 看到匿名隐私声明蓝色提示条；选项区可交互；图表 3 柱皆为 0 |
| 3 | VoterB | 登录 → 进入同一投票页 | 同上 |
| 4 | VoterA | 选中「杭州」→ 点击「提交投票」 | 按钮变为「✓ 已投票」；本端图表「杭州」柱立即变为 1 票（乐观更新）；匿名 voters 不可见 |
| 5 | VoterB | 观察图表变化（不操作） | ≤2s 内「杭州」柱从 0→1，无用户头像/姓名 |
| 6 | Creator | 观察图表 | 「杭州」=1 票，无用户身份信息 |
| 7 | VoterA | 尝试再次点击选项 | 选项只读，不可改选，底部显示「投票已提交，不可更改」 |
| 8 | Creator | 点击「结束投票」→ 确认弹窗 → 确认 | 所有 3 个浏览器页面切换为「已结束」状态，最终结果展示「杭州 1 票 100%」 |
| 9 | Creator | 查看结果页 | 无投票人明细（匿名+已结束也不暴露），总票数=1 |

#### E2E-J2：实名多选完整旅程

| 步骤 | 操作者 | 操作 | 预期结果 |
|------|--------|------|----------|
| 1 | Creator | 创建多选+实名投票，4 个选项，截止 10 分钟 | 发布成功 |
| 2 | VoterA | 进入投票页，勾选 2 个选项 → 提交 | 提交成功，柱状图更新 |
| 3 | VoterB | 进入投票页，勾选 3 个选项（不同组合）→ 提交 | 提交成功 |
| 4 | VoterA | hover 图表某选项柱 | 出现浮层，展示投该选项的用户列表（头像+姓名） |
| 5 | Creator | 手动结束投票 | 投票结束 |
| 6 | Creator | 查看最终结果 | 各选项显示投票人明细（头像+姓名，不可折叠），总票数=各选项票数之和（无重复计数） |
| 7 | VoterA | 查看最终结果 | 同样可见投票人明细（实名模式下信息公开） |

#### E2E-J3：边界条件旅程

| 步骤 | 操作者 | 操作 | 预期结果 |
|------|--------|------|----------|
| 1 | Creator | 打开创建页 → 删除选项至只剩 2 个 → 输入 100 字标题 → 设置截止 1 分钟 | 「+ 添加选项」可用（可添加至 10）；计数器显示 100/100；截止时间可设为 1 |
| 2 | Creator | 发布 | 发布成功 |
| 3 | Creator | 观察倒计时 | 从 01:00 递减 → 00:10 红色闪烁 → 00:00 自动结束 |
| 4 | Creator | 验证结果 | status='closed', closed_by='auto' |

#### E2E-J4：异常路径 + 乐观更新回滚

| 步骤 | 操作者 | 操作 | 预期结果 |
|------|--------|------|----------|
| 1 | Creator | 创建匿名单选投票 | 发布成功 |
| 2 | VoterA | 进入投票页 | 正常显示 |
| 3 | — | Mock 服务端：提交投票 API 返回 409（模拟后端判定重复投票） | — |
| 4 | VoterA | 选中选项 → 点击提交 | 本端图表先乐观更新 +1；收到 409 响应后回滚（撤销 +1）；toast 显示「您已投过票」；主动拉取最新状态 |
| 5 | VoterA | 验证图表 | 图表数据与 API 返回一致（回滚后正确） |
| 6 | Creator | 手动结束投票 | 结束成功 |
| 7 | VoterA | 重新进入已结束投票页 | 选项只读，不可投票，仅展示最终结果 |

---

## 六、性能测试方案

### 6.1 测试工具与环境

| 项目 | 配置 |
|------|------|
| 压测工具 | k6（推荐）或 Artillery |
| 目标环境 | Docker Compose 部署的完整四容器（nginx+app+pg+redis） |
| 压测机 | 与目标同网段，避免网络成为瓶颈 |
| 监控 | `GET /health/metrics` 实时指标 + Docker stats |
| 预热 | 压测前执行 30s 预热（10 并发），确保连接池充满 |

### 6.2 WebSocket 并发连接测试

| 编号 | 测试场景 | 并发量 | 持续时间 | 操作 | 成功标准 | 监控指标 |
|------|----------|--------|----------|------|----------|----------|
| PERF-WS-01 | 200 客户端同时建立 WS 连接 | 200 | — | 依次建立连接 → join `vote:{id}` room | 全部 200 连接成功建立，无拒绝/超时；连接建立 P99 ≤3s | WS 连接数=200；Nginx worker_connections 未耗尽 |
| PERF-WS-02 | 200 客户端保持连接 + 持续广播 | 200 | 5 分钟 | 每 2s 由 1 个客户端提交 1 次投票 → 广播到其余 199 个 | 广播延迟 P99 ≤2s；无消息丢失；所有客户端 tally 一致 | WS 广播延迟直方图；Socket.IO rooms.size=1 |
| PERF-WS-03 | 粘性会话稳定性 | 200 | 10 分钟 | 每 30s 随机断开 10 个客户端重连 | 重连客户端 100% 路由到同一 app 实例（ip_hash 生效） | Nginx access log 分析 |

### 6.3 API 压测

| 编号 | 测试场景 | 并发 VU | 持续时间 | 目标 API | 吞吐目标 | 响应时间目标 |
|------|----------|---------|----------|----------|----------|-------------|
| PERF-API-01 | 投票列表查询 | 50 VU × 2min | 斜坡 30s → 稳态 90s | `GET /api/votes?status=active&page=1&size=20` | ≥200 RPS | P99 ≤100ms |
| PERF-API-02 | 投票详情查询 | 50 VU × 2min | 同上 | `GET /api/votes/:id` | ≥200 RPS | P99 ≤100ms |
| PERF-API-03 | 创建投票 | 20 VU × 2min | 同上 | `POST /api/votes` | ≥50 RPS | P99 ≤200ms |
| PERF-API-04 | 提交投票 | 30 VU × 3min | 同上 | `POST /api/votes/:id/vote` | ≥100 RPS | P99 ≤200ms |
| PERF-API-05 | 混合负载（模拟真实场景） | 100 VU × 5min | 同上 | 70% GET 列表/详情 + 20% POST 投票 + 10% POST 创建 | — | 错误率 <0.1% |

### 6.4 Redis 降级场景性能

| 编号 | 测试场景 | 配置 | 预期 |
|------|----------|------|------|
| PERF-DG-01 | Redis 正常 vs 降级对比 | 先正常压测 → 停止 Redis → 再压测 | 降级后 API P99 升高（PG 聚合查询替代 HGETALL）但功能可用；确认 `health:degraded` 标志位正确 |
| PERF-DG-02 | 降级恢复 | Redis 重启后 | `health:degraded` 清除 → TallySync 重建所有 tally → 性能恢复到正常水平 |

### 6.5 ECharts 渲染基准

| 编号 | 测试场景 | 数据量 | 测量方法 | 目标 |
|------|----------|--------|----------|------|
| PERF-ECH-01 | 10 选项首次渲染 | 10 个 option，票数随机 1-10 | `performance.mark` 测量 `setOption` 耗时 | ≤100ms |
| PERF-ECH-02 | 增量更新（WS 推送） | 已有 10 柱，增量更新 1 柱 | 同上前后 `setOption` 差分对比 | ≤30ms |
| PERF-ECH-03 | 移动端弱设备渲染 | 模拟 CPU 4x slowdown（Playwright） | 同 PERF-ECH-01 | ≤300ms（弱设备允许放宽） |

---

## 七、测试数据清单

### 7.1 前置数据 SQL

```sql
-- ============================================================
-- 测试数据初始化脚本
-- 用途：为集成测试和 E2E 测试提供前置数据
-- 前置：已执行 DDL（CREATE TABLE votes/options/user_votes）
-- 备注：team_id 统一使用 '2ed263bf32ae1655'（模拟飞书 tenant_key）
-- ============================================================

-- 飞书 user_id 均为 VARCHAR(64) 格式（如 ou_xxx）

-- ----------------------------------------------------------
-- 场景 A：进行中匿名单选投票（3 选项，5 人已投）
-- 用途：测试实时看板、提交投票、WS 同步
-- ----------------------------------------------------------
INSERT INTO votes (id, title, creator_id, creator_name, team_id, vote_type, vote_mode, status, deadline, total_voters, created_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Sprint 24 团建去哪儿？',
  'ou_creator001',
  '张三',
  '2ed263bf32ae1655',
  'single',
  'anonymous',
  'active',
  NOW() + INTERVAL '30 minutes',
  24,
  NOW() - INTERVAL '5 minutes'
);

INSERT INTO options (id, vote_id, content, sort_order) VALUES
  ('a0000000-0000-0000-0000-100000000001', 'a0000000-0000-0000-0000-000000000001', '杭州西湖', 0),
  ('a0000000-0000-0000-0000-100000000002', 'a0000000-0000-0000-0000-000000000001', '苏州园林', 1),
  ('a0000000-0000-0000-0000-100000000003', 'a0000000-0000-0000-0000-000000000001', '无锡太湖', 2);

-- 5 人已投票（分散在不同选项）
INSERT INTO user_votes (id, vote_id, user_id, selected_options, created_at) VALUES
  ('a0000000-0000-0000-0000-200000000001', 'a0000000-0000-0000-0000-000000000001', 'ou_voter001', ARRAY['a0000000-0000-0000-0000-100000000001']::uuid[], NOW() - INTERVAL '4 minutes'),
  ('a0000000-0000-0000-0000-200000000002', 'a0000000-0000-0000-0000-000000000001', 'ou_voter002', ARRAY['a0000000-0000-0000-0000-100000000001']::uuid[], NOW() - INTERVAL '3 minutes'),
  ('a0000000-0000-0000-0000-200000000003', 'a0000000-0000-0000-0000-000000000001', 'ou_voter003', ARRAY['a0000000-0000-0000-0000-100000000002']::uuid[], NOW() - INTERVAL '2 minutes'),
  ('a0000000-0000-0000-0000-200000000004', 'a0000000-0000-0000-0000-000000000001', 'ou_voter004', ARRAY['a0000000-0000-0000-0000-100000000002']::uuid[], NOW() - INTERVAL '1 minute'),
  ('a0000000-0000-0000-0000-200000000005', 'a0000000-0000-0000-0000-000000000001', 'ou_voter005', ARRAY['a0000000-0000-0000-0000-100000000003']::uuid[], NOW() - INTERVAL '30 seconds');

-- Redis 补充数据（初始化 tally）
-- HSET vote:a0000000-0000-0000-0000-000000000001:tally a0000000-0000-0000-0000-100000000001 2 a0000000-0000-0000-0000-100000000002 2 a0000000-0000-0000-0000-100000000003 1
-- SET vote:a0000000-0000-0000-0000-000000000001:deadline "2026-06-01T16:XX:XX" EX 1800


-- ----------------------------------------------------------
-- 场景 B：进行中实名多选投票（5 选项，3 人已投）
-- 用途：测试实名查看投票人、多选提交
-- ----------------------------------------------------------
INSERT INTO votes (id, title, creator_id, creator_name, team_id, vote_type, vote_mode, status, deadline, total_voters, created_at)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  '技术栈选型投票',
  'ou_creator001',
  '张三',
  '2ed263bf32ae1655',
  'multi',
  'public',
  'active',
  NOW() + INTERVAL '1 hour',
  24,
  NOW() - INTERVAL '10 minutes'
);

INSERT INTO options (id, vote_id, content, sort_order) VALUES
  ('b0000000-0000-0000-0000-100000000001', 'b0000000-0000-0000-0000-000000000001', 'React + Express', 0),
  ('b0000000-0000-0000-0000-100000000002', 'b0000000-0000-0000-0000-000000000001', 'Vue + Koa', 1),
  ('b0000000-0000-0000-0000-100000000003', 'b0000000-0000-0000-0000-000000000001', 'Svelte + Fastify', 2),
  ('b0000000-0000-0000-0000-100000000004', 'b0000000-0000-0000-0000-000000000001', 'Angular + NestJS', 3),
  ('b0000000-0000-0000-0000-100000000005', 'b0000000-0000-0000-0000-000000000001', 'Next.js + tRPC', 4);

-- 3 人多选投票（模拟不同选择组合）
INSERT INTO user_votes (id, vote_id, user_id, selected_options, created_at) VALUES
  ('b0000000-0000-0000-0000-200000000001', 'b0000000-0000-0000-0000-000000000001', 'ou_voter001',
   ARRAY['b0000000-0000-0000-0000-100000000001','b0000000-0000-0000-0000-100000000003','b0000000-0000-0000-0000-100000000005']::uuid[], NOW() - INTERVAL '8 minutes'),
  ('b0000000-0000-0000-0000-200000000002', 'b0000000-0000-0000-0000-000000000001', 'ou_voter002',
   ARRAY['b0000000-0000-0000-0000-100000000001','b0000000-0000-0000-0000-100000000002']::uuid[], NOW() - INTERVAL '6 minutes'),
  ('b0000000-0000-0000-0000-200000000003', 'b0000000-0000-0000-0000-000000000001', 'ou_voter003',
   ARRAY['b0000000-0000-0000-0000-100000000004','b0000000-0000-0000-0000-100000000005']::uuid[], NOW() - INTERVAL '4 minutes');


-- ----------------------------------------------------------
-- 场景 C：已结束匿名投票（2 选项，全员 24 人均已投票）
-- 用途：测试最终结果页、匿名不暴露身份
-- ----------------------------------------------------------
INSERT INTO votes (id, title, creator_id, creator_name, team_id, vote_type, vote_mode, status, deadline, total_voters, created_at, closed_at, closed_by)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  '是否需要引入敏捷开发？',
  'ou_creator001',
  '张三',
  '2ed263bf32ae1655',
  'single',
  'anonymous',
  'closed',
  NOW() - INTERVAL '1 hour',
  24,
  NOW() - INTERVAL '2 hours',
  NOW() - INTERVAL '1 hour',
  'manual'
);

INSERT INTO options (id, vote_id, content, sort_order) VALUES
  ('c0000000-0000-0000-0000-100000000001', 'c0000000-0000-0000-0000-000000000001', '支持', 0),
  ('c0000000-0000-0000-0000-100000000002', 'c0000000-0000-0000-0000-000000000001', '反对', 1);

-- 24 人投票：16 支持 vs 8 反对
DO $$
DECLARE
  i INTEGER;
BEGIN
  FOR i IN 1..16 LOOP
    INSERT INTO user_votes (id, vote_id, user_id, selected_options, created_at)
    VALUES (gen_random_uuid(), 'c0000000-0000-0000-0000-000000000001',
            'ou_voter_c' || LPAD(i::TEXT, 3, '0'),
            ARRAY['c0000000-0000-0000-0000-100000000001']::uuid[],
            NOW() - INTERVAL '90 minutes' + (i * INTERVAL '30 seconds'));
  END LOOP;

  FOR i IN 17..24 LOOP
    INSERT INTO user_votes (id, vote_id, user_id, selected_options, created_at)
    VALUES (gen_random_uuid(), 'c0000000-0000-0000-0000-000000000001',
            'ou_voter_c' || LPAD(i::TEXT, 3, '0'),
            ARRAY['c0000000-0000-0000-0000-100000000002']::uuid[],
            NOW() - INTERVAL '90 minutes' + (i * INTERVAL '30 seconds'));
  END LOOP;
END $$;


-- ----------------------------------------------------------
-- 场景 D：即将到期的投票（deadline < 2min）
-- 用途：测试倒计时校准、自动结束、截止提醒
-- ----------------------------------------------------------
INSERT INTO votes (id, title, creator_id, creator_name, team_id, vote_type, vote_mode, status, deadline, total_voters, created_at)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  '即将到期的投票',
  'ou_creator002',
  '李四',
  '2ed263bf32ae1655',
  'single',
  'anonymous',
  'active',
  NOW() + INTERVAL '90 seconds',   -- 90s 后到期，触发 reminder（60s）+ 自动结束
  24,
  NOW() - INTERVAL '5 minutes'
);

INSERT INTO options (id, vote_id, content, sort_order) VALUES
  ('d0000000-0000-0000-0000-100000000001', 'd0000000-0000-0000-0000-000000000001', '选项 A', 0),
  ('d0000000-0000-0000-0000-100000000002', 'd0000000-0000-0000-0000-000000000001', '选项 B', 1);


-- ----------------------------------------------------------
-- 场景 E：空白投票（0 人投票，10 选项最大值）
-- 用途：测试边界条件——0 票图表、10 选项渲染、空状态
-- ----------------------------------------------------------
INSERT INTO votes (id, title, creator_id, creator_name, team_id, vote_type, vote_mode, status, deadline, total_voters, created_at)
VALUES (
  'e0000000-0000-0000-0000-000000000001',
  '年度最受欢迎技术文章评选',
  'ou_creator003',
  '王五',
  '2ed263bf32ae1655',
  'multi',
  'public',
  'active',
  NOW() + INTERVAL '2 hours',
  24,
  NOW()
);

INSERT INTO options (id, vote_id, content, sort_order) VALUES
  ('e0000000-0000-0000-0000-100000000001', 'e0000000-0000-0000-0000-000000000001', '文章 A：微服务架构实践', 0),
  ('e0000000-0000-0000-0000-100000000002', 'e0000000-0000-0000-0000-000000000001', '文章 B：前端性能优化指南', 1),
  ('e0000000-0000-0000-0000-100000000003', 'e0000000-0000-0000-0000-000000000001', '文章 C：数据库调优实战', 2),
  ('e0000000-0000-0000-0000-100000000004', 'e0000000-0000-0000-0000-000000000001', '文章 D：AI 在 DevOps 中的应用', 3),
  ('e0000000-0000-0000-0000-100000000005', 'e0000000-0000-0000-0000-000000000001', '文章 E：安全攻防入门', 4),
  ('e0000000-0000-0000-0000-100000000006', 'e0000000-0000-0000-0000-000000000001', '文章 F：云原生网络原理', 5),
  ('e0000000-0000-0000-0000-100000000007', 'e0000000-0000-0000-0000-000000000001', '文章 G：Rust 系统编程', 6),
  ('e0000000-0000-0000-0000-100000000008', 'e0000000-0000-0000-0000-000000000001', '文章 H：GraphQL 最佳实践', 7),
  ('e0000000-0000-0000-0000-100000000009', 'e0000000-0000-0000-0000-000000000001', '文章 I：Serverless 架构指南', 8),
  ('e0000000-0000-0000-0000-100000000010', 'e0000000-0000-0000-0000-000000000001', '文章 J：测试驱动开发', 9);
```

### 7.2 测试账号清单

| 账号 ID | 角色 | 姓名 | team_id | 用途 |
|---------|------|------|---------|------|
| `ou_creator001` | 投票发起者 | 张三 | `2ed263bf32ae1655` | 创建/结束投票、查看发起者专属视图 |
| `ou_creator002` | 投票发起者 | 李四 | `2ed263bf32ae1655` | 创建即将到期投票 |
| `ou_creator003` | 投票发起者 | 王五 | `2ed263bf32ae1655` | 创建空投票（10 选项） |
| `ou_voter001` ~ `ou_voter024` | 投票参与者 | Voter 001-024 | `2ed263bf32ae1655` | 模拟团队 24 人参与投票 |
| `ou_voter_c001` ~ `ou_voter_c024` | 投票参与者 | Voter C001-C024 | `2ed263bf32ae1655` | 场景 C 已全员投票 |
| `ou_teamB_creator` | 其他团队发起者 | 赵六 | `other_team_id` | 跨团队隔离测试 |

### 7.3 Redis 预处理命令（测试辅助）

```bash
# 初始化场景 A 的 Redis tally
redis-cli HSET vote:a0000000-0000-0000-0000-000000000001:tally \
  a0000000-0000-0000-0000-100000000001 2 \
  a0000000-0000-0000-0000-100000000002 2 \
  a0000000-0000-0000-0000-100000000003 1

# 初始化场景 B 的 Redis tally
redis-cli HSET vote:b0000000-0000-0000-0000-000000000001:tally \
  b0000000-0000-0000-0000-100000000001 2 \
  b0000000-0000-0000-0000-100000000002 1 \
  b0000000-0000-0000-0000-100000000003 1 \
  b0000000-0000-0000-0000-100000000004 1 \
  b0000000-0000-0000-0000-100000000005 2

# 设置自动结束定时器（场景 D）
redis-cli SET vote:d0000000-0000-0000-0000-000000000001:deadline "$(date -d '+90 seconds' -u +%Y-%m-%dT%H:%M:%S.000Z)" EX 90
```

---

## 八、测试覆盖矩阵

### 8.1 功能模块 × 测试层

| 功能模块 | AC 覆盖 | 单元测试 | 集成测试 | WS 测试 | E2E 测试 | 性能测试 |
|----------|---------|----------|----------|---------|----------|----------|
| **F-001 创建投票** | AC-001-1~10 | UT-VL-01~13 | IT-CV-01~14 | — | E2E-J1~J3 | PERF-API-03 |
| **F-002 参与投票** | AC-002-1~7 | UT-DD-01~04 | IT-SV-01~12 | WS-SYNC-01~03, WS-CONC-01~04 | E2E-J1~J2, E2E-J4 | PERF-API-04 |
| **F-003 实时结果看板** | AC-003-1~9 | — | IT-VD-01~07 | WS-SYNC-01~04, WS-RC-01~04 | E2E-J1~J2, E2E-J4 | PERF-ECH-01~03 |
| **F-004 手动结束** | AC-004-1~4 | UT-SM-02 | IT-CL-01~07 | WS-AE-02 | E2E-J1~J2 | — |
| **F-005 自动结束** | AC-005-1~4 | UT-SM-03~04, UT-SM-08 | — | WS-AE-01~05 | E2E-J1, E2E-J3 | — |
| **F-006 最终结果页** | AC-006-1~3 | — | IT-VD-05~07 | — | E2E-J1~J2 | — |
| **F-007 投票列表** | AC-007-1~4 | — | IT-VL-01~09 | — | E2E-J1（含列表入口验证） | PERF-API-01 |
| **F-008 隐私声明** | AC-008-1~3 | — | IT-VD-01, IT-VD-10 | — | E2E-J1 | — |
| **乐观更新回滚** | AC-003-9 | — | IT-SV-12 | — | E2E-J4 | — |

### 8.2 防刷三层 × 测试层

| 防线 | 实现机制 | 单元测试 | 集成测试 | 验证方法 |
|------|----------|----------|----------|----------|
| **L1: 认证层** | JWT / 飞书 SSO 验签 | — | IT-CV-11（401 拒绝未认证请求） | 无 token → 401，过期 token → 401 |
| **L2: 速率限制** | Redis Sorted Set 滑动窗口 + 降级内存 Map | UT-RL-01~05 | IT-SV-09（429 拒绝第 4 次） | Redis 正常 + 降级双路径验证 |
| **L3: 业务校验** | status 校验 + option 归属校验 | — | IT-SV-07~08（closed → 403 / 无效 option → 400） | 状态校验 + 归属校验 |
| **L4: 数据库防重** | PG UNIQUE(vote_id, user_id) | UT-DD-01~03 | IT-SV-06（重复 → 409） | 验证 23505 → 40901 错误码转换 |

### 8.3 非功能需求覆盖矩阵

| 非功能需求 | 测试方法 | 关键指标 | 关联测试 |
|-----------|----------|----------|----------|
| 页面首次加载 FCP ≤1.5s | Lighthouse / Playwright trace | FCP 时间 | E2E-J1（页面首次进入） |
| API P99 ≤200ms | k6 / Artillery 压测 | P99 响应时间 | PERF-API-01~05 |
| WS 推送延迟 ≤2s | WS 自定义脚本时间戳对比 | 广播延迟 | PERF-WS-02 |
| ECharts 渲染 ≤100ms | `performance.mark` 测量 | 渲染耗时 | PERF-ECH-01~03 |
| 200 WS 并发连接 | 多实例 socket.io-client | 连接成功率 | PERF-WS-01 |
| Redis 降级可用性 | 手动停止 Redis → API 正常响应 | 降级后 P99 < 500ms（PG 替代 Redis） | PERF-DG-01~02 |
| XSS 防护 | 输入 `<script>alert(1)</script>` | React JSX 转义输出 | E2E（创建/查看含 XSS payload 的标题和选项） |
| 敏感数据匿名保护 | API 返回值审查 | 匿名模式下 voters:[] | IT-VD-01, IT-VD-07, IT-VD-10 |
| 跨团队隔离 | team_B token 请求 team_A 数据 | 空结果或 403 | IT-VL-08, IT-VD-13, IT-CL-06 |
| 滚动重启可用性 | `docker-compose up -d --no-deps app` | 服务中断 <5s，WS 自动重连 | WS-RC-04 |
| PG 备份恢复 | 执行备份 → 清空 PG → 恢复 | 数据完整恢复 | 运维验证（非自动化测试） |

### 8.4 覆盖率目标总结

| 覆盖率维度 | 目标 | 达成方式 |
|-----------|------|----------|
| **PRD 验收标准 (AC)** | 33/33 = 100% | 每个 AC 至少 1 条集成测试用例 |
| **API 端点** | 5/5 = 100% | POST create、GET list、GET detail、POST vote、POST close |
| **API 错误码** | 所有定义的错误码全覆盖 | 40001-40005、40100、40301-40302、40400、40901-40902、42900、50000 |
| **WS 事件** | 3/3 = 100% | vote:update、vote:closed、vote:reminder |
| **状态机路径** | 8/8 = 100% | 正常流转 + 并发竞态 + 故障恢复 |
| **防刷三层** | 4/4 层串联 | L1 认证 → L2 限流 → L3 业务校验 → L4 PG UNIQUE |
| **投票模式** | 2/2 | anonymous + public |
| **投票类型** | 2/2 | single + multi |
| **浏览器兼容** | Chrome/Edge/Firefox/Safari | Playwright 多 browser 配置 |

---

## 附录 A：Bug 报告模板

```
## Bug #[编号]
- **发现时间**：2026-06-XX HH:MM
- **严重程度**：P0(阻塞) / P1(严重) / P2(一般) / P3(建议)
- **关联用例**：IT-xxx / WS-xxx / E2E-xxx
- **环境信息**：Docker Compose，浏览器版本，Node 版本
- **复现步骤**：
  1.
  2.
  3.
- **预期结果**：
- **实际结果**：
- **复现概率**：100% / 偶发(N/10)
- **截图/日志**：
```

## 附录 B：测试工具版本

| 工具 | 版本 | 用途 |
|------|------|------|
| Vitest | 1.x | 单元/集成测试 |
| supertest | 6.x | HTTP 断言 |
| Playwright | 1.40+ | E2E 浏览器测试 |
| k6 | 0.48+ | 性能压测 |
| testcontainers (Node) | 10.x | PG/Redis 集成测试容器 |
| socket.io-client | 4.x | WS 测试客户端 |

---

> 📋 **文档版本**：v1.1 | 撰写人：寻错 🔍 | 待 EeiMoo 评审
