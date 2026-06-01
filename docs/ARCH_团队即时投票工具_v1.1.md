# 总体架构设计方案 — 团队即时投票工具

> 版本：v1.1 | 设计人：栖梧 | 日期：2026-06-01 | 关联 PRD：v1.1

---

## 修订记录

| 编号 | 级别 | 章节 | 变更摘要 | 修订人 | 日期 |
|------|------|------|----------|--------|------|
| A-1 | 🔴 必须 | 5.1 DDL | `votes.creator_id` 类型从 `UUID` 修正为 `VARCHAR(64)`（飞书 user_id 为 `ou_xxx` 格式）；`user_votes.user_id` 已是 `VARCHAR(64)` 无需修改；无 `poll_participants` 表 | 栖梧 | 2026-06-01 |
| A-2 | 🔴 必须 | 5.1 DDL | `votes` 表新增 `team_id VARCHAR(64) NOT NULL` 列 + `INDEX idx_votes_team_status (team_id, status)`；auth 中间件注入 `req.user.team_id` 用于权限比对 | 栖梧 | 2026-06-01 |
| A-3 | 🔴 必须 | 9.1 | 补充前端构建产物流入说明（`client/dist` 由 `npm run build` 产出，Nginx 直接挂载）；确认 docker-compose 已含 nginx 服务 | 栖梧 | 2026-06-01 |
| B-1 | 🟡 重要 | 9.2 | Nginx 新增 443 SSL 监听 server 块；证书路径变量化 `$CERT_PATH/$CERT_KEY`；标注 MVP 可用自签/云厂商免费证书 | 栖梧 | 2026-06-01 |
| B-2 | 🟡 重要 | 9.3 | 蓝绿部署「共享数据卷」方案替换为滚动重启方案（`docker-compose up -d --no-deps app`）；删除共享数据卷相关内容 | 栖梧 | 2026-06-01 |
| B-3 | 🟡 重要 | 9.2 | Nginx `http` 块增加 `real_ip` 模块配置（`set_real_ip_from 10.0.0.0/8` + `real_ip_header X-Forwarded-For` + `real_ip_recursive on`），确保 `ip_hash` 获取真实客户端 IP | 栖梧 | 2026-06-01 |
| B-4 | 🟡 重要 | 9.1 | Redis `maxmemory-policy` 从 `noeviction` 改为 `volatile-lru`（tally key 永不过期不受淘汰影响；带 TTL 的 deadline/rate key 可安全淘汰） | 栖梧 | 2026-06-01 |
| B-5 | 🟡 重要 | 9.5（新增） | 新增 PG 备份方案：`pg_dump` 每日 cron + 保留 7 天 + 3 句话恢复 SOP | 栖梧 | 2026-06-01 |
| C-1 | 🟢 建议 | 8.3 | 限流 Lua 脚本优化：先 `ZREMRANGEBYSCORE` 清理过期 → 再 `ZCARD` 判断，消除 ZADD 后计数的时间窗口误差 | 栖梧 | 2026-06-01 |
| C-2 | 🟢 建议 | 8.3 | 降级内存 Map 增加 `setInterval` 每 5 分钟清理 >1 分钟未访问的 entry，防止服务长期运行内存膨胀 | 栖梧 | 2026-06-01 |
| C-3 | 🟢 建议 | 5.1 / 4.2 | `votes` 表新增 `creator_name VARCHAR(100)` 创建时快照写入；列表/详情 API 直接返回该字段，不再 JOIN users 表 | 栖梧 | 2026-06-01 |
| C-4 | 🟢 建议 | 4.2 / 5.1 | `total_voters` 来源说明：MVP 单团队部署从 SSO 上下文获取团队总人数（飞书通讯录 API 或环境变量 `TEAM_TOTAL_MEMBERS` 注入） | 栖梧 | 2026-06-01 |

---

## 一、方案概述

| 字段 | 内容 |
|------|------|
| 项目名称 | 团队即时投票工具 |
| 架构版本 | v1.1 |
| 设计人 | 栖梧 |
| 日期 | 2026-06-01 |
| 关联 PRD 版本 | v1.1 |

**架构核心决策**：单体 Node.js 后端（Express + Socket.IO），PostgreSQL 做持久化，Redis 做票数缓存/速率限制/自动结束定时器，前端 React SPA 嵌入飞书 WebView。MVP 阶段不引入微服务拆分，以 Docker Compose 单机部署，支持后续水平扩展。

---

## 二、技术选型

| 层次 | 技术 | 版本 | 选型理由 |
|------|------|------|----------|
| 前端框架 | React + TypeScript | 18.x / 5.x | 飞书生态 JS/TS 一致；组件化便于复用候选卡片、倒计时等模块；TypeScript 保障前后端类型契约对齐 |
| 前端构建 | Vite | 5.x | 开发冷启动 <1s，HMR 毫秒级；构建产物体积小 |
| UI 组件库 | 飞书官方 H5 组件库 (byted-ui-mobile) | latest | 飞书内嵌 WebView 样式一致性零成本；移动端触摸交互原生支持 |
| 图表库 | ECharts | 5.5.x | PRD 指定；横向柱状图 + 响应式缩放 + 轻量按需引入（仅 bar 模块） |
| HTTP 客户端 | Axios | 1.x | 拦截器统一处理飞书 SSO token 注入与 401 重定向 |
| 后端框架 | Express | 4.x + TypeScript | 轻量、成熟、团队熟悉；Socket.IO 集成成熟；中间件生态丰富 |
| WebSocket | Socket.IO | 4.x | 内置房间模式（`vote:{id}` 天然映射）、自动重连+指数退避、粘性会话适配器、降级长轮询 |
| ORM | Knex.js | 3.x | SQL builder 风格，DDL 直写无迁移黑盒；PG 原生 JSON/ARRAY 类型无阻抗 |
| 运行时 | Node.js | 20 LTS | 前后端同语言，降低上下文切换成本 |
| 数据库 | PostgreSQL | 15 | UUID 主键、ARRAY 列存多选 `selected_options`、强一致事务、JSONB 可扩展元数据字段 |
| 缓存 | Redis | 7.x | HINCRBY 原子计数、Sorted Set 速率限制滑动窗口、Keyspace Notification 实现自动结束定时器 |
| 容器 | Docker Compose | — | MVP 单机四容器（nginx / app / pg / redis），满足 ≤500 团队规模；后续平滑迁移 k8s |
| 反向代理 | Nginx | 1.25+ | 静态资源服务 + API 反向代理 + WebSocket Upgrade 代理 + 粘性会话（ip_hash） |

---

## 三、系统架构图与模块划分

### 3.1 系统分层架构图

架构图文件：`/home/eeimoo/.openclaw/agents/qiwu/workspace/arch-diagram.html`

