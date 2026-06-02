# 团队即时投票工具 — PRD v1.2

> **迭代：「CI/CD 流水线 + 飞书 SSO 接入」**
> 
> 版本：v1.2 | 撰写人：云起 | 日期：2026-06-02
>
> 关联 PRD 基线：v1.1 | 关联架构：ARCH v1.1 | 关联部署：`deploy/` 目录

---

## 一、迭代概述

| 字段 | 内容 |
|------|------|
| 迭代版本 | v1.2 |
| 迭代代号 | CI+SSO |
| 父版本 | v1.1（已上线，3 个 P0 bug 已修复、14 项进化已完成） |
| 撰写人 | 云起 |
| 日期 | 2026-06-02 |

### 1.1 迭代背景

v1.0 经历 3 个 P0 生产 bug，完成完整复盘流程（阶段八），累计 14 项进化固化（阶段九）。当前系统存在两个长期痛点：

- **部署依赖人工**：壹墨（EeiMoo）手动执行 `git pull → npm build → docker-compose up`，无自动化测试门禁，无镜像版本追溯，冒烟测试靠人工验收。
- **假登录**：`Login.tsx` 第 2 行明确标注「MVP 无飞书 SSO」，用户手填 ID+昵称即进入系统。无真实身份、无组织架构、无权限校验，仅靠 dev token 前缀 `dev_` 降级。

本轮两件事同时推进：流水线消除人工部署瓶颈，飞书 SSO 补齐真实身份闭环。

### 1.2 迭代目标

| 模块 | 目标 | 成功度量 |
|------|------|----------|
| **CI/CD 流水线** | 代码 push → GitHub Actions 自动 test+build → 镜像推送 ghcr.io + 阿里云 ACR → 自动化部署 staging → 老板审批后部署 production | 从 push 到 staging 部署完成 ≤10 分钟；生产部署需人审批 |
| **飞书 SSO** | 接入飞书 OAuth 2.0，用户点击「飞书登录」一键授权，获取 open_id + 姓名 + 头像 | 登录耗时 ≤3 秒（首次授权），无 dev token 旁路进入生产 |

### 1.3 范围定义

**本期范围**：
- 模块 M1：CI/CD 流水线（GitHub Actions 全自动化）
- 模块 M2：飞书 SSO 登录（飞书 OAuth + 前端登录页改造 + 后端 token 验签闭环）

**范围外（本期不做）**：
- 多仓库 Monorepo 策略调整
- 容器编排升级至 Kubernetes
- 飞书组织架构同步（仅取当前用户信息）
- 权限体系（RBAC）细粒度改造
- 钉钉/企业微信 SSO

---

## 二、模块 M1：CI/CD 流水线

### 2.1 现状痛点

| 痛点 | 详情 | 影响 |
|------|------|------|
| 纯手动部署 | 壹墨 SSH 到服务器 → git pull → npm install → npm build → docker-compose up | 每次部署 ≥5 分钟，凌晨发布靠咖啡续命 |
| 无自动化测试门禁 | 修改代码后本地跑一下 `npm test`（如果记得的话），直接 push main | 3 个 P0 bug 中有 2 个本可通过单测拦截 |
| 无镜像版本管理 | 当前 `vote-app:latest` 一推了之，无法追溯某次部署对应的代码版本 | 回滚靠脑子记「上次跑的哪个 commit」，P0 事故回滚耗时 >10 分钟 |
| 无 staging 隔离 | 测试直接在生产环境做（改完 push → 手动 docker-compose up），不敢大改 | 迭代速度被恐惧支配 |
| 无审批门禁 | 任何人 push main 即可更新生产 | 无代码审查、无上线决策流程 |

### 2.2 目标流水线架构

```
代码 push / PR merge → main
        │
        ▼
┌──────────────────────────────────────────────────────┐
│  Stage 1: Lint                                        │
│  - 后端 tsc --noEmit + eslint                        │
│  - 前端 tsc --noEmit + eslint                        │
│  - 并行执行                                           │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 2: Unit Test                                   │
│  - 后端 npm test（Jest/Vitest）                       │
│  - 前端 npm test（Vitest）                            │
│  - 覆盖率阈值：≥80% 行覆盖                            │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 3: Build & Push 多仓镜像                       │
│  - docker build → app 镜像 + nginx 镜像               │
│  - tag: commit SHA (前8位) + latest                   │
│  - 双推: ghcr.io + 阿里云 ACR                         │
│  - registry 地址:                                     │
│    · ghcr.io/<owner>/vote-app:<tag>                   │
│    · registry.cn-hangzhou.aliyuncs.com/<ns>/vote-app:<tag> │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 4: Deploy Staging（自动）                      │
│  - SSH 到本机 staging 环境                            │
│  - docker pull + docker-compose up -d                 │
│  - 等待 healthy（max 60s）                            │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 5: Smoke Test（staging）                       │
│  - 健康检查 /health                                   │
│  - API 创建投票 + 提交投票 + 查看结果全链路            │
│  - WS 连接测试                                        │
│  - 失败 → 自动通知，不自动回滚（staging 允许失败）     │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 6: Production Gate（人工审批）                  │
│  - GitHub Environment Protection Rule                 │
│  - 需要审批人（壹墨/老板）在 GitHub 上点击 Approve     │
│  - 审批前可查看 staging smoke test 结果               │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 7: Deploy Production（审批通过后自动）          │
│  - 同 Stage 4 但目标为生产服务器                       │
│  - 部署前记录当前运行镜像 tag 作为回滚锚点              │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 8: Smoke Test（production）                    │
│  - 同 Stage 5                                          │
│  - 失败 → 自动回滚到上一个稳定镜像 + 飞书通知          │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│  Stage 9: 通知（可选）                                │
│  - 飞书群机器人通知部署结果                            │
│  - 包含：环境、镜像 tag、触发人、smoke test 结果       │
└──────────────────────────────────────────────────────┘
```

