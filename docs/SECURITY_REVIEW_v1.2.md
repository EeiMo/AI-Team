# 安全审查报告 — 团队即时投票工具 v1.2

> **版本**：v1.2（第二轮迭代安全审查）  
> **审查人**：知微 🛡️  
> **日期**：2026-06-02  
> **审查范围**：飞书 SSO 安全审查 + 日志脱敏复查 + CI/CD 安全审查  
> **审查方法**：静态代码审查 + npm audit 依赖扫描  
> **审查代码**：凌霜（后端 SSO） + 长夜（CI/CD 流水线）  
> **关联模板**：EVO-011 安全审查模板（基于 v1.0 SECURITY_AUDIT）  
> **关联进化项**：EVO-014（匿名投票 SHA256 脱敏）

---

## 一、飞书 SSO 安全审查

### 1.1 OAuth State 参数防 CSRF

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-01 | 随机 state 生成 | ✅ 通过 | `routes/auth.ts:32` — `crypto.randomBytes(32).toString('hex')` | 64 字符十六进制随机值，熵值 256 bit，不可预测 |
| SSO-02 | state 存储与有效期 | ✅ 通过 | `routes/auth.ts:263-271` — `redis.set(stateKey, '1', 'EX', config.OAUTH_STATE_TTL)`，TTL 默认 600s | Redis 存储，10 分钟过期 |
| SSO-03 | state 一次性校验 | ✅ 通过 | `routes/auth.ts:295-300` — 读取后立即 `redis.del(stateKey)` | 防重放攻击 |
| SSO-04 | state 校验失败处理 | ✅ 通过 | `routes/auth.ts:304` — `throw AppError(40001, 'state 无效或已过期')` | 拒绝继续 OAuth 流程 |
| SSO-05 | Redis 不可用时降级 | ⚠️ 风险接受 | `routes/auth.ts:270,302` — Redis 失败时跳过 state 验证，`stateValid = true` | 降级时 CSRF 防护失效；考虑到 Redis 宕机概率低 + 飞书 SSO 本身有 code 一次性机制，风险可控 |

**总体评估**：✅ 通过。OAuth state CSRF 防护机制设计合理，state 生成（加密随机）、存储（Redis TTL）、校验（一次性删除）均正确实现。Redis 不可用时的降级为有意识的风险接受。

### 1.2 Redirect_URI 安全性

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-06 | redirect_uri 从配置读取 | ✅ 通过 | `routes/auth.ts:256-260` — `config.FEISHU_REDIRECT_URI` 环境变量 | 非硬编码，灵活性好 |
| SSO-07 | redirect_uri 未配置时拒绝 | ✅ 通过 | `routes/auth.ts:258-260` — `throw AppError(50001, '飞书回调地址未配置')` | 防止未配置时生成无效 URL |
| SSO-08 | redirect_uri 白名单校验 | ⚠️ 缺失 | 代码中无任何白名单比对逻辑 | **风险**：若攻击者能控制 `FEISHU_REDIRECT_URI` 环境变量（如通过 CI/CD 或服务器入侵），可劫持 OAuth 回调到恶意地址；**但**：1) 环境变量仅服务器可设置，2) 飞书开放平台后台还需配置安全域名双重校验。**建议**：添加 Nginx 层 Referer/Origin 校验作为额外防护层 |

**总体评估**：⚠️ 通过但建议增强。当前依赖环境变量 + 飞书平台双因素控制，缺少应用层白名单校验。

### 1.3 App Access Token 缓存与过期处理

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-09 | 模块级缓存 | ✅ 通过 | `routes/auth.ts:88-95` — `_cachedAppToken: { token, expires }` | 独立缓存，避免每次请求飞书 API |
| SSO-10 | 提前刷新（安全余量） | ✅ 通过 | `routes/auth.ts:121` — `expires: ... - 600_000`（提前 10 分钟） | 防止 token 刚好过期的时间窗口 |
| SSO-11 | 获取失败处理 | ✅ 通过 | `routes/auth.ts:103-112` — 抛 `AppError(50002)` 并包含错误上下文 | 阻止未认证请求继续 |
| SSO-12 | API 请求重试机制 | ✅ 通过 | `routes/auth.ts:44-80` — `fetchWithRetry` 指数退避重试（最多 3 次） | 5xx 和网络错误重试，4xx 不重试（防止凭证错误反复重试） |

