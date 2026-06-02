# 总体架构设计方案 — CI/CD 流水线 + 飞书 SSO 集成

> 版本：v1.2 | 设计人：栖梧 | 日期：2026-06-02 | 关联 PRD：v1.2（第二轮迭代）

---

## 修订记录

| 编号 | 级别 | 章节 | 变更摘要 | 修订人 | 日期 |
|------|------|------|----------|--------|------|
| D-1 | 🔴 必须 | 全文 | 新增第二部分「CI/CD 流水线架构」和第三部分「飞书 SSO 集成架构」；继承 v1.1 全部设计 | 栖梧 | 2026-06-02 |
| D-2 | 🔴 必须 | §10 CI/CD | 镜像仓库双策略：ghcr.io（生产/日本直连）+ 阿里云 ACR（staging/国内直连）；基础镜像策略 | 栖梧 | 2026-06-02 |
| D-3 | 🔴 必须 | §11 SSO | 飞书 OAuth 2.0 完整回调链路：前端发起→飞书授权→回调 `/api/auth/feishu/callback`→服务端换 token→返回前端 JWT | 栖梧 | 2026-06-02 |
| D-4 | 🟡 重要 | §11.3 | dev 模式降级保留：Login.tsx 手动输入 dev token → 后端 auth.ts `dev_` 前缀解析；生产无飞书凭证时降级为 user_id 直传 | 栖梧 | 2026-06-02 |
| D-5 | 🟡 重要 | §10.3 | 环境矩阵定义：staging 手动/自动触发，production 须老板验收后手动触发；两条铁律：测试环境执行 + 老板人工验收 | 栖梧 | 2026-06-02 |
| D-6 | 🟢 建议 | §10.4 | GHA 构建缓存策略：GitHub Actions Cache (gha) 缓存 Docker layer + npm cache，加速流水线 | 栖梧 | 2026-06-02 |

---

## 本文档概述

本文档为第二轮迭代（v1.2）的增量架构设计。**第一部分**为 v1.1 架构的摘要索引（完整版见 `ARCH_团队即时投票工具_v1.1.md`），**第二部分**覆盖 CI/CD 流水线架构，**第三部分**覆盖飞书 SSO 集成架构。

> **进化标记**：架构模板 v2（EVO-005）已将 CI/CD 提升为 Must Have 项目，本轮迭代将架构模板产物落实为具体设计。

---

# 第一部分：v1.1 架构摘要（索引）

> 完整架构设计详见 `docs/ARCH_团队即时投票工具_v1.1.md`。以下仅摘要核心决策，供新读者快速建立上下文。

## 技术栈速览

| 层次 | 技术 | 版本 |
|------|------|------|
| 前端 | React + TypeScript + Vite + ECharts | 18.x / 5.x |
| 后端 | Express + TypeScript + Knex + Socket.IO | 4.x / 20 LTS |
| 数据库 | PostgreSQL | 15 |
| 缓存 | Redis | 7 |
| 部署 | Docker Compose（nginx + app + pg + redis） | — |
| 仓库 | GitHub (EeiMo/AI-Team) | — |

## 系统分层

```
客户端（飞书 WebView / React SPA）
    ↓ HTTPS (WSS)
Nginx（SSL 终止 + 静态资源 + API/WS 反代 + ip_hash 粘性）
    ↓
Express App（auth / vote routes / WS handlers / Redis adapter）
    ↓           ↓
PostgreSQL 15   Redis 7
```

## 核心模块

| 模块 | 职责 |
|------|------|
| `auth.ts` | 飞书 SSO 验签 → 注入 `req.user`；dev token 降级模式 |
| `voteService.ts` | 投票 CRUD + Redis tally 初始化 + deadline TTL |
| `ballotService.ts` | 投票提交：PG 事务防重 + Redis HINCRBY 计数 + WS 广播 |
| `deadlineWorker.ts` | Redis Keyspace Notification 到期自动结束 + 启动兜底扫描 |
| `rateLimiter.ts` | 每人每投票 60s 滑动窗口 3 次限制（Redis Lua 脚本 + 降级内存兜底） |
| `tallySync.ts` | 每 5s Redis→PG 对账 |

## 数据模型

