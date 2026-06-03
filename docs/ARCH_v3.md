# 总体架构设计方案 — 创建人删除投票 + 前端美工优化

> 版本：v3 | 设计人：栖梧 | 日期：2026-06-03 | 关联 PRD：v3

---

## 修订记录

| 编号 | 级别 | 章节 | 变更摘要 | 修订人 | 日期 |
|------|------|------|----------|--------|------|
| A-1 | 🔴 必须 | §4.1 | 新增 DELETE /api/votes/:id 接口定义；GET 接口变更 del_flag 过滤 + deleted 状态返回 | 栖梧 | 2026-06-03 |
| A-2 | 🔴 必须 | §6 | DB 增量迁移：votes 表新增 del_flag/deleted_at/deleted_by；新增 audit_logs 表 | 栖梧 | 2026-06-03 |
| A-3 | 🔴 必须 | §5.2 | WS 新增 vote:{id}:deleted 事件定义与广播时机 | 栖梧 | 2026-06-03 |
| A-4 | 🔴 必须 | §9.1 | 删除鉴权策略：creator_id + team_id 双重校验 + 幂等性保证 | 栖梧 | 2026-06-03 |
| A-5 | 🟡 重要 | §3.4 | 前端美工优化模块清单：9 项优化（U-01 ~ U-09），架构约束声明（禁止引入第三方 UI 库） | 栖梧 | 2026-06-03 |
| A-6 | 🟢 建议 | §7 | 前端性能预算：动效 ≤500ms、帧率 ≥30fps（移动端）→ 与 PRD AC-306-5/6 对齐 | 栖梧 | 2026-06-03 |
| R-1 | 🔴 必须 | §4.5, §8.4 | 架构评审修订：新增 `/api/health` 端点定义 + Docker healthcheck 配置 | 栖梧 | 2026-06-03 |
| R-2 | 🔴 必须 | §4.2-4.4, §6.2, §6.4 | 架构评审修订：DELETE 幂等性策略（第2次返回 code:0）+ del_flag 类型 CHAR(1) → BOOLEAN DEFAULT FALSE（凌霜建议） | 栖梧 | 2026-06-03 |
| R-3 | 🔴 必须 | §3.3, §5.2 | 架构评审修订：WS 房间清理（删除后 io.in().socketsLeave） + WS sticky session 必要性标注 | 栖梧 | 2026-06-03 |
| R-4 | 🔴 必须 | §8.1, §8.3-8.5 | 架构评审修订：生产继续 docker-compose + 健康检查重启 + 回滚方案 + Staging 资源写死（2 vCPU / 4 GiB） | 栖梧 | 2026-06-03 |

---

## 一、方案概述

| 字段 | 内容 |
|------|------|
| 项目名称 | 团队即时投票工具 v3「创建人删除投票 + 前端美工优化」 |
| 架构版本 | v3 |
| 设计人 | 栖梧 |
| 日期 | 2026-06-03 |
| 关联 PRD 版本 | PRD_v3.md（云起，2026-06-03） |
| 基线架构 | v1.2（飞书 SSO + CI/CD 框架） |
| 架构变更级别 | 🔵 增量迭代 — 不涉及架构重构或技术栈更换 |

### 1.1 方案摘要

本轮在 v1.2 成熟架构基础上做两个增量交付：(1) **M1 创建人删除投票** — 后端新增 DELETE API + 软删除机制 + WS 广播 + 审计日志；(2) **M2 前端美工优化** — 9 项 UI 微调，不引入第三方库、不新增页面。两个模块在架构层面解耦：M1 涉及 PG/Redis/WS 全链路改动，M2 仅涉及前端 CSS/组件层。

### 1.2 设计原则

1. **软删除保证数据可追溯** — votes 表新增 `del_flag` 标记，物理数据永久保留
2. **Redis 降级不阻塞** — Redis 不可用时删除操作仍以 DB 为准；Redis 清理失败仅记录日志
3. **前端不突破约束** — 不引入第三方 UI 库、不新增路由/页面、不动 ECharts
4. **鉴权双保险** — `creator_id` + `team_id` 双重校验；前端隐藏入口不替代后端鉴权
5. **CI/CD 链路继承 v1.2** — 本轮不修复流水线问题（老板决策），继续人工验收

---

## 二、技术选型

| 层次 | 技术 | 版本 | 选型理由 |
|------|------|------|----------|
| 前端框架 | React + TypeScript + Vite | 18.x / 5.x | 基线技术栈，不变 |
| 后端框架 | Express + TypeScript + Knex + Socket.IO | 4.x / 20 LTS | 基线技术栈，不变 |
| 数据库 | PostgreSQL | 15 | 基线，本轮新增 audit_logs 表 + votes 字段 |
| 缓存 | Redis | 7 | 基线，本轮删除操作需清理 vote:{id}:tally 和 deadline key |
| 图表库 | ECharts | 5.x | 保持不变（美工优化禁止更换图表库） |
| 样式方案 | CSS Modules | — | 保持不变（禁止引入 Tailwind/Ant Design） |
| 部署 | Docker Compose（nginx + app + pg + redis） | — | 不变 |
| CI/CD 平台 | GitHub Actions | v1.2 框架 | 🔵 本轮沿用现有框架，不修复流水线跑通问题（老板决策） |

