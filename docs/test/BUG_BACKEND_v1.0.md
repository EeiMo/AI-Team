# 后端代码缺陷检测报告

> 版本：v1.0 | 审计人：寻错 🔍 | 日期：2026-06-01 | 对照基准：架构 v1.1

---

## 缺陷总览

| ID | 文件 | 严重度 | 简述 |
|----|------|--------|------|
| BUG-001 | rateLimiter.ts:118 | 🔴 P0 | 限流中间件路径匹配失效，速率限制完全不生效 |
| BUG-002 | voteService.ts:106 | 🔴 P0 | 创建投票后未调用 `scheduleReminder`，截止提醒永不触发 |
| BUG-003 | ws/handlers.ts:86 | 🟠 P1 | WS `join:vote` 无团队权限校验，用户可跨团队加入任意投票房间 |
| BUG-004 | ws/handlers.ts:72 | 🟠 P1 | WS 认证中间件生产模式未实际验签，仅截断 token |
| BUG-005 | — (缺失文件) | 🟠 P1 | `tallySync.ts` 服务缺失，Redis → PG 票数对账无实现 |
| BUG-006 | — (缺失文件) | 🟠 P1 | `redisHealth.ts` 服务缺失，降级标志无主动健康监测 |
| BUG-007 | ballotService.ts, voteService.ts | 🟠 P1 | `idempotency_key` 幂等键未实现，网络重试可致重复创建/投票 |
| BUG-008 | voteService.ts:116-141 | 🟡 P2 | PG 事务提交与 Redis tally 初始化间存在竞态，票数可被覆盖清零 |
| BUG-009 | voteService.ts:66-68 | 🟡 P2 | 应用层生成的 vote/option ID 使用 UUID v4 而非架构要求的 UUID v7 |
| BUG-010 | deadlineWorker.ts:95-108 | 🟡 P2 | `closeVoteAutomatically` 仅更新 votes 表状态，未同步最终票数至 PG |
| BUG-011 | ballotService.ts:127-151 | 🟡 P2 | WS 广播 `new_count` 非 HINCRBY 返回值，降级场景下数值不准确 |
| BUG-012 | ballotService.ts:20-21 | 🟡 P2 | 提交投票未校验 `deadline < NOW()`，仅靠 status 拒绝（状态变更存在窗口） |
| BUG-013 | ballotService.ts:130 | 🟢 P3 | 多选广播每选项重复 `fetchSockets()`，可提取至循环外 |
| BUG-014 | deadlineWorker.ts:167 | 🟢 P3 | `psubscribe` 失败仅日志无重试，服务重启后可能丢失订阅 |

---

## 详细缺陷记录

---

### BUG-001 | 🔴 P0 | 限流中间件路径匹配失效

**文件**：`src/middleware/rateLimiter.ts`，第 118 行  
**现象**：
```typescript
// rateLimiter.ts 内部判断：
if (req.method !== 'POST' || !req.path.match(/^\/api\/votes\/[^/]+\/vote$/)) {
  return next();
}
```
限流中间件在 `app.ts` 中挂载为：
```typescript
apiRouter.use('/votes', rateLimiter);    // apiRouter 挂载于 app.use('/api', ...)
```
Express 路由层叠后，进入 `rateLimiter` 时 `req.path` 为 `/votes/:id/vote`（不含 `/api` 前缀），正则 `/^\/api\/votes\/[^/]+\/vote$/` **永远匹配不到**。  
**结果**：所有 `POST /api/votes/:id/vote` 请求的速率限制完全旁路，攻击者可无限制刷票。

**预期**：
- 修正正则匹配 `req.path`，如 `/^\/[^/]+\/vote$/`，或将限流判断改在路由层面执行。
- 或改为：不在中间件内部判断 path，而在 `app.ts` 中精确挂载到 `POST /api/votes/:id/vote` 路由上。

```typescript
// 修复建议：
if (req.method !== 'POST' || !req.path.match(/^\/[^/]+\/vote$/)) {
  return next();
}
```

---

### BUG-002 | 🔴 P0 | 创建投票未调度截止提醒

**文件**：`src/services/voteService.ts`，第 106 行（`createVote` 方法结束处）  
**现象**：
`deadlineWorker.ts` 导出了 `scheduleReminder(redis, voteId, deadline)` 函数，用于在截止前 60 秒创建提醒 Redis key。但 `voteService.createVote()` 中未导入也未调用此函数。