- `votes`：投票主表（UUID v7 主键，creator_id/team_id VARCHAR(64) 存飞书 ID）
- `options`：选项表（vote_id FK，sort_order 排序）
- `user_votes`：投票记录（UNIQUE(vote_id, user_id) 防重，selected_options UUID[] 多选数组）
- Redis：`vote:{id}:tally` (Hash 计数器) / `vote:{id}:deadline` (String TTL 定时器) / `rate:{user}:{vote}` (Sorted Set 限流)

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/votes` | 创建投票 |
| GET | `/api/votes` | 投票列表（分页+状态筛选） |
| GET | `/api/votes/:id` | 投票详情（含 tally + 私有字段） |
| POST | `/api/votes/:id/vote` | 提交投票 |
| POST | `/api/votes/:id/close` | 结束投票（仅发起者） |

---

# 第二部分：CI/CD 流水线架构

## 10. CI/CD 流水线总体设计

### 10.1 设计目标

| 目标 | 说明 |
|------|------|
| **全自动化质量门禁** | 每次 push/PR 自动触发 lint → test，通过才允许后续阶段 |
| **一次性构建** | 同一 commit 构建一次镜像，同一镜像部署到所有环境（staging → production） |
| **环境隔离** | staging 与 production 共用同一镜像，但通过环境变量区分配置 |
| **安全发布** | production 部署须老板人工验收后手动触发；staging 可自动或手动 |
| **快速回滚** | 冒烟测试失败自动回滚到上一个稳定镜像；支持手动回滚 |
| **镜像就近加速** | 生产服务器（日本）拉 ghcr.io；staging 本机（国内）拉阿里云 ACR |

### 10.2 流水线阶段总览

```
        ┌─────────────────────────────────────────────────────────────────┐
        │                    GitHub Actions 流水线                          │
        │                                                                 │
        │  触发器: push main | PR main | tag v* | workflow_dispatch       │
        └─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 1: Lint                                                              │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ backend: npm ci → tsc --noEmit → eslint src/ --ext .ts        │          │
│  │ frontend: npm ci → tsc --noEmit → eslint src/ --ext .ts,.tsx  │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  产物: 无 | 耗时: ~1min | PR/main 均执行                                      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 通过
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 2: Test                                                              │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ backend: npm test (Jest + supertest)                          │          │
│  │ frontend: npm test (Vitest + @testing-library/react)          │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  产物: 测试报告 | 耗时: ~2min | PR/main 均执行                                 │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 通过 (PR 在此终止，不构建镜像)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 3: Build & Push 镜像                                                  │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ docker buildx build (多阶段: node:20-alpine → 运行时精简)      │          │
│  │   vote-app  : 多阶段编译 (builder + runtime)                   │          │
│  │   vote-nginx: 多阶段注入 (builder + runtime)                   │          │
│  │                                                                │          │
│  │ 推送到双仓库:                                                   │          │
│  │   ghcr.io/EeiMo/AI-Team/vote-app:{tag}     ← 生产（日本直连）   │          │
│  │   registry.cn-hangzhou.aliyuncs.com/...:{tag} ← staging（国内） │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  产物: 镜像 + metadata | 耗时: ~5min | 仅 main/tag/manual 触发               │
│  缓存: GitHub Actions Cache (gha) — Docker layer + npm                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 成功
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 4: Deploy (Staging)                                                   │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ SSH → 本机 (eeimoo-System)                                    │          │
│  │ docker pull registry.cn-hangzhou.aliyuncs.com/...:${TAG}      │          │
│  │ docker-compose -f deploy/docker-compose.staging.yml up -d     │          │
│  │   --no-deps app nginx                                         │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  触发: push main (自动) 或 workflow_dispatch (手动)                           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 成功
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 5: Smoke Test (Staging)                                               │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ deploy/smoke-test.sh → 目标: https://staging.eeimoo.cn         │          │
│  │ 检查项:                                                        │          │
│  │   1. /health → 200                                             │          │
│  │   2. GET /api/votes → 200 + 分页结构校验                        │          │
│  │   3. POST /api/votes → 201 + 字段校验                          │          │
│  │   4. GET /api/votes/:id → 200 + option 结构                    │          │
│  │   5. WebSocket /ws → 101 Upgrade                               │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  失败 → 自动 Rollback (Stage 5-R)                                           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 成功
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 5-R: Rollback (仅 smoke test 失败时触发)                               │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ SSH → 读取 /tmp/vote-rollback.env 中的 PREVIOUS_TAG            │          │
│  │ docker-compose up -d --no-deps app nginx (回滚至上一版本)       │          │
│  └───────────────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Stage 6: Deploy (Production)  ← 🛑 老板审批后手动触发                         │
│  ┌───────────────────────────────────────────────────────────────┐          │
│  │ 仅 workflow_dispatch 触发（environment: production）            │          │
│  │ GitHub Environment Protection Rules:                            │          │
│  │   • Required reviewers: EeiMoo (老板)                           │          │
│  │   • Wait timer: 0 (即时审批)                                    │          │
│  │                                                                │          │
│  │ SSH → 日本生产服务器 (eeimoo.cn)                                │          │
│  │ docker pull ghcr.io/EeiMo/AI-Team/vote-app:${TAG}              │          │
│  │ docker pull ghcr.io/EeiMo/AI-Team/vote-nginx:${TAG}            │          │
│  │ docker-compose -f deploy/docker-compose.yml up -d              │          │
│  │   --no-deps app nginx                                          │          │
│  └───────────────────────────────────────────────────────────────┘          │
│  触发: 仅 workflow_dispatch + environment=production                          │
│  审批: GitHub Environments → Required reviewers = EeiMoo                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 10.3 环境矩阵