**总体评估**：✅ 通过。token 缓存策略完善，提前刷新机制避免边界问题，重试逻辑合理。

### 1.4 User Access Token 验签流程

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-13 | authorization_code → access_token | ✅ 通过 | `routes/auth.ts:127-168` — `POST /open-apis/authen/v1/oidc/access_token` | 使用飞书标准 OAuth 2.0 流程 |
| SSO-14 | user_info 验签 | ✅ 通过 | `routes/auth.ts:172-199` — `GET /open-apis/authen/v1/user_info` | Bearer token 调用飞书官方 API 验签 |
| SSO-15 | 中间件层 token 多层校验 | ✅ 通过 | `middleware/auth.ts:78-100` — dev → JWT → 飞书 API 三级校验 | 自动识别 token 类型 |

**总体评估**：✅ 通过。user_access_token 的换取、验签流程均调用飞书官方 API，验证链完整。

### 1.5 JWT 密钥强度与轮换

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-16 | JWT_SECRET 环境变量化 | ⚠️ 默认值风险 | `config.ts:31` — `JWT_SECRET: process.env.JWT_SECRET \|\| 'dev-jwt-secret-change-in-production'` | **风险**：默认值 `dev-jwt-secret-change-in-production` 是一个硬编码的已知字符串，若生产部署时未设置 `JWT_SECRET` 环境变量，JWT 签名密钥即为该已知值，任何人可伪造 JWT token |
| SSO-17 | JWT 有效时长 | ✅ 通过 | `config.ts:34` — `JWT_EXPIRES_IN: '24h'`，可配置 | 默认 24 小时有时间限制，建议生产缩短至 2-4h |
| SSO-18 | JWT 密钥轮换机制 | ❌ 缺失 | 无密钥版本号、无多密钥并存的过渡机制 | **建议**：引入密钥版本化（`kid` + 验证数组），支持灰度轮换 |

**总体评估**：⚠️ 需要关注。JWT_SECRET 硬编码默认值是主要风险点；密钥轮换机制缺失但 MVP 阶段可接受。

### 1.6 Dev 降级模式安全性（🔴 关键发现）

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-19 | Dev 登录端点 NODE_ENV 检查 | ✅ 通过 | `routes/auth.ts:354-356` — `if (config.NODE_ENV === 'production') { throw AppError(40302) }` | dev/login 路由正确禁用生产环境 |
| **SSO-20** | **Dev token 中间件 `NODE_ENV` 检查** | **🔴 致命** | `middleware/auth.ts:82-90` — `if (token.startsWith('dev_')) { ... }` **无条件执行，不检查 `NODE_ENV`** | **🔴 严重漏洞**：`verifyFeishuToken()` 中 dev_ 前缀检查在所有环境（包括 production）均生效。攻击者构造任意 `dev_<user_id>_<team_id>_<name>` token 即可在生产环境绕过飞书 SSO 认证，以伪造身份调用所有受保护的 API |

**攻击向量**：
```
# 攻击者无需任何飞书账号，即可：
curl -H "Authorization: Bearer dev_attacker_targetTeam_Admin" \
     https://eeimoo.cn/api/votes
# → 以 attacker 身份冒充 targetTeam 团队成员，获取投票列表
# → 可查看、提交任意团队投票，绕过所有权限检查
```

**根因**：`verifyFeishuToken()` 的第 1 步（dev_ 前缀检查）未包裹 `config.NODE_ENV !== 'production'` 守卫。

### 1.7 日志中 Token/Secret 泄露审查

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-21 | JWT token 前缀日志输出 | 🔴 高风险 | `routes/auth.ts:334` — `console.info('[AuthRoute] JWT 签发完成', { tokenPrefix: token.substring(0, 20) + '...', ... })` | **JWT token 前 20 个字符写入日志**。JWT header + payload 前几个字节可被利用（尤其当 payload 开头为 `{"user_id":"..."` 时泄漏用户身份）。**建议**：不应记录任何 token 片段，仅记录 `tokenId: crypto.randomUUID()` |
| SSO-22 | 飞书 API 错误响应体截断输出 | 🟡 中等 | `routes/auth.ts:113,163,191` — `errBody.slice(0, 200)` 包含在错误消息中 | 飞书 API 错误响应可能包含 token、app_secret 等敏感信息。错误消息作为 `AppError.detail` 存入日志 |
| SSO-23 | 中间件认证失败日志 | 🟡 中等 | `middleware/auth.ts:123` — `console.error('[Auth] 飞书 SSO 验签失败:', err)` | 错误对象 `err` 可能包含用户提交的原始 token |
| SSO-24 | OAuth state 部分日志 | 🟢 低 | `routes/auth.ts:280` — `state: state.slice(0, 8) + '...'` | 仅记录 state 前 8 字符，其余用 `...` 替代，无安全风险 |