### 2.3 触发条件

| 触发事件 | 流水线行为 | 说明 |
|----------|-----------|------|
| `push` 到 `main` 分支 | 完整流水线：Lint → Test → Build → Deploy Staging → Smoke Test → Production Gate（审批后部署） | 合并 PR 或直接 push main 时触发 |
| `push` 到 `v*` 标签 | 同上 | 用于正式发版打 tag |
| `pull_request` 到 `main` | Lint + Test + Build（不推送镜像，不部署） | PR 阶段仅检查代码质量，镜像打入 PR 临时 tag 但不上推 |
| `workflow_dispatch` (手动) | 用户选择环境 + 可选指定 tag，完整流水线 | 紧急回滚/手动部署到指定环境 |

### 2.4 环境矩阵

| 环境 | 目标服务器 | 触发方式 | 审批要求 | 备注 |
|------|-----------|----------|----------|------|
| **staging** | 本机（当前机器）<br>`docker-compose.staging.yml`<br>端口: 8080/8443, PG 5433, Redis 6380 | push main 后自动部署 | 无（自动） | 独立 volume 命名空间，与生产数据完全隔离 |
| **production** | 生产服务器<br>`docker-compose.yml` (生产)<br>标准端口 80/443/5432/6379 | staging smoke test 通过后，经审批手动触发 | **需要审批人 Approve**（GitHub Environment Protection） | 蓝绿部署策略暂不引入，采用滚动重启（`--no-deps`） |

### 2.5 镜像仓库配置

#### 2.5.1 双仓推图策略

| 仓库 | Registry 地址 | 用途 | 费用 |
|------|--------------|------|------|
| **GitHub Container Registry** | `ghcr.io/<github-owner>/vote-app`<br>`ghcr.io/<github-owner>/vote-nginx` | 主仓库，公开可见，无限免费 | 0（公开仓库） |
| **阿里云容器镜像服务 ACR** | `registry.cn-hangzhou.aliyuncs.com/<namespace>/vote-app`<br>`registry.cn-hangzhou.aliyuncs.com/<namespace>/vote-nginx` | 国内加速拉取，生产服务器部署用 | 免费个人版 |

**推图顺序**：同时推送（GitHub Actions 两个 `docker/build-push-action` step 并行或串行均可，不存在依赖）。

**拉取优先级**（服务器端）：优先从阿里云 ACR 拉取（国内网络快），fallback ghcr.io。

#### 2.5.2 镜像标签策略

| 标签 | 说明 | 示例 |
|------|------|------|
| `<git-short-sha>` | 每次 push 的 commit SHA 前 8 位 | `a1b2c3d4` |
| `latest` | 始终指向最新构建成功的镜像 | `latest` |
| `v<semver>` | 手动打 tag 时使用，如 `v1.2.0` | `v1.2.0` |

**回滚策略**：生产部署时记录当前运行的 `<sha>` tag → 若 smoke test 失败，SSH 到服务器执行 `docker-compose up -d` 用上一个 tag。

### 2.6 验收门禁

| 门禁 | 检查项 | 不通过后果 |
|------|--------|-----------|
| **Lint Gate** | `tsc --noEmit` 零错误，`eslint` 零 error（warning 可过） | 流水线终止，无法进入 Test |
| **Test Gate** | 后端 + 前端所有测试通过；行覆盖率 ≥80% | 流水线终止，无法进入 Build |
| **Build Gate** | Docker 镜像构建成功 + 双仓推送成功 | 流水线终止，无法进入 Deploy |
| **Staging Smoke Gate** | `/health` 200 + 创建投票 API 200 + 提交投票 API 200 + WS 连接成功 | 通知但不阻断（staging 允许失败排查） |
| **Production Approval Gate** ⭐核心 | 指定审批人（壹墨）在 GitHub Environments 页面点击 Approve | 生产部署步骤永久等待，直到审批或拒绝 |
| **Production Smoke Gate** | 同 Staging Smoke Test | **自动回滚**到上一个稳定镜像 + 飞书告警 |