| 维度 | Staging | Production |
|------|---------|------------|
| **部署目标** | 本机 Ubuntu 26.04 + Snap Docker | 日本云服务器 (eeimoo.cn) |
| **镜像仓库** | 阿里云 ACR（`registry.cn-hangzhou.aliyuncs.com`） | ghcr.io（`ghcr.io/EeiMo/AI-Team`） |
| **选型理由** | 国内直连，DaoCloud 镜像代理加速 | 日本直连 GitHub，延迟低 |
| **端口映射** | 8080:80 / 8443:443 | 80:80 / 443:443 |
| **PG 端口** | 5433:5432 | 5432:5432 |
| **Redis 端口** | 6380:6379 | 6379:6379 |
| **Volume 前缀** | `*_staging` | 无前缀 |
| **网络** | `vote-net-staging` | `vote-net` |
| **环境变量** | `STAGING=true`, `NODE_ENV=staging` | `NODE_ENV=production` |
| **触发方式** | push main（自动）或 workflow_dispatch（手动） | 仅 workflow_dispatch（手动） |
| **审批要求** | 无 | 老板验收后手动触发 |
| **飞书凭证** | staging 沙箱 App ID | 生产正式 App ID |
| **冒烟测试** | ✅ 自动执行 | ✅ 需在 production workflow 中配置 |

### 10.4 镜像仓库策略

#### 10.4.1 双仓库推送矩阵

```
              GitHub Actions Runner
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    docker build   docker tag   docker push
         │                         │
         ├── ghcr.io/EeiMo/AI-Team/vote-app:{tag}
         │   └── 生产部署（日本 ← ghcr.io，GitHub 直连低延迟）
         │
         └── registry.cn-hangzhou.aliyuncs.com/eeimoo/vote-app:{tag}
             └── staging 部署（国内 ← ACR，DaoCloud 镜像代理加速）
```

**镜像标签策略**：

| 触发器 | 标签格式 | 示例 |
|--------|---------|------|
| push main | `{commit_sha[:8]}` + `latest` | `a1b2c3d4`, `latest` |
| tag v* | `{tag_name}` + `latest` | `v1.2.0`, `latest` |
| workflow_dispatch | 用户指定 或 commit SHA | `hotfix-20260602` |

#### 10.4.2 基础镜像策略

| 基础镜像 | 用途 | 策略 |
|---------|------|------|
| `node:20-alpine` | App 多阶段构建（builder + runtime） | Docker Hub 缓存；**不推送到自定义仓库** |
| `nginx:1.25-alpine` | Nginx 基础镜像 | Docker Hub 缓存；**不推送到自定义仓库** |
| `postgres:15-alpine` | PG 数据库服务 | Docker Hub 缓存；docker-compose 直接引用 |
| `redis:7-alpine` | Redis 缓存服务 | Docker Hub 缓存；docker-compose 直接引用 |

