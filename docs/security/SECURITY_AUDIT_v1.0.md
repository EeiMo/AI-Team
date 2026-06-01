# 安全审计初检清单 — 团队即时投票工具

> 版本：v1.0 | 审计人：知微 | 日期：2026-06-01 | 关联架构 v1.1 / PRD v1.1

---

## 一、认证与授权检查项

### 1.1 飞书 SSO Token 验签覆盖

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| AUTH-01 | 所有 `/api/*` 路由是否经过 `authMiddleware` 验签 | 审查 `src/middleware/auth.ts` 代码 + `src/routes/votes.ts` 路由注册逻辑；确认中间件在路由之前注册（`app.use('/api', authMiddleware, voteRouter)`） | 所有 5 个 API 端点（创建/列表/详情/提交/结束）均须经 `authMiddleware` 且不可存在绕过路径（如 `app.use('/api/votes/:id/vote', ...)` 跳过 auth） | 🔧 开发自查 |
| AUTH-02 | `Authorization: Bearer` header 缺失时返回 401 | 代码审查 `authMiddleware` 中 token 提取逻辑；确认无 token 时返回 `{code: 40100}` 而非继续放行 | `req.headers.authorization` 为空或非 `Bearer ` 格式 → 401；无 fallback 到 query string 或 cookie | 🔧 开发自查 |
| AUTH-03 | Token 验签是否调飞书 Open API（而非本地假校验） | 审查 `src/utils/feishu.ts` — `verifyFeishuToken()` 实现；确认调用了飞书 `/open-apis/authen/v1/user_info` 或使用飞书 SDK 验签 | 必须发起真实 API 调用或 SDK 验签（不可仅 `JSON.parse(atob(token.split('.')[1]))` 读 payload）；验签失败 → 401 | 🔧 开发自查 |
| AUTH-04 | `req.user` 是否从验签结果中正确提取 `user_id` / `team_id` / `name` | 审查 `authMiddleware` 中 `req.user` 注入逻辑 | `req.user.user_id` = `open_id`（`ou_xxx` 格式）、`req.user.team_id` = `tenant_key`、`req.user.name` = `display_name` | 🔧 开发自查 |
| AUTH-05 | Token 过期策略：是否有过期时间校验 | 审查 token 验签逻辑是否检查 `exp` 或调用飞书接口返回的过期信息 | 过期 token → 401，不可静默刷新或降级为匿名访问 | 🔧 开发自查 |

### 1.2 RBAC 权限隔离

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| RBAC-01 | `POST /api/votes/:id/close` 是否校验 `creator_id === req.user.user_id` | 审查 `VoteService.closeVote()` 或对应路由处理函数；确认事务内 `SELECT creator_id FROM votes WHERE id=$1 FOR UPDATE` + 比对 | `creator_id !== req.user.user_id` → 403（`{code: 40302}`）；不可接受 admin 角色绕过 | 🔧 开发自查 |
| RBAC-02 | `POST /api/votes/:id/close` 是否同时校验 `team_id` | 审查 closeVote 逻辑是否包含 `team_id !== req.user.team_id` 检查（架构第 10.2 节明确要求双重校验） | 跨团队用户不可关闭另一个团队的投票 → 403 | 🔧 开发自查 |
| RBAC-03 | `GET /api/votes` 列表是否按 `req.user.team_id` 过滤 | 审查列表查询 SQL/Knex；确认 `WHERE team_id = ?` 条件存在于所有查询路径（含 active/closed 筛选） | 不同 team_id 的用户仅能看到本团队投票；不可通过不传 team_id 参数看到全局数据 | 🔧 开发自查 |
| RBAC-04 | 非发起者不可见「结束投票」按钮（前端） | 前端代码审查：`VoteDetail.tsx` 中 `creator_id === currentUser.user_id` 条件渲染 | 后端也须校验（RBAC-01 已覆盖），前端仅作 UI 隐藏不替代后端权限检查 | 🔧 开发自查 |
| RBAC-05 | 匿名模式下 API 返回的 `voters` 字段是否按角色过滤 | 审查 `VoteService.getDetail()` 中 `voters` 字段构建逻辑；按架构 4.2.3 规则：匿名模式始终 `[]`；实名模式按请求者身份区分 | 匿名模式下任何请求者（含发起者）的 `voters` 均为 `[]`；实名模式发起者可见全部、参与者可见全部（公开投票） | 🔧 开发自查 |
| RBAC-06 | `join:vote` WS 事件是否校验用户属于本团队 | 审查 `src/ws/index.ts` 或 `handlers.ts` 中 `join:vote` 处理逻辑；确认 `socket.data.team_id` 与 `votes.team_id` 比对 | 跨团队用户不可加入另一个投票的 WS 房间（架构 7.2 注释要求） | 🔧 开发自查 |

