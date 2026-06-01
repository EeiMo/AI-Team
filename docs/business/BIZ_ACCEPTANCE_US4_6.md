# 业务验收 — 用户故事 4-6

> **验收人**：云起 📋  
> **验收日期**：2026-06-01  
> **验收范围**：投票结束（手动+自动）、历史（最终结果+列表）、防刷安全 三个功能域  
> **对照基线**：PRD v1.1 §6 章 AC-004~AC-007（含 §7.2 安全措施）
>
> **代码覆盖**：
> - 后端 `deadlineWorker.ts` / `ballotService.ts` / `rateLimiter.ts`
> - 前端 `VoteList.tsx` / `VoteCard.tsx`
> - 投票详情页组件（`/votes/:id`）、创建页组件（`/votes/new`）**不在本次提供的文件中**，无法直接验证 UI 交互

---

## 结论总览

| 功能域 | AC 条数 | ✅ 通过 | ⚠️ 存疑 | 整体判断 |
|--------|---------|---------|---------|----------|
| F-004 投票结束（手动） | 4 | 0 | 4 | 后端关闭通道已验证，前端「结束投票」UI 不在代码范围内 |
| F-005 投票结束（自动） | 4 | 4 | 0 | ✅ 全部通过 — deadlineWorker + ballotService 实现完整 |
| F-006 最终结果页 | 3 | 0 | 3 | VoteCard 标签正确，详情页柱状图/投票人明细不在代码范围内 |
| F-007 投票列表入口 | 4 | 4 | 0 | ✅ 全部通过 — VoteList + VoteCard 覆盖完整 |
| 防刷安全（§7.2） | — | ✅ | — | rateLimiter + ballotService 事务锁 + 幂等 key 均已实现 |
| **合计** | **15** | **8** | **7** | **有条件通过** — 7 项 ⚠️ 均因依赖未提供的详情/创建页代码 |

> **Go / No-Go 判断**：**Go（有条件）** — 已提供代码的核心功能域（自动结束、列表、防刷）全部满足 PRD 要求。7 项存疑依赖投票详情页（`VoteDetail.tsx`）和创建页（`VoteCreate.tsx`）前端实现，建议在 Go/No-Go 评审前补充这两个组件的验收检查。

---

## 逐条验收

### F-004 · 投票结束（手动）

| 编号 | 业务预期 | 代码验证 | 结论 |
|------|----------|----------|:----:|
| AC-004-1 | 发起者点击「结束投票」→ 二次确认 → 投票变为「已结束」，通道关闭，所有在线用户推送更新 | **后端通道关闭已验证**：`ballotService.ts` L76 `vote.status === 'closed' \|\| new Date(vote.deadline) < new Date()` 双重拦截，已结束投票无法提交。**前端未覆盖**：「结束投票」按钮、确认弹窗、发起者权限校验应由 `VoteDetail.tsx` 实现，不在本次提供的 `VoteList.tsx` / `VoteCard.tsx` 中 | ⚠️ 存疑 |
| AC-004-2 | 非发起者不可见「结束投票」按钮 | 依赖投票详情页组件，不在提供范围内 | ⚠️ 存疑 |
| AC-004-3 | 点击「取消」关闭弹窗，投票保持进行中 | 依赖投票详情页组件，不在提供范围内 | ⚠️ 存疑 |
| AC-004-4 | 网络中断时结束失败，toast「网络异常，请稍后重试」，投票保持进行中 | 前端网络超时 + toast 逻辑在详情页中，不在提供范围内 | ⚠️ 存疑 |

> **综合判断**：后端投票通道关闭逻辑已由 `ballotService.ts` 覆盖（关闭后提交被 `40301` 拒绝）；前端交互实现需补充验证。

---

### F-005 · 投票结束（自动倒计时）

| 编号 | 业务预期 | 代码验证 | 结论 |
|------|----------|----------|:----:|
| AC-005-1 | 倒计时归零自动结束，WS 推送 `vote:{id}:closed` | `deadlineWorker.ts` L59-77：`closeVoteAutomatically()` 通过条件 UPDATE `WHERE status='active'`（幂等）更新 PG，随后 `io.to(room).emit(vote:{id}:closed)` 广播。附带从 PG 聚合最终票数（BUG-010 修复）。完美满足。 | ✅ 通过 |
| AC-005-2 | 倒计时精确到秒，00:00 触发结束 | `deadlineWorker.ts` 使用 Redis `SET key EX ttlSeconds`（秒级 TTL）+ Keyspace Notification `__keyevent@0__:expired` 订阅。PRD §10 技术约束已知 Redis 惰性清理可能导致 ≤60s 延迟，但代码已实现**启动兜底扫描** (`startupRecoveryScan` L95-106：扫描 `deadline < NOW() AND status='active'`)，确保服务重启后所有到期投票被补结束。方案符合 PRD 批准的架构设计。 | ✅ 通过 |
| AC-005-3 | 倒计时归零时用户已勾选未提交 → 选择失效，视为未投票 | `ballotService.ts` L76：提交时校验 `new Date(vote.deadline) < new Date()` → 拒绝并抛 `40301「投票已结束，无法提交」`。截止后所有未提交的选择均失效。 | ✅ 通过 |
| AC-005-4 | 服务端时钟与客户端有偏差时以服务端时间为准 | `ballotService.ts` L76：`new Date(vote.deadline)` 使用服务端 PG 存储的截止时间，与 `new Date()`（服务端当前时间）比较，完全基于服务端时钟。`deadlineWorker.ts` TTL 由 Redis 服务端维护。不以客户端时间为准。 | ✅ 通过 |