**结果**：所有自动到期的投票，用户在截止前 60 秒不会收到 `vote:{id}:reminder` 事件；前端倒计时组件（红色脉冲/大号闪烁）无法触发。

**预期**：`createVote` 在 Redis 初始化完成后调用 `scheduleReminder(redis, voteId, deadline)`。

```typescript
// 修复建议（在 createVote 中 initRedisTally 之后添加）：
import { scheduleReminder } from './deadlineWorker';
// ...
await this.initRedisTally(voteId, optionIds);
await scheduleReminder(this.redis, voteId, deadline);  // 新增
```

---

### BUG-003 | 🟠 P1 | WS join:vote 无团队级权限校验

**文件**：`src/ws/handlers.ts`，第 86 行  
**现象**：
```typescript
socket.on('join:vote', ({ vote_id }) => {
    if (!vote_id) { /* ... */ return; }
    const room = `vote:${vote_id}`;
    socket.join(room);   // 无任何团队归属校验
});
```
架构文档第 7.2 节明确要求：
> `// 权限校验：用户是否属于本团队（可通过 socket.data.team_id 判断）`

**结果**：任意认证用户只要知道 voteId（UUID 可枚举），即可加入任意团队的投票房间，接收实时票数更新广播（在 `public` 模式下泄露投票人身份）。

**预期**：加入房间前查询 `votes` 表的 `team_id` 并与 `socket.data.team_id` 比对。

```typescript
// 修复建议：
const vote = await knex('votes').select('team_id').where({ id: vote_id }).first();
if (!vote || vote.team_id !== socket.data.team_id) {
    console.warn('[WS] 跨团队 join 尝试', { socketId: socket.id, vote_id });
    return;
}
socket.join(room);
```

---

### BUG-004 | 🟠 P1 | WS 认证中间件生产模式未实际验签

**文件**：`src/ws/handlers.ts`，第 72-82 行  
**现象**：
```typescript
// 生产模式：此处调用飞书验签（简化实现，实际由 auth.ts 提供）
// 为 Socket.IO 场景复用 auth 中间件的验证逻辑
socket.data.user_id = token.substring(0, 64);
socket.data.team_id = 'env_team';
socket.data.display_name = token.substring(0, 32);
next();
```
生产路径仅截断 token 字符串作为 `user_id`，**无任何验签调用**。注释声称"简化实现"但实际等同于无认证。此外 `team_id` 硬编码为 `'env_team'`，所有用户同属一个团队。

**结果**：任何发送任意字符串 token 的 WS 连接均认证通过，且可伪装为任意 user_id。

**预期**：WS 认证中间件应复用 `auth.ts` 中的 `verifyFeishuToken()` 进行真实 token 验签。

```typescript
// 修复建议：
import { verifyFeishuToken } from './auth';  // 需 export
// ...
const user = await verifyFeishuToken(token);
socket.data.user_id = user.user_id;
socket.data.team_id = user.team_id;
socket.data.display_name = user.display_name;
next();
```

---

### BUG-005 | 🟠 P1 | tallySync.ts 服务缺失

**文件**：不存在（架构 3.2 节要求 `src/services/tallySync.ts`）  
**现象**：架构明确要求：
> `TallySync` — Redis→PG 定期同步票数，每 5 秒将 Redis tally 批量写回 PG，兜底对账

当前代码中：
- `ballotService` 的 `HINCRBY` 是"尽力而为"（降级时跳过）
- `voteService.getTally` 有 PG 回退逻辑（`getTallyFromPG`）
- 但 **没有反向同步机制**：当 Redis 降级恢复后，内存中的 tally 与 PG 中的真实数据可能不一致

**结果**：
- Redis 恢复后可能返回过期/错误的 tally 数据
- 多实例部署时（ip_hash 路由），不同实例的 Redis 可能不一致（同一 Redis 实例无此问题，但架构预留了水平扩展）

**预期**：实现 `tallySync.ts`，周期性地从 PG `user_votes` 表聚合票数并写回 Redis tally Hash（全量或增量）。

---

### BUG-006 | 🟠 P1 | redisHealth.ts 服务缺失