### 1.3 WebSocket 连接认证

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| WS-01 | WS 连接是否校验 token（Socket.IO `auth` 中间件） | 审查 `src/ws/index.ts` 中 `io.use((socket, next) => { ... })` 中间件；确认 token 从 `socket.handshake.auth.token` 提取并验签 | 无 token 或验签失败 → `next(new Error('Unauthorized'))` 拒绝连接；不可接受匿名 WS 连接 | 🔧 开发自查 |
| WS-02 | WS 连接是否校验 Origin（防止跨域 WebSocket 劫持） | 审查 Nginx 配置中 `/ws/` location 是否设置 `proxy_set_header Origin`；后端 WS 中间件是否检查 `socket.handshake.headers.origin` | Origin 须匹配飞书域名或白名单域名（`*.feishu.cn`、部署域名）；非白名单拒绝连接 | 🔧 开发自查 |
| WS-03 | WS 升级代理路径是否为 `/ws/` 命名空间 | 审查 Nginx `location /ws/` 配置 - `proxy_pass` + `Upgrade`/`Connection` header；确认客户端连接 `wss://<domain>/ws` | Nginx 正确转发 WebSocket Upgrade；不存在 `/socket.io/` 的额外路径暴露 | 🔧 开发自查 |

---

## 二、数据安全清单

### 2.1 匿名模式数据隔离

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| DATA-01 | `GET /api/votes/:id` 匿名模式下 `voters` 字段是否始终为 `[]` | 代码审查 `VoteService.getDetail()`：检查 `vote_mode === 'anonymous'` 条件下 `voters` 字段赋值逻辑；确认无论 status 为 active 还是 closed 均返回空数组 | 匿名模式下 API 响应中任何 `options[].voters` 不可包含 `user_id`、`user_name` 或任何可推导用户身份的映射值；代码中不可有 `if (anonymous) voters = [] else if (requestUser === creator && public) ...` 的匿名分支泄露路径 | 🔧 开发自查 |
| DATA-02 | `GET /api/votes` 列表匿名模式下是否泄露 `creator_id` | 审查列表 API 返回体是否包含 `creator_id` 字段；注意架构定义中列表返回含 `creator_id`（架构 4.2.2），需确认匿名模式下此字段处理策略 | 架构设计中列表返回不含 `voters` 字段故无泄露风险；`creator_id` 为投票发起者身份，实名/匿名模式均可展示（发起者身份本身是公开信息） | 🔧 开发自查 |
| DATA-03 | `my_selected_options` 字段是否仅返回当前请求用户自己的选择 | 审查 `VoteService.getDetail()` 中 `my_selected_options` 查询逻辑；确认 `WHERE user_id = req.user.user_id` | 不可返回其他用户的选项；不可接受客户端传入 `user_id` 参数查询他人选择 | 🔧 开发自查 |
| DATA-04 | `POST /api/votes/:id/vote` 响应是否不暴露其他用户信息 | 审查提交投票 API 返回体（架构 4.2.4）：仅含 `vote_id` / `selected_options` / `submitted_at` | 不可在响应中附带当前 tally、其他投票人信息或任何匿名模式下的用户数据 | 🔧 开发自查 |

### 2.2 传输层安全

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| TLS-01 | HTTPS 是否强制启用（HTTP → HTTPS 301 重定向） | 审查 `nginx.conf` 中 80 端口 server 块是否配置 `return 301 https://$host$request_uri`（架构 9.2） | 所有 HTTP 请求自动重定向到 HTTPS；飞书 WebView 强制要求 HTTPS | 🔧 开发自查 |
| TLS-02 | SSL 证书路径是否变量化、TLS 版本是否 ≥1.2 | 审查 `nginx.conf` 确认 `ssl_protocols TLSv1.2 TLSv1.3` 且无 TLSv1.0/1.1；确认 `ssl_ciphers` 使用强密码套件 | TLSv1.0/1.1 已禁用；无 `RC4`/`3DES` 等弱密码 | 🔧 开发自查 |
| TLS-03 | WSS 是否通过 443 端口（与 HTTPS 共用） | 审查 Socket.IO 客户端连接 URL：`wss://<domain>/ws`（架构 7.1）；确认无 `ws://` 明文连接路径 | 客户端使用 `wss://` + Nginx 443 → 内部 `proxy_pass http://vote_app` | 🔧 开发自查 |
| TLS-04 | 内部 Docker 网络通信是否不暴露到公网 | 审查 docker-compose.yml：`pg`/`redis` 容器的 `ports` 是否仅绑定 `127.0.0.1`；`app` 容器使用 `expose` 而非 `ports` | PG 端口仅映射 `127.0.0.1:5432:5432`；Redis 仅映射 `127.0.0.1:6379:6379`；app 容器端口仅 Docker 内部网络可达 | 🔧 开发自查 |

### 2.3 Token 传输安全

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| TOK-01 | Token 是否仅通过 `Authorization: Bearer` header 传输 | 审查所有 API 和 WS 连接代码中 token 传递方式（架构 4.1 / 7.1 / 9.3） | token 不可出现在 URL query string（`?token=xxx`）或 POST body 中；WS 通过 `auth.token` 传递（架构 7.1） | 🔧 开发自查 |
| TOK-02 | Nginx access_log 是否记录 Authorization header | 审查 `nginx.conf` 中 `log_format` 定义（架构 9.2）；确认日志格式不含 `$http_authorization` | access_log 中不可包含 Bearer token 明文；若需调试建议记录 token hash | 🔧 开发自查 |
| TOK-03 | 前端 Axios 拦截器是否正确注入 token | 审查 `client/src/services/api.ts` 确认拦截器从飞书 SSO 获取 token 并注入 `Authorization` header（架构 3.2 模块清单） | 所有 API 请求自动携带 token；无手动拼接 header 的重复代码 | 🔗 开发自查（前端） |