### 2.7 审批流程详细

```
Staging Smoke Test 通过
        │
        ▼
GitHub Actions 进入 deployment job (environment: production)
        │
        ▼
GitHub 检查 production environment 的 Protection Rules:
  - Required reviewers: 壹墨 (EeiMoo)
  - Wait timer: 无（即时审批）
        │
    ┌───┴───┐
    │       │
  Approve  Reject
    │       │
    ▼       ▼
  继续    流水线终止
  部署    标注失败原因
    │
    ▼
  Deploy to Production
```

**审批人操作**：
1. GitHub 仓库 → Settings → Environments → `production`
2. 在流水线的 Deploy 步骤看到黄色等待标志，点击「Review deployments」
3. 查看 staging smoke test 结果
4. 勾选 `production` 环境 → 点击 **Approve and deploy**

**审批前检查清单**（由壹墨自行确认）：
- [ ] Staging smoke test 全部通过
- [ ] 本次变更的非功能影响已评估（性能、安全、兼容性）
- [ ] 如需数据库迁移，已在 staging 执行并验证
- [ ] 回滚方案已就位（上一个稳定镜像 tag 已记录）

### 2.8 GitHub Actions Secrets 配置清单

| Secret 名称 | 说明 | 示例值 | 环境 |
|------------|------|--------|------|
| `GHCR_USERNAME` | GitHub 用户名（ghcr.io 认证） | `eeimoo` | 仓库级 |
| `GHCR_TOKEN` | GitHub Personal Access Token（`write:packages` 权限） | `ghp_xxx` | 仓库级 |
| `ACR_USERNAME` | 阿里云 ACR 用户名 | `aliyun@eeimoo` | 仓库级 |
| `ACR_PASSWORD` | 阿里云 ACR 密码（RAM 子账号或容器镜像服务独立密码） | — | 仓库级 |
| `STAGING_HOST` | Staging 服务器 IP/域名 | `192.168.1.100` | 仓库级 |
| `STAGING_USER` | Staging SSH 用户名 | `eeimoo` | 仓库级 |
| `STAGING_KEY` | Staging SSH 私钥 | — | 仓库级 |
| `STAGING_PG_PASSWORD` | Staging PG 密码 | `vote_dev_pass` | 仓库级 |
| `PROD_HOST` | 生产服务器 IP/域名 | — | `production` 环境级 |
| `PROD_USER` | 生产 SSH 用户名 | — | `production` 环境级 |
| `PROD_KEY` | 生产 SSH 私钥 | — | `production` 环境级 |
| `PROD_PG_PASSWORD` | 生产 PG 密码 | — | `production` 环境级 |
| `FEISHU_APP_ID` | 飞书应用 App ID（公共） | — | 仓库级 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret（敏感） | — | 仓库级 |
| `FEISHU_WEBHOOK` | 飞书群机器人 Webhook URL（通知用） | — | 仓库级 |

> GitHub 支持 Environment-level secrets：生产环境敏感信息（PROD_HOST 等）仅在 `production` 环境内可见，不会暴露给 staging 部署步骤。

### 2.9 环境变量注入策略

| 变量 | Staging 值 | Production 值 | 来源 |
|------|-----------|---------------|------|
| `NODE_ENV` | `staging` | `production` | docker-compose 中直接写定 |
| `STAGING` | `"true"` | 不设 | docker-compose 中写定 |
| `DATABASE_URL` | `postgresql://vote_user:${PG_PASSWORD}@pg:5432/vote_db` | 同（容器内 DNS） | 环境变量 `${PG_PASSWORD}` 由 GH Actions 注入 |
| `REDIS_URL` | `redis://redis:6379/0` | 同 | 写定 |
| `FEISHU_APP_ID` | `cli_xxx`（飞书测试应用） | 正式飞书应用 ID | GH Secrets → env |
| `FEISHU_APP_SECRET` | 测试应用 Secret | 正式应用 Secret | GH Secrets → env |
| `TEAM_TOTAL_MEMBERS` | `24` | `24` | GH Secrets 或写定 |
| `CORS_ORIGINS` | `*` | 生产域名 | docker-compose 直接写定 |

### 2.10 流水线文件更新清单

基于现有 `deploy/ci-pipeline.yml`（evo-v1），本轮改动：

| 改动项 | 详请 |
|--------|------|
| 双仓推送 | Build job 的 `tags` 增加 `ghcr.io/...` + `ACR/...` 两套 tag；`docker/login-action` 执行两次登录 |
| Staging 自动部署 | `deploy` job 拆分为 `deploy-staging`（自动）和 `deploy-prod`（需审批） |
| Production 审批门禁 | `deploy-prod` job 添加 `environment: production`，依赖 GitHub Environment Protection |
| Staging smoke test | 新增 `smoke-test-staging` job，基于 `deploy/smoke-test.sh` |
| 飞书通知 | `notify` job 调飞书 Webhook 推送部署结果 |
| 并发控制 | `concurrency: group: ${{ github.ref }}` 保留，防止重复触发 |
| 镜像标签传递 | 使用 `outputs` 在 jobs 间传递 `image_tag` |