---

## 三、模块划分

### 3.1 系统架构图（v1.2 基线，本轮无变更）

```
                          ┌──────────────┐
                          │   飞书客户端   │
                          │ (WebView/浏览器)│
                          └──────┬───────┘
                                 │ HTTPS / WSS
                                 ▼
                      ┌──────────────────────┐
                      │  Nginx (SSL 终止)     │
                      │  ├ 静态资源 /assets   │
                      │  ├ API 反代 → :3001   │
                      │  └ WS 反代 → :3001    │
                      │    (ip_hash 粘性)     │
                      └──────────┬───────────┘
                                 │
                                 ▼
            ┌────────────────────────────────────┐
            │        Express App (:3001)          │
            │  ┌──────────┐  ┌────────────────┐  │
            │  │ auth.ts   │  │ voteService.ts │  │
            │  │ (JWT验证) │  │ ballotService  │  │
            │  ├──────────┤  │ deleteService  │◀─┤ v3 新增
            │  │routes/   │  │ tallySync      │  │
            │  │ votes.ts  │  │ deadlineWorker │  │
            │  │ ─────────│  │ rateLimiter    │  │
            │  │+ DELETE   │  └───────┬────────┘  │
            │  └──────────┘          │           │
            │  ┌──────────────────┐  │           │
            │  │ Socket.IO Server │  │           │
            │  │ (Redis Adapter)  │  │           │
            │  │ + deleted 事件    │  │           │
            │  └──────────────────┘  │           │
            └────────┬───────────────┼───────────┘
                     │               │
                     ▼               ▼
            ┌────────────┐  ┌──────────────┐
            │ PostgreSQL │  │    Redis 7   │
            │    15      │  │  tally hash  │
            │+ audit_logs│  │  deadline key│
            │+ del_flag  │  │  rate limit  │
            └────────────┘  └──────────────┘
```

### 3.2 模块清单

| 模块名称 | 职责 | 所属端 | v3 变更 | 依赖模块 |
|----------|------|--------|---------|----------|
| `auth.ts` | 飞书 SSO 验签 → `req.user`；dev 降级 | 后端 | 无变更 | 飞书 OAuth API |
| `voteService.ts` | 投票 CRUD + Redis tally 管理 | 后端 | 🔵 listVotes 默认过滤 del_flag=FALSE；getVoteDetail 返回 deleted 状态 | `knex`, `ioredis` |
| `ballotService.ts` | 提交投票（防重 + Redis HINCRBY + WS 广播） | 后端 | 🔵 校验投票 del_flag=FALSE 才可投 | `voteService` |
| **`deleteService.ts`** | 🆕 软删除投票（DB UPDATE + Redis 清理 + WS 广播 + 审计日志 + 房间清理） | 后端 | 🆕 新增 | `knex`, `ioredis`, `Socket.IO` |
| **`auditService.ts`** | 🆕 审计日志写入（action/entity/user/ip/ua） | 后端 | 🆕 新增 | `knex` |
| `deadlineWorker.ts` | Redis Keyspace Notification + 启动兜底扫描 | 后端 | 🔵 启动扫描需过滤 del_flag=FALSE | `ioredis` |
| `tallySync.ts` | Redis → PG 对账（每 5s） | 后端 | 无变更 | `knex`, `ioredis` |
| `rateLimiter.ts` | 限流（投票操作 60s/3 次滑动窗口） | 后端 | 无变更 | `ioredis` |
| `ws/handlers.ts` | WS join:vote / leave:vote / disconnect | 后端 | 🔵 新增 vote:{id}:deleted 广播路由 | `Socket.IO` |
| **前端路由（React）** | 4 个页面：列表/创建/详情(active)/详情(closed) | 前端 | 🔵 无新增路由；详情页新增 deleted 状态分支 | `react-router-dom` |
| **VoteList** | 投票列表页 | 前端 | 🔵 卡片样式升级 + 删除入口 + 淡出移除动效 | `api.ts`, `useSocket` |
| **VoteDetail** | 投票详情页 | 前端 | 🔵 已删除占位页 + 实时结果卡片化 + 动效 | `api.ts`, `useSocket` |
| **CreateVote** | 创建投票页 | 前端 | 🔵 表单样式升级 | `api.ts` |
| **DeleteConfirm** | 🆕 删除确认弹窗组件 | 前端 | 🆕 新增 | — |
| **ResultChart** | ECharts 柱状图 | 前端 | 🔵 样式升级（渐变/圆角/过渡） | `ECharts` |
| **全局 CSS 变量** | 色彩系统 + 动效基调 | 前端 | 🆕 新增统一 CSS 变量体系 | — |

### 3.3 通信机制