### 2.4 幂等与防重机制

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| IDEM-01 | PG `UNIQUE(vote_id, user_id)` 约束是否已创建（DDL） | 审查 `src/db/migrations/` 中 DDL 脚本；确认 `user_votes` 表含 `CONSTRAINT uq_user_votes_vote_user UNIQUE (vote_id, user_id)` | 约束实际存在于数据库中；可通过 `\d user_votes` 验证 | 🔧 开发自查 |
| IDEM-02 | BallotService 是否捕获 PG `23505` 错误码并转 409 | 审查 `src/services/ballotService.ts` 中事务 catch 逻辑（架构 8.4 伪码）；确认 `err.code === '23505'` 判断存在 | 并发提交导致的 UNIQUE violation 正确映射为 `{code: 40901}` 而非 500 | 🔧 开发自查 |
| IDEM-03 | 提交投票事务是否使用 `FOR UPDATE` 锁定 vote 行 | 审查 BallotService 事务中 `SELECT status FROM votes WHERE id=$1 FOR UPDATE` 是否存在（架构 6.3.1） | `FOR UPDATE` 必须在 INSERT 之前，防止 TOCTOU 竞态 | 🔧 开发自查 |
| IDEM-04 | 手动结束与自动结束并发时是否幂等 | 审查 `closeVoteAutomatically()` 使用 `WHERE status='active'` 条件 UPDATE（架构 6.3.3） | 先执行者 UPDATE 成功，后者 `affectedRows=0` 静默跳过，不重复广播关闭事件 | 🔧 开发自查 |

### 2.5 数据保留策略可实施性

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| RET-01 | `votes.created_at` 字段是否可支持 90 天清理查询 | 审查 DDL 确认 `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` 存在（架构 5.1） | `created_at` 字段有值且不可为 null；可基于此字段编写 `WHERE created_at < NOW() - INTERVAL '90 days'` 清理 SQL | 🔧 开发自查 |
| RET-02 | `ON DELETE CASCADE` 是否确保清理 votes 时级联删除关联数据 | 审查 DDL 确认 `options` 和 `user_votes` 外键均含 `ON DELETE CASCADE` | `DELETE FROM votes WHERE created_at < ...` 可安全级联删除所有关联 options 和 user_votes | 🔧 开发自查 |
| RET-03 | Redis tally 数据清除是否在投票结束时执行 | 审查 `closeVote` 逻辑确认是否调用了 Redis `DEL vote:{voteId}:tally` | 投票结束（手动/自动）后 Redis tally key 被删除；避免长期滞留投票缓存 | 🔧 开发自查 |
| RET-04 | 30 天 user_id→vote 关联清除方案是否可实施 | 审查 `user_votes` 表结构；确认 `created_at` 字段存在，可与 votes 的 `created_at` 关联 | 支持 SQL：`DELETE FROM user_votes WHERE vote_id IN (SELECT id FROM votes WHERE created_at < NOW() - INTERVAL '30 days' AND vote_mode='anonymous')` | 🔧 开发自查 |

---

## 三、防刷机制渗透测试用例

### 3.1 L1 认证层穿透

| 编号 | 测试用例 | 测试步骤 | 预期结果 | 执行阶段 |
|------|----------|----------|----------|----------|
| PEN-01 | **无 token 直接 POST API** | `curl -X POST https://<domain>/api/votes/:id/vote -H 'Content-Type: application/json' -d '{"option_ids":["..."]}'` | HTTP 401 `{code: 40100}` | 🧪 阶段五渗透 |
| PEN-02 | **伪造 JWT payload 请求** | 本地生成一个自签 JWT（`{"user_id":"ou_fake","team_id":"xxx"}`）作为 Bearer token 提交 | HTTP 401（验签失败）；不可接受自签 token | 🧪 阶段五渗透 |
| PEN-03 | **使用其他团队的合法 token 访问本团队投票** | 获取团队 A 的合法 token，请求团队 B 的投票详情/列表 API | 列表 API 仅返回本团队投票（WHERE team_id 过滤）；详情/提交 API 返回 403 或 404（跨团队隔离） | 🧪 阶段五渗透 |
| PEN-04 | **过期 token 能否继续使用** | 获取 token 后等待其过期（或手动过期），再次请求 API | HTTP 401 `{code: 40100}` | 🧪 阶段五渗透 |

### 3.2 L2 速率限制穿透