---

## 三、模块 M2：飞书 SSO 集成

### 3.1 现状与目标

#### 3.1.1 现状（v1.1 假登录）

```
用户打开投票工具
        │
        ▼
┌──────────────────┐
│  Login.tsx 表单   │
│  - 手填用户 ID    │
│  - 手填昵称       │
│  - 点「进入投票」  │
└────────┬─────────┘
         ▼
  生成 dev token: "dev_<id>_default_<name>"
         │
         ▼
┌─────────────────────────────────┐
│  auth.ts verifyFeishuToken()    │
│  - startsWith("dev_") → 降级   │
│  - 解析出 user_id, display_name │
│  - 注入 req.user                │
└─────────────────────────────────┘
```

**问题**：
- 无真实身份：任何人都可以随便填一个 ID 侵入系统
- 无飞书组织验证：无法区分团队内/外成员
- dev token 格式公开可逆 (`dev_<id>_default_<name>`)
- 无法获取头像、组织信息等飞书用户属性

#### 3.1.2 目标（v1.2 飞书 OAuth）

```
用户打开投票工具
        │
        ▼
┌──────────────────────┐
│  Login.tsx（重构）     │
│  ┌──────────────────┐ │
│  │  团队即时投票      │ │
│  │                   │ │
│  │  [飞书图标]       │ │
│  │  飞书一键登录      │ │  ← 主按钮，品牌色
│  │                   │ │
│  │  ── 或 ──        │ │
│  │                   │ │
│  │  [开发模式登录]    │ │  ← 仅 NODE_ENV≠production 时可见
│  └──────────────────┘ │
└────────┬─────────────┘
         │
         │ 点击「飞书一键登录」
         ▼
┌──────────────────────────────────────┐
│  飞书 OAuth 2.0 授权流程              │
│                                      │
│  1. 前端构造飞书授权 URL:             │
│     https://open.feishu.cn/open-apis │
│       /authen/v1/authorize?          │
│       app_id=<FEISHU_APP_ID>&        │
│       redirect_uri=<回调地址>         │
│                                      │
│  2. 用户在飞书 H5 页面授权            │
│     - 仅请求：获取用户信息（open_id   │
│        + 姓名 + 头像）                │
│     - 用户点「同意授权」              │
│                                      │
│  3. 飞书回调 redirect_uri             │
│     带 ?code=<临时授权码>             │
│                                      │
│  4. 后端用 code 换取 user_access_token│
│     POST /open-apis/authen/v1/       │
│       oidc/access_token              │
│                                      │
│  5. 后端用 token 获取用户信息          │
│     GET /open-apis/authen/v1/        │
│       user_info                      │
│     → { open_id, name, avatar_url }  │
│                                      │
│  6. 后端签发 JWT + 写入 Redis 会话     │
│     → 重定向回前端首页 /votes          │
└──────────────────────────────────────┘
```

### 3.2 授权范围

**严格最小化原则**：仅请求必要字段，不多拿任何用户数据。

| 请求字段 | 飞书 API 权限 | 用途 | 必要性 |
|----------|-------------|------|--------|
| `open_id` | 基础用户标识 | 用户唯一 ID，用于防重投票、权限校验 | **必须** |
| `name`（姓名） | 基础用户信息 | 投票发起者显示、实名模式下投票人展示 | **必须** |
| `avatar_url`（头像） | 基础用户信息 | UI 头像展示、实名投票人列表 | **必须** |
| `tenant_key`（租户标识） | 基础企业信息 | 团队级权限校验 | 按需（当前单团队部署可用环境变量，预留多团队能力） |

**明确不请求**：
- ❌ 手机号、邮箱、部门——不涉及
- ❌ 通讯录、用户组——权限过大
- ❌ 聊天、云文档、日历——完全不相关

**飞书应用的 OAuth 权限配置（开放平台）**：
- 仅勾选「获取用户基本信息」
- 无需审核企业权限，自建应用即可

### 3.3 登录流程（完整时序）