**总体评估**：🔴 JWT token 前缀日志输出是关键发现，必须修复。其他项为中低风险。

### 1.8 飞书 SSO 其他安全点

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| SSO-25 | Authorization header 大小写兼容 | ✅ 通过 | `middleware/auth.ts:107` — `req.headers.authorization?.replace(/^Bearer\s+/i, '')` | 大小写不敏感处理 |
| SSO-26 | 无 Authorization header → 401 | ✅ 通过 | `middleware/auth.ts:108-110` | 明确拒绝未认证请求 |
| SSO-27 | 飞书 API 调用超时控制 | ⚠️ 无显式超时 | `routes/auth.ts` `fetchWithRetry` 无超时配置 | fetch API 在 Node.js 20 有默认超时，但未显式设置；建议添加 `AbortController` + 5s 超时 |
| SSO-28 | `upsertUser` 避免注入 | ✅ 通过 | `routes/auth.ts:228-254` — 使用 Knex.js 参数化查询 | 无 SQL 注入风险 |
| SSO-29 | 用户信息登录日志脱敏 | ✅ 通过 | `routes/auth.ts:321-323` — `crypto.createHash('sha256').update(userInfo.user_id).digest('hex').slice(0, 12)` | SSO 成功登录日志中 userId 已 SHA256 脱敏 |

---

## 二、日志脱敏复查（EVO-014 追溯）

### 2.1 EVO-014：匿名投票 SHA256 脱敏状态

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| LOG-01 | ballotService 匿名投票脱敏 | ✅ 已实现 | `ballotService.ts:155-158` — `safeUserId = voteMode === 'anonymous' ? createHash('sha256')... : userId` | EVO-014 修复已正确落地 |
| LOG-02 | 脱敏无误回退 | ✅ 通过 | `ballotService.ts:156` — 实名模式仍输出原始 `userId`，匿名模式 SHA256 前 12 字符 | 符合预期 |
| LOG-03 | `upsertUser` 失败日志脱敏 | ✅ 通过 | `routes/auth.ts:244-249` — `crypto.createHash('sha256').update(user.user_id)...` | 已脱敏 |

### 2.2 未覆盖的敏感日志输出（新增发现）

| 编号 | 位置 | 日志内容 | 风险 | 建议 |
|------|------|----------|------|------|
| **LOG-04** | `voteService.ts:168` ↵ | `console.info('[VoteService] 创建投票成功', { voteId, userId, teamId })` | 🟡 原始 userId 输出（`ou_xxx` 格式） | 对 userId 做 SHA256 脱敏 |
| **LOG-05** | `voteService.ts:356` ↵ | `console.info('[VoteService] 手动结束投票', { voteId, userId })` | 🟡 原始 userId 输出 | 同上 |
| **LOG-06** | `ws/handlers.ts:87` ↵ | `console.info('[WS] 客户端连接', { socketId, userId, teamId })` | 🟡 原始 userId 输出 | 同上 |
| **LOG-07** | `ws/handlers.ts:92-95` | `console.info('[WS] 加入房间', ...)` + `[WS] 离开房间` | 🟡 原始 userId 输出 | 同上 |
| LOG-08 | `deadlineWorker.ts:69,71` | `console.info('[DeadlineWorker] 自动结束投票', ...)` + `[DeadlineWorker] 最终票数` | 🟢 低 | 不含 userId，无风险 |
| LOG-09 | `deadlineWorker.ts:144` | `console.info('[DeadlineWorker] 启动兜底扫描', { count })` | 🟢 低 | 仅计数值 |
| LOG-10 | `redisHealth.ts:45,59,65` | 降级/恢复日志 | 🟢 低 | 仅 Redis 状态信息 |
| LOG-11 | `tallySync.ts:75` | `console.error('[TallySync] 同步失败:', err)` | 🟢 低 | 无用户数据 |