| 编号 | 测试用例 | 测试步骤 | 预期结果 | 执行阶段 |
|------|----------|----------|----------|----------|
| PEN-05 | **同一用户高频提交（验证 L2 限流 3次/分钟）** | 脚本循环 POST `/api/votes/:id/vote`，间隔 10s，连续 10 次（同 vote_id） | 前 3 次正常处理（第 1 次成功 200，第 2-3 次 409 重复投票）；第 4+ 次返回 429 `{code: 42900}` + `Retry-After` 头 | 🧪 阶段五渗透 |
| PEN-06 | **不同 vote_id 的速率限制是否独立** | 创建 2 个投票（voteA, voteB），以同一用户对 voteA 提交 3 次（触发 429），再对 voteB 提交 1 次 | voteB 提交应正常（不受 voteA 速率限制影响），因为限流 key 维度是 `rate:{user_id}:{vote_id}` | 🧪 阶段五渗透 |
| PEN-07 | **速率限制窗口边界测试** | 在 60s 窗口内提交 3 次，等待 61s 后提交第 4 次 | 第 4 次应被允许（窗口已滑动）；验证 ZREMRANGEBYSCORE 清理逻辑正确 | 🧪 阶段五渗透 |
| PEN-08 | **绕过前端校验直接 POST API（绕过 L2 限流感知）** | 使用 curl/postman 直接调用投票提交 API（不经过前端限流提示） | 后端 L2 限流仍生效；前端提示仅 UI 层面辅助，后端是真防线 | 🧪 阶段五渗透 |
| PEN-09 | **分布式/并发高频请求（竞态测试）** | 10 个并发连接同时提交同一用户的投票（模拟脚本并发） | 仅 1 个请求成功（200），其余 409（重复）或 429（限流）；无票数重复计数 | 🧪 阶段五渗透 |

### 3.3 L3 业务校验穿透

| 编号 | 测试用例 | 测试步骤 | 预期结果 | 执行阶段 |
|------|----------|----------|----------|----------|
| PEN-10 | **向已结束投票提交投票** | `POST /api/votes/:id/vote` 其中 `vote.status=closed` | HTTP 403 `{code: 40301}` | 🧪 阶段五渗透 |
| PEN-11 | **提交不属于该投票的 option_id** | `POST /api/votes/:id/vote` body `{"option_ids":["不属于该vote的id"]}` | HTTP 400 `{code: 40005}` "option_ids 中有不属于本投票的选项" | 🧪 阶段五渗透 |
| PEN-12 | **单选投票提交多个 option_id** | vote_type=single，body `{"option_ids":["id1","id2"]}` | HTTP 400，不可接受多选 | 🧪 阶段五渗透 |
| PEN-13 | **option_ids 为空数组** | body `{"option_ids":[]}` | HTTP 400 `{code: 40001}` "option_ids 不能为空" | 🧪 阶段五渗透 |
| PEN-14 | **option_ids 中含重复 ID** | body `{"option_ids":["id1","id1"]}` | HTTP 400 参数校验拒绝 | 🧪 阶段五渗透 |

### 3.4 L4 数据库防重穿透

| 编号 | 测试用例 | 测试步骤 | 预期结果 | 执行阶段 |
|------|----------|----------|----------|----------|
| PEN-15 | **同一用户并发提交 2 次投票（验证 PG UNIQUE 约束）** | 使用 2 个并发连接几乎同时提交同一 user_id + vote_id 的投票 | 第 1 个事务成功 INSERT；第 2 个触发 PG `23505 unique_violation` → 409；PG 中仅 1 条记录 | 🧪 阶段五渗透 |
| PEN-16 | **分布式环境下同一用户重复投票** | 模拟多 Node 进程（或同一进程多连接）同时提交 | 同上，PG UNIQUE 约束是跨进程的最终防线 | 🧪 阶段五渗透 |

### 3.5 综合防刷场景

| 编号 | 测试用例 | 测试步骤 | 预期结果 | 执行阶段 |
|------|----------|----------|----------|----------|
| PEN-17 | **死用户批量注册投票（验证 L1 身份绑定）** | 尝试用伪造/无效的飞书 token 创建投票并提交 | 所有请求 → 401（L1 认证层拒绝，不进入后续防线） | 🧪 阶段五渗透 |
| PEN-18 | **IP 代理池轮询（验证 IP 滑动窗口是否具备）** | 架构当前仅实现 user_id 维度的速率限制（`rate:{user_id}:{vote_id}`）；检查是否实现了 IP 维度限流 | 当前架构未实现 IP 维度限流（设计为 user_id 维度）；**发现项**：若攻击者通过 SSO 获取多个合法 token，可用不同 user_id 绕过 user_id 维度限流；建议后续版本增加 IP 维度辅助限流（但 MVP 适用场景下风险可控，因为飞书 SSO token 绑定真实身份） | 🧪 阶段五渗透 |
| PEN-19 | **Redis 不可用时限流是否降级生效** | 手动停止 Redis 容器，执行投票提交 | 降级标志激活；内存 Map 限流生效（第 4 次提交返回 429）；日志记录 `action: degraded_on` | 🧪 阶段五渗透 |
| PEN-20 | **SQL 注入攻击投票创建/提交** | 在 title / option content 中注入 SQL payload（如 `'; DROP TABLE votes; --`） | Knex.js 参数化查询阻止注入；后端无 SQL 拼接；请求正常处理或返回 400（参数校验） | 🧪 阶段五渗透 |

---

## 四、数据埋点验证方案

### 4.1 核心埋点事件清单

根据架构第 10.4.1 节日志规范，定义以下 10 个核心埋点事件：