> **理由**：基础镜像是 Docker Official Images，本身托管在 Docker Hub 上且全球 CDN 加速。ghcr.io 和 ACR 对公开仓库免费无限，重新推送基础镜像浪费存储和带宽。使用 Docker Hub 缓存层（拉取一次后本地缓存）即可满足 CI 和部署需求。

#### 10.4.3 国内 Docker Hub 加速

```bash
# 本机 staging 环境使用 DaoCloud 镜像代理（已配置）
# /etc/docker/daemon.json
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
```

### 10.5 GitHub Actions 文件设计

流水线定义文件：`deploy/ci-pipeline.yml` → 放置在 `.github/workflows/ci.yml`

```yaml
# .github/workflows/ci.yml
# 实际文件由长夜从 deploy/ci-pipeline.yml 迁移并适配仓库路径
# 关键结构：

name: Vote App CI/CD

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        default: staging
      tag:
        type: string

env:
  NODE_VERSION: '20'
  # 双仓库
  REGISTRY_GHCR: ghcr.io/${{ github.repository }}
  REGISTRY_ACR: registry.cn-hangzhou.aliyuncs.com/eeimoo

jobs:
  lint:     # → PR + main
  test:     # → PR + main（依赖 lint）
  build:    # → 仅 main/tag/manual（依赖 test）
            #   docker buildx → push ghcr.io + ACR
  deploy-staging:  # → main 自动 / manual 可选
  smoke-test:      # → 依赖 deploy-staging
  rollback:        # → 仅 smoke-test 失败
  deploy-prod:     # → 仅 manual + environment=production
                   #   GitHub Environment Protection 强制审批
```

### 10.6 CI/CD 所需 Secrets 清单

| Secret 名称 | 用途 | 环境 |
|------------|------|------|
| `GHCR_USERNAME` | ghcr.io 用户名 | 全局 |
| `GHCR_PASSWORD` | ghcr.io Personal Access Token (write:packages) | 全局 |
| `ACR_USERNAME` | 阿里云 ACR 用户名 | 全局 |
| `ACR_PASSWORD` | 阿里云 ACR 密码 | 全局 |
| `DEPLOY_HOST_STAGING` | staging 部署目标主机 | staging |
| `DEPLOY_USER_STAGING` | staging SSH 用户 | staging |
| `DEPLOY_KEY_STAGING` | staging SSH 私钥 | staging |
| `DEPLOY_HOST_PROD` | 生产部署目标主机（日本） | production |
| `DEPLOY_USER_PROD` | 生产 SSH 用户 | production |
| `DEPLOY_KEY_PROD` | 生产 SSH 私钥 | production |
| `PG_PASSWORD` | 数据库密码 | staging + production |
| `FEISHU_APP_ID` | 飞书应用 ID | staging + production |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | staging + production |

### 10.7 GitHub Environment Protection Rules

生产环境使用 GitHub Environments 保护规则：

```
Settings → Environments → production
  ├── Required reviewers: EeiMoo（老板）
  ├── Wait timer: 0 minutes（即时审批）
  └── Deployment branches: main（仅 main 分支可部署）
```

**审批流程**：
1. 开发者或 CI 触发 `workflow_dispatch`，选择 `environment: production`
2. GitHub 自动请求 EeiMoo 审批
3. EeiMoo 在 GitHub / 邮件中看到审批请求 → 检查 staging 冒烟测试结果 → 批准/拒绝
4. 批准后流水线继续执行 SSH 部署到日本生产服务器

### 10.8 两条铁律

| 铁律 | 实现方式 |
|------|---------|
| **测试环境先执行** | 任何代码变更必须经过 staging 完整流水线（lint→test→build→deploy staging→smoke test），staging smoke test 通过是 production 部署的前置条件 |
| **老板人工验收** | production 部署使用 GitHub Environment Protection，`Required reviewers: EeiMoo`。只有老板明确审批后 production workflow 才执行 |

### 10.9 回滚机制

```
正常流程：     build → deploy staging → smoke test → ✅ pass
异常流程：     build → deploy staging → smoke test → ❌ fail
                                                         │
                                                         ▼
                                              ┌──────────────────┐
                                              │ 自动 Rollback     │
                                              │ 1. 读取上一版本 TAG│
                                              │ 2. docker pull    │
                                              │ 3. docker-compose │
                                              │    up -d (回滚)   │
                                              └──────────────────┘

手动回滚：     ssh staging-server
              export TAG=<上一稳定版本>
              docker-compose -f deploy/docker-compose.staging.yml up -d --no-deps app nginx
```