**总体评估**：⚠️ EVO-014 的核心修复（匿名投票脱敏）已正确实现且未被回退，但日志脱敏未全面覆盖所有 userId 输出点。`voteService.ts` 和 `ws/handlers.ts` 中的 `console.info` 仍输出原始 userId。

### 2.3 数据库连接 URL 硬编码凭证

| 编号 | 检查项 | 状态 | 证据 / 代码位置 | 分析 |
|------|--------|------|----------------|------|
| LOG-12 | config.ts 默认 DATABASE_URL 含凭证 | 🟡 中等 | `config.ts:17` — `DATABASE_URL: ... \|\| 'postgresql://vote_user:vote_pass@localhost:5432/vote_db'` | 硬编码默认数据库密码 `vote_pass`。若 config 对象被日志输出或错误堆栈打印，凭证将泄露。**建议**：默认值设为空字符串，无配置时启动报错退出 |

---

## 三、CI/CD 安全审查

### 3.1 Secrets 管理

| 编号 | 检查项 | 状态 | 证据 | 分析 |
|------|--------|------|------|------|
| CI-01 | GitHub Actions secrets 管理 | ✅ 通过 | `ci-pipeline.yml:29-37` — 所有敏感值通过 `${{ secrets.XXX }}` 引用 | 使用 GitHub 加密 secrets |
| CI-02 | secrets 注入方式 | ✅ 通过 | 环境变量注入（`env:` 块 + deploy 脚本 `export`），非明文 | 正确实践 |
| CI-03 | `FEISHU_APP_SECRET` 保护 | ✅ 通过 | `ci-pipeline.yml:34` — `secrets.FEISHU_APP_SECRET` | 飞书密钥通过 secrets 注入 |
| CI-04 | SSH 私钥保护 | ✅ 通过 | `ci-pipeline.yml:32` — `secrets.DEPLOY_KEY` | SSH 密钥通过 secrets 引用 |
| CI-05 | 数据库密码保护 | ✅ 通过 | `ci-pipeline.yml:33` — `secrets.PG_PASSWORD` | 数据库密码通过 secrets 注入 |
| CI-06 | 镜像仓库凭证保护 | ✅ 通过 | `ci-pipeline.yml:30-31` — `DOCKER_USERNAME` + `DOCKER_PASSWORD` 通过 secrets | docker/login-action 使用 GitHub secrets |

### 3.2 流水线安全配置

| 编号 | 检查项 | 状态 | 证据 | 分析 |
|------|--------|------|------|------|
| CI-07 | PR 触发仅 lint + test | ✅ 通过 | `ci-pipeline.yml:118` — `if: github.event_name != 'pull_request'` 跳过构建部署 | PR 不会触发部署，防止未审核代码上线 |
| CI-08 | 并发控制 | ✅ 通过 | `ci-pipeline.yml:45-47` — `concurrency: group: ${{ github.ref }}, cancel-in-progress: false` | 同一分支仅一个流水线运行，防止竞态部署 |
| CI-09 | 环境隔离 | ✅ 通过 | `ci-pipeline.yml:147-148` — `environment: name: ${{ github.event.inputs.environment \|\| 'staging' }}` | 手动选择 staging/production 环境 |
| CI-10 | 手动触发保护 | ✅ 通过 | `ci-pipeline.yml:19-33` — `workflow_dispatch` 需要环境参数输入 | 不能通过 API 随意触发部署 |
| CI-11 | 回滚机制 | ✅ 通过 | `ci-pipeline.yml:201-243` — 冒烟测试失败自动回滚 | 部署的安全网 |
| CI-12 | 镜像签名验证 | ❌ 缺失 | 无 Docker Content Trust / cosign 签名验证 | **建议**：引入镜像签名机制（`cosign sign`），防止供应链攻击 |
| CI-13 | 依赖漏洞扫描 | ❌ 缺失 | 流水线中无 `npm audit` / OWASP Dependency Check 步骤 | **建议**：在 lint 或 test 阶段添加 `npm audit --audit-level=moderate` 步骤 |
| CI-14 | 静态安全扫描（SAST） | ❌ 缺失 | 无 CodeQL / SonarQube 安全扫描步骤 | **建议**：添加 GitHub CodeQL analysis workflow |

### 3.3 Docker 安全