| 编号 | 事件名 | 触发时机 | 采集字段 | 用途 | 验证方法 |
|------|--------|----------|----------|------|----------|
| TRK-01 | `vote_created` | 创建投票成功 | `voteId`, `userId`, `teamId`, `voteType`, `voteMode`, `optionCount`, `deadline` | 创建行为分析、匿名/实名偏好分布 | 审查 `VoteService.create()` 中 `logger.info({action:'vote_created', ...})` 是否存在；执行创建操作后检查日志输出 |
| TRK-02 | `ballot_submitted` | 提交投票成功 | `voteId`, `userId`, `optionIds`, `latencyMs` | 投票行为分析、提交耗时分布 | 审查 `BallotService.submitVote()` 中 `logger.info({action:'ballot_submitted', ...})` 是否存在 |
| TRK-03 | `vote_closed` | 投票结束（手动/自动） | `voteId`, `userId`(手动结束者), `closedBy`(`manual`/`auto`) | 结束方式分析、手动 vs 自动比例 | 审查 `VoteService.closeVote()` 和 `DeadlineWorker` 中的日志点 |
| TRK-04 | `rate_limited` | 触发速率限制 | `userId`, `voteId` | 限流触发频率、异常行为检测 | 审查 `rateLimiter.ts` 中 429 返回前的日志点 |
| TRK-05 | `degraded_on` | Redis 降级激活 | `reason`(连续超时) | 缓存可用性监控 | 审查 `redisHealth.ts` 中的降级日志 |
| TRK-06 | `degraded_off` | Redis 降级恢复 | `reason`(恢复) | 缓存恢复监控 | 同上 |
| TRK-07 | `vote_create_failed` | 创建投票失败 | `voteId`(部分), `userId`, `error`, `stack` | 创建失败原因分布 | 审查 error 级别日志 |
| TRK-08 | `ballot_submit_failed` | 提交投票失败 | `voteId`, `userId`, `errorCode` | 提交失败原因分布（409/403/429） | 审查 BallotService catch 块 |
| TRK-09 | `deadline_worker_error` | 自动结束逻辑异常 | `voteId`, `error` | DeadlineWorker 健康监控 | 审查 `DeadlineWorker` 异常捕获日志 |
| TRK-10 | `page_view`（前端补充） | 投票详情页加载 | `page`, `voteId`, `referrer`, `timestamp` | 页面 PV/UV | 前端 `useVoteDetail` hook 或页面组件 `useEffect` 中上报 |

### 4.2 埋点规范检查

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| TRK-11 | 日志格式是否结构化（pino JSON） | 检查 `package.json` 是否引入 `pino`；检查日志输出是否为 JSON 行（非 `console.log` 字符串拼接） | 使用 `pino` 或等效结构化日志库；`logger.info({...})` 输出为单行 JSON | 🔧 开发自查 |
| TRK-12 | 用户 ID 是否在上报前 hash | 审查日志中 `userId` 字段是否直接输出飞书 `ou_xxx` 原始值 | ⚠️ **架构中未定义 hash 要求**；当前设计直接输出 `userId` 原始值（飞书 open_id 是系统内部 ID，非用户手机号/姓名）；日志存储安全由日志系统访问控制保障；若 EeiMoo 要求进一步脱敏，可在 logger 序列化层做 SHA256 hash | 🔧 开发自查 |
| TRK-13 | 关键操作日志是否包含 latency 字段 | 审查 `ballot_submitted` 日志是否记录从请求到响应的时间（`latencyMs`） | `ballot_submitted` 日志包含 `latencyMs`；可用于 P99 监控 | 🔧 开发自查 |
| TRK-14 | 错误日志是否包含 stack trace（仅 error 级别） | 审查 `logger.error(...)` 调用是否传入 `stack: err.stack` | error 级别日志含 `stack` 字段；info 级别不含（避免堆栈噪音） | 🔧 开发自查 |

### 4.3 监控指标暴露

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| MET-01 | `GET /health/metrics` 端点是否可用 | 部署后 `curl https://<domain>/health/metrics` | 返回 JSON `{code:0, data:{ws_connections, active_votes, redis_degraded, ...}}` | 🧪 阶段五渗透 |
| MET-02 | metrics 端点是否需要认证 | 审查是否对 `/health/metrics` 应用了 authMiddleware | 建议：metrics 端点不暴露公网，通过 Nginx `allow` 内网 IP 限制访问；架构中未明确，需与长夜确认 | 🔧 开发自查 |

---

## 五、合规审计项

### 5.1 隐私声明

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| CPL-01 | 匿名投票页面是否展示隐私声明（前端 `PrivacyBanner` 组件） | 审查 `client/src/components/PrivacyBanner.tsx` 是否存在；审查 `VoteDetail.tsx` 中是否在 `vote_mode=anonymous` 且 `status=active` 时渲染该组件 | 蓝色提示条展示文案：「本次为匿名投票，你的选择不会对其他参与者显示，但系统会记录你的身份以进行防重复投票」（PRD F-008） | 🔧 开发自查（前端） |
| CPL-02 | 实名投票页面不展示防重提示（区分展示逻辑） | 审查 `VoteDetail.tsx` 中条件渲染逻辑：`{vote_mode === 'anonymous' && <PrivacyBanner />}` | 实名模式下无上述匿名提示条 | 🔧 开发自查（前端） |
| CPL-03 | 创建页选择「匿名」时是否展示隐私声明 | 审查 `CreateVote.tsx` 中 `vote_mode=anonymous` 时的蓝色提示条（PRD AC-008-3） | 提示文案：「匿名投票下，其他参与者看不到你的身份，但系统会记录你的投票以防重复提交」 | 🔧 开发自查（前端） |