**文件**：不存在（架构 3.2 节要求 `src/services/redisHealth.ts`）  
**现象**：架构明确要求：
> `redisHealth` — 每秒 PING Redis，连续 3 次失败触发降级标志；恢复后自动切换回 Redis

当前代码中降级标志 `health:degraded` 的设置方式：
- `voteService.initRedisTally` catch 块（写操作失败）
- `ballotService.incrementTally` catch 块（写操作失败）
- `rateLimiter` catch 块（读操作失败）

这些是**被动触发**的，仅在写/读操作报错时才设置降级标志。没有主动健康监测来**恢复**降级标志。

**结果**：
- 一旦触发降级，`SET health:degraded "1" EX 10` 的 10 秒 TTL 过后，如果没有新的失败，标志自动消失。但没有主动恢复检测。
- 如果 Redis 网络抖动（间歇性失败），会反复降级/恢复，产生大量日志。

**预期**：实现 `redisHealth.ts`，主动 PING 监测 + 连续失败 N 次设降级 + 连续成功 M 次清除降级。

---

### BUG-007 | 🟠 P1 | idempotency_key 幂等键未实现

**文件**：`src/types/index.ts`（`CreateVoteBody`, `SubmitVoteBody`），`src/services/voteService.ts`，`src/services/ballotService.ts`  
**现象**：`CreateVoteBody` 和 `SubmitVoteBody` 均无 `idempotency_key` 字段。POST 创建投票和提交投票均不支持幂等。

**结果**：
- 网络超时后客户端重试创建投票 → 可能创建重复投票
- 网络超时后客户端重试提交投票 → 可能被 PG UNIQUE 约束拒绝（409），但用户体验差（不知道是哪次操作成功的）
- 飞书 WebView 弱网环境下重试概率高，无幂等键会导致不可预期的重复操作

**预期**：
- `CreateVoteBody` 新增 `idempotency_key: string`（可选）
- `SubmitVoteBody` 新增 `idempotency_key: string`（可选）
- 服务端以 `user_id + idempotency_key` 为键缓存操作结果（Redis，TTL 24h），相同幂等键返回已缓存结果

---

### BUG-008 | 🟡 P2 | Redis tally 初始化竞态导致票数清零

**文件**：`src/services/voteService.ts`，第 116-141 行  
**现象**：
```typescript
// Step 1: PG 事务提交（投票已存在，用户可见）
await trx.commit();

// Step 2: Redis 初始化（事务外，非关键路径）
await this.initRedisTally(voteId, optionIds);
```

`initRedisTally` 使用 `HSET` 将所有 option 字段设为 `0`：
```typescript
await this.redis.hset(tallyKey, ...fields); // field1=0, field2=0, ...
```

竞态窗口（Step 1 与 Step 2 之间）：
1. PG 事务提交完成
2. **用户 A 提交投票** → `HINCRBY` 将 option1 设为 1（若 key 不存在，Redis 自动创建）
3. `initRedisTally` 执行 `HSET vote:{id}:tally option1 0 option2 0 ...`
4. option1 被**覆盖为 0**，已投的一票丢失！

**结果**：极端竞态下票数丢失，Redis tally 与 PG 不一致。后续 TallySync（若实现）可能从 PG 修正，但在对账周期内展示错误票数。

**预期**：
- 使用 `HSETNX`（仅当字段不存在时设置）或
- 先检查 Hash 是否存在（`EXISTS`），存在则跳过初始化；或
- 在 PG 事务**之前**初始化 Redis tally（此时投票不可见，无人能投票）

```typescript
// 修复建议（事务前初始化）：
// 1. 先生成 ID
// 2. 先 initRedisTally(voteId, optionIds)
// 3. 再执行 PG 事务（如果 PG 失败，Redis 中有冗余的 0 值 Hash，无危害）
```

---

### BUG-009 | 🟡 P2 | UUID v4 替代 v7，失去时间有序性

**文件**：`src/services/voteService.ts`，第 66-68 行  
**现象**：
```typescript
function uuidV7(): string {
  // 使用 uuid v4 作为替代（PG 端 uuid_v7() 生成真实 v7）
  return uuidv4();
}
```
应用层生成 `voteId` 和 `optionIds` 时调用 `uuidV7()`，实际返回的是 UUID v4（随机，非时间有序）。架构 DDL 中的 `DEFAULT uuid_v7()` 仅在 INSERT 未提供显式 ID 时生效，但代码显式提供了 ID。