| 编号 | 检查项 | 状态 | 证据 | 分析 |
|------|--------|------|------|------|
| CI-15 | 非 root 用户运行 | ✅ 通过 | `app.Dockerfile:41-45` — `addgroup -g 1001 vote && adduser -u 1001 -G vote` + `USER vote` | 容器以非特权用户运行 |
| CI-16 | 多阶段构建 | ✅ 通过 | `app.Dockerfile:26,43` — builder 阶段 → 运行时阶段 | 减小攻击面，devDependencies 不进入最终镜像 |
| CI-17 | 基础镜像固定版本 | ✅ 通过 | `nginx:1.25-alpine`, `node:20-alpine`, `postgres:15-alpine`, `redis:7-alpine` | 固定主版本号，避免意外升级 |
| CI-18 | Docker 健康检查 | ✅ 通过 | `app.Dockerfile:52-53` — `HEALTHCHECK ... curl -f` | 支持自动重启不健康容器 |
| CI-19 | 敏感环境变量 Docker Compose 注入 | ⚠️ 关注 | `docker-compose.yml:60-62` — `FEISHU_APP_ID: ${FEISHU_APP_ID}` | 环境变量在容器内可通过 `docker inspect` / `/proc/<pid>/environ` 暴露，但 Docker 内默认仅同用户可见 |

### 3.4 Nginx 安全配置审查

| 编号 | 检查项 | 状态 | 证据 | 分析 |
|------|--------|------|------|------|
| CI-20 | HTTP → HTTPS 301 重定向 | ✅ 通过 | `nginx.conf:99-100` — `return 301 https://$host$request_uri` | 强制 HTTPS |
| CI-21 | TLS 版本 ≥ 1.2 | ✅ 通过 | `nginx.conf:114` — `ssl_protocols TLSv1.2 TLSv1.3` | 禁用 TLSv1.0/1.1 |
| CI-22 | 强密码套件 | ✅ 通过 | `nginx.conf:115` — `ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256` | 无 RC4/3DES 弱密码 |
| CI-23 | 安全响应头 | ✅ 通过 | `nginx.conf:122-125` — `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy` | 4 个安全头已配置 |
| CI-24 | Access log 不含 Authorization | ✅ 通过 | `nginx.conf:52-55` — log_format 仅含 `$request`, `$http_referer`, `$http_user_agent`, `$http_x_request_id` | **不包含** `$http_authorization`，token 不会泄露到 Nginx 日志 |
| CI-25 | 健康检查不记日志 | ✅ 通过 | `nginx.conf:130` — `access_log off` for `/health` | 减少日志噪音 |
| CI-26 | 静态资源强缓存 | ✅ 通过 | `nginx.conf:135-140` — `/assets/` 30d 缓存 + `immutable` | 性能优化，无安全风险 |
| CI-27 | WebSocket Origin 校验 | ⚠️ 缺失 | Nginx 层无 `valid_referers` 或 `if ($http_origin)` 规则 | 建议添加飞书白名单 Origin 校验（已在 v1.0 报告中指出，仍未实现） |
| CI-28 | CORS 配置 | ⚠️ 关注 | Nginx 无 `add_header Access-Control-Allow-Origin`；后端使用 `cors` npm 包默认配置 | 需确认 `cors` 包是否限制了允许的 Origin |
| CI-29 | CSP 内容安全策略头 | ❌ 缺失 | 无 `Content-Security-Policy` 头 | **建议**：添加 CSP 头，防御 XSS 攻击 |

### 3.5 网络与基础设施

| 编号 | 检查项 | 状态 | 证据 | 分析 |
|------|--------|------|------|------|
| CI-30 | 数据库端口绑定 | ⚠️ 关注 | `docker-compose.yml:107` — `ports: "127.0.0.1:5432:5432"` | PostgreSQL 仅绑定回环地址，外部不可达；**但**同主机其他进程可访问 |
| CI-31 | Redis 端口绑定 | ⚠️ 关注 | `docker-compose.yml:122` — `ports: "127.0.0.1:6379:6379"` | Redis 仅绑定回环地址；**但未配置密码**（Redis 命令中无 `--requirepass`） |
| CI-32 | Redis 无密码 | 🟡 中等 | `docker-compose.yml:116-122` — Redis 命令行未含 `--requirepass` | 虽然仅绑定 127.0.0.1，但同主机多用户或多容器场景下存在未授权访问风险 |
| CI-33 | Redis appendonly 持久化 | 🟢 低 | `docker-compose.yml:118` — `--appendonly yes` | AOF 文件可能包含 session/token 数据 |

---

## 四、依赖安全检查