```
前端 (React SPA)                    后端 (Express)                    飞书 Open API
     │                                    │                              │
     │  ① 用户点击「飞书登录」              │                              │
     │─────────────────────────────────────│                              │
     │  window.location.href =             │                              │
     │  "https://open.feishu.cn/           │                              │
     │   open-apis/authen/v1/              │                              │
     │   authorize?app_id=xxx&             │                              │
     │   redirect_uri=xxx"                 │                              │
     │──────────────────────────────────────────────────────────────────→│
     │                                    │                              │
     │                                    │    ② 用户在飞书 H5 授权       │
     │                                    │    飞书回调 redirect_uri      │
     │                                    │    GET /api/auth/callback     │
     │                                    │    ?code=xxx                  │
     │                                    │←─────────────────────────────│
     │                                    │                              │
     │                                    │  ③ 用 code 换 user_access_token
     │                                    │  POST authen/v1/oidc/        │
     │                                    │    access_token              │
     │                                    │──────────────────────────────→│
     │                                    │←── { access_token }          │
     │                                    │                              │
     │                                    │  ④ 获取用户信息               │
     │                                    │  GET authen/v1/user_info     │
     │                                    │──────────────────────────────→│
     │                                    │←── { open_id, name,          │
     │                                    │      avatar_url, tenant_key } │
     │                                    │                              │
     │                                    │  ⑤ 签发 JWT + 存 Redis       │
     │                                    │  token = jwt.sign({          │
     │                                    │    user_id, name, avatar_url  │
     │                                    │    tenant_key, exp: 7d        │
     │                                    │  })                          │
     │                                    │  SET token:<jti> user_data   │
     │                                    │    EX 604800                 │
     │                                    │                              │
     │  ⑥ 302 重定向到 /votes              │                              │
     │  set-cookie: vote_token=<jwt>      │                              │
     │←───────────────────────────────────│                              │
     │                                    │                              │
     │  ⑦ 后续请求带 token                  │                              │
     │  Authorization: Bearer <jwt>       │                              │
     │────────────────────────────────────→│  ⑧ 验签 + 注入 req.user      │
     │                                    │                              │
```

### 3.4 与现有 dev 模式的兼容策略

**设计目标**：开发阶段仍可用假登录快速调试；生产环境强制飞书 SSO，杜绝 dev token 旁路。

#### 3.4.1 环境分层策略

| 环境 | `NODE_ENV` | 飞书配置 | 登录方式 | dev token |
|------|-----------|---------|----------|-----------|
| **本地开发** | `development` | `FEISHU_APP_ID` 可选 | 飞书 SSO 或 dev 模式均可 | ✅ 允许 |
| **Staging** | `staging` | 飞书测试应用（`cli_xxx`） | 飞书 SSO 或 dev 模式均可 | ✅ 允许（用于自动化测试、冒烟测试） |
| **Production** | `production` | 飞书正式应用 | **仅飞书 SSO** | ❌ 禁止 |

#### 3.4.2 auth.ts 改造点

原有降级逻辑：

```typescript
// 降级模式：dev 令牌（飞书就绪前，或测试用）
if (token.startsWith(DEV_TOKEN_PREFIX)) {
  const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
  return { user_id: parts[0], team_id: parts[1], display_name: parts[2] };
}
```

改造后：

```typescript
// 降级模式：仅在非生产环境允许 dev token
if (token.startsWith(DEV_TOKEN_PREFIX)) {
  if (config.NODE_ENV === 'production') {
    throw new Error('Dev token 不允许在生产环境使用');
  }
  // 开发/staging 环境：保留原有降级逻辑
  const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
  return { user_id: parts[0], team_id: parts[1], display_name: parts[2] };
}
```

#### 3.4.3 Login.tsx 改造点

原有表单（手填 ID+昵称）改造为：

```tsx
export default function Login() {
  const isProduction = import.meta.env.VITE_NODE_ENV === 'production';

  const handleFeishuLogin = () => {
    const redirectUri = `${window.location.origin}/api/auth/callback`;
    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?` +
      `app_id=${import.meta.env.VITE_FEISHU_APP_ID}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.location.href = authUrl;
  };

  return (
    <div>
      {/* 主按钮：飞书一键登录（所有环境均可见） */}
      <button onClick={handleFeishuLogin}>
        <FeishuIcon /> 飞书一键登录
      </button>

      {/* 开发模式入口：仅非生产环境可见 */}
      {!isProduction && (
        <>
          <Divider>或</Divider>
          <DevLoginForm />  {/* 保留原有手填表单逻辑 */}
        </>
      )}
    </div>
  );
}
```

#### 3.4.4 后端新增路由

```
GET /api/auth/login        → 重定向到飞书授权页（由前端直接构造 URL 即可，此路由为快捷方式）
GET /api/auth/callback     → 飞书回调：接收 code → 换 token → 获取用户信息 → 签发 JWT → 302 重定向
GET /api/auth/me           → 获取当前用户信息（用于前端获取头像、姓名展示）
POST /api/auth/logout      → 清除 Redis session → 清除前端 token
```

#### 3.4.5 飞书开放平台配置需求

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 应用名称 | 团队即时投票 | 用户授权页展示 |
| 应用图标 | 投票工具 logo | — |
| 回调 URL | `https://<domain>/api/auth/callback` | 生产与 staging 需分别配置 |
| OAuth 权限 | 获取用户基本信息 | 最小权限 |
| 安全设置 | `redirect_uri` 白名单 | 仅允许已配置的回调域名 |

### 3.5 前后端改动范围

#### 3.5.1 前端改动清单

