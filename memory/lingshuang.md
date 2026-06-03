# 凌霜💻 项目记忆 — 投票应用 v3

## 项目背景
投票应用 (vote-app)，v3 迭代方向：
1. 增加创建人删除投票功能
2. 优化前端美化

## Kick-off 认知（2026-06-03）
### 核心理解
- 新增 `DELETE /api/votes/:id` 路由，创建者可在投票进行中或结束后删除自己的投票
- 涉及：PG 级联删除（已有 ON DELETE CASCADE）、Redis tally/deadline key 清理、WS 通知、前端入口
- 建议软删除（加 `deleted_at` 字段），便于数据审计和可能的恢复

### 已识别风险
- 删除的数据一致性——并发投票提交与删除的事务顺序需设计，避免死锁
- Redis 清理遗漏——tally hash、deadline key、幂等缓存
- WS 需要新增 `vote:{id}:deleted` 事件

### 角色边界
- ✅ 后端 API 设计实现、DB migration（含回滚）、接口文档、自测
- ❌ 前端 UI 改动、DevOps/CI-CD 配置、越过架构评审直接写代码

### 需要对齐的决策
- 软删还是硬删？
- 删除后 WS 广播什么事件？
- 仅创建者可删，还是团队管理员也可删？
- 删除允许的 status 范围（仅 closed 或 active 也可删？）

## 架构输入
- 方向对齐纪要：`docs/KICKOFF_ALIGNMENT_v3.md`
- 待栖梧架构方案下发后开始后端实现

## 后端开发产出（2026-06-03 阶段四）

### 完成项
1. **数据库迁移**：`migrations/003_votes_soft_delete.sql` + rollback
   - votes 表新增 `del_flag BOOLEAN DEFAULT FALSE`, `deleted_at`, `deleted_by`
   - 新增 `audit_logs` 表
   - 新增 `idx_votes_del_flag` 索引

2. **DELETE API**: `DELETE /api/votes/:id`
   - 软删除（UPDATE del_flag = TRUE）
   - 权限校验：creator_id + team_id 双层鉴权
   - 幂等：已删除投票第 2 次请求返回 code:0
   - Redis 清理：tally hash + deadline key
   - WS 广播 `vote:{id}:deleted` 事件
   - WS 房间清理：socketsLeave(room)
   - 审计日志写入 audit_logs

3. **列表过滤**：GET /api/votes 默认 `del_flag = FALSE`
4. **详情新增字段**：GET /api/votes/:id 返回 `deleted: boolean`
5. **健康检查**：`GET /api/health` 返回 status/uptime/checks(postgres, redis)
6. **新服务**：`DeleteService` + `AuditService`
7. **测试**：全部 66 个用例通过（原有 56 个 + 新增 10 个 DELETE 相关）

### 文件清单
- `backend/migrations/003_votes_soft_delete.sql` (UP)
- `backend/migrations/003_votes_soft_delete.down.sql` (DOWN)
- `backend/src/services/deleteService.ts`
- `backend/src/services/auditService.ts`
- `backend/src/routes/votes.ts`（已更新：新增 DELETE 路由）
- `backend/src/app.ts`（已更新：集成 DeleteService）
- `backend/src/services/voteService.ts`（已更新：del_flag 过滤 + 详情返回 deleted）
- `backend/src/services/ballotService.ts`（已更新：校验 del_flag）
- `backend/src/types/index.ts`（已更新：新增字段/类型/WS 事件）
- `backend/src/__tests__/testSetup.ts`（已更新：DDL + createTestVote）
- `backend/src/__tests__/votes.test.ts`（已更新：新增 DELETE API 测试）
- `docs/API_DOCUMENTATION.md`（已更新：删除 API + health + WS deleted）
- `docs/backend_self_test.md`（自测报告）
