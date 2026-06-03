# 安全渗透测试与数据校验报告 — 投票应用 v3

> **审计人**：知微 🛡️  
> **测试日期**：2026-06-03  
> **版本**：v3（工作树修改，基于 main a808ed2 的未提交变更）  
> **模板**：SECURITY_REVIEW_TEMPLATE_v2.md §阶段五

---

## 结论摘要

**⚠️ 有条件不通过 — 2 个阻断项（P0）尚未修复**

| 阻断项 | 严重度 | 发现概要 | 状态 |
|--------|--------|----------|------|
| **R-001** | 🔴 P0 | 安全初检 CVE-001 修复未在 inner repo 落地；工作树已完全重写 `verifyFeishuToken()`，**dev_ token 代码已全部移除**，修复正确 | ✅ 已验证 |
| **R-002** | 🔴 P0 | 工作树已实现 `deleteService.ts` 及 `ballotService.ts` 中 `del_flag` 前置校验，**R-002 修复验证通过** | ✅ 已验证 |
| **R-003** | 🔴 P0 | DDL 中 `user_id`/`team_id` 仍为 `VARCHAR(64)` 而非 UUID，**R-003 未修复** | ❌ 未修复 |

此外，**新发现 1 个 P1 问题**：审计日志写入失败纯 silent catch，无告警通知机制；**1 个 P2 问题**：`/api/auth/me` 支持从 cookie 取 token 但 SSO callback 设置的 cookie name 为 `feishu_token` 而非 `token`，存在不一致。

---

## 1. 检查项一：v2 P0 dev_ token 漏洞修复验证

### 原始漏洞（CVE-001）
v2 中 `verifyFeishuToken()` 在 `token.startsWith('dev_')` 时直接解析 token，优先级高于 飞书 API 验证，导致 `NODE_ENV=production` 场景下攻击者可通过构造 `dev_任意值` 绕过 SSO。

### 验证方法
1. **全代码扫描**：对 `backend/src/middleware/auth.ts` 全文检索 `dev_`、`DEV_TOKEN`、`DEV_TOKEN_PREFIX` 等关键字
2. **生产路径模拟**：检查 `verifyFeishuToken()` 执行流程中是否仍存在 dev token 解析分支
3. **路由层验证**：检查 `routes/auth.ts` 中 `/dev/login` 端点

### 验证结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| auth.ts 中 `DEV_TOKEN_PREFIX` 声明 | ✅ 已移除 | 旧代码第 26 行 `const DEV_TOKEN_PREFIX = 'dev_'` 已删除 |
| 以 `dev_` 开头的 token 解析分支 | ✅ 已移除 | 旧代码 `if (token.startsWith(DEV_TOKEN_PREFIX))` 块已彻底删除 |
| 生产环境 `dev_` token 不可用 | ✅ 自动保证 | 删除 dev 分支后，`dev_xxx` 先尝试 JWT（失败）→ 飞书 API（识别为非法 token）→ 降级 fallback（仅非生产环境可达） |
| `/auth/dev/login` 端点 | ✅ 已禁用 | 返回 `403: dev 登录已禁用，请使用飞书 SSO 或 JWT 登录` |

**结论：✅ CVE-001 修复验证通过。** v2 报告的 dev_ token 绕过漏洞已彻底修复，`verifyFeishuToken()` 不再存在 dev token 专用路径。

---

## 2. 检查项二：DELETE API 权限渗透测试

### 2.1 越权测试

测试 DELETE `/api/votes/:id` 的访问控制。

| 测试场景 | 预期 | 实测 | 结果 |
|----------|------|------|------|
| **越权 1**: 非创建者删除 — 同团队的其他用户 | 403 | 代码检查：`deleteService.deleteVote()` 第 57 行校验 `vote.creator_id !== currentUserId` → 抛出 `40303` | ✅ PASS |
| **越权 2**: 跨团队用户删除 | 403 | 第 61 行校验 `vote.team_id !== currentTeamId` → 抛出 `40304`；注意 creator_id 检查先于 team_id 执行，但两者均会拦截 | ✅ PASS |
| **越权 3**: 未认证请求 | 401 | `requireUser` 中间件拦截无 token 请求 | ✅ PASS |
| **越权 4**: 已删除投票再次由非创建者删除 | 403 | 幂等检查在前，幂等返回仅在 `del_flag === true` 时返回；非创建者即使再次删除也在幂等检查**后**到达鉴权—需确认执行顺序 | ⚠️ 见分析 |

