# 长夜🚀 Staging 部署报告 — v3「创建人删除投票 + 前端美工优化」

> **报告人**：长夜 🚀 | **日期**：2026-06-03 10:18 GMT+8  
> **项目**：团队即时投票工具 v3  
> **环境**：Staging（本机 Docker Compose）  
> **部署方式**：手工部署 `docker compose -f deploy/docker-compose.staging.yml up -d`

---

## 结论摘要

**✅ Staging 验证通过** — v3「创建人删除投票」功能在 Staging 环境运行正常：软删除、审计日志、幂等删除均已验证。前端页面正确渲染，API 返回正常。共 **0 个阻断项**。存在 **2 个已知非阻断问题**（Health Check 端点认证问题 + 自签证书导致的 nginx healthcheck 失败，均为预存问题，不影响功能）。

---

## 一、环境信息

| 项目 | 值 |
|------|-----|
| **环境** | Staging（本地单机） |
| **Docker Compose** | `deploy/docker-compose.staging.yml`（v3 修订版） |
| **启动时间** | 2026-06-03 10:18 CST |
| **部署方式** | 手工 `docker compose -f deploy/docker-compose.staging.yml up -d` |
| **CI/CD** | 🔵 本轮不修复（老板决策） |

### 容器运行状态

| 容器 | 镜像 | Docker 状态 | 端口映射 | 说明 |
|------|------|-----------|----------|------|
| vote-app-staging | vote-app:staging | 🔴 Unhealthy（功能正常） | 3001/tcp | 见 §三 健康检查问题 |
| vote-nginx-staging | vote-nginx:staging | 🔴 Unhealthy（功能正常） | 8080→80, 8443→443 | 见 §三 健康检查问题 |
| vote-pg-staging | postgres:15-alpine | 🟢 Healthy | 127.0.0.1:5433→5432 | ✅ |
| vote-redis-staging | redis:7-alpine | 🟢 Healthy | 127.0.0.1:6380→6379 | ✅ |

### 中间件版本

| 组件 | 版本 | 镜像 | 状态 |
|------|------|------|------|
| PostgreSQL | 15 | `postgres:15-alpine` | ✅ |
| Redis | 7 | `redis:7-alpine` | ✅ |
| Node.js（运行时） | 20 | `node:20-alpine` | ✅ |
| Nginx | 1.25-alpine | `nginx:1.25-alpine` | ✅ |

### 数据库迁移执行

| 迁移 | 状态 | 说明 |
|------|------|------|
| `001_init.sql` | ✅ 跳过（已存在） | 基础表结构 |
| `002_users.sql` | ✅ 执行成功 | 用户表 |
| `003_v3_delete_audit.sql` | ✅ 执行成功 | v3 新增软删除 + audit_logs |
| `003_v3_delete_audit_rollback.sql` | ✅ 执行成功 | 回滚脚本（向下兼容） |
| `003_votes_soft_delete.down.sql` | ✅ 执行成功 | 下行兼容 |
| `003_votes_soft_delete.sql` | ✅ 执行成功 | 软删除字段 |

---

## 二、v3 增量功能验证 — 创建人删除投票

### 2.1 测试场景

创建一条测试投票，使用创建人 JWT 身份调用 `DELETE /api/votes/:id`。

### 2.2 测试结果

| 测试项 | 预期 | 实际 | 结果 |
|--------|------|------|------|
| ① DELETE API 返回 | `{"code":0,"message":"投票已删除"}` | `{"code":0,"message":"投票已删除"}` | ✅ |
| ② 软删除标记 | `votes.del_flag = true` | `t` | ✅ |
| ③ 删除时间记录 | `votes.deleted_at` 非空 | `2026-06-03 02:19:48.85+00` | ✅ |
| ④ 删除人记录 | `votes.deleted_by = test-creator` | `test-creator` | ✅ |
| ⑤ 审计日志写入 | audit_logs 表写入 DELETE_VOTE 记录 | 已写入（含详情 JSON） | ✅ |
| ⑥ 幂等删除 | 第二次 DELETE 返回幂等成功 | `{"code":0,"message":"投票已删除"}` | ✅ |

### 2.3 审计日志内容验证

```
action      | DELETE_VOTE
entity_type | vote
entity_id   | 00000000-0000-7000-8000-000000000001
user_id     | test-creator
team_id     | test-team
detail      | {"deleted_at":"2026-06-03T02:19:48.850Z","vote_title":"测试删除投票","vote_status":"active"}
```

### 2.4 数据库结构验证

- ✅ `votes` 表：`del_flag`（BOOLEAN）、`deleted_at`（TIMESTAMPTZ）、`deleted_by`（VARCHAR(64)）列均正确
- ✅ `audit_logs` 表：完整含 `action`、`entity_type`、`entity_id`、`user_id`、`team_id`、`ip`、`user_agent`、`detail`（JSONB）、`created_at`
- ✅ 索引：`idx_votes_del_flag`、`idx_audit_logs_action`、`idx_audit_logs_entity`、`idx_audit_logs_user` 均存在