---

# 第三部分：飞书 SSO 集成架构

## 11. 飞书 SSO OAuth 2.0 集成

### 11.1 认证体系总览

v1.0/v1.1 使用**简易 dev token 模式**（前端手动输入 ID → 拼接 `dev_userId_teamId_name` → 后端 `dev_` 前缀解析）。v1.2 引入完整的飞书 OAuth 2.0 授权码流程，同时**保留 dev 模式作为降级**。

```
┌──────────────────────────────────────────────────────────────────┐
│                    🔐 认证策略矩阵                                  │
│                                                                  │
│  环境      认证方式          前端入口         后端验签              │
│  ────────  ────────────────  ──────────────  ──────────────────  │
│  production 飞书 OAuth 2.0   飞书授权按钮    飞书 Open API 验签    │
│  staging    飞书 OAuth 2.0   飞书授权按钮    飞书 Open API 验签    │
│             (沙箱 App)                                          │
│  development dev token       手动输入表单    dev_ 前缀解析        │
│             降级模式          (保留 v1.0)                         │
│  fallback   无飞书凭证       手动输入表单    token 直传为 user_id  │
│             完全降级          (保留 v1.0)                         │
└──────────────────────────────────────────────────────────────────┘
```

### 11.2 OAuth 2.0 授权码流程（完整时序）

```
  用户浏览器(飞书 WebView)        前端 React SPA           飞书授权服务器       后端 Express
  ────────────────────────      ──────────────          ───────────────      ──────────────
        │                           │                        │                    │
        │ 1. 访问 /login           │                        │                    │
        │─────────────────────────→│                        │                    │
        │                           │                        │                    │
        │ 2. 显示飞书登录按钮       │                        │                    │
        │←─────────────────────────│                        │                    │
        │                           │                        │                    │
        │ 3. 点击「飞书登录」       │                        │                    │
        │─────────────────────────→│                        │                    │
        │                           │ 4. 构造授权 URL + state│                    │
        │                           │───────────────────────→│                    │
        │                           │ redirect_uri=          │                    │
        │                           │   /api/auth/feishu/    │                    │
        │                           │   callback             │                    │
        │                           │ scope=open_id+name+    │                    │
        │                           │   avatar               │                    │
        │                           │                        │                    │
        │ 5. 飞书授权页             │                        │                    │
        │←───────────────────────────────────────────────────│                    │
        │                           │                        │                    │
        │ 6. 用户授权确认           │                        │                    │
        │───────────────────────────────────────────────────→│                    │
        │                           │                        │                    │
        │                           │ 7. 回调 redirect_uri   │                    │
        │                           │    带 code + state     │                    │
        │                           │←───────────────────────│                    │
        │                           │                        │                    │
        │                           │ 8. 服务端回调处理        │                    │
        │                           │ GET /api/auth/feishu/   │───────────────────→│
        │                           │   callback?code=xxx     │                    │
        │                           │                        │                    │
        │                           │                        │  9. 用 code 换 token │
        │                           │                        │←──────────────────│
        │                           │                        │ /open-apis/authen/ │
        │                           │                        │   v1/oidc/         │
        │                           │                        │   access_token     │
        │                           │                        │                    │
        │                           │                        │ 10. 返回 token      │
        │                           │                        │──────────────────→│
        │                           │                        │ {access_token,     │
        │                           │                        │  refresh_token}    │
        │                           │                        │                    │
        │                           │                        │  11. 获取用户信息    │
        │                           │                        │←──────────────────│
        │                           │                        │ /open-apis/authen/ │
        │                           │                        │   v1/user_info     │
        │                           │                        │                    │
        │                           │                        │ 12. 返回 user_info  │
        │                           │                        │──────────────────→│
        │                           │                        │ {open_id, name,    │
        │                           │                        │  avatar_url}       │
        │                           │                        │                    │
        │                           │ 13. 302 → 前端 /?token=│                    │
        │                           │     {feishu_token}     │                    │
        │                           │←───────────────────────────────────────────│
        │                           │                        │                    │
        │ 14. 前端解析 URL 参数      │                        │                    │
        │    localStorage 存 token  │                        │                    │
        │    navigate('/votes')     │                        │                    │
        │                           │                        │                    │
```