### 4.1 npm Audit 结果

| 服务 | 漏洞 | 严重度 | 详情 | 修复 |
|------|------|--------|------|------|
| 后端 | `uuid@<11.1.1` | 🟡 Moderate | GHSA-w5hq-g745-h8pq: Missing buffer bounds check in v3/v5/v6 | `npm audit fix --force` → uuid@14.0.0（破坏性变更） |
| 前端 | `esbuild@<=0.24.2` (via vite@5.3.1) | 🟡 Moderate | GHSA-67mh-4wv8-2f99: Dev server allows arbitrary origin reads | `npm audit fix --force` → vite@8.0.16（破坏性变更） |
| 前端 | `vite@<=6.4.1` | 🟡 Moderate | 同上（被 esbuild 影响） | 同上 |

### 4.2 漏洞影响分析

| 漏洞 | 影响范围 | 生产可利用性 | 建议 |
|------|----------|-------------|------|
| uuid buffer bounds | 仅影响后端使用 `uuid` 包的功能（voteId 生成等） | 🟢 低 — 需要攻击者控制 buffer 参数 | 生产前升级至 uuid@11.1.1+ |
| esbuild dev server | 仅影响前端 dev 模式（`vite dev`） | 🟢 低 — 生产使用 Nginx 静态服务，无 dev server | 生产不受影响，dev 环境需注意 |
| vite 间接依赖 | 同上 | 🟢 低 | 同上 |

### 4.3 依赖清单审查

| 依赖 | 版本 | 已知 CVE | 说明 |
|------|------|----------|------|
| express | ^4.21.0 | 无 | 最新稳定版本 |
| socket.io | ^4.7.5 | 无 | 最新 4.x 版本 |
| knex | ^3.1.0 | 无 | 稳定版本 |
| pg | ^8.12.0 | 无 | 最新 8.x 版本 |
| ioredis | ^5.4.1 | 无 | 最新 5.x 版本 |
| jsonwebtoken | ^9.0.2 | 无 | 稳定版本 |
| zod | ^3.23.8 | 无 | 最新 3.x 版本 |
| react | ^18.3.1 | 无 | React 18 稳定版 |

---

## 五、发现汇总与风险评级

### 5.1 致命漏洞（P0 — 必须上线前修复）

| 编号 | 发现 | 文件 | 影响 |
|------|------|------|------|
| **CVE-001** | 🔴 **Dev token 绕过生产认证** — `verifyFeishuToken()` 不检查 `NODE_ENV`，攻击者可构造 `dev_*` token 在 production 环境任意访问 API | `middleware/auth.ts:82-90` | 完全绕过 SSO 认证，伪造任意身份 |
| **CVE-002** | 🔴 **JWT token 片段写入日志** — OAuth 回调成功后日志输出 `token.substring(0, 20)`，泄露 JWT 前 20 字符 | `routes/auth.ts:334` | 日志泄露导致 token 部分明文暴露 |

### 5.2 高危发现（P1 — 建议上线前修复）

| 编号 | 发现 | 文件 | 影响 |
|------|------|------|------|
| VUL-001 | 🟠 **JWT_SECRET 硬编码已知默认值** — `'dev-jwt-secret-change-in-production'`，生产部署未覆盖则所有人可伪造 JWT | `config.ts:31` | JWT 签名密钥泄露 |
| VUL-002 | 🟠 **config.ts 默认 DATABASE_URL 硬编码凭证** — `vote_user:vote_pass` 明文密码 | `config.ts:17` | 数据库凭证泄露风险 |
| VUL-003 | 🟠 **飞书 API 错误响应截断写入日志** — `errBody.slice(0, 200)` 可能包含 token/secret | `routes/auth.ts:113,163,191` | 敏感信息泄露 |
| VUL-004 | 🟠 **中间件认证失败日志可能含原始 token** — `console.error(err)` 直接输出错误对象 | `middleware/auth.ts:123` | Token 信息泄露 |

### 5.3 中等发现（P2 — 上线前或迭代中修复）