> **综合判断**：自动结束链路完整 — Redis 定时器 + 启动兜底扫描 + 提交截止校验 + WS 广播，覆盖正常/边界/异常全路径。

---

### F-006 · 最终结果页

| 编号 | 业务预期 | 代码验证 | 结论 |
|------|----------|----------|:----:|
| AC-006-1 | 已结束投票展示「已结束」标签 + 最终票数/百分比统计 | **卡片层面已验证**：`VoteCard.tsx` L19-23 `isActive` 判断，非 active 时显示「已结束」标签，进度条展示 `已投 vote_count/total_voters`。**详情页最终柱状图未覆盖**：ECharts 渲染逻辑在投票详情组件中。后端 `deadlineWorker.ts` 在自动结束时调用 `aggregateTallyFromPG()` 同步最终票数。 | ⚠️ 存疑 |
| AC-006-2 | 实名模式已结束显示各选项投票人明细（头像+姓名，不可折叠） | 依赖投票详情页组件，不在提供范围内 | ⚠️ 存疑 |
| AC-006-3 | 匿名模式已结束不显示投票人身份 | 依赖投票详情页组件；PRD §7.2 要求 API 层匿名投票下投票人列表字段置空/null — 后端 API 过滤逻辑不在提供文件中 | ⚠️ 存疑 |

> **综合判断**：卡片层 status 驱动 UI 切换正确；详情页最终结果展示（柱状图 + 投票人明细/匿名过滤）依赖未提供的 `VoteDetail.tsx` 组件。

---

### F-007 · 投票列表入口

| 编号 | 业务预期 | 代码验证 | 结论 |
|------|----------|----------|:----:|
| AC-007-1 | 列表展示进行中投票卡片：标题、类型标签、剩余时间、已投进度 | `VoteList.tsx`：通过 `useVotes(status)` 按 active/closed 过滤拉取列表。`VoteCard.tsx`：完整渲染 — 标题（`vote.title`）、标签行（`typeLabel` + `modeLabel` + 剩余 `mm:ss`）、进度条（`已投 voteCount/total_voters 人` + 百分比进度条）。全部满足 PRD §5.1 线框要求。 | ✅ 通过 |
| AC-007-2 | 无进行中投票时显示空状态 | `VoteList.tsx` L55-64：`status === 'active' ? '暂无进行中的投票' : '暂无已结束的投票'` + 空状态插画 📋 + 「创建第一个投票」CTA 按钮。PRD §5.1 空状态完全覆盖。 | ✅ 通过 |
| AC-007-3 | 切换「已结束」Tab 展示已结束投票卡片 | `VoteList.tsx` L35-43：Tab 列表包含 `{ key: 'closed', label: '已结束' }`，点击切换 `setStatus` 触发 `useVotes` 重拉数据。`VoteCard.tsx`：非 active 时 `getRemaining()` 返回「已结束」、状态指示点变灰色（`dotClosed`）。 | ✅ 通过 |
| AC-007-4 | 点击卡片跳转至 `/votes/:id` | `VoteCard.tsx` L38-42：`onClick → navigate(/votes/${vote.id})` + `role="button"` + `tabIndex={0}` + `onKeyDown` 键盘 Enter 支持。可访问性完备。 | ✅ 通过 |

> **综合判断**：F-007 全部 4 条 AC **无一存疑**。VoteList + VoteCard 的组合实现完整覆盖了 PRD §5.1 的所有交互状态（正常列表 / 空状态 / 骨架屏 / Tab 切换 / 卡片跳转 / 分页加载），代码质量高。

---

### 防刷安全（PRD §7.2）