### 5.2 数据清除能力

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| CPL-04 | 30 天自动清除匿名投票 `user_id→vote` 关联是否可实现 | 审查 `user_votes` 表结构；确认 `created_at` 字段存在并可关联 `votes.created_at` 和 `votes.vote_mode` | 支持 SQL 清理：`DELETE FROM user_votes WHERE vote_id IN (SELECT id FROM votes WHERE vote_mode='anonymous' AND created_at < NOW() - INTERVAL '30 days')` | 🔧 开发自查 |
| CPL-05 | 投票数据 90 天保留期是否具备删除能力 | 审查 `votes` 表 `created_at` + `ON DELETE CASCADE`；确认清理 SQL 可安全执行 | MVP 手动执行或配置 `pg_cron` 定时任务（后续运维规范定义）；`ON DELETE CASCADE` 确保级联删除 | 🔧 开发自查 |
| CPL-06 | 是否有用户请求删除个人投票记录的能力（GDPR 数据主体权利） | 审查是否提供 `DELETE /api/votes/:id/my-vote` 或等效端点 | **发现项**：架构中无用户删除个人投票记录的 API；MVP 阶段可接受（投票提交不可更改，删除需人工），但后续版本应补充 | 📋 风险记录 |

### 5.3 个人信息收集最小化

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| CPL-07 | 系统是否仅收集必要信息（`user_id`、`team_id`、`name`） | 审查 `authMiddleware` 中 `req.user` 注入字段；审查 PG 表中存储字段 | 仅收集飞书 `open_id`（`user_id`）、`tenant_key`（`team_id`）、`display_name`（`creator_name` 快照）；不收集手机号、邮箱、IP（日志除外） | 🔧 开发自查 |
| CPL-08 | `creator_name` 快照是否可在用户改名后保持原始值 | 审查 `VoteService.create()` 中 `creator_name` 写入逻辑；确认从 SSO token 提取而非 JOIN 实时查询 | `creator_name` 为创建时刻快照；即使后续改名，历史投票显示创建时名字（架构设计意图） | 🔧 开发自查 |
| CPL-09 | 是否在服务端日志中记录不必要的个人信息 | 审查 logger 调用中记录的字段（userId 为 open_id 可接受；不可记录实名、手机号等） | 日志中 `userId` 为 `open_id`（飞书内部 ID）；不记录 `name` 到 info 日志（仅 vote_created 可含 name，其他日志不记） | 🔧 开发自查 |

### 5.4 CORS 配置

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| CPL-10 | Nginx 是否限制 CORS `Access-Control-Allow-Origin` | 审查 `nginx.conf` 中是否包含 `add_header Access-Control-Allow-Origin` 及允许的域名白名单 | 仅允许飞书域名（`*.feishu.cn`）和部署域名；不可使用 `*` 通配 | 🔧 开发自查 |
| CPL-11 | 后端 `cors` 中间件是否限制 Origin | 审查 Express `cors()` 中间件配置（`src/index.ts` 或 `app.ts`） | origin 配置为白名单数组，不可为 `true`（允许所有） | 🔧 开发自查 |

---

## 六、第三方依赖审查清单

### 6.1 后端依赖扫描清单

| 类别 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| DEP-01 | `express` 4.x 已知 CVE 扫描 | `npm audit --production` 或 OWASP Dependency-Check；关注 RCE、DoS、绕过认证类漏洞 | 无 high/critical CVE 未修复 | 🔧 开发自查 + 🧪 阶段五 |
| DEP-02 | `socket.io` 4.x 已知漏洞 | 同上；特别关注 WebSocket 相关 CVE（如 DoS、认证绕过） | 同上 | 🔧 开发自查 + 🧪 阶段五 |
| DEP-03 | `knex` 3.x SQL 注入相关 CVE | 同上 | Knex 参数化查询天然防注入；关注版本中已修复的 bypass 漏洞 | 🔧 开发自查 + 🧪 阶段五 |
| DEP-04 | `ioredis` (Redis 客户端) 已知漏洞 | 同上 | 无 high/critical CVE | 🔧 开发自查 + 🧪 阶段五 |
| DEP-05 | `pg` (node-postgres) 已知漏洞 | 同上 | 无 high/critical CVE | 🔧 开发自查 + 🧪 阶段五 |
| DEP-06 | `pino` (日志库) 已知漏洞 | 同上 | 日志库漏洞通常低风险，但需确认无原型污染类漏洞 | 🔧 开发自查 |
| DEP-07 | `zod` (校验库) 已知漏洞 | 同上；关注 ReDoS、schema 注入类漏洞 | 无 high/critical CVE | 🔧 开发自查 |
| DEP-08 | `jsonwebtoken` 或飞书 SDK（验签库）已知漏洞 | 同上；特别关注 `jwt.verify` 的 `none` algorithm bypass（经典漏洞） | 验签时必须指定 `algorithms: ['HS256', 'RS256']` 等，不可接受 `none` algorithm | 🔧 开发自查 |
| DEP-09 | Node.js 20 LTS 运行时 CVE | `node --version` 确认确切小版本；检查 Node.js 官方安全公告 | 使用最新的 Node.js 20 LTS 补丁版本（如 20.11.x+） | 🔧 开发自查 |