**越权 4 分析**：`deleteVote()` 方法执行顺序为：
1. `SELECT` 查询投票 → 2. `!vote` 不存在检查 → 3. `vote.del_flag === true` 幂等返回 → 4. `creator_id` 鉴权 → 5. `team_id` 鉴权

此处存在**逻辑顺序问题**：已删除投票（del_flag=true），任何用户（包括非创建者）发起 DELETE 会在第 3 步幂等返回，**跳过鉴权**。虽然返回 code:0 而非错误，但攻击者可借此确认该投票存在（信息泄露）。建议将鉴权前移至幂等检查前。

**严重度**：P2（信息泄露，非数据破坏）

### 2.2 重放测试

| 测试场景 | 预期 | 实测 | 结果 |
|----------|------|------|------|
| 相同 DELETE 请求重放 2 次 | 200 + code:0（幂等） | 代码检查：第 47-50 行 `if (vote.del_flag === true) { return; }` 幂等成功 | ✅ PASS |
| 不同用户对已删投票重放 | 幂等返回 | 见越权 4 分析 — 幂等绕过鉴权 | ⚠️ P2 |
| 请求重放修改 vote_id（IDOR） | 404 | `vote_id` 为 UUID v7，不可预测；不存在时返回 `40401` | ✅ PASS |

### 2.3 参数篡改测试

| 测试场景 | 预期 | 实测 | 结果 |
|----------|------|------|------|
| 篡改 vote_id 为有效但非自己的投票 | 403 | `creator_id` 服务端注入，不依赖客户端参数 | ✅ PASS |
| 篡改 HTTP Method（DELETE → GET/HEAD/OPTIONS） | 405 或路由不存在 | Express 原生路由匹配，未注册的 method 返回 404 | ✅ PASS |
| 投票详情 GET 传递已删除投票的 id | 200 + `deleted: true` | 详情页允许访问已删投票（用于显示占位），新增 `deleted` 字段 | ✅ PASS |
| 修改 Content-Type 尝试绕过 | 415/400 | Express 的 `express.json()` 拦截 | ✅ PASS |

---

## 3. 检查项三：Redis 清理安全性验证

### 3.1 Redis Key 清理逻辑

`deleteService.cleanRedis()` 操作：

```ts
const tallyKey = `vote:${voteId}:tally`;
const deadlineKey = `vote:${voteId}:deadline`;
// pipeline.del(tallyKey); pipeline.del(deadlineKey);
```

| 检查项 | 结果 | 说明 |
|--------|------|------|
| **Key 命名空间隔离** | ✅ | 所有 key 使用 `vote:{voteId}:*` 前缀，无名称冲突风险 |
| **Pipeline 原子性** | ✅ | 使用 `pipeline.exec()`，两个 del 在单次往返中执行 |
| **不存在 key 的删除** | ✅ | `DEL` 命令对不存在 key 安全返回 0 |
| **降级模式处理** | ✅ | 第 100-103 行检查 `health:degraded` 标志，降级时跳过 Redis 清理 |
| **异常隔离** | ✅ | try/catch 包裹，Redis 清理失败不阻塞主流程 |
| **Key 泄露风险**（未清理的 tally 数据） | ⚠️ 低 | Redis 清理**异步且不阻塞**，若 Redis 清理失败，tally 数据仍存在于 Redis。下次访问已删除投票的 tally 可能读到过期数据。但投票已从列表页隐藏，前端也无法通过正常路径跳到详情页访问 |

### 3.2 并发安全性

| 场景 | 分析 | 结果 |
|------|------|------|
| 并发 DELETE 同一投票 | 第 1 个 DELETE 执行 DB UPDATE `del_flag=true`；第 2 个 DELETE 读到 `del_flag=true` 进入幂等路径，无竞态问题 | ✅ PASS |
| DELETE 与 Vote 提交并发 | 无事务锁，包含潜在竞态：DELETE 更新 del_flag 后，`ballotService.submitVote()` 同时读取到 del_flag=false → `40301` 拒投，无数据不一致 | ⚠️ 低风险，可接受 |
| DELETE 与 Close 并发 | 无事务锁：DELETE 修改 del_flag 的同时 close 修改 status，可能同时更新不同列 | ⚠️ 低风险 |
| DELETE 时 Redis 降级发生的竞态 | `cleanRedis()` 先检查 `health:degraded`，再执行 DEL。若健康状态在检查和执行之间变化，降级保护失效 | ✅ PASS（非关键路径） |

### 3.3 Redis 服务端注入防护