| 通信路径 | 协议 | 说明 |
|----------|------|------|
| 前端 ↔ 后端 API | HTTPS REST | 所有 CRUD 操作走 REST（含 DELETE） |
| 前端 ↔ 后端实时推送 | WSS (Socket.IO) | 投票更新/结束/删除等事件广播；Nginx `ip_hash` 粘性会话保证同一客户端始终路由到同一后端实例 |
| 后端多实例同步 | Redis Pub/Sub | Socket.IO Redis Adapter，跨实例广播与房间管理（join/leave 操作经 Redis 同步） |
| WS 粘性会话 | Nginx `ip_hash` | ✅ 必需的：Socket.IO 握手阶段依赖 HTTP 长轮询升级，同一客户端必须始终路由到同一实例；`ip_hash` 已在 v1.2 架构图中配置，本轮无变更 |
| 后端 ↔ PostgreSQL | TCP (Knex) | 参数化查询，禁止拼接 SQL |
| 后端 ↔ Redis | TCP (ioredis) | Tally 计数、deadline TTL、限流 |

### 3.4 前端美工优化模块详细约束

> 架构层面对 M2 的硬约束，超出以下范围的 PR 直接打回。

| 编号 | 优化对象 | 架构约束 |
|------|---------|----------|
| U-01 | 全局色彩系统 | CSS 变量定义在 `:root`（`index.css`）：`--color-primary`, `--color-primary-hover`, `--color-success`, `--color-warning`, `--color-danger`, `--color-disabled`, `--color-bg`, `--color-bg-card`, `--color-text`, `--color-text-secondary`, `--color-border`；所有组件通过 `var(--xxx)` 引用 |
| U-02 | 全局动效基调 | `--transition-fast: 150ms ease; --transition-base: 250ms ease; --transition-slow: 400ms ease;`；所有 `< 500ms` |
| U-03 | 实时计票 UI | ResultChart 图表选项 `animationDuration: 300`, `animationEasing: 'cubicOut'`；容器加 `.resultCard` 包裹 （圆角 12px, box-shadow, padding 16px）|
| U-04 | 投票列表卡片 | VoteCard 组件样式升级；新增 `del_flag=FALSE` 过滤逻辑 |
| U-05 | 创建投票表单 | CreateVote 表单控件聚焦态 `transition: border-color var(--transition-fast)` |
| U-06 | 空状态/错误状态 | 统一 EmptyState 组件（图标 + 文案 + CTA）；Skeleton 骨架屏 |
| U-07 | 详情页布局 | VoteDetail 顶部信息栏卡片化（`.voteHeader` → `.voteHeaderCard`）|
| U-08 | 移动端适配 | `min-width: 320px`, 触控目标 `min-height: 44px; min-width: 44px` |
| U-09 | 删除交互 | DeleteConfirm 弹窗：危险色按钮 + 投票标题预览 + 遮罩层关闭 + ESC 关闭 |

---

## 四、API 契约

### 4.1 接口规范

#### 🆕 新增接口

| 接口名 | 方法 | 路径 | 请求参数 | 响应格式 | 错误码 |
|--------|------|------|----------|----------|--------|
| 删除投票 | **DELETE** | `/api/votes/:id` | Header: `Authorization: Bearer <JWT>` | `{ code: 0, message: '投票已删除' }` | 见 4.3 |

#### 🔵 现有接口变更

| 接口名 | 变更内容 |
|--------|----------|
| **GET /api/votes** | 默认 WHERE 条件追加 `AND del_flag = FALSE`；新增可选参数 `?include_deleted=true`（仅限审计/管理用途，不暴露给前端常规列表） |
| **GET /api/votes/:id** | 返回体中新增 `deleted: boolean`, `deleted_at: string|null`, `deleted_by: string|null`；已删除投票 `code ≠ 0`（前端据此渲染「已删除」占位页） |
| **POST /api/votes/:id/close** | 前置校验：已删除投票（`del_flag=TRUE`）返回 404 |
| **POST /api/votes/:id/vote** | 前置校验：已删除投票返回 403，`code: 40303, message: '投票已被删除'` |

### 4.2 认证与鉴权

- **认证方式**：JWT（飞书 SSO 签发），Bearer header 传递
- **权限模型**：团队级 RBAC（v1.2 基线） + 资源级 creator 校验
- **Token 刷新策略**：v1.2 基线（飞书 access_token 服务端代理刷新，前端无感）
- **删除鉴权（v3 新增）**：
  ```
  1. JWT 解析 → 获取 req.user = { user_id, team_id, display_name }
  2. votes 表查询 → 校验 vote.creator_id === req.user.user_id
  3. 校验 vote.team_id === req.user.team_id（防止跨团队越权）
  4. 校验 vote.del_flag === TRUE → 已删除，返回 200 { code: 0, message: '投票已删除' }（幂等成功）
  5. vote.del_flag === FALSE → 执行软删除
  ```
- **前端入口隐藏不替代后端鉴权**：前端仅向 `creator_id === current_user_id` 的用户展示删除按钮；但后端必须独立执行上述完整校验

### 4.3 错误码规范（v3 新增）