### 6.2 前端依赖扫描清单

| 类别 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| DEP-10 | `react` 18.x / `react-dom` 已知 XSS 相关 CVE | `cd client && npm audit --production`；关注 `dangerouslySetInnerHTML` 相关修复 | 无 high/critical CVE | 🔧 开发自查（前端） |
| DEP-11 | `axios` 1.x 已知漏洞（SSRF、header 注入） | 同上 | 无 high/critical CVE | 🔧 开发自查（前端） |
| DEP-12 | `echarts` 5.5.x 已知漏洞（XSS via label formatter） | 同上；关注组件注入、事件处理相关 CVE | 无 high/critical CVE；且项目按需引入仅 bar 模块，攻击面小 | 🔧 开发自查（前端） |
| DEP-13 | `socket.io-client` 4.x 已知漏洞 | 同上 | 无 high/critical CVE | 🔧 开发自查（前端） |
| DEP-14 | `vite` 5.x 构建工具已知漏洞（开发依赖） | `npm audit`（含 devDependencies）；关注 dev server 任意文件读取类漏洞 | 开发依赖漏洞风险较低（不部署到生产），但应保持最新 | 🔧 开发自查（前端） |
| DEP-15 | 飞书官方 H5 组件库 `byted-ui-mobile` 版本与安全公告 | 检查组件库文档/CHANGELOG 中的安全相关修复 | 使用 latest 稳定版本 | 🔧 开发自查（前端） |

### 6.3 基础设施依赖扫描

| 类别 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| DEP-16 | PostgreSQL 15 已知 CVE | `docker inspect vote-pg` 确认镜像 tag；检查 Docker Hub / PostgreSQL 安全公告 | 使用最新的 PG 15.x 补丁版本 | 🔧 开发自查 |
| DEP-17 | Redis 7 已知 CVE | 同上；特别关注未授权访问、Lua 沙箱逃逸类漏洞 | 使用最新的 Redis 7.x 补丁版本 | 🔧 开发自查 |
| DEP-18 | Nginx 1.25 已知 CVE | `docker inspect vote-nginx` 确认镜像 tag | 使用最新的 nginx:1.25-alpine | 🔧 开发自查 |
| DEP-19 | Docker 基础镜像 `node:20-alpine` 系统包漏洞 | `docker scan vote-app` 或 Trivy 扫描 | 无 high/critical OS 级别 CVE；定期重建镜像获取安全更新 | 🔧 开发自查 |

### 6.4 依赖审计最佳实践

| 编号 | 建议 | 说明 |
|------|------|------|
| DEP-20 | 启用 Dependabot / Renovate 自动 PR | 配置 GitHub/GitLab 依赖自动更新机器人，每周检查并自动提交安全更新 PR |
| DEP-21 | CI 中集成 `npm audit --audit-level=high` | 在 CI 流水线中添加 `npm audit --production --audit-level=high` 步骤，high/critical 漏洞阻断构建 |
| DEP-22 | 定期执行容器镜像扫描 | 每次部署前执行 `docker scan` 或 `trivy image` 扫描所有镜像 |

---

## 七、输入校验与注入防护检查

### 7.1 后端校验 (zod schema)

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| INP-01 | `title` 校验：1-100 字符，trim 非空 | 审查 zod schema `z.string().min(1).max(100)` | 空字符串、纯空格、超长字符串均被拒绝 | 🔧 开发自查 |
| INP-02 | `options` 校验：2-10 项，每项 1-50，不重复 | 审查 zod schema `z.array(z.string().min(1).max(50)).min(2).max(10)` + `.refine()` 校验重复 | 少于 2 项、多于 10 项、空选项、重复选项均被拒绝 | 🔧 开发自查 |
| INP-03 | `deadline_minutes` 校验：1-10080 | 审查 zod schema `z.number().int().min(1).max(10080)` | 0、负数、小数、>10080 均被拒绝 | 🔧 开发自查 |
| INP-04 | `option_ids` 校验：非空数组、所有 ID 属于本投票 | 审查 zod schema + 业务校验逻辑 | 空数组、含不属于本投票的 ID、含重复 ID 均被拒绝 | 🔧 开发自查 |
| INP-05 | `vote_type` / `vote_mode` 枚举值校验 | 审查 zod schema `z.enum(['single','multi'])` / `z.enum(['anonymous','public'])` | 非法枚举值被拒绝；不接受大小写变体 | 🔧 开发自查 |

### 7.2 XSS 防护

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| XSS-01 | React JSX 默认转义是否生效 | 审查前端组件是否使用 `dangerouslySetInnerHTML` | 不可使用 `dangerouslySetInnerHTML`；所有 `{title}` `{content}` 通过 JSX 默认转义 | 🔧 开发自查（前端） |
| XSS-02 | API 返回 JSON 中 `title` / `content` 不做额外转义（JSON 自动安全） | 确认后端未对输出做 HTML 编码（会导致前端显示异常）；由前端 React 渲染时转义 | 后端输出原始文本，前端 React 转义 | 🔧 开发自查 |

### 7.3 SQL 注入