| 文件 | 改动 | 影响 |
|------|------|------|
| `Login.tsx` ⭐重点 | 重构为飞书 SSO 按钮 + 保留 dev 模式折叠区 | 高 |
| `Login.module.css` | 新样式：飞书品牌色按钮 + 布局 | 中 |
| `services/api.ts` | Axios 拦截器适配：token 从 localStorage 改为读取 HttpOnly cookie 或 JWT | 中 |
| `App.tsx` | 路由守卫：未登录 → 跳转 `/login`；已登录但有 token → 自动跳转 `/votes` | 中 |
| `types/index.ts` | 新增 `User` 类型：`{ user_id, display_name, avatar_url, team_id }` | 低 |
| `store/index.ts` | 新增用户状态管理：存储当前用户信息 | 低 |
| `.env` | 新增 `VITE_FEISHU_APP_ID` 环境变量（前端构建时注入） | 低 |

#### 3.5.2 后端改动清单

| 文件 | 改动 | 影响 |
|------|------|------|
| `middleware/auth.ts` ⭐重点 | 重构：支持飞书 JWT 验签 + dev token（按环境开关）+ 新增 `/api/auth/*` 路由白名单 | 高 |
| `routes/auth.ts` ⭐新增 | 新增认证路由：`GET /callback`, `GET /me`, `POST /logout` | 高 |
| `config.ts` | 新增 `JWT_SECRET`, `JWT_EXPIRES_IN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | 中 |
| `types/index.ts` | `req.user` 类型扩展：增加 `avatar_url` 字段 | 低 |
| `app.ts` | 挂载 `/api/auth` 路由（白名单，不经过 auth 中间件） | 低 |
| `services/ballotService.ts` | 无逻辑变更，但类型适配（`req.user` 扩展了 `avatar_url`） | 低 |

### 3.6 安全考量

| 维度 | 措施 |
|------|------|
| **CSRF** | OAuth `state` 参数：飞书授权前生成随机 state → 存入 Redis（TTL 10 分钟）→ 回调时校验 state 是否匹配。不匹配则拒绝。 |
| **Token 存储** | 生产环境使用 HttpOnly Secure SameSite=Strict Cookie 传递 JWT，前端 JS 不直接接触 token；staging/dev 可沿用 `localStorage` |
| **JWT 签名** | HS256 签名，密钥 `JWT_SECRET` 从环境变量读取，≥32 字符 |
| **JWT 过期** | 7 天过期；过期后前端自动跳转飞书重新授权 |
| **飞书 API 凭证** | `FEISHU_APP_SECRET` 仅后端持有，不暴露给前端；app_access_token 缓存在后端内存（1.5h 刷新） |
| **回调域名校验** | 后端校验 `redirect_uri` 的域名必须在白名单内（防止开放重定向攻击） |
| **Dev Token 生产封禁** | `config.NODE_ENV === 'production'` 时，`verifyFeishuToken()` 对 `dev_` 前缀 token 直接抛出 401，绝不降级 |
| **防重放** | JWT 含 `jti`（唯一 ID），可配合 Redis 黑名单实现 token 吊销（本期可做可不做，后续安全迭代） |

### 3.7 验收标准（SSO 模块）

#### 用户故事

| 编号 | 用户故事 | 优先级 |
|------|----------|--------|
| US-SSO-01 | 作为团队成员，我希望点击「飞书一键登录」后自动完成授权，无需手动输入任何信息，以便无缝进入投票系统 | P0 |
| US-SSO-02 | 作为系统，我需要在生产环境**完全禁止** dev token 登录，确保所有用户身份均经过飞书 SSO 验证 | P0 |
| US-SSO-03 | 作为开发者，我希望在 staging 环境保留 dev 模式，以便自动化测试和冒烟测试可绕过飞书授权 | P0 |

#### 验收场景

| 编号 | 场景 | 前置条件 | 操作步骤 | 预期结果 |
|------|------|----------|----------|----------|
| AC-SSO-01 | **正常**：飞书授权登录 | 用户未登录，环境有飞书应用配置 | 打开登录页 → 点击「飞书一键登录」→ 跳转飞书授权页 → 点「同意授权」 | 302 重定向到 `/votes` 首页，页面展示用户真实姓名+头像 |
| AC-SSO-02 | **正常**：JWT 未过期 → 免登录 | 用户上次登录签发的 JWT 仍在有效期内（7 天内） | 直接访问 `/votes` | 自动带 cookie/JWT → 后端验签通过 → 直接展示首页，无登录页闪现 |
| AC-SSO-03 | **正常**：JWT 过期 → 重新授权 | 用户 token 已过期 | 访问 `/votes` | API 返回 401 → 前端自动跳转登录页 → 用户点「飞书一键登录」重新授权 |
| AC-SSO-04 | **正常**：生产环境 dev token 被拒绝 | `NODE_ENV=production` | 构造 `dev_xxx` token 发请求 | 返回 401 `{ code: 40100, message: "Dev token 不允许在生产环境使用" }` |
| AC-SSO-05 | **正常**：Staging 环境 dev token 可用 | `NODE_ENV=staging` | 用 `dev_testuser_default_测试` token 发请求 | 后端降级解析成功，返回正常数据 |
| AC-SSO-06 | **正常**：`GET /api/auth/me` 返回当前用户信息 | 用户已登录 | 前端调用 `/api/auth/me` | 返回 `{ user_id, display_name, avatar_url, team_id }`，头像 URL 可访问 |
| AC-SSO-07 | **异常**：飞书回调 state 不匹配 | state 被篡改或过期 | 回调 URL 带无效 state | 返回 400 `{ code: 40001, message: "OAuth state 校验失败，请重新登录" }` |
| AC-SSO-08 | **异常**：飞书回调 code 已使用/无效 | 重复使用同一个 code | 第二次用同一 code 访问 callback | 返回 401 `{ code: 40100, message: "飞书授权码无效或已使用" }` |
| AC-SSO-09 | **异常**：用户拒绝授权 | 用户在飞书授权页点击「拒绝」 | 飞书回调 redirect_uri 时不带 code | 前端展示「授权已取消」提示，保留登录页 |
| AC-SSO-10 | **正常**：退出登录 | 用户已登录 | 点击退出 → 前端调 `POST /api/auth/logout` | 后端清除 Redis session → 前端清除 token → 跳转登录页 |

---

## 四、非功能需求（仅本轮新增/变更）

### 4.1 CI/CD 性能

| 指标 | 要求 |
|------|------|
| Lint 阶段耗时 | ≤2 分钟（含 npm ci + tsc + eslint） |
| Test 阶段耗时 | ≤3 分钟（后端 + 前端并行） |
| Build & Push 阶段耗时 | ≤5 分钟（含 Docker build + 双仓 push） |
| Staging 部署耗时 | ≤1 分钟（pull + compose up + healthcheck） |
| 全流水线端到端（push → staging 就绪） | ≤10 分钟 |
| 生产部署耗时（审批通过后） | ≤2 分钟 |

### 4.2 SSO 性能与可用性

| 指标 | 要求 |
|------|------|
| 首次授权登录耗时 | ≤3 秒（不含用户在飞书页面操作时间） |
| JWT 验签耗时 | ≤50ms（HS256 哈希比对，无网络调用） |
| 飞书 API 调用超时 | 5 秒（超时后返回友好错误提示） |
| 飞书 SSO 不可用降级 | 飞书 API 不可用时（非生产环境）自动降级 dev 模式；生产环境返回错误提示「飞书授权服务暂时不可用，请稍后重试」 |

### 4.3 安全（新增项）

| 维度 | 要求 |
|------|------|
| OAuth State 防 CSRF | 授权前生成随机 `state`（crypto.randomUUID），Redis 存储 TTL 10 分钟，回调时校验 |
| JWT 签名算法 | HS256，Secret 长度 ≥ 32 字节 |
| Token 传输 | 生产：HttpOnly Secure SameSite=Strict Cookie；Staging/Dev：`Authorization: Bearer <jwt>` |
| 回调域名白名单 | 后端硬编码白名单：`[production_domain, staging_domain, localhost]`，拒绝未授权的 redirect_uri |
| Dev Token 生产禁止 | `NODE_ENV === 'production'` 时拒绝所有 `dev_` 前缀 token |
| GitHub Secrets 安全 | 生产环境 Secrets 仅绑定 `production` Environment，staging job 无法访问 |
| Docker 镜像安全 | 基础镜像使用 `node:20-alpine`（非 slim/buster），定期更新；镜像扫描可后续引入 Trivy/Grype |

---

## 五、数据模型变更（M2 相关）

### 5.1 user_votes 表 — 新增 avatar_url

```sql
ALTER TABLE user_votes ADD COLUMN IF NOT EXISTS user_avatar VARCHAR(512);
```

> 投票提交时从 `req.user.avatar_url` 快照写入，用于实名模式下展示投票人头像。避免每次展示都调飞书 API。

### 5.2 votes 表 — 新增 creator_avatar

```sql
ALTER TABLE votes ADD COLUMN IF NOT EXISTS creator_avatar VARCHAR(512);
```

> 同理由：发起者头像在创建时快照写入，后续展示不依赖外部 API。

---

## 六、约束与假设

### 约束
- **部署铁律**：staging 验证通过 + 老板审批 → 才能上生产。不得绕过审批直接部署生产。
- **测试铁律**：所有代码必须在本机 staging 环境实际执行通过（Docker + PG15 + Redis7）。
- **GitHub Packages 公开免费**：ghcr.io 公开仓库无限免费存储和拉取，无需计费。
- **飞书应用类型**：自建应用即可，无需审核企业权限。
- **飞书 OAuth**：仅使用 Web 应用授权（`/authen/v1/authorize`），不使用小程序/免登。

### 假设
- 团队使用 GitHub 作为代码仓库，GitHub Actions 可用
- 本机 staging 环境已就位（Docker Compose + PG15 + Redis7）
- 飞书开放平台已注册应用，回调域名已配置
- GitHub 组织或个人账号已开通 ghcr.io 使用权限
- 阿里云 ACR 已开通个人版（免费实例）
- 生产服务器可通过 SSH 从 GitHub Actions 访问（公网 IP 或内网穿透）

### 范围外（本期不做）
- Kubernetes / Helm Chart 部署
- 蓝绿部署（沿用滚动重启 `--no-deps`）
- 飞书通讯录同步
- 多团队/多租户架构
- 钉钉/企业微信 SSO
- JWT 黑名单/吊销机制（后续安全迭代）

---

## 七、风险评估（本轮新增）

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 双仓推送网络超时 | 中 — 一侧仓库推送失败导致镜像不一致 | 低 | GitHub Actions runner 在境外，推 ghcr.io 稳定；阿里云 ACR 推送失败时写入 warning 不阻断流水线（可后续手动补推） |
| 飞书 OAuth 回调域名未就绪 | 高 — SSO 完全不可用 | 中 | Staging 回调可用 `localhost`；生产回调需提前配置 DNS+SSL；backup：staging 阶段充分验证 |
| GitHub Environment Protection 配置错误 | 高 — 生产部署无限等待 | 低 | 提前在仓库 Settings 配置好 `production` environment + required reviewers；CI 配置文档化 |
| Staging 环境与生产环境差异导致「staging 没问题、生产炸」 | 高 — P0 事故 | 中 | `docker-compose.staging.yml` 与生产 `docker-compose.yml` 除端口/volume 外完全一致；PG/Redis 版本锁定 15/7 |
| 飞书 API 限流（`app_access_token` 获取频率） | 低 — 用户信息获取频率低 | 低 | `app_access_token` 缓存 1.5h；user_info 仅登录时调用一次 |
| dev token 旁路未彻底关闭 | 高 — 生产安全漏洞 | 中 | 代码级强制：`NODE_ENV=production` 时直接 throw 401；自动化测试覆盖此场景 |
| SSH 私钥泄露 | 严重 — 服务器被控 | 低 | GitHub Secrets 加密存储；SSH key 仅开放必要命令权限（非 root）；定期轮换 |

---

## 八、附录

### A. 飞书 OAuth 关键 API 速查

| API | 方法 | 用途 | 文档 |
|-----|------|------|------|
| `open.feishu.cn/open-apis/authen/v1/authorize` | GET | 用户授权页跳转 | 飞书开放平台 → 身份验证 → Web 应用授权 |
| `open.feishu.cn/open-apis/authen/v1/oidc/access_token` | POST | code 换 token | 同上 |
| `open.feishu.cn/open-apis/authen/v1/user_info` | GET | 获取用户信息 | 同上 |
| `open.feishu.cn/open-apis/auth/v3/app_access_token/internal` | POST | 获取应用 token | 已实现 |

### B. 流水线 Secrets 配置步骤

1. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
2. 逐项添加 2.8 节列出的所有 secrets
3. Settings → Environments → 新建 `staging` 和 `production` 两个环境
4. `production` 环境添加 Required reviewers（选壹墨的 GitHub 账号）
5. `production` 环境的 Environment secrets 里添加 `PROD_HOST`, `PROD_USER`, `PROD_KEY`, `PROD_PG_PASSWORD`

### C. 飞书机器人通知 Webhook 格式

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": { "tag": "plain_text", "content": "🚀 投票工具部署通知" }
    },
    "elements": [
      { "tag": "div", "text": { "tag": "plain_text", "content": "环境：staging" } },
      { "tag": "div", "text": { "tag": "plain_text", "content": "镜像：vote-app:a1b2c3d4" } },
      { "tag": "div", "text": { "tag": "plain_text", "content": "Lint: ✅ Test: ✅ Smoke: ✅" } },
      { "tag": "div", "text": { "tag": "plain_text", "content": "触发人：eeimoo" } }
    ]
  }
}
```

### D. 术语对照

| 术语 | 定义 |
|------|------|
| ghcr.io | GitHub Container Registry，GitHub 提供的 Docker 镜像仓库 |
| ACR | Alibaba Cloud Container Registry，阿里云容器镜像服务 |
| OAuth 2.0 | 开放授权协议，飞书基于此实现第三方登录 |
| JWT | JSON Web Token，用于服务端签发用户会话令牌 |
| HttpOnly Cookie | 浏览器 cookie 安全属性，禁止 JavaScript 读取 |
| Environment Protection | GitHub Actions 环境保护规则，可要求人工审批 |
| Concurrency Group | GitHub Actions 并发组，同一组内同时只运行一个流水线 |
| 双仓推送 | 一次构建同时推送到两个镜像仓库 |

---

## 九、Changelog

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-02 | v1.2 draft | 初始起草：CI/CD 模块 + 飞书 SSO 模块 |
| — | — | 待架构评审（栖梧）后修订 |

---

> 📋 **下一篇文档**：栖梧需基于本 PRD 更新 `ARCH_团队即时投票工具_v1.2.md`，补充 auth 路由设计、JWT 签发验签方案、双仓推送流水线 YAML 交付件。