**结果**：
- UUID v4 随机分布导致 B-tree 索引页分裂加剧（对比 v7 时间有序插入）
- `created_at` 可弥补排序需求，但索引效率降低（尤其 options 表大量写入时）

**预期**：
- 改用真实的 UUID v7 实现（`uuid` npm 包 `uuidv7()` 或自行实现），或
- INSERT 时不传 `id`，依赖 PG 的 `DEFAULT uuid_v7()` 生成

```typescript
// 修复建议：不在应用层生成 ID，让 PG 默认值生效
await trx('votes').insert({
    // id 不传，由 PG uuid_v7() 生成
    title: body.title.trim(),
    ...
}).returning('id');  // 获取 PG 生成的 id
```

---

### BUG-010 | 🟡 P2 | 自动结束未同步最终票数至 PG

**文件**：`src/services/deadlineWorker.ts`，第 95-108 行  
**现象**：
```typescript
async function closeVoteAutomatically(voteId, io) {
  const updatedRows = await knex('votes')
    .where({ id: voteId, status: 'active' })
    .update({ status: 'closed', closed_at: knex.fn.now(), closed_by: 'auto' });
  // ...仅广播关闭事件，未同步 tally
}
```
自动结束时只更新了 votes 表的状态，**未将 Redis tally 中的最终票数写回 PG**（如写入 `options` 表或独立汇总表）。当前 PG 中没有持久化的票数汇总，`getTallyFromPG` 通过 JOIN `user_votes` 实时计算。

**结果**：虽然当前设计依赖 `user_votes` JOIN 实时计算票数，但如果在 Redis 存续期间发生了降级/数据丢失，`user_votes` 始终是真实数据源。本缺陷影响有限，因为 PG 中始终可通过 JOIN 计算。**但如果后续引入票数汇总表**，则需要在此处同步。

**评级下调说明**：当前架构设计中 PG 无票数汇总表（票数由 `user_votes` 实时 JOIN 计算），因此本缺陷当前不造成数据丢失。但架构 3.2 中 `TallySync` 模块要求"定期同步"，说明设计预期有同步机制。如果 TallySync 实现后仍不在此处同步，则升级为 P1。

**预期**：在 `closeVoteAutomatically` 中调用 tally sync 逻辑，确保关闭时 Redis 票数与 PG 一致（或直接依赖 PG 作为真实数据源）。

---

### BUG-011 | 🟡 P2 | WS 广播 count 非 HINCRBY 返回值

**文件**：`src/services/ballotService.ts`，第 127-151 行  
**现象**：
架构文档 6.3.1 节要求广播使用 HINCRBY 返回值：
```
new_count: newCount,    -- HINCRBY 返回值
```
但实际代码在 `incrementTally` (HINCRBY) 之后，丢弃返回值，重新用 `HGET` 获取：
```typescript
// incrementTally 调用 HINCRBY 但丢弃返回值
await this.incrementTally(voteId, selectedOptions);
// ...
// 重新 HGET 获取（可能不是 HINCRBY 后的值）
const rawCount = await this.redis.hget(tallyKey, oid).catch(() => '0');
```

**风险场景**：
- Redis 降级时 `incrementTally` 跳过 → `HGET` 返回旧值（未包含本次投票）
- 并发投票时，两个用户同时对同一选项投票，HGET 可能读到中间态

**预期**：`incrementTally` 应返回 HINCRBY 的返回值数组，直接用于 WS 广播。

```typescript
// 修复建议：
const newCounts = await this.incrementTally(voteId, selectedOptions);
// 使用 newCounts[oid] 而非再次 HGET
```

---

### BUG-012 | 🟡 P2 | 提交投票仅靠 status 拒绝，无 deadline 时间校验

**文件**：`src/services/ballotService.ts`，第 20-21 行（前置校验未包含 deadline）  
**现象**：
```typescript
if (vote.status === 'closed') {
    throw new AppError(40301, '投票已结束，无法提交');
}
```
仅检查 `status === 'closed'`，不检查 `deadline < NOW()`。DeadlineWorker 负责将过期投票状态从 active 改为 closed，但这个更新是**异步的**。从 deadline 时间到达到 DeadineWorker 执行之间，用户仍然可以投票。