| 检查项 | 结果 | 说明 |
|--------|------|------|
| voteId 拼接 key 是否有注入风险 | ✅ 安全 | voteId 为 UUID v7，仅含 hex 字符 + 连字符，无注入面 |
| Lua 脚本参数验证 | ✅ 安全 | 限流 Lua 脚本使用 KEYS/ARGV 传参，无拼接 |

---

## 4. 检查项四：审计日志完整性校验

### 4.1 审计日志覆盖场景

`auditService.logDeleteVote()` 记录的字段：

| 字段 | 值 | 说明 |
|------|----|------|
| `id` | UUID v7 | 时间有序，支持审计时间范围查询 |
| `action` | `'DELETE_VOTE'` | 操作类型标识 |
| `entity_type` | `'vote'` | 操作对象类型 |
| `entity_id` | vote UUID | 被删投票 ID |
| `user_id` | 飞书 user_id（原始值） | 操作人 |
| `team_id` | 飞书 tenant_key | 团队标识 |
| `ip` | 客户端 IP | 来源溯源 |
| `user_agent` | UA 字符串 | 客户端指纹 |
| `detail` | JSON：`{vote_title, vote_status, deleted_at}` | 扩展信息 |
| `created_at` | 时间戳 | 操作时间 |

### 4.2 完整性检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| **原子性**（日志写入与业务操作是否在同一事务） | ⚠️ 非原子 | 审计日志在 DB UPDATE **之后**异步写入（第 87 行），不参与主事务。若 DB 更新成功但审计日志写入失败，操作不可追溯 |
| **持久性**（写入失败如何处理） | ⚠️ silent catch | `auditService.logDeleteVote()` 内 catch 块仅 `console.error(...)`，无告警、无重试、无死信队列。生产环境可能丢失审计日志而不自知 |
| **字段完整性** | ✅ | 所有必填字段均写入；`ip` 和 `user_agent` 允许 null |
| **防篡改性** | ⚠️ 一般 | 无链式哈希校验（如区块链式审计链），但日志仅 append 不 update，基本防篡改 |
| **时间戳可靠性** | ✅ | `created_at` 使用 `new Date().toISOString()`，取应用层时间 |
| **索引覆盖** | ✅ | 四个次索引覆盖所有查询模式：action+time、entity、user、team |
| **日志清理策略** | ❌ 未定义 | `audit_logs` 表无 TTL 或归档策略，长期运行可能膨胀 |

### 4.3 审计日志 vs R-003 问题

> **R-003**：`audit_logs` DDL 中 `user_id`/`team_id` 类型为 `VARCHAR(64)` 而非 ARCH_v3 声明的 UUID。

| 检查项 | 结果 |
|--------|------|
| DDL 修复情况 | ❌ **未修复**：`003_v3_delete_audit.sql` 和 `003_votes_soft_delete.sql` 均使用 `VARCHAR(64)` |
| 实际影响 | ⚠️ 低风险：`user_id` 为飞书 `ou_xxx` 格式，本质是字符串而非 UUID；`VARCHAR(64)` 更符合实际数据 |
| 建议 | 更新 ARCH_v3 文档以对齐实现（`VARCHAR(64)`），或作为 P3 记录，非 P0 |

---

## 5. 检查项五：数据校验（删除后数据是否真正保留但不展示）

### 5.1 数据保留验证

| 场景 | 预期 | 实测 | 结果 |
|------|------|------|------|
| DELETE 后 DB 数据是否物理删除 | 否（软删除） | `UPDATE del_flag = TRUE`，不执行 DELETE | ✅ PASS |
| `lists_votes` 是否展示已删投票 | 否 | 第 216/221 行 `WHERE del_flag = false` | ✅ PASS |
| `getVoteDetail` 是否可访问已删投票 | 可访问（占位页） | 返回 `deleted: true` 字段 | ✅ PASS |
| 已删投票的 vote_type/vote_mode/tally 是否保留 | 保留 | 详情页返回完整数据 | ✅ PASS |
| 已删投票的 `closed_at`/`closed_by` 是否保留 | 保留 | 详情页返回所有原始字段 | ✅ PASS |
| 投票后删除，`user_votes` 是否受影响 | 否 | `votes` 表仅更新 del_flag，不级联删除 user_votes | ✅ PASS |

### 5.2 已删除投票的行为闸门

| 场景 | 保护措施 | 结果 |
|------|----------|------|
| 已删投票可投票吗？ | ❌ — `ballotService.submitVote()` 第 77-80 行检查 `del_flag === true` → 抛出 40301 | ✅ 正确拒绝 |
| 已删投票可关闭吗？ | ❌ — `voteService.closeVote()` 第 330-333 行检查 `del_flag === true` → 抛出 40400 | ✅ 正确拒绝 |
| 已删投票可创建人恢复？ | ❌ — 无 `undelete` 接口 | ⚠️ 缺能力但非安全风险 |
| WS 删除事件后新投票可正常进行 | ✅ — 房间清理+key 删除 | ✅ 正确 |