### 11.3 授权参数

| 参数 | 值 | 说明 |
|------|-----|------|
| **授权端点** | `https://open.feishu.cn/open-apis/authen/v1/authorize` | 飞书 OAuth 授权页 |
| **App ID** | `<飞书应用 App ID>` | 环境变量 `FEISHU_APP_ID` |
| **redirect_uri** | `https://<domain>/api/auth/feishu/callback` | 回调端点注册在 Express |
| **scope** | `open_id` `name` `avatar` | 最小权限原则：仅获取 open_id + 姓名 + 头像 |
| **state** | 随机 UUID（防 CSRF） | 前端生成，回调时校验 |
| **grant_type** | `authorization_code` | OAuth 2.0 授权码模式 |

### 11.4 API 端点设计

#### 11.4.1 新增端点：飞书 OAuth 回调

```
GET /api/auth/feishu/callback
```

**描述**：飞书授权服务器回调端点。接收授权码，换取 user_access_token，获取用户信息，生成内部 session token，重定向回前端。

**查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `code` | string | 飞书返回的授权码（一次性，5 分钟有效） |
| `state` | string | 防 CSRF 随机串，须与发起时一致 |

**响应**：HTTP 302 重定向到前端，URL 携带 token：

```
Location: https://<domain>/?token=<feishu_session_token>&name=<display_name>&avatar=<avatar_url>
```

**内部处理流程**：

```typescript
// 伪码（auth.ts 新增回调处理函数）
async function handleFeishuCallback(req: Request, res: Response) {
  const { code, state } = req.query;

  // 1. 校验 state（防 CSRF）—— 从 Redis/内存中获取原始 state 比对
  //    MVP 可跳过（state 存在即通过）

  // 2. 用 code 换取 user_access_token
  const appToken = await getAppAccessToken();
  const tokenRes = await fetch(
    'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appToken}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    }
  );
  const { data: { access_token } } = await tokenRes.json();

  // 3. 获取用户信息
  const userRes = await fetch(
    'https://open.feishu.cn/open-apis/authen/v1/user_info',
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  const { data: user } = await userRes.json();
  // user: { open_id, name, en_name, avatar_url, tenant_key }

  // 4. 生成内部 token（使用 user_access_token 作为后续 API 请求的 Bearer token）
  //    或签发一个内部 JWT 包含 user 信息
  const internalToken = access_token;  // 生产：直接用飞书 token
  const displayName = user.name || user.en_name || user.open_id;
  const avatarUrl = user.avatar_url || '';

  // 5. 302 重定向到前端
  const frontendUrl = config.FRONTEND_URL || '/';
  res.redirect(302,
    `${frontendUrl}?token=${encodeURIComponent(internalToken)}` +
    `&name=${encodeURIComponent(displayName)}` +
    `&avatar=${encodeURIComponent(avatarUrl)}`
  );
}
```

#### 11.4.2 前端入口点：/login 路由

```
GET /login
```

**UI 布局**：

```
┌────────────────────────────────────┐
│                                    │
│        🗳️ 团队即时投票              │
│                                    │
│     ┌──────────────────────┐       │
│     │  🟢 飞书账号登录       │       │  ← 飞书授权按钮（生产/staging）
│     │  使用飞书账号一键登录   │       │
│     └──────────────────────┘       │
│                                    │
│     ─────── 或 ───────             │
│                                    │
│     ┌──────────────────────┐       │
│     │  用户 ID: [________]  │       │  ← dev 模式降级（development/fallback）
│     │  昵　称: [________]  │       │
│     │  [进入投票]           │       │
│     └──────────────────────┘       │
│                                    │
│     连接飞书 SSO 后将自动登录       │
│                                    │
└────────────────────────────────────┘
```

#### 11.4.3 回调端点注册

后端 `app.ts` 新增路由注册：