| 编号 | 发现 | 文件 | 影响 |
|------|------|------|------|
| MED-001 | 🟡 日志脱敏未全面覆盖 — `voteService.ts` 和 `ws/handlers.ts` 的 `console.info` 仍输出原始 userId | 多处 | 日志泄露用户身份 |
| MED-002 | 🟡 Redis 无密码保护 — 仅 bind 127.0.0.1 但无 `requirepass` | `docker-compose.yml` | 同主机未授权访问 |
| MED-003 | 🟡 redirect_uri 无应用层白名单校验 — 仅依赖环境变量 | `routes/auth.ts:256` | 开放重定向（需配合环境变量修改 + 飞书平台绕过） |
| MED-004 | 🟡 WS Origin 校验缺失 — Nginx 和后端均未实现 | `nginx.conf`, `ws/handlers.ts` | 跨域 WebSocket 连接风险 |
| MED-005 | 🟡 CI/CD 无依赖漏洞扫描步骤 | `ci-pipeline.yml` | `npm audit` 未集成到流水线 |
| MED-006 | 🟡 无 Docker 镜像签名 | `ci-pipeline.yml` | 供应链安全 |

### 5.4 低优建议（P3 — 迭代改进）

| 编号 | 发现 | 建议 |
|------|------|------|
| LOW-001 | 无 CSP 安全头 | Nginx 添加 `Content-Security-Policy` 头 |
| LOW-002 | 无 CI/CD SAST 扫描 | 添加 GitHub CodeQL workflow |
| LOW-003 | 飞书 API 调用无显式超时 | 添加 `AbortController` + 5s 超时 |
| LOW-004 | 无 JWT 密钥轮换机制 | 引入密钥版本化 |
| LOW-005 | `ballotService.ts` 死代码 | 删除不可达的 `return` 语句（第 157-163 行） |
| LOW-006 | 无 `/health/metrics` 端点 | 实现监控指标暴露 |

---

## 六、修复建议详情

### 6.1 CVE-001 修复：Dev Token 绕过（🔴 P0）

**问题代码** (`middleware/auth.ts:82-90`):
```typescript
if (token.startsWith(DEV_TOKEN_PREFIX)) {
    const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
    return {
        user_id: decodeURIComponent(parts[0] || 'ou_dev_user_001'),
        team_id: decodeURIComponent(parts[1] || 'dev_team_001'),
        display_name: decodeURIComponent(parts[2] || '开发用户'),
    };
}
```

**修复方案**：
```typescript
if (token.startsWith(DEV_TOKEN_PREFIX)) {
    if (config.NODE_ENV === 'production') {
        throw new Error('开发 token 不可在生产环境使用');
    }
    const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
    return {
        user_id: decodeURIComponent(parts[0] || 'ou_dev_user_001'),
        team_id: decodeURIComponent(parts[1] || 'dev_team_001'),
        display_name: decodeURIComponent(parts[2] || '开发用户'),
    };
}
```

### 6.2 CVE-002 修复：JWT Token 日志泄露（🔴 P0）

**问题代码** (`routes/auth.ts:332-335`):
```typescript
console.info('[AuthRoute] JWT 签发完成', {
    userId: safeUserId,
    tokenPrefix: token.substring(0, 20) + '...',  // ❌ 泄露 JWT 片段
});
```

**修复方案**：不记录 token 任何片段，改用 token 摘要或 UUID：
```typescript
console.info('[AuthRoute] JWT 签发完成', {
    userId: safeUserId,
});
```

### 6.3 VUL-001 修复：JWT_SECRET 默认值

**修复方案**：config.ts 不设默认值，无 JWT_SECRET 时启动报错：
```typescript
JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'dev-jwt-secret-change-in-production') {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('生产环境必须配置 JWT_SECRET 环境变量');
        }
    }
    return secret || 'dev-jwt-secret-change-in-production';
})(),
```

### 6.4 VUL-002 修复：DATABASE_URL 默认凭证

**修复方案**：移除硬编码凭证：
```typescript
DATABASE_URL: process.env.DATABASE_URL || '',
// 启动检查：
if (!config.DATABASE_URL) throw new Error('DATABASE_URL 未配置');
```

### 6.5 日志脱敏统一修复 (MED-001)

为 `voteService.ts` 和 `ws/handlers.ts` 的日志输出添加 userId 脱敏：

```typescript
// votesService.ts
const safeUserId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12);
console.info('[VoteService] 创建投票成功', { voteId, userId: safeUserId, teamId });
```

### 6.6 CI/CD 增强建议

1. **添加 npm audit 步骤**：在 `test` job 之前添加：
   ```yaml
   - name: Security Audit
     run: npm audit --audit-level=moderate
   ```

2. **添加 Docker 镜像签名**：引入 cosign

