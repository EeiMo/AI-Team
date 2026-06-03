# 部署就绪报告

**项目**: 团队即时投票工具  
**评审人**: 长夜 🚀  
**日期**: 2026-06-01  
**阶段**: 阶段六 Go/No-Go 评审 — 部署就绪验证

---

## 检查清单

### 1. docker-compose.yml — 4 服务完整性

| 服务   | 镜像/构建方式                   | 状态 |
|--------|-------------------------------|------|
| app    | `app.Dockerfile` 本地构建      | ✅   |
| pg     | `postgres:15-alpine` 官方镜像  | ✅   |
| redis  | `redis:7-alpine` 官方镜像      | ✅   |
| nginx  | `nginx.Dockerfile` 本地构建    | ✅   |

**结果**: 🟢 通过  
4 个服务全部定义，健康检查均已配置（pg: `pg_isready`、redis: `redis-cli ping`、app: `/health`、nginx: `/health`），依赖顺序正确（app depends_on pg+redis with `condition: service_healthy`，nginx depends_on app）。数据持久化通过命名卷 `pg_data` / `redis_data` 保障。

---

### 2. nginx.conf — SSL + 反代 + ip_hash + real_ip

| 检查项          | 配置位置                                                                 | 状态 |
|-----------------|--------------------------------------------------------------------------|------|
| SSL (TLS)       | `listen 443 ssl http2`，TLSv1.2/TLSv1.3，证书路径 `/etc/nginx/certs/`   | ✅   |
| 反向代理 (API)  | `location /api/` → `proxy_pass http://vote_app`                          | ✅   |
| 反向代理 (WS)   | `location /ws/` → WebSocket Upgrade 头 + `proxy_buffering off`           | ✅   |
| ip_hash         | `upstream vote_app { ip_hash; server app:3001 ... }`                     | ✅   |
| real_ip         | `set_real_ip_from 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16` + `X-Forwarded-For` + `real_ip_recursive on` | ✅   |

**结果**: 🟢 通过  
所有四项关键配置均已正确实现。real_ip 覆盖 Docker 默认桥接网段，确保 ip_hash 基于真实客户端 IP 而非网关 IP。SPA fallback（`try_files $uri $uri/ /index.html`）和静态资源强缓存（`/assets/` 30d）均已配置。

---

### 3. Dockerfile — 多阶段构建

| Dockerfile        | Stage 1                        | Stage 2                 | 非 root 用户 | 状态 |
|-------------------|--------------------------------|-------------------------|-------------|------|
| `app.Dockerfile`  | `node:20-alpine AS builder`   | `node:20-alpine` 运行时 | `vote:vote` (1001) | ✅   |
| `nginx.Dockerfile`| `node:20-alpine AS client-builder` | `nginx:1.25-alpine` | nginx 默认 (nginx) | ✅   |

**结果**: 🟢 通过  
- `app.Dockerfile`：Stage 1 完成 `npm ci --include=dev` → TypeScript 编译 → `npm prune --production`，Stage 2 仅复制编译产出和 production node_modules，镜像精简。非 root 用户 `vote` 已配置。  
- `nginx.Dockerfile`：Stage 1 完成前端 `npm run build`（Vite），Stage 2 注入 `nginx.conf` + 前端构建产物。无 devDependencies 残留。

---

### 4. backup.sh — 可执行性 + cron 语法

| 检查项           | 详情                                                       | 状态 |
|------------------|------------------------------------------------------------|------|
| 文件权限         | `-rwxrwxr-x`（可执行）                                     | ✅   |
| cron 语法        | `0 3 * * * root <script> >> /var/log/vote-backup.log 2>&1` | ✅   |
| 备份逻辑         | `pg_dump --no-owner --no-acl --clean --if-exists` + gzip   | ✅   |
| 过期清理         | `find ... -mtime +7 -delete`（7 天保留）                   | ✅   |
| 恢复 SOP         | 停 app → 恢复 → 启 app（TallySync 自动重建 Redis）          | ✅   |

**结果**: 🟢 通过  
cron 语法符合标准五段式格式，每天凌晨 3:00 执行。备份脚本功能齐全：一键备份、自动清理、列表查看、交互式恢复（需输入 YES 确认），以及一键安装 cron。

---

### 5. deploy.sh — lint → test → build → push → deploy 五步

| 步骤 | 名称    | 实现                                                                                      | 状态 |
|------|---------|-------------------------------------------------------------------------------------------|------|
| 1/5  | Lint    | 后端 `tsc --noEmit` + `eslint`，前端 `tsc --noEmit` + `eslint`（`--local` 模式跳过）       | ✅   |
| 2/5  | Test    | `npm test`（jest/vitest），`--local` 模式跳过                                              | ✅   |
| 3/5  | Build   | `docker build -f app.Dockerfile` + `docker build -f nginx.Dockerfile`                      | ✅   |
| 4/5  | Push    | `docker push`（`DOCKER_REGISTRY` 为空时跳过）                                              | ✅   |
| 5/5  | Deploy  | `docker-compose up -d --no-deps --build app`（滚动重启）+ health check + nginx reload      | ✅   |

**结果**: 🟢 通过  
五步流水线完整且顺序正确。支持三种运行模式：`--lint-only`、`--build-only`、`--local`。部署阶段采用灰度策略（仅重启 app，不动 pg/redis/nginx），含 60 秒健康检查超时和超时回滚提示。支持 `--env` / `--tag` 参数化。

---

### 6. PG migration 文件命名规范

| 文件                    | 命名格式          | 内容                                          | 状态 |
|-------------------------|-------------------|-----------------------------------------------|------|
| `migrations/001_init.sql` | `<序号>_<描述>.sql` | UUID v7 函数 + 3 张表（votes/options/user_votes）+ 索引 | ✅   |

**结果**: 🟢 通过  
文件命名遵循标准 `NNN_description.sql` 规范，序号从 `001` 开始，`init` 描述清晰。DDL 完整覆盖 MVP 数据模型：UUID v7 主键、外键约束（ON DELETE CASCADE）、唯一约束（防重复投票）、合理索引（按 team+status+time 复合索引、按 deadline 部分索引）。docker-compose 中映射到 `/docker-entrypoint-initdb.d`，PG 容器首次启动自动执行。

---

## 综合结论

| # | 检查项                          | 结果  |
|---|--------------------------------|------|
| 1 | docker-compose 4 服务完整性     | ✅   |
| 2 | nginx SSL/反代/ip_hash/real_ip | ✅   |
| 3 | Dockerfile 多阶段构建           | ✅   |
| 4 | backup.sh 可执行性 + cron       | ✅   |
| 5 | deploy.sh 五步流水线            | ✅   |
| 6 | PG migration 命名规范           | ✅   |

---

## 🟢 部署就绪

**六项检查全部通过。配置完整、可执行、满足生产部署要求，建议 Go。**

> 备注：正式部署前请确保 `certs/` 目录已放置有效的 SSL 证书（MVP 可先用自签证书，脚本中已给出 openssl 命令）。`PG_PASSWORD`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等敏感环境变量请通过 CI/CD secrets 或 `.env` 文件注入，切勿提交到版本控制。