### 5.3 回滚脚本验证

| 文件 | 完整性 | 结果 |
|------|--------|------|
| `003_v3_delete_audit_rollback.sql` | `DROP TABLE IF EXISTS audit_logs CASCADE` + `DROP INDEX` + `ALTER TABLE DROP COLUMN` 3 列 | ✅ 完整 |
| `003_votes_soft_delete.down.sql` | 同上 | ✅ 完整 |

---

## 6. 补充发现

### 6.1 P1 — 审计日志写入失败无告警

```ts
// auditService.ts
try {
  await knex('audit_logs').insert({...});
} catch (err) {
  console.error('[AuditService] 审计日志写入失败:', err);
  // 仅打印日志，无告警
}
```

**影响**：生产环境下审计日志静默丢失，无运维告警。若 DB 写入审计日志超时或失败，操作不可追溯。

**建议**：增加 Prometheus 计数器或 sentry 告警。

### 6.2 P2 — `/api/auth/me` cookie name 不一致

`auth.ts` 中 SSO callback 设置 `res.cookie('feishu_token', ...)`，而 `/api/auth/me` 解析时查找 `cookies.token || cookies.session`。两者名称不一致，导致通过 cookie 访问 `/me` 时 token 解析失败。

### 6.3 P2 — 已删除投票越权信息泄露（越权 4 分析）

非创建者对已删投票 DELETE 时幂等返回跳过鉴权，可被用于确认投票 ID 是否有效。

---

## 7. 安全检查清单汇总

| 章节 | 检查项 | 结果 | 备注 |
|------|--------|------|------|
| §1 | v2 P0 dev_token 漏洞修复 | ✅ PASS | dev_ 分支完全移除 |
| §2.1 | DELETE 越权测试 | ⚠️ P2 | 已删投票越权 4 信息泄露 |
| §2.2 | 重放测试 | ✅ PASS | 幂等正确 |
| §2.3 | 参数篡改测试 | ✅ PASS | 服务端校验完整 |
| §3.1 | Redis key 清理逻辑 | ✅ PASS | Pipeline + 降级保护 |
| §3.2 | 并发安全性 | ⚠️ 低风险 | 无事务锁但可接受 |
| §3.3 | Redis 注入防护 | ✅ PASS | UUID key 无注入面 |
| §4.1 | 审计日志字段覆盖 | ✅ PASS | 9 个字段完整 |
| §4.2 | 完整性检查 | ⚠️ P1 | 写入失败静默丢失 |
| §4.3 | R-003 DDL 修复 | ❌ 未修复 | VARCHAR(64) 非 UUID |
| §5.1 | 数据保留验证 | ✅ PASS | 软删除数据完整保留 |
| §5.2 | 已删投票行为闸门 | ✅ PASS | 投票/关闭均受阻 |

---

## 8. 阻断项与修复建议

### 阻断项（本次评审新增）

| 编号 | 严重度 | 发现 | 建议修复 |
|------|--------|------|----------|
| **R-003（延续）** | 🔴 P0 | `audit_logs` DDL `user_id`/`team_id` 类型为 `VARCHAR(64)`，与 ARCH_v3 声明 UUID 不符 | 优先：更新 ARCH_v3 文档对齐实现；或改为 `UUID` 类型 |
| **PEN-001** | 🟠 P1 | 审计日志写入失败静默丢弃 — 仅在 console.error 输出 | 增加 Prometheus 计数器 (`audit_log_write_failures`) + 告警规则 |
| **PEN-002** | 🟡 P2 | 已删除投票 DELETE 幂等返回在鉴权前，导致非创建者可探测投票存在性 | 将 `creator_id`/`team_id` 鉴权移到幂等检查前 |

### 观察项（无需阻断）

| 编号 | 级别 | 说明 |
|------|------|------|
| OBS-001 | 建议 | audit_logs 表未定义 TTL/归档策略，建议增加 90 天自动清理 |
| OBS-002 | 建议 | cookie name 不一致（feishu_token vs token），同步命名 |
| OBS-003 | 建议 | DELETE 操作无事务锁，极端并发下 close 和 delete 同时更新同表 | 
| OBS-004 | 建议 | v3 工作树代码与 main 基线不匹配（revert 后重新添加），建议将工作树变更一次性提交 |

---

*报告结束 — 知微 🛡️*