```typescript
// 飞书 OAuth 回调（无需认证中间件）
app.get('/api/auth/feishu/callback', handleFeishuCallback);

// 飞书授权入口重定向（可选：服务端拼接完整授权 URL）
app.get('/api/auth/feishu/login', (req, res) => {
  const state = crypto.randomUUID();
  const redirectUri = `${config.BASE_URL}/api/auth/feishu/callback`;
  const authUrl =
    `https://open.feishu.cn/open-apis/authen/v1/authorize` +
    `?app_id=${config.FEISHU_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=open_id%20name%20avatar` +
    `&state=${state}`;

  // 可选：将 state 存入 Redis（TTL 5min）供回调时校验
  res.redirect(302, authUrl);
});
```

### 11.5 降级策略

| 场景 | 行为 | 入口 |
|------|------|------|
| **正常生产** | Login.tsx 显示飞书授权按钮，用户点击后跳转飞书 OAuth | Login.tsx（飞书按钮） |
| **飞书 App ID 未配置**（`FEISHU_APP_ID` 为空） | Login.tsx 不显示飞书按钮，仅显示 dev 手动输入表单 | Login.tsx（条件渲染） |
| **飞书 OAuth 回调失败**（网络异常/飞书服务不可用） | 回调端点返回 500 错误页面，引导用户使用 dev 模式 | 服务端错误页面 |
| **后端 auth.ts 解析 token 失败** | 飞书验签失败 → 401 → 前端清除 token → 重定向 /login | api.ts 拦截器 |

**降级判断逻辑（前端 Login.tsx）**：

```typescript
// Login.tsx 新增逻辑
const [hasFeishu, setHasFeishu] = useState(false);

useEffect(() => {
  // 通过 API 探测飞书是否可用：GET /api/auth/feishu/status
  // 返回 { available: true/false }
  api.get('/auth/feishu/status')
    .then(res => setHasFeishu(res.data.available))
    .catch(() => setHasFeishu(false));
}, []);

// 渲染：
// {hasFeishu && <FeishuLoginButton />}   ← 飞书 OAuth 按钮
// <DevLoginForm />                        ← 手动输入（始终可见作为降级）
```

### 11.6 Token 生命周期

| Token 类型 | 来源 | 存储位置 | 有效期 | 刷新策略 |
|-----------|------|---------|--------|---------|
| **user_access_token** | 飞书 OAuth 回调 | 前端 localStorage (`feishu_token`) | 飞书默认 ~2h | 过期后前端重定向飞书重新授权 |
| **app_access_token** | 飞书 Open API | 后端内存（`_cachedAppToken`） | 2h（提前 10min 刷新） | 自动调用 `/auth/v3/app_access_token/internal` |
| **内部 dev token** | 前端手动输入 | 前端 localStorage | 无过期（开发用） | 无需刷新 |

> **关于 refresh_token**：飞书 OAuth v3 授权码模式支持 refresh_token，可换取新的 user_access_token 延长会话。MVP 阶段简化为：token 过期后重新走飞书授权（用户体验可接受，因为飞书 WebView 内 cookie 持久化，二次授权无需用户确认）。

### 11.7 安全约束

| 约束 | 实现 |
|------|------|
| **HTTPS 强制** | Nginx 80→443 301 重定向；飞书 WebView 要求 HTTPS |
| **CSRF 防护** | OAuth `state` 参数（前端生成 UUID，回调时校验） |
| **redirect_uri 白名单** | 飞书应用后台配置回调域名白名单，防止授权码劫持 |
| **最小权限 scope** | 仅请求 `open_id` + `name` + `avatar`，不请求通讯录/日历等敏感权限 |
| **Token 不落地 URL** | 回调后立即 302 重定向去掉 URL 中的 code（code 一次性用完即失效） |

### 11.8 auth.ts 改造要点（供凌霜参考）

现有 `auth.ts` 已包含飞书生产模式验签逻辑（`verifyFeishuToken` → `getAppAccessToken` → `getUserAccessToken` → `/user_info`）。v1.2 需新增：

1. **新增导出函数** `handleFeishuCallback`：处理 `GET /api/auth/feishu/callback`
2. **新增导出路由** `feishuAuthRouter`：包含 `/callback` 和 `/login` 端点
3. **配置新增**：`config.BASE_URL`（用于拼接 redirect_uri）、`config.FRONTEND_URL`
4. **保持向后兼容**：现有 `feishuAuth` 中间件的 dev token 降级逻辑不变

### 11.9 Login.tsx 改造要点（供流光参考）

现有 `Login.tsx` 包含手动输入表单。v1.2 需新增：

1. **新增飞书授权按钮**：调用 `/api/auth/feishu/login`（服务端 302 到飞书授权页）
2. **URL 参数解析**：`/login?token=xxx&name=xxx&avatar=xxx` → 存 localStorage → navigate('/votes')
3. **条件渲染**：`hasFeishu` 状态控制飞书按钮显隐；dev 表单始终作为降级可见
4. **头像展示**：登录后从 `localStorage` 读取 `feishu_avatar` 在顶栏显示

### 11.10 飞书应用配置清单

| 配置项 | 说明 |
|--------|------|
| **应用类型** | 企业自建应用 |
| **App ID / App Secret** | 在飞书开放平台 → 应用详情获取 |
| **OAuth 2.0 回调 URL** | `https://eeimoo.cn/api/auth/feishu/callback`（生产）<br>`https://staging.eeimoo.cn/api/auth/feishu/callback`（staging） |
| **权限范围** | `open_id` + 获取用户姓名 + 获取用户头像 |
| **安全设置** | 回调域名白名单：`eeimoo.cn`, `staging.eeimoo.cn` |