| 错误码 | HTTP 状态码 | 含义 | 处理建议 |
|--------|------------|------|----------|
| 40303 | 403 | 仅创建者可删除 | 前端不展示删除按钮即可规避，若出现则提示用户 |
| 40304 | 403 | 无权删除此投票（跨团队） | 前端检查；出现则为异常 |
| 40401 | 404 | 投票不存在（ID 从未创建） | 前端显示「投票不存在」 |
| 40305 | 403 | 投票已被删除（禁止投票操作） | 前端在详情页渲染「已删除」占位页 |

> ⚠️ **幂等性说明**：已删除投票（`del_flag=TRUE`）再次 DELETE 返回 `200 { code: 0, message: '投票已删除' }`（幂等成功），不使用 40401 错误码。仅当 vote ID 在系统中从未存在时才返回 40401。

### 4.4 DELETE API 请求/响应详细契约

**请求**：
```
DELETE /api/votes/:id
Headers:
  Authorization: Bearer <JWT>
  Content-Type: application/json
```

**成功响应 (200)**：
```json
{
  "code": 0,
  "message": "投票已删除"
}
```

**失败响应 (403)**：
```json
{
  "code": 40303,
  "message": "仅投票创建者可删除"
}
```

**失败响应 (403 — 跨团队)**：
```json
{
  "code": 40304,
  "message": "无权删除此投票"
}
```

**幂等成功响应 (200 — 第 2 次及后续 DELETE，投票已删除)**：
```json
{
  "code": 0,
  "message": "投票已删除"
}
```

**失败响应 (404 — vote ID 从未创建)**：
```json
{
  "code": 40401,
  "message": "投票不存在"
}
```

---

### 4.5 健康检查端点

**`GET /api/health`** — 供 Docker healthcheck 与负载均衡器探测使用。

**请求**：
```
GET /api/health
（无需认证）
```