| 验收项 | PRD 要求 | 代码验证 | 结论 |
|--------|----------|----------|:----:|
| 速率限制：每人每投票每分钟 ≤3 次 | `rateLimiter.ts`：Redis Sorted Set + Lua 原子脚本，key=`rate:{userId}:{voteId}`（不同投票独立计数），窗口内 `ZCARD` → 超限返回 429 + `Retry-After` 头。PRD 精确要求完全满足。 | ✅ 通过 |
| 速率限制降级 | `rateLimiter.ts` L79-122：Redis 不可用时自动激活降级内存 Map（`health:degraded=1`），每 5 分钟清理过期 entry。ballotService.ts 的 `incrementTally()` 同样检查 `health:degraded` 降级标志。降级路径完整。 | ✅ 通过 |
| Lua 脚本正确性（先清理后计数） | `rateLimiter.ts` RATE_LIMIT_LUA L5-6：`ZREMRANGEBYSCORE` 清理窗口外记录 → `ZCARD` 计数 → `ZADD` 记录。注释注明「C-1 修正：先清理后计数，消除 +1 误差」，逻辑正确。 | ✅ 通过 |
| 防重投票（UNIQUE 约束） | `ballotService.ts` L103-106：PG `user_votes` 插入，catch `err.code === '23505'` → 返回 `40901「您已投过票」`。后端唯一约束 + 业务错误码双层保障。 | ✅ 通过 |
| 幂等 key（防网络重试重复） | `ballotService.ts` L43-46 & L138-153：提交前检查 `idempotency_key` → 命中缓存直接返回；提交后缓存结果 24h TTL。BUG-007 修复标注清晰。 | ✅ 通过 |
| 事务 + 行锁防并发 | `ballotService.ts` L61-63：`FOR UPDATE` 锁定 vote 行，事务内完成状态校验 + option_ids 归属校验 + INSERT。并发安全。 | ✅ 通过 |
| 输入校验（前后端双重） | `ballotService.ts` L50-56：校验 `option_ids` 非空 + 去重 + 归属 + 单选长度=1。后端校验完备。前端表单校验不在提供文件中但 PRD 已有详细 rules。 | ✅ 通过 |
| XSS 防护 | 不在提供代码范围内（输出编码应在模板/序列化层实现） | ⚠️ 存疑 |
| 匿名投票敏感数据过滤 | PRD 要求「API 返回给前端的投票人列表字段必须置空/null」— 后端 API 响应构造逻辑不在提供文件中 | ⚠️ 存疑 |
| 数据保留 ≥90 天 | DB 层配置/定时任务，不在本次代码范围内 | ⚠️ 存疑 |

> **综合判断**：核心防刷链路（限流 + 降级 + 防重 + 幂等 + 事务锁）全部实现，代码质量高，降级路径完整。XSS 防护、匿名敏感数据过滤、数据保留策略三项因不在提供文件中标记存疑，建议在 Go/No-Go 评审中由栖梧/寻错补充验证。

---

## 补充观察

### deadlineWorker.ts 亮点
- **启动兜底扫描**（L95-106）：`WHERE status='active' AND deadline < NOW()` — 解决进程崩溃后定时器丢失的 PRD R-05 风险
- **幂等关闭**（L51-53）：`WHERE status='active'` 条件 UPDATE，防止 Redis 重复事件触发多次关闭
- **BUG-010 修复**：自动结束时调用 `aggregateTallyFromPG()` 同步最终票数
- **BUG-014 修复**：psubscribe 失败带指数退避重试（最多 3 次）
- **截止前提醒**：`scheduleReminder()` 创建独立 Redis key（截止前 60s 触发），与关闭 key 分离，设计合理

### ballotService.ts 亮点
- **BUG-007 修复**：幂等 key 机制（24h 缓存），防止网络重试导致重复提交
- **BUG-011 修复**：`HINCRBY` 返回值直读，不二次 HGET，消除读-写间隙
- **BUG-012 修复**：同时检查 `status='closed'` 和 `deadline < NOW()`，双重截止校验
- **BUG-013 修复**：`fetchSockets()` 提到循环外，避免 N+1 查询
- **降级链路**：Redis 异常时写 `health:degraded=1`（10s TTL），`incrementTally()` 和 `rateLimiter.ts` 均检查此标志，降级路径完整统一

### VoteList.tsx / VoteCard.tsx 亮点
- 骨架屏（3 张卡片）、空状态（插画 + CTA）、错误态、分页加载全部覆盖
- VoteCard 键盘可访问性（`role="button"` + `tabIndex={0}` + `onKeyDown` Enter）
- 进度条百分比边界处理：`Math.min(100, ...)` 防止超 100%
- 倒计时客户端渲染：`Math.max(0, ...)` 防止负数显示

---

## 后续行动建议

| 优先级 | 行动项 | 负责 |
|--------|--------|------|
| **P0** | 补充验收投票详情页 `VoteDetail.tsx`（含手动结束按钮、二次确认弹窗、最终柱状图、匿名/实名模式切换、乐观更新回滚） | 云起 |
| **P0** | 补充验收创建页 `VoteCreate.tsx`（含表单校验、隐私声明展示） | 云起 |
| **P1** | 确认后端 API 响应层匿名模式下投票人列表字段是否置空/null | 云起 → 栖梧 |
| **P1** | 确认输出编码层 XSS 防护（HTML 实体转义）是否已实现 | 云起 → 栖梧 |
| **P2** | 确认数据保留策略（≥90 天）的 DB 配置/定时任务 | 云起 → 长夜 |

---

*本报告基于 2026-06-01 代码快照，验收结论随补充验证更新。*