---

## 12. 变更影响分析

### 12.1 对现有模块的影响

| 模块 | 影响 | 变更类型 |
|------|------|---------|
| `deploy/ci-pipeline.yml` | 拆分为 `.github/workflows/ci.yml`，新增双仓库推送、environment protection | 🔴 新增 |
| `backend/src/middleware/auth.ts` | 新增 `handleFeishuCallback` + `/callback` + `/login` 路由；现有中间件逻辑不变 | 🟡 增量 |
| `backend/src/app.ts` | 注册新路由 `/api/auth/feishu/*`（白名单，无需 auth 中间件） | 🟡 增量 |
| `frontend/src/pages/Login.tsx` | 新增飞书授权按钮 + URL 参数解析；保留 dev 表单 | 🟡 增量 |
| `frontend/src/services/api.ts` | 401 拦截器重定向到 `/login`（已有，无需改） | 🟢 无变更 |
| Docker Compose 文件 | 引用远程镜像替代本地构建（staging/production 分离镜像源） | 🔴 变更 |
| `deploy/nginx.conf` | 无需变更（回调路由为 `/api/auth/feishu/*`，已由 `location /api/` 代理） | 🟢 无变更 |
| 数据模型（DDL） | 无需变更（creator_id/team_id/creator_name 已有） | 🟢 无变更 |

### 12.2 部署顺序

```
1. 飞书应用配置（回调 URL + 权限申请）
2. 后端 auth.ts 新增回调端点 → 合并 main → CI 自动部署 staging
3. 前端 Login.tsx 改造 → 合并 main → CI 自动部署 staging
4. staging 烟雾测试 → 集成测试飞书 OAuth 完整流程（沙箱 App）
5. boss 验收 → 手动触发 production 部署
```

---

## 13. 归档索引

| 文档 | 路径 | 版本 | 说明 |
|------|------|------|------|
| 总体架构设计 v1.1 | `docs/ARCH_团队即时投票工具_v1.1.md` | v1.1 | 基础架构完整文档 |
| 总体架构设计 v1.2 | `docs/ARCH_v1.2_CI+SSO.md` | v1.2 | 本文档：CI/CD + SSO 增量设计 |
| PRD v1.1 | `docs/PRD_团队即时投票工具_v1.1.md` | v1.1 | 产品需求文档 |
| CI/CD 流水线定义 | `deploy/ci-pipeline.yml` | evo-v1 | GitHub Actions workflow 文件 |
| 部署运维手册 | `DEPLOYMENT_RUNBOOK.md` | v1.0 | 部署操作 SOP |
| Docker Compose 编排 | `deploy/docker-compose.yml` | v1.1 | 生产环境编排 |
| Docker Compose (staging) | `deploy/docker-compose.staging.yml` | evo-v1 | Staging 环境编排 |
| Nginx 配置 | `deploy/nginx.conf` | v1.1 | 反向代理 + SSL + WS |

---

> **设计人签署**：栖梧 | 2026-06-02
>
> **审查记录**：
> - 待云起☁️ 审查
> - 待凌霜❄️ 审查（后端 auth.ts 改造可行性）
> - 待流光✨ 审查（前端 Login.tsx 改造可行性）
> - 待长夜🌙 审查（CI/CD 流水线 + 双仓库推送可行性）
> - 待知微🛡️ 审查（OAuth 安全 + CSRF 防护）