---

## 三、健康检查

### 3.1 诊断

| 端点 | Docker healthcheck 结果 | 功能是否可用 | 说明 |
|------|------------------------|-------------|------|
| `GET /api/health`（container → app） | 🔴 401 | ✅ 可用（需认证） | App 内部 `/api/health` 端点返回 `401`（需 JWT），`curl -f` 视为失败 |
| `GET /api/health`（nginx → app） | 🔴 SSL 握手失败 | ✅ 可用（需认证） | nginx healthcheck 通过 wget 到 `http://localhost/api/health`，被 301 HTTPS 重定向，自签证书导致 wget 验证失败 |
| `GET /`（nginx → 浏览器） | — | ✅ 200 | SPA 前端正常渲染 |
| `GET /assets/*`（nginx） | — | ✅ 200 | 静态资源正确加载 |
| `GET /api/*`（nginx → app） | — | ✅ 200/401 | API 逻辑正常（401 是预期的未认证响应） |

### 3.2 已知非阻断问题

| # | 问题 | 影响 | 根因 | 严重性 |
|---|------|------|------|--------|
| P1 | App healthcheck 返回 401 | `docker ps` 显示 app unhealthy，但不影响功能 | `/api/health` 端点需要 JWT 认证，healthcheck `curl -f` 不允许 401 | ⚠️ 低（预存问题，v1.2 延续） |
| P2 | Nginx healthcheck 因自签证书失败 | `docker ps` 显示 nginx unhealthy，不影响功能 | nginx healthcheck 使用 `wget http://localhost/api/health` 被 301 到 HTTPS，自签证书导致 wget 退出码 1 | ⚠️ 低（预存问题，v1.2 延续） |

> **修复建议**（迭代 backlog）：为 `/api/health` 端点添加无需 JWT 的 `GET /api/healthz` 存活端点（存活检查用）/ `GET /api/readyz` 就绪端点（含依赖检查），Docker healthcheck 指向 `/api/healthz`。这样 `/api/health` 保留认证用于外部监控。

---

## 四、前端验证

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 首页 HTML 渲染 | ✅ 200 OK | SPA 入口正确 |
| JS Bundle 加载 | ✅ 200 OK | 存在 `index-5JKiwPDS.js` |
| CSS 加载 | ✅ 200 OK | 存在 `index-hgHF8I5P.css` |
| SPA 路由 fallback | ✅ 200 OK | 未知路由返回 index.html |
| HTTPS 证书 | ✅ 警告（自签） | Staging 使用自签证书，生产需替换 |

---

## 五、后端验证

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 应用启动 | ✅ 正常 | 无异常退出 |
| 数据库连接 | ✅ 正常 | PG `SELECT 1` 通过 |
| Redis 连接 | ✅ 正常 | Redis PING 通过 |
| WebSocket 初始化 | ✅ 正常 | `/ws` 路径已注册 |
| 过期任务 Worker | ✅ 正常 | 订阅了 Redis keyspace 过期事件 |

---

## 六、遗留问题与风险

### 6.1 当前遗留

| # | 问题 | 类型 | 当前状态 |
|---|------|------|---------|
| 1 | `GET /api/health` 端点需 JWT 认证 → healthcheck 不可用 | 非阻断 | 预存问题，v1.2 延续 |
| 2 | Nginx healthcheck 因自签证书 HTTPS 重定向失败 | 非阻断 | 预存问题，v1.2 延续 |
| 3 | CI/CD 流水线未修复 | 已知限制 | 老板决策保留人工验收 |
| 4 | GitHub Actions 自托管 Runner 未注册 | 待办 | 需老板提供 token 注册 |

### 6.2 生产部署前待办

| # | 事项 | 优先级 | 依赖 |
|---|------|--------|------|
| 1 | 生产 SSL 证书替换（Let's Encrypt / 云厂商免费证书） | P0 | 证书管理员 |
| 2 | 生产 PG 密码 + JWT_SECRET 替换为强密码 | P0 | 安全管理 |
| 3 | 生产 Docker Compose 端口恢复为默认（80/443/5432/6379） | P0 | — |
| 4 | 灾备方案验证（DB 定期备份脚本：`deploy/backup.sh`） | P1 | — |
| 5 | 监控：Prometheus + Grafana 接入或 Docker healthcheck 告警 | P2 | 架构规划 |
| 6 | 容量规划（架构 §8.3：2 vCPU / 4 GiB Mem 验证） | P2 | 生产上线前 |

---

## 七、数据库回滚方案

如生产发现 v3 变更有问题，执行：

```sql
-- 回滚 v3 DDL：删除 audit_logs 表、索引、votes 新增列
\i /app/migrations/003_v3_delete_audit_rollback.sql
\i /app/migrations/003_votes_soft_delete.down.sql
```

回滚具有幂等性（各 DROP/DELETE 语句已有 IF EXISTS 保护）。

---

*报告完毕 · 长夜 🚀*