```
┌──────────────────────────────────────────────────────────────────┐
│                     🖥️ 客户端层 (Client)                           │
│  ┌───────────────────────────────┐ ┌───────────────────────────┐  │
│  │  飞书桌面端 WebView           │ │  飞书移动端 WebView        │  │
│  │  React SPA + ECharts 5.x     │ │  (响应式, max-w 640px)     │  │
│  │  + Socket.IO Client          │ │  + Socket.IO Client        │  │
│  └───────────────────────────────┘ └───────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │  HTTPS (WSS)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    🌐 接入层 (Gateway)                             │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Nginx                                                       │  │
│  │  • 静态资源 `/assets/*` → dist/                              │  │
│  │  • API 反代 `/api/*` → app:3001                              │  │
│  │  • WS Upgrade `/ws/*` → app:3001  (ip_hash 粘性)             │  │
│  │  • gzip / brotli 压缩                                        │  │
│  │  • SSL 终止（443 → 内部 3001）                                │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ⚙️ 应用层 (Application)                         │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ │
│  │ Auth 中间件  │ │ Vote Router  │ │ WS Handler   │ │ Redis    │ │
│  │ (飞书SSO验签)│ │ POST/GET     │ │ Socket.IO 4  │ │ Adapter  │ │
│  │ JWT 签发    │ │ /api/votes/* │ │ join/leave   │ │ (粘性)   │ │
│  │ RBAC 校验   │ │ Knex Query   │ │ broadcast    │ │          │ │
│  └──────┬──────┘ └──────┬───────┘ └──────┬───────┘ └────┬─────┘ │
│         │               │                │              │       │
│  ┌──────┴───────────────┴────────────────┴──────────────┴─────┐ │
│  │              核心服务层 (Services)                           │ │
│  │  VoteService — 创建/查询/结束/列表                           │ │
│  │  BallotService — 提交投票/校验/防重/计数                      │ │
│  │  DeadlineWorker — Redis 过期监听 + 启动兜底扫描               │ │
│  │  RateLimiter — Redis 滑动窗口 + 降级内存兜底                 │ │
│  │  TallySync — Redis→PG 定期同步票数                          │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┬───┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
┌───────────────────────────┐  ┌───────────────────────────┐
│    🗄️ 数据层 (Data)        │  │  ⚡ 缓存层 (Cache)         │
│                           │  │                           │
│  PostgreSQL 15            │  │  Redis 7                   │
│  • votes                  │  │  • vote:{id}:tally (Hash)  │
│  • options                │  │  • vote:{id}:deadline     │
│  • user_votes             │  │    (String, TTL=deadline) │
│  • UNIQUE(vote_id,user_id)│  │  • rate:{user_id}:{vote_id}│
│                           │  │    (Sorted Set 滑动窗口)  │
│                           │  │  • health:degraded (标志)  │
└───────────────────────────┘  └───────────────────────────┘
```

### 3.2 模块清单

#### 后端模块（`src/` 目录结构）

| 模块路径 | 职责 | 依赖模块 |
|----------|------|----------|
| `src/middleware/auth.ts` | 飞书 SSO token 验签、提取 user_id/team_id/display_name、注入 `req.user` | 飞书 Open API |
| `src/middleware/rateLimiter.ts` | 每人每投票每分钟 3 次限制，Redis Sorted Set 实现 | Redis |
| `src/middleware/errorHandler.ts` | 统一错误中间件：catch → 归一化错误码 → JSON 响应 | — |
| `src/routes/votes.ts` | REST 路由：`POST /api/votes`、`GET /api/votes`、`GET /api/votes/:id`、`POST /api/votes/:id/vote`、`POST /api/votes/:id/close` | VoteService, BallotService |
| `src/services/voteService.ts` | 投票 CRUD：创建（事务写 PG + 初始化 Redis tally + 设 deadline TTL）、查询列表（分页+筛选）、详情（含 tally merged）、结束（PG 写 closed_at + WS 广播） | Knex, Redis |
| `src/services/ballotService.ts` | 投票提交：选项校验、防重检查（PG UNIQUE 兜底）、原子计数（HINCRBY）、写 user_votes 记录 | Knex, Redis |
| `src/services/deadlineWorker.ts` | 订阅 Redis `__keyevent@0__:expired`，收到 `vote:{id}:deadline` 过期事件后执行结束逻辑；启动时兜底扫描 PG 中到期未结束投票 | Redis, VoteService |
| `src/services/tallySync.ts` | 每 5 秒将 Redis tally 批量写回 PG（`UPDATE vote_tallies SET count = ...` 或直接汇总 user_votes），兜底对账 | Redis, Knex |
| `src/services/redisHealth.ts` | 每秒 PING Redis，连续 3 次失败触发降级标志；恢复后自动切换回 Redis | Redis |
| `src/ws/index.ts` | Socket.IO 初始化：auth 中间件（校验 token）、join `vote:{id}` room、事件处理 | — |
| `src/ws/handlers.ts` | WS 事件：`ballot:submitted`（接收→广播 `vote:{id}:update`）、`vote:{id}:closed`（主动推送）、`vote:{id}:reminder` | BallotService |
| `src/utils/feishu.ts` | 飞书 SSO token 验签：调飞书 `/open-apis/authen/v1/access_token` 或自签 JWT 验签 | — |
| `src/utils/idGenerator.ts` | UUID v7 生成（时间有序，便于索引） | — |
| `src/types/index.ts` | 共享类型定义：`Vote`, `Option`, `UserVote`, `ApiResponse<T>` | — |
| `src/db/knex.ts` | Knex 实例配置（PG 连接池 min=2 max=20） | — |
| `src/db/migrations/` | DDL 迁移脚本 | — |
| `src/config.ts` | 环境变量读取：`PORT`, `DATABASE_URL`, `REDIS_URL`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `TEAM_TOTAL_MEMBERS`, `REDIS_DEGRADE_THRESHOLD` 等 | — |

#### 前端模块（`client/src/` 目录结构）

| 组件/模块 | 职责 | 依赖 |
|-----------|------|------|
| `App.tsx` | 路由根：`/votes`(列表) `/votes/new`(创建) `/votes/:id`(详情) | React Router v6 |
| `pages/VoteList.tsx` | 投票列表页：筛选 Tab（active/closed）、分页加载、空状态、骨架屏 | `useVotes` hook |
| `pages/CreateVote.tsx` | 创建表单：标题/选项/类型/模式/截止时间、校验逻辑、提交 | `useCreateVote` hook |
| `pages/VoteDetail.tsx` | 详情页：根据 status 渲染 active/closed 视图、管理 WS 与用户状态 | `useVoteDetail` hook |
| `components/VoteCard.tsx` | 投票卡片：状态指示点、标题、标签行、进度条 | — |
| `components/OptionList.tsx` | 选项列表：单选/多选交互、已选高亮、锁定只读态 | — |
| `components/ResultChart.tsx` | ECharts 横向柱状图：票数/百分比、乐观更新、匿名/实名区分、响应式 | ECharts (bar) |
| `components/CountdownTimer.tsx` | 倒计时：≤60s 红色脉冲、≤10s 大号闪烁、归零回调 | — |
| `components/PrivacyBanner.tsx` | 匿名模式隐私声明蓝色提示条 | — |
| `components/ConfirmDialog.tsx` | 二次确认弹窗（结束投票等危险操作） | — |
| `components/NetworkBanner.tsx` | WS 断线黄色横幅提示 | — |
| `hooks/useSocket.ts` | Socket.IO 客户端封装：连接/断开/重连、`vote:{id}:update`/`vote:{id}:closed`/`vote:{id}:reminder` 事件监听 | socket.io-client |
| `hooks/useVotes.ts` | 投票列表数据：分页加载、状态筛选 | Axios |
| `hooks/useCreateVote.ts` | 创建投票：表单状态管理、校验、提交 | Axios |
| `hooks/useVoteDetail.ts` | 详情数据：初始加载、WS 增量更新、乐观更新回滚 | Axios, useSocket |
| `hooks/useOptimisticTally.ts` | 乐观更新：提交前本地 +1、失败回滚拉最新 | — |
| `services/api.ts` | Axios 实例：baseURL、拦截器注入 Authorization header、401→登录页 | — |
| `utils/validation.ts` | 前端校验：标题≤100、选项≤50、不重复、非空 | — |

---

## 四、API 契约（完整接口文档）

### 4.1 通用约定

```yaml
basePath: /api
authentication:
  method: Bearer Token (飞书 SSO)
  header: "Authorization: Bearer <feishu_session_token>"
response_format:
  success: { "code": 0, "data": <any> }
  error:   { "code": <number>, "message": "<string>", "detail?": "<string>" }
content_type: application/json
charset: utf-8
```

### 4.2 接口清单

#### 4.2.1 创建投票

```
POST /api/votes
```

**请求头**：
```
Authorization: Bearer <token>
Content-Type: application/json
```

**请求体**：
```json
{
  "title": "Sprint 24 团建去哪儿？",
  "options": ["杭州西湖", "苏州园林", "无锡太湖", "南京中山陵"],
  "vote_type": "single",
  "vote_mode": "anonymous",
  "deadline_minutes": 30
}
```

**字段约束**：
| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `title` | string | 是 | 1-100 字符，trim 后非空 |
| `options` | string[] | 是 | 长度 2-10，每项 1-50 字符，不可重复 |
| `vote_type` | enum | 是 | `"single"` \| `"multi"` |
| `vote_mode` | enum | 是 | `"anonymous"` \| `"public"` |
| `deadline_minutes` | number | 是 | 1-10080（1分钟~7天） |

**成功响应** (HTTP 201)：
```json
{
  "code": 0,
  "data": {
    "vote": {
      "id": "0192e8a1-7b3c-7000-8000-000000000001",
      "title": "Sprint 24 团建去哪儿？",
      "creator_id": "ou_abc123def456",
      "creator_name": "张三",
      "team_id": "2ed263bf32ae1655",
      "vote_type": "single",
      "vote_mode": "anonymous",
      "status": "active",
      "deadline": "2026-06-01T16:20:00.000Z",
      "total_voters": 24,
      "created_at": "2026-06-01T15:50:00.000Z",
      "closed_at": null,
      "closed_by": null,
      "options": [
        { "id": "0192e8a1-7b3c-8000-8000-000000000011", "content": "杭州西湖", "sort_order": 0 },
        { "id": "0192e8a1-7b3c-8000-8000-000000000012", "content": "苏州园林", "sort_order": 1 },
        { "id": "0192e8a1-7b3c-8000-8000-000000000013", "content": "无锡太湖", "sort_order": 2 },
        { "id": "0192e8a1-7b3c-8000-8000-000000000014", "content": "南京中山陵", "sort_order": 3 }
      ]
    }
  }
}
```

> **设计说明**：
> - `creator_name` 在创建投票时从 SSO token 提取 `display_name`，作为快照写入 `votes.creator_name`。后续即使发起者改名，历史投票显示的仍是创建时的名字。
> - `team_id` 从 SSO token 提取 `tenant_key`，用于 auth 中间件的团队级权限校验。
> - `total_voters` 来源：MVP 单团队部署下，从 SSO 上下文获取团队总人数。实现方式：优先调飞书通讯录 API 获取，降级为环境变量 `TEAM_TOTAL_MEMBERS` 注入。此值为创建时刻快照，仅作参与率参考，前端的参与率提示文案注明"创建时刻"。

**错误响应**：
```json
// 400 — 参数校验失败
{ "code": 40001, "message": "参数校验失败", "detail": "title 不能为空" }
{ "code": 40002, "message": "参数校验失败", "detail": "options 数量须在 2-10 之间" }
{ "code": 40003, "message": "参数校验失败", "detail": "选项不可重复" }
{ "code": 40004, "message": "参数校验失败", "detail": "deadline_minutes 须在 1-10080 之间" }

// 401 — 未认证
{ "code": 40100, "message": "未登录或登录已过期，请重新登录" }

// 500 — 服务端错误
{ "code": 50000, "message": "服务器内部错误" }
```

#### 4.2.2 投票列表

```
GET /api/votes?status=active&page=1&size=20
```

**查询参数**：
| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `status` | enum | 否 | `"active"` | `"active"` \| `"closed"` |
| `page` | number | 否 | 1 | ≥1 |
| `size` | number | 否 | 20 | 1-100 |

**成功响应** (HTTP 200)：
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": "0192e8a1-7b3c-7000-8000-000000000001",
        "title": "Sprint 24 团建去哪儿？",
        "creator_id": "ou_abc123def456",
        "creator_name": "张三",
        "team_id": "2ed263bf32ae1655",
        "vote_type": "single",
        "vote_mode": "anonymous",
        "status": "active",
        "deadline": "2026-06-01T16:20:00.000Z",
        "total_voters": 24,
        "vote_count": 8,
        "created_at": "2026-06-01T15:50:00.000Z"
      }
    ],
    "total": 15,
    "page": 1,
    "size": 20
  }
}
```

> **设计说明**：`creator_name` 直接从 `votes` 表读取快照值，不再 JOIN users 表。`user_id` 在飞书体系内不直接对应可读姓名，快照方案避免依赖外部用户服务。

#### 4.2.3 投票详情

```
GET /api/votes/:id
```

**成功响应** (HTTP 200)：
```json
{
  "code": 0,
  "data": {
    "vote": {
      "id": "0192e8a1-7b3c-7000-8000-000000000001",
      "title": "Sprint 24 团建去哪儿？",
      "creator_id": "ou_abc123def456",
      "creator_name": "张三",
      "team_id": "2ed263bf32ae1655",
      "vote_type": "single",
      "vote_mode": "anonymous",
      "status": "active",
      "deadline": "2026-06-01T16:20:00.000Z",
      "total_voters": 24,
      "created_at": "2026-06-01T15:50:00.000Z",
      "closed_at": null,
      "closed_by": null,
      "options": [
        {
          "id": "0192e8a1-7b3c-8000-8000-000000000011",
          "content": "杭州西湖",
          "sort_order": 0,
          "count": 5,
          "voters": []
        },
        {
          "id": "0192e8a1-7b3c-8000-8000-000000000012",
          "content": "苏州园林",
          "sort_order": 1,
          "count": 2,
          "voters": []
        },
        {
          "id": "0192e8a1-7b3c-8000-8000-000000000013",
          "content": "无锡太湖",
          "sort_order": 2,
          "count": 1,
          "voters": []
        },
        {
          "id": "0192e8a1-7b3c-8000-8000-000000000014",
          "content": "南京中山陵",
          "sort_order": 3,
          "count": 0,
          "voters": []
        }
      ]
    },
    "has_voted": false,
    "my_selected_options": []
  }
}
```

**`voters` 字段规则**（关键安全约束）：
- `vote_mode=anonymous` 且 `status=active`：`voters` 始终为 `[]`（空数组），不可泄露投票人身份
- `vote_mode=anonymous` 且 `status=closed`：`voters` 为 `[]`（仍不暴露）
- `vote_mode=public` 且请求者是发起者：`voters` 包含 `[{ "user_id": "...", "user_name": "..." }]`
- `vote_mode=public` 且请求者是普通参与者：`voters` 包含（公开投票信息透明）
- **后端须在 VoteService 层做字段级过滤，不可依赖前端隐藏**

**私有字段 `my_selected_options`**：仅当前用户可见，返回自己选的选项 ID 列表；未投票时为空数组。

**错误响应**：
```json
// 404
{ "code": 40400, "message": "投票不存在" }
```

#### 4.2.4 提交投票

```
POST /api/votes/:id/vote
```

**请求体**：
```json
{
  "option_ids": ["0192e8a1-7b3c-8000-8000-000000000011"]
}
```

**字段约束**：
| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `option_ids` | string[] | 是 | 长度 ≥1；单选时长度 =1；所有 ID 须属于该 vote_id；不可重复 |

**成功响应** (HTTP 200)：
```json
{
  "code": 0,
  "data": {
    "vote_id": "0192e8a1-7b3c-7000-8000-000000000001",
    "selected_options": ["0192e8a1-7b3c-8000-8000-000000000011"],
    "submitted_at": "2026-06-01T15:51:30.000Z"
  }
}
```

**错误响应**：
```json
// 400 — 参数校验
{ "code": 40001, "message": "参数校验失败", "detail": "option_ids 不能为空" }
{ "code": 40005, "message": "参数校验失败", "detail": "option_ids 中有不属于本投票的选项" }

// 403 — 投票已结束
{ "code": 40301, "message": "投票已结束，无法提交" }

// 409 — 重复投票
{ "code": 40901, "message": "您已投过票，不可重复提交" }

// 429 — 速率限制
{ "code": 42900, "message": "提交过于频繁，请稍后再试" }
// 响应头: Retry-After: 45 (秒)
```

#### 4.2.5 结束投票

```
POST /api/votes/:id/close
```

**请求体**：无

**权限**：仅 `vote.creator_id === req.user.user_id`

**成功响应** (HTTP 200)：
```json
{
  "code": 0,
  "data": {
    "vote_id": "0192e8a1-7b3c-7000-8000-000000000001",
    "status": "closed",
    "closed_by": "manual",
    "closed_at": "2026-06-01T15:55:00.000Z"
  }
}
```

**错误响应**：
```json
// 403 — 非发起者
{ "code": 40302, "message": "仅投票发起者可结束投票" }

// 409 — 已结束
{ "code": 40902, "message": "投票已结束" }
```

### 4.3 错误码规范总表

| 错误码 | HTTP 状态码 | 含义 | 处理建议 |
|--------|------------|------|----------|
| `0` | 200/201 | 成功 | — |
| `40001` | 400 | 通用参数校验失败 | 查看 `detail` 修正参数 |
| `40002` | 400 | options 数量越界 | 调整选项数至 2-10 |
| `40003` | 400 | 选项值重复 | 去除重复选项 |
| `40004` | 400 | deadline_minutes 越界 | 调整至 1-10080 |
| `40005` | 400 | option_ids 不属于本投票 | 检查选项归属 |
| `40100` | 401 | 未认证 / token 过期 | 重新飞书登录 |
| `40301` | 403 | 投票已结束 | 提示用户投票结束 |
| `40302` | 403 | 无操作权限 | 提示仅发起者可操作 |
| `40400` | 404 | 资源不存在 | 跳转 404 页 |
| `40901` | 409 | 重复投票冲突 | toast「您已投过票」；乐观更新回滚 |
| `40902` | 409 | 投票已结束冲突 | toast「投票已结束」；页面切换状态 |
| `42900` | 429 | 速率限制 | `Retry-After` 秒后重试 |
| `50000` | 500 | 服务器内部错误 | 通用错误提示 + 日志告警 |

---

## 五、数据模型（可直接给凌霜实现）

### 5.1 PostgreSQL DDL

```sql
-- ============================================================
-- 扩展：UUID v7 生成函数（时间有序，利于 B-tree 索引）
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE
  v_time timestamp with time zone := clock_timestamp();
  v_secs bigint := floor(extract(epoch from v_time) * 1000);
  v_usec bigint := extract(microseconds from v_time)::bigint % 1000;
  v_rand1 bigint := (floor(random() * 65536))::bigint;
  v_rand2 bigint := (floor(random() * 4294967296))::bigint;
BEGIN
  RETURN encode(set_byte(
      set_byte(
        lpad(to_hex((v_secs * 1000 + v_usec)::bigint), 12, '0')::bytea
        || lpad(to_hex(v_rand1), 4, '0')::bytea
        || lpad(to_hex(v_rand2), 8, '0')::bytea,
        6, (get_byte(decode(lpad(to_hex(v_rand1), 4, '0'), 'hex'), 0) & 15) | 112
      ),
      8, (get_byte(decode(lpad(to_hex(v_rand2), 8, '0'), 'hex'), 0) & 63) | 128
    ), 'hex')::uuid;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 表定义
-- ============================================================

-- 1. votes 表：投票主表
CREATE TABLE votes (
    id            UUID PRIMARY KEY DEFAULT uuid_v7(),
    title         VARCHAR(100) NOT NULL,
    creator_id    VARCHAR(64) NOT NULL,              -- 飞书 user_id（如 ou_abc123def456），非 UUID
    creator_name  VARCHAR(100) NOT NULL,             -- 创建者姓名快照（创建时从 SSO 提取）
    team_id       VARCHAR(64) NOT NULL,              -- 飞书 tenant_key，团队标识
    vote_type     VARCHAR(10) NOT NULL CHECK (vote_type IN ('single', 'multi')),
    vote_mode     VARCHAR(10) NOT NULL CHECK (vote_mode IN ('anonymous', 'public')),
    status        VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    deadline      TIMESTAMPTZ NOT NULL,
    total_voters  INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    closed_by     VARCHAR(10) CHECK (closed_by IN ('manual', 'auto'))
);

COMMENT ON TABLE votes IS '投票主表';
COMMENT ON COLUMN votes.creator_id IS '飞书 user_id 原始值，非 UUID';
COMMENT ON COLUMN votes.creator_name IS '创建者姓名快照，后续改名不影响历史投票';
COMMENT ON COLUMN votes.team_id IS '飞书 tenant_key，用于团队级权限校验';
COMMENT ON COLUMN votes.total_voters IS '创建时刻的团队总人数快照';
COMMENT ON COLUMN votes.closed_by IS 'manual=手动结束, auto=自动到期';

-- 按 team + 状态 + 创建时间查询（列表页高频查询，跨团队部署安全）
CREATE INDEX idx_votes_team_status ON votes (team_id, status, created_at DESC);

-- 启动扫描：查找到期未结束投票
CREATE INDEX idx_votes_active_deadline ON votes (deadline) WHERE status = 'active';


-- 2. options 表：投票选项
CREATE TABLE options (
    id         UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id    UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    content    VARCHAR(50) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_options_vote_id ON options (vote_id, sort_order);


-- 3. user_votes 表：投票记录（防重核心）
CREATE TABLE user_votes (
    id               UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id          UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    user_id          VARCHAR(64) NOT NULL,           -- 飞书 user_id (如 ou_xxx)
    selected_options UUID[] NOT NULL,                 -- PostgreSQL 原生数组
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_votes_vote_user UNIQUE (vote_id, user_id)
);

COMMENT ON TABLE user_votes IS '用户投票记录';
COMMENT ON COLUMN user_votes.selected_options IS '用户选中的选项 ID 数组，单选时长度为1';

CREATE INDEX idx_user_votes_vote_id ON user_votes (vote_id);

-- user_votes + options JOIN 可汇总出最终票数（与 Redis 对账用）
-- SELECT o.id, COUNT(uv.id) as cnt
-- FROM options o
-- LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
-- WHERE o.vote_id = $1
-- GROUP BY o.id;
```

> **设计说明**：
> - **A-1 修正**：`creator_id` / `user_id` 均使用 `VARCHAR(64)` 存储飞书 `user_id`（如 `ou_abc123def456`），不使用 UUID。飞书 user_id 是飞书统一身份标识的原始值，直接存储避免映射层。
> - **A-2 新增**：`team_id VARCHAR(64)` 存储飞书 `tenant_key`，与 `idx_votes_team_status` 联合索引保证按团队 + 状态查询的性能。auth 中间件注入 `req.user.team_id`，列表查询与关闭权限均做 team 级校验。
> - **C-3 新增**：`creator_name VARCHAR(100)` 在投票创建时从 SSO token 提取 `display_name` 写入，后续即使发起者改名也不影响历史投票显示。列表/详情 API 直接返回该字段，不再 JOIN 外部用户表。
> - `selected_options` 使用 PG 原生 `UUID[]` 数组类型，多选直接存于一条记录，无需建关联表。
> - `UNIQUE(vote_id, user_id)` 是防重投票的数据库最后防线（配合应用层 Redis 计数原子性，双重保障）。
> - **C-4**：`total_voters` 创建时取值来源：调用飞书通讯录 API 获取团队总人数，降级为环境变量 `TEAM_TOTAL_MEMBERS` 写入。单团队部署下可写死，多团队部署从 SSO 上下文获取。

### 5.2 Redis 数据结构

#### 5.2.1 票数计数器

```
键：vote:{vote_id}:tally
类型：Hash
内容：
  field = option_id (UUID 字符串)
  value = 当前票数 (INT)

命令示例：
  # 初始化（创建投票时）
  HSET vote:0192...0001:tally "0192...0011" 0 "0192...0012" 0 "0192...0013" 0 "0192...0014" 0

  # 投票（原子递增，BallotService）
  HINCRBY vote:0192...0001:tally "0192...0011" 1
  HINCRBY vote:0192...0001:tally "0192...0012" 1   # 多选时对每个选项分别 INCR

  # 查询（VoteService.getDetail）
  HGETALL vote:0192...0001:tally
  → {"0192...0011": "5", "0192...0012": "2", "0192...0013": "1", "0192...0014": "0"}

TTL：不设（与投票同生命周期，手动结束或自动结束时显式删除）
```

#### 5.2.2 自动结束定时器

```
键：vote:{vote_id}:deadline
类型：String
值：deadline ISO 时间戳
TTL：deadline - now (秒)

命令示例：
  # 创建投票时设置
  SET vote:0192...0001:deadline "2026-06-01T16:20:00.000Z" EX 1800

  # 手动结束时立即删除，防止重复触发
  DEL vote:0192...0001:deadline

  # 服务重启兜底扫描 (SQL)
  # SELECT id FROM votes WHERE status='active' AND deadline < NOW();
```

**Redis 配置要求**：
```
notify-keyspace-events Ex
```
`E` = 启用键过期事件，`x` = 过期事件推送至 `__keyevent@<db>__:expired` 通道。

#### 5.2.3 速率限制滑动窗口

```
键：rate:{user_id}:{vote_id}
类型：Sorted Set
member：提交时间戳（毫秒）
score：提交时间戳（毫秒）

命令示例：
  # 检查 + 记录（Lua 脚本原子执行，见 8.3）
  # 1. ZREMRANGEBYSCORE 清理窗口外记录 (now - 60000)
  # 2. ZCARD 统计窗口内计数
  # 3. 若 < 3 → ZADD 并返回 OK；≥ 3 → 返回拒绝

  EVAL <lua_script> 1 rate:ou_abc:0192...0001 <now_ms>

TTL：自动清理，或设 EXPIRE 61 秒（窗口 60s + 缓冲）
```

#### 5.2.4 Redis 降级标志

```
键：health:degraded
类型：String
值："1" | (none)

操作：
  # 降级激活
  SET health:degraded "1" EX 10  # 10 秒 TTL，持续 PING 失败会续期

  # 恢复
  DEL health:degraded
```

---

## 六、投票状态机详细设计

### 6.1 状态定义

| 状态 | 枚举值 | 触发条件 | 允许操作 |
|------|--------|----------|----------|
| 进行中 | `active` | 创建投票成功 | 用户提交投票、查看实时结果、发起者手动结束 |
| 已结束 | `closed` | 手动关闭 / 倒计时归零 | 仅查看最终结果 |

> MVP 无「草稿」状态——创建即发布，简化状态数。

### 6.2 状态流转图

```
                    POST /api/votes (创建)
                    │
                    ▼
              ┌───────────┐
              │  active   │ ←──────── 当前状态
              │  进行中    │
              └─────┬─────┘
                    │
          ┌─────────┴─────────┐
          │                   │
    POST /close          Redis TTL 过期
    (手动结束)            (自动结束)
          │                   │
          │  closed_by=manual │  closed_by=auto
          ▼                   ▼
      ┌──────────────────────────┐
      │        closed            │  ← 终态
      │        已结束             │
      └──────────────────────────┘
```

### 6.3 核心状态转换的原子操作方案

#### 6.3.1 提交投票（`POST /votes/:id/vote`）

这是最复杂的并发操作。方案：

```
BallotService.submitVote(voteId, userId, optionIds)

前置检查（非原子）：
1. SELECT status FROM votes WHERE id = $1  → 若 'closed' → 返回 403
2. SELECT 1 FROM user_votes WHERE vote_id=$1 AND user_id=$2  → 若存在 → 返回 409

原子写入（PG 事务）：
BEGIN;
  -- 乐观锁：再次检查 vote 状态（防止在前置检查和事务之间被结束）
  SELECT status FROM votes WHERE id = $1 FOR UPDATE;
  IF status = 'closed' THEN ROLLBACK; RETURN 403; END IF;

  -- 插入防重记录（UNIQUE 约束兜底）
  INSERT INTO user_votes (vote_id, user_id, selected_options)
  VALUES ($1, $2, $3);
  -- 若违反 UNIQUE(vote_id, user_id) → ROLLBACK; RETURN 409;

COMMIT;

后置异步（事务成功后）：
-- Redis 原子递增（HINCRBY 天然线程安全）
FOREACH option_id IN option_ids:
  HINCRBY vote:{voteId}:tally {option_id} 1

-- WS 广播（非阻塞，fire-and-forget）
io.to("vote:{voteId}").emit("vote:{voteId}:update", {
  option_id: option_id,
  new_count: newCount,    -- HINCRBY 返回值
  total_votes: totalCount -- HLEN 或 SCARD
})
```

**关键设计决策**：
- PG 事务是核心防线（确保 `selected_options` 落盘），Redis 计数是「尽力而为」的缓存层
- 顺序：先 PG 事务成功 → 再 Redis INCR → 再 WS 广播。若 Redis 不可用，降级标志激活，跳过 Redis INCR，后续 TallySync 从 PG 重建
- `FOR UPDATE` 行锁防止 TOCTOU 竞态（前置检查和事务写入之间的状态变更）

#### 6.3.2 手动结束投票（`POST /votes/:id/close`）

```
VoteService.closeVote(voteId, userId)

BEGIN;
  -- 获取当前状态 + 校验权限（含 team 校验）
  SELECT id, status, creator_id, team_id FROM votes WHERE id = $1 FOR UPDATE;

  IF NOT FOUND → ROLLBACK; RETURN 404;
  IF status = 'closed' → ROLLBACK; RETURN 409;
  IF creator_id != userId → ROLLBACK; RETURN 403;
  IF team_id != req.user.team_id → ROLLBACK; RETURN 403;

  -- 原子更新状态
  UPDATE votes SET status='closed', closed_at=now(), closed_by='manual' WHERE id=$1;

COMMIT;

-- 后置操作（事务外）：
1. DEL vote:{voteId}:deadline   -- 删除定时器 key，防止到期重复触发
2. io.to("vote:{voteId}").emit("vote:{voteId}:closed", {
     closed_by: "manual",
     closed_at: now.toISOString()
   })
3. logger.info({voteId, userId, action: "close_manual"})
```

#### 6.3.3 自动结束投票（DeadlineWorker）

```
DeadlineWorker 事件处理流程：

// 线程 A：Redis 过期事件监听
redisClient.on('message', (channel, message) => {
  // channel = "__keyevent@0__:expired"
  // message = "vote:{voteId}:deadline"
  const voteId = extractVoteId(message);

  // 幂等检查：从 PG 读取当前状态
  const vote = await db.select('status').from('votes').where({id: voteId}).first();
  if (!vote || vote.status === 'closed') return;  // 已结束（可能被手动结束抢先）

  // 执行结束逻辑
  await closeVoteAutomatically(voteId);
});

async function closeVoteAutomatically(voteId) {
  await db('votes')
    .where({ id: voteId, status: 'active' })
    .update({ status: 'closed', closed_at: db.fn.now(), closed_by: 'auto' });

  // 仅当 UPDATE 影响行数 > 0 时广播（防止并发重复）
  if (updatedRows > 0) {
    io.to(`vote:${voteId}`).emit(`vote:${voteId}:closed`, {
      closed_by: "auto",
      closed_at: new Date().toISOString()
    });
    logger.info({voteId, action: "close_auto"});
  }
}

// 线程 B：服务启动兜底扫描
async function startupRecoveryScan() {
  const expiredVotes = await db('votes')
    .select('id')
    .where({ status: 'active' })
    .where('deadline', '<', db.fn.now());

  for (const vote of expiredVotes) {
    await closeVoteAutomatically(vote.id);
  }
  logger.info({count: expiredVotes.length, action: "startup_recovery"});
}
```

### 6.4 状态机边界情况一览（供寻错参考）

| 场景 | 预期行为 | 实现保障 |
|------|----------|----------|
| 用户提交投票时，投票恰好被手动结束 | 返回 403，本地数据不变 | `FOR UPDATE` + 事务内状态再检查 |
| 用户提交投票时，投票恰好被自动结束 | 返回 403 | 同上 |
| 手动结束与自动结束并发 | 先执行者胜，后者 `WHERE status='active'` 无匹配行，静默跳过 | 条件 UPDATE + 影响行数检查 |
| 进程崩溃重启后定时器丢失 | 启动兜底扫描 `deadline < NOW()` 批量结束 | `startupRecoveryScan()` |
| 同一用户并发提交 2 次投票 | 第一次成功写 PG，第二次触发 UNIQUE 约束 → 409 | PG UNIQUE 约束兜底 |
| Redis 不可用时提交投票 | PG 事务正常写入，Redis HINCRBY 跳过；TallySync 定期从 PG 重建 Redis | 降级标志 + 定期对账 |
| 投票结束后用户重新进入页面 | API 返回 status=closed，前端渲染最终结果 | 状态驱动 UI |

---

## 七、WebSocket 协议（完整定义）

### 7.1 连接建立

```javascript
// 客户端
const socket = io('wss://<domain>/ws', {
  path: '/ws',
  auth: {
    token: '<feishu_session_token>'  // Socket.IO auth 中间件验签
  },
  transports: ['websocket'],          // MVP 仅 WebSocket，不支持长轮询降级
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,            // 初始 1s
  reconnectionDelayMax: 30000,        // 最大 30s（指数退避上限）
  timeout: 10000
});
```

### 7.2 房间管理

| 事件 | 方向 | 触发时机 | Payload |
|------|------|----------|---------|
| `join:vote` | 客户端 → 服务端 | 用户进入投票详情页 | `{ vote_id: "0192..." }` |
| `leave:vote` | 客户端 → 服务端 | 用户离开投票详情页 | `{ vote_id: "0192..." }` |

服务端处理：
```typescript
socket.on('join:vote', ({ vote_id }) => {
  // 权限校验：用户是否属于本团队（可通过 socket.data.team_id 判断）
  socket.join(`vote:${vote_id}`);
  // 可选：记录用户在线状态，供「已投/在线人数」展示
});

socket.on('leave:vote', ({ vote_id }) => {
  socket.leave(`vote:${vote_id}`);
});
```

### 7.3 服务端 → 客户端事件

#### 事件 1：投票更新

```
事件名：vote:{vote_id}:update
方向：服务端 → 客户端（房间广播，不含发送者）
触发：任一用户提交投票成功
```

```json
{
  "option_id": "0192e8a1-7b3c-8000-8000-000000000011",
  "new_count": 6,
  "total_votes": 9
}
```

**广播范围**：`io.to("vote:{vote_id}").except(socket.id).emit(...)` — 排除发送者（发送者本端已乐观更新）

#### 事件 2：投票已结束

```
事件名：vote:{vote_id}:closed
方向：服务端 → 客户端（房间全量广播）
触发：手动结束 / 自动到期
```

```json
{
  "closed_by": "manual",
  "closed_at": "2026-06-01T15:55:00.000Z"
}
```

#### 事件 3：截止提醒

```
事件名：vote:{vote_id}:reminder
方向：服务端 → 客户端（房间全量广播）
触发：距 deadline 剩余 60 秒时
```

```json
{
  "remaining_seconds": 60
}
```

**实现**：
- 创建投票时，向 BullMQ 延迟队列投递一个 `sendReminder` 任务（`delay = (deadline - 60s) - now`）
- 备选：Redis 另一个带 TTL 的 key（`deadline - 60s`），过期时触发提醒
- MVP 若 BullMQ 未引入：可用 `setTimeout`（内存方案），服务重启后丢失的提醒是可接受的（提醒为锦上添花功能）

### 7.4 客户端端 → 服务端（MVP 无）

> MVP 阶段由 REST API 承载写操作，不通过 WS 提交投票。这降低了 WS 消息去重与事务一致性的复杂度。

### 7.5 客户端事件处理伪码（供流光参考）

```typescript
// hooks/useSocket.ts
function useSocket(voteId: string) {
  const socket = useRef<Socket>();
  const [tallyUpdates, setTallyUpdates] = useState<Map<string, number>>();
  const [isClosed, setIsClosed] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const chartRef = useRef<EChartsInstance>();

  useEffect(() => {
    socket.current = io('/ws', { auth: { token: getToken() } });

    socket.current.on('connect', () => {
      socket.current.emit('join:vote', { vote_id: voteId });
      setIsDisconnected(false);
    });

    socket.current.on('disconnect', () => setIsDisconnected(true));

    socket.current.on(`vote:${voteId}:update`, (payload) => {
      // 增量更新图表：找到对应 option_id 的柱，new_count 替换旧值
      setTallyUpdates(prev => new Map(prev).set(payload.option_id, payload.new_count));
    });

    socket.current.on(`vote:${voteId}:closed`, () => {
      setIsClosed(true);
      // 触发全量数据重新拉取
      refetchVoteDetail();
    });

    socket.current.on(`vote:${voteId}:reminder`, ({ remaining_seconds }) => {
      // 触发倒计时组件高亮（红色脉冲）
      setReminderTrigger(true);
    });

    return () => {
      socket.current?.emit('leave:vote', { vote_id: voteId });
      socket.current?.disconnect();
    };
  }, [voteId]);

  return { tallyUpdates, isClosed, isDisconnected };
}
```

---

## 八、防刷机制实现方案

### 8.1 多层防线架构

```
┌─────────────────────────────────────────────────┐
│                  请求进入                         │
└────────────────────┬────────────────────────────┘
                     ▼
      ┌───────────────────────────┐
      │  L1: 认证层                │  无 token → 401
      │  JWT/飞书 SSO 验签         │  验签失败 → 401
      └────────────┬──────────────┘
                   ▼
      ┌───────────────────────────┐
      │  L2: 速率限制层            │  同一人同一投票 >3次/分钟 → 429
      │  Redis Sorted Set 滑动窗口 │  Redis 不可用 → 降级内存 Map
      └────────────┬──────────────┘
                   ▼
      ┌───────────────────────────┐
      │  L3: 业务校验层            │  status=closed → 403
      │  vote 状态 + 选项归属校验   │  option_ids 无效 → 400
      └────────────┬──────────────┘
                   ▼
      ┌───────────────────────────┐
      │  L4: 数据库防重层          │  UNIQUE(vote_id, user_id)
      │  PG UNIQUE 约束 + FOR UPDATE│  重复插入 → 409
      └───────────────────────────┘
```

### 8.2 L1：认证中间件

```typescript
// src/middleware/auth.ts
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ code: 40100, message: '未登录' });
  }

  try {
    // 飞书 SSO token 验签
    const user = await verifyFeishuToken(token);
    req.user = {
      user_id: user.open_id,       // 如 ou_abc123def456
      team_id: user.tenant_key,    // 如 2ed263bf32ae1655
      name: user.name,             // 如 "张三"
    };
    next();
  } catch (err) {
    return res.status(401).json({ code: 40100, message: '登录已过期' });
  }
}
```

### 8.3 L2：速率限制（Redis 滑动窗口）

> **C-1 修正**：Lua 脚本调整为先 `ZREMRANGEBYSCORE` 清理过期记录 → 再 `ZCARD` 判断，消除先 ZADD 后 ZCARD 的 +1 窗口误差。

```typescript
// src/middleware/rateLimiter.ts
import Redis from 'ioredis';

const RATE_LIMIT_WINDOW = 60_000;         // 60 秒窗口
const RATE_LIMIT_MAX = 3;                 // 最多 3 次
const DEGRADE_MAP = new Map<string, number[]>(); // 降级内存兜底

// Lua 脚本：原子清理 + 检查 + 记录
// 修正：先清理过期，再计数，消除 ZADD 后 ZCARD 的 +1 误差
const RATE_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local max_requests = tonumber(ARGV[3])
  local window_start = now - window

  -- 1. 先清理窗口外的过期记录（关键：在计数前清理）
  redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

  -- 2. 计数当前窗口内的记录
  local current = redis.call('ZCARD', key)

  -- 3. 判断是否超限
  if current >= max_requests then
    -- 返回最早记录的时间戳用于计算 Retry-After
    local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return earliest
  end

  -- 4. 未超限：记录本次请求
  redis.call('ZADD', key, now, now)
  redis.call('EXPIRE', key, 65)
  return 0  -- OK
`;

export function createRateLimiter(redis: Redis) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 仅限制 POST /api/votes/:id/vote
    if (!req.path.match(/^\/api\/votes\/[^/]+\/vote$/) || req.method !== 'POST') {
      return next();
    }

    const userId = req.user!.user_id;
    const voteId = req.params.id;
    const key = `rate:${userId}:${voteId}`;

    let result: number | [string, string];

    // 检查 Redis 降级标志
    const degraded = await redis.get('health:degraded');
    if (degraded === '1') {
      result = degradeCheck(userId, voteId);
    } else {
      try {
        result = await redis.eval(
          RATE_LIMIT_SCRIPT, 1, key,
          Date.now().toString(),
          RATE_LIMIT_WINDOW.toString(),
          RATE_LIMIT_MAX.toString()
        ) as number | [string, string];
      } catch {
        // Redis 异常 → 降级内存
        setDegraded(redis);
        result = degradeCheck(userId, voteId);
      }
    }

    if (result !== 0) {
      const retryAfter = result instanceof Array
        ? Math.ceil((parseInt(result[1]) + RATE_LIMIT_WINDOW - Date.now()) / 1000)
        : 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ code: 42900, message: '提交过于频繁，请稍后再试' });
    }

    next();
  };
}

function degradeCheck(userId: string, voteId: string): 0 | [string, string] {
  const key = `${userId}:${voteId}`;
  const now = Date.now();
  const records = DEGRADE_MAP.get(key) || [];
  const valid = records.filter(t => now - t < RATE_LIMIT_WINDOW);

  if (valid.length >= RATE_LIMIT_MAX) {
    return [valid[0].toString(), valid[0].toString()]; // 非 0 = 拒绝
  }

  valid.push(now);
  DEGRADE_MAP.set(key, valid);
  return 0; // OK
}

// C-2: 降级内存 Map 定期清理（每 5 分钟清理 >1 分钟未访问的 entry）
// 防止服务运行 30 天后 deactivated 用户 map 无限膨胀
const DEGRADE_CLEANUP_INTERVAL = 5 * 60_000;    // 5 分钟
const DEGRADE_ENTRY_MAX_AGE = 60_000;            // 1 分钟

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of DEGRADE_MAP) {
    // 保留最近 1 分钟内有记录或有活跃窗口记录的 entry
    const recent = timestamps.filter(t => now - t < DEGRADE_ENTRY_MAX_AGE);
    if (recent.length === 0) {
      DEGRADE_MAP.delete(key);
    } else {
      DEGRADE_MAP.set(key, recent);
    }
  }
  if (DEGRADE_MAP.size > 0) {
    logger.info({ action: 'degrade_map_cleanup', remaining_entries: DEGRADE_MAP.size });
  }
}, DEGRADE_CLEANUP_INTERVAL);
```

### 8.4 L4：数据库防重

已在 5.1 DDL 中定义 `CONSTRAINT uq_user_votes_vote_user UNIQUE (vote_id, user_id)`。

后端 BallotService 不依赖应用层检查防重（尽管有前置 SELECT），以 PG UNIQUE 约束为唯一真相源：

```typescript
// src/services/ballotService.ts (伪码)
async function submitVote(voteId: string, userId: string, optionIds: string[]) {
  const trx = await db.transaction();

  try {
    // 1. 锁定 vote 行
    const vote = await trx('votes').select('status').where({ id: voteId }).forUpdate().first();
    if (!vote) throw new AppError(40400, '投票不存在');
    if (vote.status === 'closed') throw new AppError(40301, '投票已结束');

    // 2. 插入（UNIQUE 约束是最终防线）
    await trx('user_votes').insert({
      vote_id: voteId,
      user_id: userId,
      selected_options: optionIds,
    });
    // PG 错误码 23505 = unique_violation → 捕获后转业务错误

    await trx.commit();
  } catch (err) {
    await trx.rollback();
    if (err.code === '23505') {  // PostgreSQL unique_violation
      throw new AppError(40901, '您已投过票');
    }
    throw err;
  }

  // 3. 事务成功后 → Redis 计数 + WS 广播（非关键路径，外放）
  await incrementTally(voteId, optionIds);
  await broadcastUpdate(voteId, optionIds);
}
```

---

## 九、部署架构（可直接给长夜实施）

### 9.1 Docker Compose 配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  # ========== Nginx 反向代理 ==========
  nginx:
    image: nginx:1.25-alpine
    container_name: vote-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./client/dist:/usr/share/nginx/html:ro      # 前端构建产物（见下方说明）
      - ./certs:/etc/nginx/certs:ro                  # SSL 证书目录
    depends_on:
      - app
    restart: unless-stopped
    networks:
      - vote-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ========== Node.js 应用 ==========
  app:
    build:
      context: ./server
      dockerfile: Dockerfile
    container_name: vote-app
    expose:
      - "3001"
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgresql://vote_user:${PG_PASSWORD}@pg:5432/vote_db
      REDIS_URL: redis://redis:6379/0
      FEISHU_APP_ID: ${FEISHU_APP_ID}
      FEISHU_APP_SECRET: ${FEISHU_APP_SECRET}
      TEAM_TOTAL_MEMBERS: ${TEAM_TOTAL_MEMBERS}    # total_voters 降级值
      REDIS_DEGRADE_THRESHOLD: 3                   # 连续失败 3 次触发降级
    depends_on:
      pg:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - vote-net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode===200?0:1))"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ========== PostgreSQL ==========
  pg:
    image: postgres:15-alpine
    container_name: vote-pg
    environment:
      POSTGRES_DB: vote_db
      POSTGRES_USER: vote_user
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./server/src/db/migrations:/docker-entrypoint-initdb.d:ro  # 首次启动自动执行 DDL
    ports:
      - "127.0.0.1:5432:5432"  # 仅本地调试，生产通过 Docker 网络
    restart: unless-stopped
    networks:
      - vote-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vote_user -d vote_db"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ========== Redis ==========
  redis:
    image: redis:7-alpine
    container_name: vote-redis
    command:
      - redis-server
      - --notify-keyspace-events Ex    # ← 必须！Keyspace Notification for deadline
      - --appendonly yes               # AOF 持久化，重启恢复
      - --maxmemory 256mb
      - --maxmemory-policy volatile-lru  # B-4: 仅淘汰带 TTL 的 key，tally(无TTL)永不过期
    volumes:
      - redis_data:/data
    ports:
      - "127.0.0.1:6379:6379"
    restart: unless-stopped
    networks:
      - vote-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pg_data:
  redis_data:

networks:
  vote-net:
    driver: bridge
```

> **A-3 补充说明 — 前端构建产物流入路径**：
> ```
> 开发阶段                    CI/CD 阶段                      部署阶段
> ┌──────────┐    git push    ┌──────────────┐   docker cp    ┌──────────────┐
> │ client/  │ ──────────────→│ CI Runner    │ ──────────────→│ 宿主机        │
> │ src/     │                │ npm ci       │                │ ./client/dist/│
> │          │                │ npm run build│                │ (静态文件目录) │
> └──────────┘                │ → dist/ 产出 │                └──────┬───────┘
>                             └──────────────┘                       │
>                                                         volume mount (ro)
>                                                               │
>                                                               ▼
>                                                    ┌──────────────────┐
>                                                    │ Nginx 容器        │
>                                                    │ /usr/share/nginx/ │
>                                                    │   html/           │
>                                                    └──────────────────┘
> ```
> 1. 开发者在 `client/` 目录开发前端代码
> 2. CI/CD 流水线执行 `cd client && npm install && npm run build`，产出 `client/dist/` 静态文件
> 3. 部署脚本将 `dist/` 拷贝到宿主机 `./client/dist/`（或在 CI 中直接 rsync/scp）
> 4. Docker Compose 将该目录以只读方式挂载到 Nginx 容器的 `/usr/share/nginx/html`
> 5. MVP 简化方案：在宿主机直接 `cd client && npm run build`，无需 CI

### 9.2 Nginx 配置（含粘性会话 + SSL + real_ip）

```nginx
# nginx.conf
user nginx;
worker_processes auto;

events {
    worker_connections 2048;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # B-3: real_ip 模块 — 确保 ip_hash 获取真实客户端 IP（而非 Docker 网关 IP）
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 172.16.0.0/12;
    set_real_ip_from 192.168.0.0/16;
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;

    # 日志格式（含 request_id 用于链路追踪）
    log_format main '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent" '
                    'rt=$request_time ua="$http_x_user_agent" '
                    'rid="$http_x_request_id"';

    access_log /var/log/nginx/access.log main;
    error_log /var/log/nginx/error.log warn;

    sendfile on;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    upstream vote_app {
        # 粘性会话：同一 IP 始终路由到同一后端节点
        # real_ip 模块确保此处 $remote_addr 为真实客户端 IP
        ip_hash;
        server app:3001 max_fails=3 fail_timeout=30s;
        # 扩展时取消注释：
        # server app-2:3001 max_fails=3 fail_timeout=30s;
        keepalive 32;  # 连接池
    }

    # B-1: HTTP → HTTPS 重定向
    server {
        listen 80;
        server_name _;
        return 301 https://$host$request_uri;
    }

    # B-1: HTTPS 主服务（飞书 WebView 强制要求 HTTPS）
    server {
        listen 443 ssl http2;
        server_name _;

        # SSL 证书路径（变量化，按环境替换）
        # MVP 阶段：自签证书（openssl req -x509 -nodes -days 365 -newkey rsa:2048）
        # 生产阶段：替换为云厂商免费证书或 Let's Encrypt
        ssl_certificate     /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;

        # SSL 安全配置
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
        ssl_prefer_server_ciphers off;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # 健康检查（不记日志）
        location /health {
            access_log off;
            proxy_pass http://vote_app/health;
        }

        # 前端静态资源
        location / {
            root /usr/share/nginx/html;
            try_files $uri $uri/ /index.html;   # SPA fallback
            expires 1h;
            add_header Cache-Control "public, immutable";
        }

        # API 反代
        location /api/ {
            proxy_pass http://vote_app;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Request-ID $request_id;
            proxy_read_timeout 30s;
            proxy_connect_timeout 10s;
        }

        # WebSocket 反代（粘性会话关键配置）
        location /ws/ {
            proxy_pass http://vote_app;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Request-ID $request_id;
            proxy_read_timeout 86400s;   # WS 长连接，24h 超时
            proxy_send_timeout 86400s;
            proxy_buffering off;          # 禁用缓冲
        }
    }
}
```

### 9.3 滚动重启部署方案

> **B-2 替换**：废弃 v1.0 的蓝绿部署「共享数据卷」方案（不安全，共享 PG/Redis 数据卷存在写冲突和数据损坏风险），改为 Docker Compose 滚动重启。

MVV 单机 Docker Compose 部署场景，滚动重启流程：

```
部署流程：
1. 构建新镜像 → docker build -t vote-app:v2 ./server
   更新 docker-compose.yml 中 app.build 指向新镜像（或覆盖 image tag）

2. 滚动重启（仅重启 app 容器，pg/redis/nginx 不受影响）：
   docker-compose pull app            # 若使用远程镜像
   docker-compose up -d --no-deps app # --no-deps 仅重启 app，不影响依赖服务

可用性分析：
- app 重启耗时：Node.js 冷启动 ~2-3s，healthcheck 通过后 Nginx 恢复路由
- 总可用性损失：3-5s（含容器停止+启动+healthcheck）
- Socket.IO 客户端在 app 不可用期间断开，重启后自动重连（指数退避 1s→30s）
- 重连后客户端执行全量数据重新拉取（refetchVoteDetail），确保状态一致
- 该方案无需额外 infra（无需多套 compose 文件、无需共享卷），运维简单

滚动重启验证：
1. docker-compose up -d --no-deps app
2. sleep 10 && curl -f https://localhost/health  # 确认 healthcheck 通过
3. docker-compose logs --tail=50 app              # 确认无启动错误
```

> **生产建议**：团队规模增长至 >500 后，迁移至 k8s + Helm，由 k8s Service sessionAffinity 替代 ip_hash，结合 Readiness Probe 和 RollingUpdate（maxUnavailable=0）实现零停机滚动更新。

### 9.4 Dockerfile（Node.js 应用）

```dockerfile
# server/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 vote && adduser -u 1001 -G vote -D vote
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
USER vote
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

### 9.5 PostgreSQL 备份方案

> **B-5 新增**：防止数据丢失，每日自动备份 + 7 天保留 + 快速恢复 SOP。

#### 备份 Cron（宿主机 crontab）

```bash
# /etc/cron.d/vote-pg-backup
# 每天凌晨 3:00 执行 pg_dump，保留最近 7 天
0 3 * * * root /opt/vote-app/scripts/pg-backup.sh >> /var/log/vote-backup.log 2>&1
```

#### 备份脚本

```bash
#!/bin/bash
# /opt/vote-app/scripts/pg-backup.sh
BACKUP_DIR="/opt/vote-app/backups/pg"
RETENTION_DAYS=7
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CONTAINER="vote-pg"

mkdir -p "$BACKUP_DIR"

# 从宿主机通过 Docker 网络执行 pg_dump（避免暴露 PG 端口）
docker exec "$CONTAINER" pg_dump -U vote_user -d vote_db \
  --no-owner --no-acl --clean --if-exists \
  | gzip > "$BACKUP_DIR/vote_db_${TIMESTAMP}.sql.gz"

# 清理 7 天前的备份
find "$BACKUP_DIR" -name "vote_db_*.sql.gz" -mtime +$RETENTION_DAYS -delete

echo "[$(date)] Backup completed: vote_db_${TIMESTAMP}.sql.gz ($(du -h "$BACKUP_DIR/vote_db_${TIMESTAMP}.sql.gz" | cut -f1))"
```

#### 恢复 SOP（3 句话）

1. **停止应用**：`docker-compose stop app`，防止恢复期间写入冲突
2. **执行恢复**：`gunzip -c /opt/vote-app/backups/pg/vote_db_YYYYMMDD_HHMMSS.sql.gz | docker exec -i vote-pg psql -U vote_user -d vote_db`（自动 drop + recreate 表结构及数据）
3. **重建 Redis 缓存**：`docker-compose start app`，app 启动后 TallySync 自动检测空 Redis 并从 PG 全量重建全部 tally key

---

## 十、非功能需求实现策略（逐项拆解为实施方案）

### 10.1 性能

| 指标 | 目标 | 实施方案 |
|------|------|----------|
| 页面首次加载 (FCP) | ≤1.5s | **前端**：Vite code-split → 首屏仅加载 React + 路由骨架（~50KB gzip）；非首屏页面懒加载 `React.lazy()`；ECharts 按需引入 bar 模块而非完整包；静态资源 CDN 化（飞书 OSS 或 Nginx gzip_static）；**后端**：API 响应 gzip 压缩 |
| API 写操作 P99 | ≤200ms | **后端**：PG 连接池 min=2/max=20（Knex pool config）；投票写入事务仅 3 条 INSERT（votes + options + user_votes），无复杂 JOIN；Redis HINCRBY 耗时 <1ms；WS 广播异步非阻塞 `setImmediate()` |
| 实时推送延迟 P99 | ≤2s | **Socket.IO**：仅 WebSocket transport（无长轮询降级延迟）；广播走房间模式避免全量遍历；Nginx `proxy_buffering off` 消除缓冲延迟 |
| ECharts 渲染 | ≤100ms (≤10选项) | **前端**：按需引入 `echarts/charts/bar`；`notMerge=false` + `setOption` 增量更新；禁用不必要的动画（如 `animationDuration: 0` for 增量更新）；Canvas 渲染（非 SVG）保证移动端性能 |
| 并发 200 人 | 在线同一投票 | **后端**：Socket.IO 房间模式下 200 人同房间广播无性能瓶颈（基于内存 emit）；Node.js Event Loop 单线程处理 200 连接绰绰有余；PG 连接池 20 足以应对 200 并发 REST |

### 10.2 安全

| 维度 | 实施方案 |
|------|----------|
| 身份认证 | **中间件 auth.ts**：解析 `Authorization: Bearer` header → 调飞书 `/open-apis/authen/v1/user_info` 验签 → 提取 open_id（user_id）、tenant_key（team_id）和 name（creator_name 快照）→ 注入 `req.user`；token 过期 → 401 |
| 授权控制 | **VoteService.closeVote**：比对 `req.user.user_id === vote.creator_id` **且** `req.user.team_id === vote.team_id`；列表查询按 `req.user.team_id` 过滤（不可跨团队查看投票） |
| 防重投票 | **PG UNIQUE(vote_id, user_id)** + **应用层 PRE-CHECK** + **速率限制** 三层防线（详见第八章节） |
| 输入校验 | **前端**：`validation.ts` 表单级校验（长度、非空、不重复）→ UI 提示；**后端**：`validateVoteInput()` 中间件，使用 `zod` schema 校验所有字段边界（title 1-100、options 2-10、deadline 1-10080）→ 400 拒绝 |
| XSS 防护 | **后端输出**：`title` 和 `content` 不做 HTML 转义（API 返回 JSON，浏览器自动转义）；**前端渲染**：React JSX 默认转义 `{title}` 即可；若使用 `dangerouslySetInnerHTML`——禁止使用 |
| 敏感数据保护 | **VoteService.getDetail**：字段级过滤——匿名投票下 `voters` 字段始终返回 `[]`，不可返回 `user_id` 或可推导出用户身份的映射值（如匿名 ID 映射表）；**代码审查 checklist**：确认 `GET /votes/:id` 返回体不含任何 `user_id`（匿名模式下） |
| 速率限制 | **rateLimiter.ts**：Redis Lua 脚本滑动窗口（每人每投票每分钟 3 次）；Redis 不可用时降级为内存 Map；```429 Too Many Requests``` + `Retry-After` 头 |
| SQL 注入 | **Knex.js** 参数化查询天然防注入（`db('votes').where({id})` 使用 `$1` 占位符）；禁止拼接 SQL 字符串 |
| HTTPS/TLS | **Nginx** 层 443 SSL 终止，HTTP → HTTPS 301 重定向；内部通信（Nginx→app）走 Docker 网络不加密（MVP 可接受）；证书路径变量化，MVP 用自签证书，生产用云厂商免费证书 |
| 数据保留 | **MVP 阶段不做自动清理**；`created_at` 字段保证 90 天后可手动清理；后续运维规范定义 `pg_cron` 定时清理任务 |
| CORS | **Nginx** 层统一配置 `Access-Control-Allow-Origin` 仅允许飞书域名；后端 `cors` 中间件同样限制 |

### 10.3 可用性

#### 10.3.1 Redis 降级方案

```
降级触发：redisHealth.ts 每秒 PING，连续 3 次超时(>500ms) → SET health:degraded "1"
降级效果：
  - 票数写入：跳过 Redis HINCRBY，仅写 PG
  - 票数读取：直接从 user_votes 表 COUNT GROUP BY option_id 聚合（降级查询耗时会升高）
  - 速率限制：降级为内存 Map（多进程环境不共享，但 MVP 单进程不构成问题）
  - 自动结束：Redis Keyspace Notification 失效，但应用层兜底——每 10 秒扫描 PG 中 deadline < NOW() 的 active 投票
恢复触发：连续 3 次 PING 成功 → DEL health:degraded
恢复后动作：全量从 PG 重建 Redis tally（TallySync.rebuildAll()）
```

#### 10.3.2 故障恢复

| 故障场景 | 恢复方案 |
|----------|----------|
| 应用进程崩溃 | Docker `restart: unless-stopped` 自动拉起；启动时 `startupRecoveryScan()` 扫描到期未结束投票并执行结束 |
| PostgreSQL 崩溃 | `pg_isready` healthcheck 触发容器重启；WAL 日志恢复；REST API 返回 503 + 前端展示「服务暂时不可用」；恢复后从备份还原（见 9.5） |
| Redis 崩溃 | 降级方案自动激活；Redis 重启后 `health:degraded` 删除 + TallySync 重建全部 tally |
| Nginx 崩溃 | Docker 自动重启；重启期间飞书 WebView 白屏，用户刷新后恢复 |
| 宿主机宕机 | 运维层面：同一台机器部署，宕机后需人工启动 Docker Compose；生产环境建议迁移至 k8s 多节点 |

### 10.4 可观测性

#### 10.4.1 日志规范

```typescript
// 统一日志格式（使用 pino 结构化日志）
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) { return { level: label }; },
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// 关键操作日志
logger.info({ action: 'vote_created',   voteId, userId, teamId, voteType, voteMode, optionCount, deadline });
logger.info({ action: 'ballot_submitted', voteId, userId, optionIds, latencyMs });
logger.info({ action: 'vote_closed',    voteId, userId, closedBy: 'manual'|'auto' });
logger.info({ action: 'degraded_on',   reason: 'redis_3x_ping_timeout' });
logger.info({ action: 'degraded_off',  reason: 'redis_recovered' });
logger.info({ action: 'rate_limited',  userId, voteId });

logger.error({ action: 'vote_create_failed', voteId, userId, error: err.message, stack: err.stack });
logger.error({ action: 'ballot_submit_failed', voteId, userId, errorCode: err.code });
logger.error({ action: 'deadline_worker_error', voteId, error: err.message });
```

#### 10.4.2 监控指标暴露

```typescript
// GET /health/metrics (Prometheus 格式或 JSON)
app.get('/health/metrics', async (req, res) => {
  const io = req.app.get('io') as Server;
  const metrics = {
    ws_connections: io.engine.clientsCount,        // WS 连接数
    ws_rooms: io.sockets.adapter.rooms.size,        // 活跃房间数
    active_votes: await db('votes').where('status', 'active').count(),
    pg_pool_active: (db.client.pool as any).numUsed?.() || 0,
    pg_pool_idle: (db.client.pool as any).numFree?.() || 0,
    redis_degraded: await redis.get('health:degraded') === '1',
    uptime_seconds: process.uptime(),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    vote_submit_qps_1m: getQPS(),                   // 滑动窗口统计
    api_p99_ms: getP99(),
  };
  res.json({ code: 0, data: metrics });
});
```

#### 10.4.3 告警规则（飞书通知）

| 告警条件 | 阈值 | 通知方式 |
|----------|------|----------|
| WS 连接数 1 分钟内下降 >50% | 突发断连 | 飞书 Webhook → 团队频道 |
| API 5xx 错误率 >1% (1min) | 服务异常 | 飞书 Webhook |
| Redis 降级标志激活 | 缓存不可用 | 飞书 Webhook（高优先级） |
| PG 连接池耗尽（active = max） | DB 瓶颈 | 飞书 Webhook |
| 未结束的过期投票数 >5 | deadline worker 异常 | 飞书 Webhook |

> **实现方式**：独立 `healthMonitor.ts` 模块，每 30 秒检查指标 → 触达阈值 → POST 飞书机器人 Webhook → 发送 Markdown 格式告警卡片。

---

## 十一、架构图 HTML（SVG）

配套架构图文件已生成：`/home/eeimoo/.openclaw/agents/qiwu/workspace/arch-diagram.html`

---

## 十二、技术风险与预案

| 风险 | 影响 | 概率 | 预案 |
|------|------|------|------|
| Redis Keyspace Notification 延迟 >5s 导致自动结束不准 | 中 — 投票延迟结束 | 低 | 降级为每 10s 扫描 PG（与 Notification 并行双路径）；若 Notification 持续延迟 → 升级为 BullMQ 延迟任务 |
| 滚动重启 WS 粘性会话断裂 | 高 — 用户投票中途断开 | 中 | Socket.IO 自动重连 + 重连后全量拉取最新状态（`refetchVoteDetail()`）；Nginx `ip_hash` + `real_ip` 保障粘性 |
| 并发 HINCRBY 计数竞争 | 低 — 原子操作天然安全 | 极低 | HINCRBY 天然原子；TallySync 每 5s 与 PG 对账，发现偏差自动修正 |
| 匿名模式 user_id 泄露 | 高 — 隐私合规 | 低 | API 层字段过滤 + 安全测试用例覆盖；Code Review 确认 `/votes/:id` 匿名下返回 `voters:[]` |
| 飞书 WebView ECharts 兼容性异常 | 中 — 图表无法渲染 | 低 | 提前在飞书桌面+移动端内测版验证；备选降级为纯 CSS 柱状图（`div` + 百分比宽度） |
| 服务崩溃导致定时器丢失 | 高 — 投票永久卡 active | 低 | 定时器持久化到 Redis TTL + 启动兜底扫描 PG（双重保障） |
| 团队人员变更 total_voters 不准 | 中 — 参与率失真 | 中 | `total_voters` 标注为「创建时刻快照」，前端提示文案注明；参与率仅作参考 |
| Redis noeviction 写满后写操作全失败 | 高 — 投票提交中断 | 低 | B-4 已修正为 `volatile-lru`，仅淘汰带 TTL 的 key，tally 不受影响 |
| PG 数据丢失（磁盘故障/误删） | 极高 | 极低 | B-5 每日 pg_dump + 7 天保留 + docker exec 快速恢复 |

---

## 附录 A：与其他角色的交付接口

| 角色 | 交付物 | 文档位置 |
|------|--------|----------|
| **凌霜**（后端） | PG DDL、表关联说明、索引策略（含 team_id + creator_name 新增列） | 第五章 5.1 |
| **凌霜**（后端） | Redis 数据结构 + 操作命令 | 第五章 5.2 |
| **凌霜**（后端） | 投票状态机 + 原子操作伪码（含 team 权限校验） | 第六章 |
| **凌霜**（后端） | 速率限制 Lua 脚本（修正版）+ 降级内存清理逻辑 | 第八章 8.3 |
| **流光**（前端） | API 契约（请求/响应/filter 规则，含 team_id/creator_name 字段） | 第四章 |
| **流光**（前端） | WS 消息格式 + 事件处理伪码 | 第七章 |
| **流光**（前端） | ECharts 数据结构（options + tally 合并） | 4.2.3 投票详情响应 |
| **寻错**（测试） | 状态机边界 + 并发场景表 | 第六章 6.4 |
| **寻错**（测试） | 多层防刷测试点位 | 第八章 8.1 |
| **长夜**（DevOps） | Docker Compose 完整配置（含 nginx/volatile-lru/滚动重启） | 第九章 9.1 |
| **长夜**（DevOps） | Nginx 配置（SSL + real_ip + HTTP→HTTPS 重定向） | 第九章 9.2 |
| **长夜**（DevOps） | 滚动重启部署流程 + Redis 降级方案 | 第九章 9.3 / 10.3.1 |
| **长夜**（DevOps） | PG 备份 cron + 恢复 SOP | 第九章 9.5 |
| **知微**（安全） | 安全加固点清单（含 HTTPS/TLS） | 第十章 10.2 |
| **知微**（安全） | 埋点事件 + 监控指标 | 第十章 10.4 |

---

> 📋 **文档版本**：v1.1 | 设计人：栖梧 | 已通过 v1.0 架构评审（有条件通过），修订 12 项后提交复审
