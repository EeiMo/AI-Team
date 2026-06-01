# 生产部署操作手册（SOP）

> 项目：团队即时投票工具 | 版本：v1.0 | 最后更新：2026-06-01

---

## 一、部署架构

```
┌──────────────────────────────────────┐
│  生产服务器 (目标机器)               │
│                                      │
│  ┌─────────┐  ┌──────────────────┐   │
│  │ Nginx   │  │  vote-app (Node) │   │
│  │ :80:443 │──│  :3001           │   │
│  └─────────┘  └────┬──────┬──────┘   │
│                    │      │          │
│             ┌──────┘      └──────┐   │
│             ▼                    ▼   │
│      ┌──────────┐       ┌──────────┐ │
│      │ Postgres │       │  Redis   │ │
│      │ :5432    │       │  :6379   │ │
│      └──────────┘       └──────────┘ │
│                                      │
│  cron: 每天 03:00 pg_dump 备份      │
└──────────────────────────────────────┘
```

---

## 二、前置条件检查清单

在部署前，逐项确认生产服务器满足以下条件：

### 操作系统
- [ ] 操作系统：Ubuntu 20.04+ / Debian 11+ / CentOS 8+
- [ ] CPU ≥ 2 核，内存 ≥ 4 GB，磁盘 ≥ 20 GB 可用
- [ ] 时区设置为 `Asia/Shanghai`

### 基础软件
- [ ] Docker ≥ 24.0（`docker --version`）
- [ ] Docker Compose ≥ 2.20（`docker compose version`）
- [ ] Git ≥ 2.30（`git --version`）
- [ ] curl 和 wget 已安装

```bash
# 一键检查
docker --version && docker compose version && git --version && curl --version | head -1
```

### 网络
- [ ] 服务器可访问外网（拉取 GitHub + Docker Hub）
- [ ] 端口 80、443 未被占用（`ss -tlnp | grep -E ':80|:443'`）
- [ ] 如有防火墙，开放 80/443

### 飞书应用
- [ ] 飞书开放平台已创建应用，获取 App ID 和 App Secret
- [ ] 应用已配置回调域名（生产域名）

### SSL 证书
- [ ] 已准备证书文件：`fullchain.pem` 和 `privkey.pem`
- [ ] 放置到 `deploy/certs/` 目录下
- [ ] 如暂无证书：先用自签证书部署测试连通性，之后切换为正式证书

---

## 三、部署步骤

### Step 1: 获取代码

```bash
# 在目标服务器上执行
cd /opt
git clone git@github.com:EeiMo/AI-Team.git vote-app
cd vote-app
```

### Step 2: 配置环境变量

```bash
cp .env.example .env.production
vim .env.production
```

必填项：
| 变量 | 说明 | 示例 |
|------|------|------|
| `PG_PASSWORD` | PostgreSQL 密码（≥16字符） | `aB3xYz...` |
| `FEISHU_APP_ID` | 飞书应用 App ID | `cli_a...` |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | `***` |
| `TEAM_TOTAL_MEMBERS` | 团队总人数 | `24` |

### Step 3: 放置 SSL 证书

```bash
cp /path/to/your/fullchain.pem deploy/certs/
cp /path/to/your/privkey.pem deploy/certs/
chmod 600 deploy/certs/privkey.pem
```

### Step 4: 构建并启动

```bash
# 从项目根目录执行
export $(cat .env.production | xargs)
docker compose -f deploy/docker-compose.yml up -d --build
```

首次构建约 3-5 分钟（拉取基础镜像 + npm install + TypeScript 编译）。

### Step 5: 验证部署

```bash
# 1. 检查容器状态（4 个容器应为 Up）
docker compose -f deploy/docker-compose.yml ps

# 2. 健康检查
curl -k https://localhost/health
# 预期: {"status":"ok"}

# 3. 后端 API 测试
curl -k https://localhost/api/votes
# 预期: []

# 4. 查看日志（确认无 ERROR）
docker compose -f deploy/docker-compose.yml logs --tail=50 app
```

### Step 6: 安装定时备份

```bash
sudo deploy/backup.sh --install-cron
# 每天凌晨 3:00 自动备份 PostgreSQL 到 /opt/vote-app/backups/pg/
```

---

## 四、常用运维操作

### 日常检查
```bash
# 容器状态
docker compose -f deploy/docker-compose.yml ps

# 资源占用
docker stats --no-stream

# 日志
docker compose -f deploy/docker-compose.yml logs --tail=100 app
```

### 更新部署（滚动更新，不停机）
```bash
cd /opt/vote-app
git pull origin main
export $(cat .env.production | xargs)
docker compose -f deploy/docker-compose.yml up -d --no-deps --build app
# Nginx 自动 reload
```

### 数据库备份与恢复
```bash
# 手动备份
deploy/backup.sh

# 列出已有备份
deploy/backup.sh --list

# 恢复最近备份（⚠️ 会覆盖当前数据）
deploy/backup.sh --restore
```

### 查看 Redis 状态
```bash
docker compose -f deploy/docker-compose.yml exec redis redis-cli INFO memory
docker compose -f deploy/docker-compose.yml exec redis redis-cli DBSIZE
```

---

## 五、监控指标

| 指标 | 正常范围 | 检查方法 |
|------|---------|---------|
| 容器状态 | 全部 Up | `docker compose ps` |
| app 健康检查 | HTTP 200 | `curl https://localhost/health` |
| PG 连接 | pg_isready OK | `docker exec vote-pg pg_isready` |
| Redis 内存 | < 200MB | `redis-cli INFO memory` |
| 磁盘使用 | < 80% | `df -h /opt/vote-app` |
| API 延迟 | < 200ms | nginx access.log `$request_time` |

---

## 六、回滚流程

如果部署后发现严重问题：

```bash
cd /opt/vote-app

# 1. 回滚 Git 到上一版本
git log --oneline -5          # 找到上一个稳定版本
git checkout <commit-hash>

# 2. 重建镜像并部署
docker compose -f deploy/docker-compose.yml up -d --no-deps --build app

# 3. 如数据也需回滚
deploy/backup.sh --restore    # 选择部署前的备份
```

---

## 七、应急预案

| 故障场景 | 处理 | SOP 链接 |
|---------|------|---------|
| app 容器反复重启 | 查看日志：`docker logs vote-app --tail 100`，常见原因：PG/Redis 未就绪、环境变量缺失 | 检查 .env.production |
| 投票结果不推送 | 检查 Redis：`docker exec vote-redis redis-cli PING`，检查 WS 连接：浏览器 DevTools → Network → WS | 重启 Redis |
| 数据库磁盘满 | 清理旧备份 + 扩容磁盘 | `deploy/backup.sh --list` |
| SSL 证书过期 | 更新 certs/ 下证书，`docker exec vote-nginx nginx -s reload` | Let's Encrypt 自动续期 |
| 飞书 SSO 登录失败 | 检查 FEISHU_APP_ID/SECRET，确认开放平台回调域名配置 | 飞书开放平台后台 |