| 编号 | 检查项 | 检查方法 | 判定标准 | 执行阶段 |
|------|--------|----------|----------|----------|
| SQL-01 | 所有查询是否使用 Knex.js 参数化 | 审查所有 `db('votes').where(...)` / `db.raw(...)` 调用 | 不可有字符串拼接 SQL（如 `` db.raw(`SELECT * FROM votes WHERE id = '${voteId}'`) ``）；`db.raw('...', [param])` 正确使用占位符 | 🔧 开发自查 |
| SQL-02 | 是否存在动态 ORDER BY / GROUP BY 注入风险 | 审查列表查询中分页/排序逻辑；若存在动态排序字段，是否使用白名单校验 | 列表 API 当前无动态排序参数（仅 status/page/size），无注入风险；若后续增加 sort 参数需白名单 | 🔧 开发自查 |

---

## 八、执行阶段划分总结

### A. 🔧 当前阶段可自查项（阶段四 · 开发自查）

以下检查项无需部署运行环境，通过代码审查和配置检查即可完成：

| 检查类别 | 检查项编号 | 数量 |
|----------|-----------|------|
| 认证与授权 | AUTH-01 ~ AUTH-05, RBAC-01 ~ RBAC-06, WS-01 ~ WS-03 | 14 |
| 数据安全 | DATA-01 ~ DATA-04, TLS-01 ~ TLS-04, TOK-01 ~ TOK-03, IDEM-01 ~ IDEM-04, RET-01 ~ RET-04 | 19 |
| 输入校验 | INP-01 ~ INP-05, XSS-01 ~ XSS-02, SQL-01 ~ SQL-02 | 9 |
| 埋点规范 | TRK-01 ~ TRK-14, MET-01 ~ MET-02 | 16 |
| 合规审计 | CPL-01 ~ CPL-11 | 11 |
| 依赖扫描 | DEP-01 ~ DEP-22 | 22 |
| **合计** | | **91** |

> 💡 **开发自查建议**：按模块分配
> - **凌霜（后端）**：AUTH-01~05, RBAC-01~06, WS-01~03, DATA-01~04, TLS-01~04, TOK-01~03, IDEM-01~04, RET-01~04, INP-01~05, XSS-02, SQL-01~02, TRK-01~09, TRK-11~14, CPL-04~11, DEP-01~09, DEP-16~19
> - **流光（前端）**：CPL-01~03, XSS-01, TOK-03, TRK-10, DEP-10~15
> - **长夜（DevOps）**：TLS-01~04, MET-01~02, DEP-16~22

### B. 🧪 阶段五渗透项（需部署环境才能执行）

| 检查类别 | 检查项编号 | 数量 | 说明 |
|----------|-----------|------|------|
| 认证穿透 | PEN-01 ~ PEN-04 | 4 | 需要合法 token 和部署环境 |
| 速率限制穿透 | PEN-05 ~ PEN-09 | 5 | 需要运行中的 Redis + App |
| 业务校验穿透 | PEN-10 ~ PEN-14 | 5 | 需要完整的 PG 数据 |
| 数据库防重穿透 | PEN-15 ~ PEN-16 | 2 | 需要并发测试工具 |
| 综合防刷场景 | PEN-17 ~ PEN-20 | 4 | 需要模拟多种攻击场景 |
| 依赖漏洞终扫 | DEP-01~19（阶段五复扫） | 19 | 部署后重新扫描最新 CVE 数据库 |
| 监控指标验证 | MET-01 | 1 | 部署后验证 metrics 端点 |
| **合计** | | **40** | |

---

## 九、发现的风险项与建议

| 编号 | 风险发现 | 严重程度 | 建议 |
|------|----------|----------|------|
| RISK-01 | 架构未实现 IP 维度速率限制（仅 user_id 维度） | 🟡 中 | 若攻击者通过 SSO 获取多个合法 token，可用不同 user_id 绕过 user_id 维度限流；建议后续版本增加 IP 维度辅助限流；MVP 阶段风险可控（飞书 SSO token 绑定真实身份，获取多 token 门槛高） |
| RISK-02 | 无用户主动删除投票记录 API | 🟡 中 | 违反 GDPR「被遗忘权」；MVP 阶段可接受（投票不可更改，删除需人工运维），后续版本需补充 `DELETE /api/votes/:id/my-vote` |
| RISK-03 | `/health/metrics` 端点认证策略未明确 | 🟢 低 | 建议 Nginx 层限制内网 IP 访问（`allow 10.0.0.0/8; deny all;`），避免公网暴露 |
| RISK-04 | 日志中 `userId` 直接使用飞书 `open_id` 原始值 | 🟢 低 | `open_id` 是飞书内部标识，非用户个人身份信息；若合规要求更严格可在 logger 序列化层做 hash；当前方案可接受 |
| RISK-05 | MVP 使用自签证书 → 飞书 WebView 可能报警告 | 🟡 中 | 自签证书需在客户端安装 CA 信任；建议尽快替换为云厂商免费证书或 Let's Encrypt；架构已标注此风险（B-1） |

---

> 📋 **文档版本**：v1.0 | 审计人：知微 | 状态：待 EeiMoo 审核
> 
> **下一步**：开发团队按「阶段四可自查项」执行自查 → 知微收集自查结果 → 阶段五执行渗透测试