**结果**：
- 用户可在投票截止时间后继续投票（直到 DeadineWorker 更新状态）
- 时间窗口取决于 Redis keyspace notification 延迟 + 兜底扫描间隔（兜底扫描仅在启动时执行一次）

**预期**：在 `FOR UPDATE` 查询中增加 `deadline` 字段并校验：
```typescript
const vote = await trx('votes')
    .select('id', 'status', 'vote_type', 'deadline')
    .where({ id: voteId })
    .forUpdate()
    .first();
if (!vote) throw new AppError(40400, '投票不存在');
if (vote.status === 'closed' || new Date(vote.deadline) < new Date()) {
    throw new AppError(40301, '投票已结束，无法提交');
}
```

---

### BUG-013 | 🟢 P3 | 多选广播重复 fetchSockets

**文件**：`src/services/ballotService.ts`，第 130 行  
**现象**：
```typescript
for (const oid of selectedOptions) {
    // ...
    const sockets = await this.io.in(room).fetchSockets();  // 每次循环都 fetch
    for (const s of sockets) { /* emit */ }
}
```
多选投票时，每个 option 都会调用 `fetchSockets()` 获取房间内所有 socket，多次重复获取。

**预期**：将 `fetchSockets()` 提取到循环外，对每个已连接的 socket 发送所有 option 的更新。

```typescript
const sockets = await this.io.in(room).fetchSockets();  // 移到循环外
for (const oid of selectedOptions) {
    const newCount = newCounts[oid];  // 配合 BUG-011 修复
    for (const s of sockets) {
        if (s.data.user_id === userId) continue;
        s.emit(`vote:${voteId}:update`, { option_id: oid, new_count: newCount, total_votes: totalVotes });
    }
}
```

---

### BUG-014 | 🟢 P3 | psubscribe 失败无重试机制

**文件**：`src/services/deadlineWorker.ts`，第 167 行  
**现象**：
```typescript
subRedis.psubscribe('__keyevent@0__:expired', (err) => {
    if (err) {
        console.error('[DeadlineWorker] 订阅过期通道失败:', err);
        return;  // 仅日志，无重试
    }
});
```
如果 Redis 连接建立后立即尝试订阅但 Redis `notify-keyspace-events` 未配置或 Redis 暂时不可用，订阅失败后不会重试。

**结果**：自动结束功能完全失效（仅依赖启动兜底扫描），已创建的投票到期后不会被自动结束。

**预期**：添加重试逻辑（指数退避，最多 3 次）；或检查 Redis `CONFIG GET notify-keyspace-events` 并主动 warn。

---

## 架构合规性检查清单

| 检查项 | 架构要求 | 实现状态 |
|--------|----------|----------|
| API 入参/出参与架构第4章一致 | ✅ 接口定义匹配 | ⚠️ 缺 `idempotency_key` |
| 状态机：仅 ACTIVE 态可投票 | ✅ `FOR UPDATE` + status 校验 | ⚠️ 缺 deadline 校验 |
| 原子操作：HINCRBY + PG UNIQUE 防重 | ✅ 双重防线实现 | ⚠️ HINCRBY 返回值未利用 |
| 幂等键：`idempotency_key` | ❌ 未实现 | ❌ 完全缺失 |
| 错误码与架构表一致 | ✅ 错误码完整 | ✅ — |
| Redis 降级开关 | ⚠️ 被动触发 | ❌ 缺 `redisHealth.ts` |
| deadline 到期逻辑 | ⚠️ 部分实现 | ❌ 缺 `scheduleReminder` 调用 |
| TallySync 定期对账 | ❌ 未实现 | ❌ 文件缺失 |
| WS 广播排除发送者 | ✅ 实现 | ⚠️ `fetchSockets` 效率低 |
| WS join 团队校验 | ❌ 未实现 | ❌ 无权限检查 |
| 创建时快照 `creator_name` | ✅ 实现 | ✅ — |

---

## 修复优先级建议

1. **立即修复（阻塞提测）**：BUG-001 (P0), BUG-002 (P0)
2. **高危（测试前修复）**：BUG-003, BUG-004, BUG-007
3. **重要（第一轮回归前）**：BUG-005, BUG-006, BUG-008, BUG-011, BUG-012
4. **可延后（v1.1 优化）**：BUG-009, BUG-010, BUG-013, BUG-014