**成功响应 (200)**：
```json
{
  "status": "ok",
  "uptime": 12345.6,
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

**降级响应 (503 — 任一依赖不可用)**：
```json
{
  "status": "degraded",
  "uptime": 12345.6,
  "checks": {
    "postgres": "ok",
    "redis": "error"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `string` | `"ok"` 全部健康 / `"degraded"` 部分依赖不可用 |
| `uptime` | `number` | 进程运行秒数 |
| `checks.postgres` | `string` | `"ok"` 或 `"error"`（执行 `SELECT 1` 探测） |
| `checks.redis` | `string` | `"ok"` 或 `"error"`（执行 `PING` 探测） |

**Docker Compose healthcheck 配置**：
```yaml
# docker-compose.yml
services:
  app:
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

> 📌 healthcheck 用于 `docker-compose` 自动重启不健康的 app 容器；`start_period: 15s` 给 Express 启动 + DB migration 留足时间。

---

## 五、数据流与领域模型

### 5.1 核心实体（v3 变更）

| 实体 | 属性（v3 新增/变更） | 关系 |
|------|---------------------|------|
| **Vote** | `del_flag BOOLEAN DEFAULT FALSE`、`deleted_at TIMESTAMPTZ NULL`、`deleted_by UUID NULL FK → users(id)` | 一对多 Options；一对多 UserVotes |
| **AuditLog** 🆕 | `id UUID PK`、`action VARCHAR(50)`、`entity_type VARCHAR(50)`、`entity_id UUID`、`user_id UUID`、`team_id UUID`、`ip VARCHAR(45)`、`user_agent TEXT`、`detail JSONB NULL`、`created_at TIMESTAMPTZ` | 独立日志表，不与业务表外键关联（保证删除灵活性） |

### 5.2 删除流程数据流（时序）

```
[创建者 前端]                [Express 后端]                    [PostgreSQL]           [Redis]              [其他在线用户]
     │                            │                                │                    │                       │
     │ DELETE /api/votes/:id       │                                │                    │                       │
     │ (Bearer JWT)               │                                │                    │                       │
     │───────────────────────────▶│                                │                    │                       │
     │                            │                                │                    │                       │
     │                    ┌───────┴────────┐                        │                    │                       │
     │                    │  鉴权校验         │                       │                    │                       │
     │                    │  1. JWT → user   │                       │                    │                       │
     │                    │  2. SELECT votes  │                       │                    │                       │
     │                    │  3. creator_id=user│                      │                    │                       │
     │                    │  4. team_id 对等   │                      │                    │                       │
     │                    │  5. del_flag=FALSE    │                      │                    │                       │
     │                    └───────┬────────┘                        │                    │                       │
     │                            │                                │                    │                       │
     │                            │  UPDATE votes SET del_flag=TRUE,│                    │                       │
     │                            │  deleted_at=NOW(), deleted_by=?│                    │                       │
     │                            │───────────────────────────────▶│                    │                       │
     │                            │                                │                    │                       │
     │                            │  INSERT INTO audit_logs (...)  │                    │                       │
     │                            │───────────────────────────────▶│                    │                       │
     │                            │                                │                    │                       │
     │                            │  DEL vote:{id}:tally           │                    │                       │
     │                            │──────────────────────────────────────────────────▶│                       │
     │                            │                                │                    │                       │
     │                            │  DEL vote:{id}:deadline        │                    │                       │
     │                            │──────────────────────────────────────────────────▶│                       │
     │                            │                                │                    │                       │
     │                            │  WS emit('vote:{id}:deleted',  │                    │                       │
     │                            │    {vote_id, deleted_by, ts})  │                    │                       │
     │                            │────────────────────────────────────────────────────────────────────────────▶│
     │                            │                                │                    │                       │
     │                            │  io.in(vote:{id})              │                    │                       │
     │                            │    .socketsLeave(vote:{id})    │                    │  [所有客户端离开房间]  │
     │                            │────────────────────────────────────────────────────────────────────────────▶│
     │                            │                                │                    │                       │
     │                            │                                │                    │                       │
     │      200 { code: 0 }       │                                │                    │                       │
     │◀───────────────────────────│                                │                    │                       │
     │                            │                                │                    │                       │
     │  [列表页：卡片淡出移除]       │                                │                    │  [收到 WS：列表页      │
     │  [详情页：已删除占位页]       │                                │                    │   移除卡片/详情页     │
     │                            │                                │                    │   显示已删除占位页]    │
```

### 5.3 Redis 不可用时降级数据流

```
[创建者 前端]                [Express 后端]                     [PostgreSQL]
     │                            │                                │
     │ DELETE /api/votes/:id       │                                │
     │───────────────────────────▶│                                │
     │                            │  UPDATE votes SET del_flag=TRUE│
     │                            │───────────────────────────────▶│
     │                            │  INSERT audit_logs             │
     │                            │───────────────────────────────▶│
     │                            │                                │
     │                            │  DEL tally/deadline (Redis)    │
     │                            │  ❌ 失败 → 记录 error 日志      │
     │                            │  ⚠️ 不阻塞主流程               │
     │                            │                                │
     │                            │  WS emit → 失败记录 warn 日志  │
     │                            │                                │
     │      200 { code: 0 }       │                                │
     │◀───────────────────────────│                                │
     │                            │                                │
     │  [前端正常更新]              │                                │
     │  [下次 GET /api/votes       │                                │
     │   列表已过滤 del_flag=FALSE] │                                │
```

---

## 六、数据库设计概要

### 6.1 核心表（v3 变更）

| 表名 | 用途 | v3 变更 | 预估量级 |
|------|------|---------|----------|
| `votes` | 投票主表 | 🔵 新增 3 列：`del_flag`, `deleted_at`, `deleted_by` | 10K~100K |
| `options` | 投票选项 | 无变更 | 50K~500K |
| `user_votes` | 投票记录（防重） | 无变更（已删除投票的投票记录保留） | 100K~1M |
| `users` | 用户表（飞书 SSO 登录） | 无变更 | 100~10K |
| `audit_logs` | 🆕 审计日志 | 🆕 新增表 | 1K~100K |

### 6.2 votes 表变更详情

| 字段 | 类型 | 默认值 | 说明 | 操作 |
|------|------|--------|------|------|
| `del_flag` | `BOOLEAN` | `FALSE` | FALSE=未删除，TRUE=已删除 | **新增** |
| `deleted_at` | `TIMESTAMPTZ` | `NULL` | 删除时间戳 | **新增** |
| `deleted_by` | `UUID` | `NULL` | 执行删除的用户 UUID（FK → users.id） | **新增** |

### 6.3 audit_logs 表 DDL

```sql
CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_v7(),
    action      VARCHAR(50) NOT NULL,          -- 如 'delete_vote', 'close_vote'
    entity_type VARCHAR(50) NOT NULL,          -- 如 'vote'
    entity_id   UUID NOT NULL,                 -- 被操作实体 ID
    user_id     UUID NOT NULL,                 -- 操作人 users.id
    team_id     UUID NOT NULL,                 -- 操作人团队
    ip          VARCHAR(45) NOT NULL,          -- 客户端 IP（支持 IPv6）
    user_agent  TEXT NOT NULL,                 -- User-Agent
    detail      JSONB,                         -- 扩展信息（如删除时的投票状态）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_logs IS '操作审计日志表，记录敏感操作（删除、关闭等）';

-- 按操作类型 + 时间查询（审计常用）
CREATE INDEX idx_audit_logs_action_time ON audit_logs (action, created_at DESC);

-- 按被操作实体查询
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- 按操作人查询
CREATE INDEX idx_audit_logs_user ON audit_logs (user_id, created_at DESC);

-- 按团队查询
CREATE INDEX idx_audit_logs_team ON audit_logs (team_id, created_at DESC);
```

### 6.4 迁移脚本要求

| 脚本 | 内容 |
|------|------|
| **up (003_v3_delete_audit.sql)** | ① `ALTER TABLE votes ADD COLUMN del_flag BOOLEAN DEFAULT FALSE NOT NULL`；② `ALTER TABLE votes ADD COLUMN deleted_at TIMESTAMPTZ`；③ `ALTER TABLE votes ADD COLUMN deleted_by UUID`；④ 创建 `audit_logs` 表（含索引）；⑤ 新增索引 `CREATE INDEX idx_votes_del_flag ON votes (team_id, del_flag)` 以覆盖列表查询 |
| **down (003_v3_delete_audit_rollback.sql)** | ① `ALTER TABLE votes DROP COLUMN del_flag, DROP COLUMN deleted_at, DROP COLUMN deleted_by`；② `DROP TABLE IF EXISTS audit_logs CASCADE`；③ `DROP INDEX IF EXISTS idx_votes_del_flag` |

### 6.5 索引策略（v3 新增）

| 索引 | 覆盖查询 | 说明 |
|------|----------|------|
| `idx_votes_del_flag (team_id, del_flag)` | `GET /api/votes` 列表查询 | 原 idx_votes_team_status 可覆盖 range 扫描；新增 del_flag 复合索引减少回表 |
| `idx_audit_logs_action_time` | 审计按操作类型回溯 | — |
| `idx_audit_logs_entity` | 按实体查询审计记录 | — |
| `idx_audit_logs_user` | 按操作人查询审计记录 | — |

### 6.6 自定义函数安全声明

本次 v3 **不引入新的自定义函数/存储过程**。现有 `uuid_v7()` 函数已在 v1.1 架构中声明并通过 v1.2 安全审查。审计日志的 UUID 主键继续使用 `uuid_v7()`。

---

## 七、非功能需求实现策略

| 维度 | 策略 | 交付等级 |
|------|------|----------|
| **性能** | 删除 API 执行流程：PG UPDATE (1 条) + Redis DEL (2 keys) + WS emit + INSERT audit_logs → 全部同步执行，满足 P99 ≤ 500ms。Redis 不可用时跳过 Redis 操作，仅 PG UPDATE + audit INSERT → 延迟更低 | Must Have |
| **安全** | 详见第九章「安全设计」：creator_id + team_id 双重鉴权、幂等性、审计日志、DELETE 需有效 JWT | Must Have |
| **CI/CD** | 🔵 本轮沿用 v1.2 框架，不修复流水线跑通问题（老板决策），继续人工验收；CI/CD 最低覆盖 lint → test → build → deploy staging → smoke test → deploy prod 的规范已在 v1.2 架构中定义，但 stall 待修复 | 继承 v1.2 |
| **高可用** | 无状态 Express 实例 + Redis Pub/Sub 跨实例广播；PG 主备；删除操作以 PG 成功为准，Redis 为辅助 | Must Have |
| **可扩展** | v1.2 基线已支持水平扩展（无状态服务 + Redis Adapter），本轮不引入新状态依赖 | Must Have |
| **可观测** | 新增审计日志表（`audit_logs`）；Redis 清理失败 → `console.error`；WS 推送失败 → `console.warn`；删除操作 QPS/成功率 P99 建议接入指标采集（v1.2 普罗米修斯端点可用） | Must Have |
| **兼容性** | 前端新 CSS 变量/动画在 Chrome 90+ / Edge 90+ / Firefox 90+ / Safari 15+ 均原生支持（transition/var/box-shadow 均为 CSS3 标准，无兼容性问题） | Must Have |

---

## 八、部署与环境矩阵

### 8.1 环境矩阵（继承 v1.2）

| 维度 | 开发环境 (dev) | Staging 环境 | 生产环境 (prod) |
|------|---------------|-------------|-----------------|
| **部署方式** | 本地 docker-compose | docker-compose（与生产同配，端口 offset） | docker-compose（本轮确认继续使用，不迁移 K8s） |
| **PG 版本** | 15 | 15 | 15 |
| **Docker Base Image** | `node:20-alpine` | `node:20-alpine` | `node:20-alpine` |
| **PG 扩展列表** | `pgcrypto`, `uuid-ossp` | `pgcrypto`, `uuid-ossp` | `pgcrypto`, `uuid-ossp` |
| **Redis 版本** | 7 | 7 | 7 |
| **端口映射** | app:3001, pg:5432, redis:6379 | app:3002, pg:5433, redis:6380 | app:3001, pg:5432, redis:6379 |
| **数据卷** | 本地 volume（可重建） | 独立 volume | 持久化 volume + 每日备份 |
| **SSL/TLS** | 可选（自签） | 必须启用 | 必须启用 |
| **日志级别** | debug | info | warn |
| **审计日志表** | ✅ 创建（dev 验证 DDL） | ✅ 创建（staging 验证写入） | ✅ 创建（生产记录） |

### 8.2 CI/CD 流水线（继承 v1.2，本轮不修复）

> 🔵 **本轮决策**：老板明确本轮不修复 CI/CD 流水线问题，继续人工验收。以下为 v1.2 定义的流水线规范（待后续迭代修复）。

```
git push ──→ Stage 1: Lint ──→ Stage 2: Test ──→ Stage 3: Build Image
                                                      │
                                                      ▼
                                             Stage 4: Deploy Staging
                                                      │
                                                      ▼
                                             Stage 5: Smoke Test
                                                    ╱     ╲
                                              通过 ✅       失败 ❌
                                                │            │
                                                ▼            ▼
                                         Stage 6:        🚫 阻断
                                     Deploy Production
```

**本轮验收方式**：人工执行以下 checklist：
- [ ] TypeScript 编译通过（`tsc --noEmit`）
- [ ] 单元测试全绿（`npm test`）
- [ ] Docker Compose 可启动（`docker-compose up -d`）
- [ ] Migration up/down 可在 staging 正常执行
- [ ] 验收标准 AC-301-1 ~ AC-309-5 全部通过

### 8.3 部署拓扑与基础设施要求（给长夜）

| 环境 | 资源配置 | 中间件 | 网络要求 |
|------|----------|--------|----------|
| 开发 | 本地 Docker（CPU 2 核 / 内存 4GiB） | PG 15 + Redis 7 | 端口 3001/5432/6379 |
| Staging | 与生产同配：**最低 2 vCPU / 4 GiB Mem**（端口 offset） | PG 15 + Redis 7 | 端口偏移 |
| 生产 | 2 vCPU / 4 GiB Mem（低并发团队投票工具） | PG 15 + Redis 7 | HTTPS(443) + WSS，Nginx SSL 终止 |

**v3 基础设施变更**：无变更。仅需执行 DB migration 003（`docker-compose exec app npm run migrate:up`）。

### 8.4 健康检查与自动重启

> 配合 §4.5 `/api/health` 端点，Docker Compose 自动检测容器健康状态并重启异常容器。

| 服务 | 健康检查方式 | 自动重启策略 |
|------|------------|-------------|
| **app** | `wget http://localhost:3001/api/health`（每 30s，超时 5s，3 次重试） | `restart: unless-stopped` + healthcheck 触发重启 |
| **postgres** | `pg_isready -U ${POSTGRES_USER}` | `restart: unless-stopped` |
| **redis** | `redis-cli PING` | `restart: unless-stopped` |
| **nginx** | `wget http://localhost:3001/api/health`（通过 app 代理） | `restart: unless-stopped` |

### 8.5 生产回滚方案

| 回滚场景 | 回滚操作 | 验证方式 |
|----------|----------|----------|
| **DB migration 失败** | ① 执行 down 脚本 `docker-compose exec app npm run migrate:down`；② 回退至前一 Docker image `docker-compose up -d` | 列表/投票/详情 API 正常返回 |
| **新镜像功能异常** | ① `docker-compose down`；② 切换 image tag 至前一版本；③ `docker-compose up -d`；④ 无需回滚 migration（向下兼容） | healthcheck 200 + 核心业务流程（创建/投票/列表）验收通过 |
| **数据卷损坏** | ① 从最新每日备份恢复 PG 数据卷；② `docker-compose up -d` | PG 连接正常 + 关键表数据完整性校验 |

> 📌 v3 migration 为纯增量（ADD COLUMN + CREATE TABLE），向下兼容 v1.2 image；回滚镜像无需同时回滚 migration。

---

## 九、安全设计

### 9.1 认证与授权方案

#### 9.1.1 认证方案

| 维度 | 方案 |
|------|------|
| **认证协议** | JWT（飞书 OAuth 2.0 SSO 签发），v1.2 基线 |
| **Token 签发** | `/api/auth/feishu/callback` → 换飞书 token → 签发 JWT（有效期 2h） |
| **Token 存储** | 前端 localStorage（v1.2 基线） |
| **会话管理** | 无服务端会话，JWT 无状态；登出由前端清除 token |

#### 9.1.2 授权模型 — 删除操作（v3 新增）

| 维度 | 方案 |
|------|------|
| **权限模型** | 团队级 RBAC（v1.2 基线） + v3 资源级 creator 验证 |
| **角色定义** | `creator`（投票创建者）：可删除自己的投票、可结束自己的投票；`participant`（普通参与者）：可投票、可查看 |
| **资源级权限** | `vote.creator_id === req.user.user_id AND vote.team_id === req.user.team_id` — 双重校验 |
| **越权防护** | 服务端强制校验，不依赖前端隐藏按钮；DELETE API 返回 403 即拦截；`closeVote` 已有 FOR UPDATE + creator 校验，v3 增强添加 `del_flag=FALSE` 前置检查 |

#### 9.1.3 匿名场景脱敏策略

| 维度 | 要求（v1.2 基线，v3 无变更） |
|------|------|
| **user_id 不可追溯** | 匿名投票下 API 响应中 `voters` 字段返回 `[]`（已在 `getVotersMap` 中实现） |
| **字段级过滤** | 服务端根据 `vote_mode === 'anonymous'` 决定是否返回投票人信息 |
| **日志脱敏** | 匿名投票操作日志中不记录 voter user_id（v1.2 基线已实现；审计日志中 `delete_vote` 记录操作人，属于必要的安全追溯，不属于匿名泄露） |

### 9.2 数据库函数安全设计

本次 v3 **不引入新的自定义函数/存储过程**。`uuid_v7()` 已在 v1.1 声明并通过 v1.2 安全审查。审计日志表使用标准 SQL，无存储过程。

### 9.3 数据流中的敏感数据处理

#### 9.3.1 删除操作的数据安全

| 维度 | 方案 |
|------|------|
| **软删除数据保留** | votes 数据物理保留（`del_flag=TRUE`），`user_votes` 不级联删除，确保投票记录可追溯 |
| **审计日志完整性** | 记录 `user_id` / `vote_id` / `ip` / `user_agent` / `timestamp`，不可篡改（仅 INSERT，无 UPDATE/DELETE 权限） |
| **敏感数据访问控制** | `audit_logs` 表不暴露 REST API；仅运维/安全角色通过 DB 直接访问 |

#### 9.3.2 传输加密

| 链路 | 加密方案（v1.2 基线，无变更） |
|------|------|
| **客户端 ↔ 服务端** | HTTPS（TLS 1.2+），Nginx SSL 终止 |
| **服务间通信** | 内部 Docker 网络（单实例部署） |
| **数据库连接** | 本地 socket/TCP localhost（Docker 内部网络，无需 SSL） |
| **Redis 连接** | 本地 TCP localhost（Docker 内部网络） |

#### 9.3.3 日志脱敏

| 数据类型 | 脱敏策略 |
|----------|----------|
| **user_id（审计日志）** | 记录为 UUID（users.id），用于安全追溯，属于必要安全字段 |
| **IP 地址（审计日志）** | 记录完整 IP（`req.ip` 或 `x-forwarded-for`），用于安全审计 |
| **user_agent（审计日志）** | 记录完整 User-Agent，用于安全审计 |
| **敏感业务数据** | 密码、token、密钥**禁止**写入任何日志（v1.2 基线已有日志过滤器） |

### 9.4 安全审查接入时机

| 阶段 | 审查内容 | 负责人 | 交付物 |
|------|----------|--------|--------|
| **阶段二：设计审查** | 架构安全设计评审：删除鉴权双保险策略、审计日志方案、软删除数据安全 | 栖梧 + 知微 | 本架构文档第九章 |
| **阶段五：实现验证** | 代码安全审查：DELETE API 鉴权完整性、幂等性、审计日志写入、v2 P0 漏洞回归检查、依赖漏洞扫描 | 知微 | 安全测试报告 |

---

## 十、技术风险与预案

| 风险 | 影响 | 概率 | 预案 |
|------|------|------|------|
| **Redis tally/deadline 清理不完整** | 高 — 数据残留，脏数据 | 中 | AC-301-1 验证 Redis DEL；tallySync 对账可覆盖 Redis 残留清理；deadline key 有 TTL 自动过期兜底 |
| **WS 推送失败导致用户不同步** | 中 — 部分在线用户看不到删除 | 低 | 用户刷新页面后 API 层已过滤 `del_flag=FALSE`；删除时服务端主动 `io.in(vote:{id}).socketsLeave(vote:{id})` 清理房间，最终一致性有保证 |
| **美化范围 scope 蔓延** | 中 — 工期超支 | 中 | PRD §3.4「禁止项」6 条约束 + 本架构 §3.4 架构约束 9 条，评审门禁直接打回 |
| **移动端动画性能下降** | 中 — 低端设备卡顿 | 中 | AC-306-5/6：动效 ≤500ms、无循环动画（状态点除外）；低端设备 ≥30fps；使用 `will-change: transform` 优化 |
| **审计日志表增长** | 低 — 小型项目 | 低 | 当前仅记录删除操作；v3 不设自动清理策略；监控表大小 |
| **删除操作被恶意批量调用** | 中 — 批量删除 | 低 | JWT 鉴权仅创建者可调用；如有需要后续可加 rate limit（PRD §12 已识别） |

---

## 十一、v3 与 v1.2 差异总览

| 维度 | v1.2 | v3 | 变更类型 |
|------|------|-----|----------|
| REST 端点 | `POST /api/votes, GET /api/votes, GET /api/votes/:id, POST /api/votes/:id/vote, POST /api/votes/:id/close` | + `DELETE /api/votes/:id`；GET 变更 del_flag 过滤 | 新增/变更 |
| WS 事件 | `update, closed, reminder` | + `vote:{id}:deleted` | 新增 |
| DB 表 | `votes, options, user_votes, users` | + `audit_logs`；votes 新增 3 列 | 新增 |
| 后端模块 | `voteService, ballotService, deadlineWorker, tallySync, rateLimiter` | + `deleteService, auditService` | 新增 |
| 前端页面 | `VoteList, CreateVote, VoteDetail(active), VoteDetail(closed)` | + `DeleteConfirm` 弹窗组件；各页面样式升级 | 新增/优化 |
| 鉴权 | JWT + team_id 校验 | + `creator_id` 双保险（v3 新增） | 增强 |
| 前端样式 | 分散的 hard-coded 颜色值 | CSS 变量体系 + 统一动效 | 重构 |
| CI/CD | GHA 框架（未跑通） | 不修复（老板决策），人工验收 | 不变 |

---

> 📋 **v3 架构方案完成（修订版）** | 设计人：栖梧 | 审阅状态：待 EeiMoo 复审
>
> **结论摘要**：通过。已完成架构评审 4 项修订——(1) 新增 `/api/health` 端点 + Docker healthcheck；(2) DELETE 幂等性补全（第 2 次返回 code:0）+ del_flag 改为 BOOLEAN；(3) WS 房间清理 + sticky session 标注；(4) 生产部署 docker-compose + 健康检查重启 + 回滚方案 + Staging 资源写死。共 0 个阻断项。