3. **添加 CodeQL 扫描**：使用 GitHub 官方 action

---

## 七、漏洞统计与判定

### 7.1 审查总览

| 分类 | 检查项数 | ✅ 通过 | ⚠️ 风险 | 🔴 致命 | 🟠 高危 | 🟡 中等 |
|------|---------|---------|---------|---------|---------|---------|
| 飞书 SSO 安全 | 29 | 21 | 4 | 2 | 2 | 0 |
| 日志脱敏 | 12 | 4 | 0 | 0 | 0 | 5 |
| CI/CD 安全 | 33 | 22 | 2 | 0 | 0 | 4 |
| 依赖安全 | 2 | 0 | 1 | 0 | 0 | 1 |
| **合计** | **76** | **47** | **7** | **2** | **2** | **10** |

### 7.2 综合判定

| 项 | 判定 |
|----|------|
| 飞书 SSO OAuth 流程 | ✅ 通过 — state/CSRF 防护正确，授权码换取流程标准 |
| App Access Token 管理 | ✅ 通过 — 缓存 + 提前刷新 + 重试机制完善 |
| User Token 验签 | ✅ 通过 — 调用飞书官方 API 验签 |
| Dev 降级模式安全 | 🔴 **No-Go** — 致命漏洞 CVE-001 需紧急修复 |
| JWT 安全 | 🟠 需修复 — VUL-001/002 上线前必须解决 |
| 日志安全 | 🟠 需修复 — CVE-002 Token 日志泄露 + MED-001 脱敏不全 |
| CI/CD Secrets 管理 | ✅ 通过 — 全部通过 GitHub secrets 引用 |
| CI/CD 安全扫描 | 🟡 缺失 — npm audit / SAST 未集成 |
| Nginx 安全配置 | ✅ 通过 — TLS/安全头/AccessLog 均正确 |
| 依赖漏洞 | 🟡 低风险 — uuid/esbuild 漏洞生产不可利用 |

### 7.3 最终判定

**🔴 No-Go — 存在 2 个致命漏洞，须修复后重新审查**

**阻断项**：
1. CVE-001：Dev token 生产环境绕过（`middleware/auth.ts:82-90`）
2. CVE-002：JWT token 片段写入日志（`routes/auth.ts:334`）

**修复后需复查项**：
1. VUL-001：JWT_SECRET 硬编码默认值
2. VUL-002：DATABASE_URL 硬编码凭证
3. VUL-003/004：API 错误响应日志脱敏

---

## 八、v1.0 → v1.2 变化对比

### 8.1 v1.0 发现修复状态

| v1.0 发现 | 严重度 | v1.2 状态 | 说明 |
|-----------|--------|-----------|------|
| F-01 `getVoteDetail` 无 team_id 校验 | 🟡 中等 | ❌ 未修复 | 仍未添加校验 |
| F-02 Redis tally key 清理 | 🟡 中等 | ❌ 未修复 | `closeVote()` 仍未删除 `tally` key |
| F-03 WS Origin 校验 | 🟡 中等 | ❌ 未修复 | Nginx 和后端均未实现 |
| F-04 非生产回退路径 | 🟢 低 | ✅ 进化为 CVE-001 | 该问题已从低优（安全回退）升级为致命漏洞（dev token 生产可绕过） |
| O-05 ballotService 死代码 | 🟢 低 | ❌ 未修复 | 第 157-163 行死代码仍在 |

### 8.2 v1.2 新增能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 飞书 SSO OAuth 完整流程 | ✅ 已实现 | redirect + callback + state CSRF + JWT 签发 |
| 用户自动 upsert | ✅ 已实现 | 首次 SSO 登录自动创建 DB 用户记录 |
| Dev 登录端点保护 | ✅ 已实现 | `dev/login` 正确实现 NODE_ENV 守卫 |
| JWT token 验签 | ✅ 已实现 | 中间件新增 JWT 验证路径（在飞书 API 调用前） |
| EVO-014 匿名脱敏 | ✅ 已实现 | ballotService 中 SHA256 脱敏已落地 |

---

## 九、签字

> 🛡️ **审计人**：知微  
> 📅 **日期**：2026-06-02  
> 📋 **送达**：EeiMoo（PM）、凌霜（后端）、长夜（CI/CD）  
> 🔄 **下一步**：修复 CVE-001 + CVE-002 → 寻错回归测试 → 知微复查
