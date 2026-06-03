# 壹墨运维协作规范

- **设计人**：长夜
- **日期**：2026-06-01
- **进化版本**：evo-v1 | 来源：EVO-007 壹墨协作规范
- **受众**：壹墨（生产运维 AI）+ EeiMoo（开发总控 AI）

---

## 1. 角色定位

| 角色 | 职责 |
|------|------|
| **EeiMoo** | 开发侧总控：需求分析、架构设计、编码实现、测试协调 |
| **壹墨** | 运维侧执行：部署上线、服务监控、故障处理、数据备份 |
| **长夜** | 运维模板提供者：本指南及 deploy/ 下所有脚本的维护者 |

**核心铁律**：壹墨负责「运行态」、EeiMoo 负责「开发态」。生产环境变更必须经 EeiMoo 确认后方可执行。

---

## 2. 壹墨可执行的运维指令清单

### 2.1 容器生命周期管理

```bash
# 查看所有容器状态
docker-compose -f deploy/docker-compose.yml ps

# 启动全部服务
PG_PASSWORD=<pw> FEISHU_APP_ID=<id> FEISHU_APP_SECRET=<sec> TEAM_TOTAL_MEMBERS=24 \
  docker-compose -f deploy/docker-compose.yml up -d

# 停止全部服务（保留数据卷）
docker-compose -f deploy/docker-compose.yml down

# 停止并删除数据卷（⚠️ 危险操作，需 EeiMoo 确认）
docker-compose -f deploy/docker-compose.yml down -v

# 重启单个服务（不影响其他服务）
docker-compose -f deploy/docker-compose.yml restart app
docker-compose -f deploy/docker-compose.yml restart nginx

# 滚动更新 app（不中断 pg/redis/nginx）
docker-compose -f deploy/docker-compose.yml up -d --no-deps --build app
```

### 2.2 日志查看

```bash
# 实时跟踪 app 日志（最近 100 行）
docker-compose -f deploy/docker-compose.yml logs -f --tail=100 app

# 查看 nginx 访问日志
docker-compose -f deploy/docker-compose.yml logs -f --tail=100 nginx

# 查看 PostgreSQL 日志
docker-compose -f deploy/docker-compose.yml logs -f --tail=100 pg

# 搜索特定关键词
docker-compose -f deploy/docker-compose.yml logs app 2>&1 | grep -i "error"

# 查看最近 10 分钟的日志
docker-compose -f deploy/docker-compose.yml logs --since 10m app
```

### 2.3 数据库操作

```bash
# 进入 PostgreSQL 交互式命令行
docker exec -it vote-pg psql -U vote_user -d vote_db

# 执行单条 SQL（非交互）
docker exec -i vote-pg psql -U vote_user -d vote_db <<< "SELECT COUNT(*) FROM votes;"

# 查看所有表
docker exec -i vote-pg psql -U vote_user -d vote_db <<< "\dt"

# 查看表结构
docker exec -i vote-pg psql -U vote_user -d vote_db <<< "\d votes"

# 手动执行迁移脚本
docker exec -i vote-pg psql -U vote_user -d vote_db < backend/migrations/001_init.sql

# 备份数据库（使用 backup.sh）
sudo ./deploy/backup.sh

# 恢复数据库（使用 backup.sh）
sudo ./deploy/backup.sh --restore
```

### 2.4 容器状态诊断

```bash
# 容器健康状态
docker inspect vote-app --format '{{.State.Health.Status}}'
docker inspect vote-pg --format '{{.State.Health.Status}}'
docker inspect vote-redis --format '{{.State.Health.Status}}'

# 容器资源使用
docker stats --no-stream vote-app vote-pg vote-redis vote-nginx

# 容器运行时间
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}"

# 检查端口监听
docker exec vote-app netstat -tlnp 2>/dev/null || docker exec vote-app ss -tlnp
```

### 2.5 版本回滚

```bash
# 查看可用镜像
docker images vote-app --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}"

# 回滚到指定版本
APP_IMAGE=vote-app:<旧标签> docker-compose -f deploy/docker-compose.yml up -d --no-deps app

# 紧急回滚（用上一个已知稳定的镜像）
docker tag vote-app:stable vote-app:rollback
docker-compose -f deploy/docker-compose.yml up -d --no-deps app
```

### 2.6 冒烟测试

```bash
# 部署后执行冒烟测试
./deploy/smoke-test.sh

# 对远程服务器执行
BASE_URL=https://your-server.com ./deploy/smoke-test.sh
```

---

## 3. 上下文传递模板

### 3.1 EeiMoo → 壹墨：Bug/问题描述格式

当 EeiMoo 发现需要壹墨在运维侧排查的问题时，按以下格式传递：

```
【问题类型】[崩溃 | 性能下降 | 数据异常 | 服务不可用 | 其他]
【发现时间】2026-06-01 14:30
【影响范围】[全部用户 | 部分用户 | 仅开发/测试环境]
【现象描述】
  用户反馈投票页面加载超时，/api/votes 接口返回 504

【关联变更】
  最近一次部署：v1.2.3（2026-06-01 10:00）
  变更内容：新增投票结果导出功能

【需要壹墨采集】
  □ app 容器最近 30 分钟日志（含 ERROR 级别）
  □ PostgreSQL 慢查询日志（如有）
  □ 服务器 CPU/内存/磁盘当前使用率
  □ Nginx 错误日志
  □ Redis 内存使用情况

【紧急程度】[P0-立即 | P1-24h内 | P2-本周]
```

### 3.2 壹墨 → EeiMoo：运维发现报告格式

当壹墨主动发现问题时，按以下格式报告：

```
【报告类型】[告警 | 观察 | 建议]
【发现时间】2026-06-01 15:00
【来源】[自动监控 | 日志巡检 | 手动检查]

【发现内容】
  vote-pg 容器磁盘使用率已达 85%，过去 24h 增长 10%

【已采集数据】
  - df -h 输出：(贴数据)
  - pg 数据目录大小：(贴数据)
  - 备份目录大小：(贴数据)

【初步分析】
  可能原因：审计日志表未设清理策略，日均增长 200MB

【建议行动】
  □ 短期：手动清理 30 天前的审计日志
  □ 长期：添加定时清理任务

【需 EeiMoo 决策】
  是否需要暂停写入功能？是否需要紧急扩容？
```

---

## 4. 问题升级路径

### 4.1 壹墨可自主处理（无需通知 EeiMoo）

| 场景 | 操作 |
|------|------|
| 容器 healthcheck 失败自动重启 | 观察 3 次重启后是否恢复，记录日志 |
| 证书即将过期（30 天内） | 执行证书续期脚本 |
| 磁盘使用率 > 80% | 清理过期备份，执行 `docker system prune` |
| 单次健康检查超时后自动恢复 | 记录事件，不升级 |
| 定时备份失败（网络抖动） | 重试 1 次，仍失败则升级 |

### 4.2 需通知 EeiMoo 决策

| 场景 | 壹墨先执行 | 需 EeiMoo 决策的内容 |
|------|-----------|---------------------|
| 连续 3 次 healthcheck 失败 → 容器反复重启 | 采集日志、检查资源 | 是否回滚到上一版本？是否紧急修复？ |
| 数据库磁盘使用率 > 90% | 执行紧急清理、暂停非关键写入 | 是否需要扩容？清理哪些数据？ |
| 发现异常流量（疑似攻击） | 临时限流、采集访问日志 | 是否封禁 IP？是否启用 WAF？ |
| Redis 内存使用率 > 90% | 检查淘汰策略是否生效 | 是否扩容 Redis？是否清理缓存？ |
| 飞书 API 限流导致功能异常 | 确认限流详情 | 是否申请提额？是否降级处理？ |
| 数据库主键冲突/数据不一致 | 采集冲突记录 | 是否需要数据修复脚本？ |
| 安全漏洞公告（依赖组件） | 评估影响范围 | 是否紧急升级？ |
| 生产环境需要 DDL 变更 | 备份当前数据 | 变更脚本 review，变更窗口确认 |

### 4.3 需立即升级（P0）

| 场景 | 动作 |
|------|------|
| 生产服务完全不可用（> 5 分钟） | 立即通知 EeiMoo + 执行紧急回滚 |
| 数据丢失或损坏 | 立即通知 EeiMoo + 停止写入 + 准备恢复 |
| 安全入侵迹象 | 立即通知 EeiMoo + 下线服务 + 保留证据 |

---

## 5. 日常巡检清单

壹墨应每日执行以下检查（可通过 cron 自动化）：

| 检查项 | 命令/方法 | 正常标准 |
|--------|----------|---------|
| 所有容器运行中 | `docker ps --filter name=vote` | 4 个容器全部 Up |
| 健康检查通过 | `curl -k -f https://localhost/health` | HTTP 200 |
| 磁盘空间 | `df -h /opt/vote-app` | 使用率 < 80% |
| 备份状态 | `ls -lt /opt/vote-app/backups/pg/ \| head -3` | 最近 24h 内有备份 |
| 日志无异常 | `docker logs --since 1h vote-app \| grep -ci error` | 错误数 < 10/h |

---

## 6. 紧急联系人 & 通知渠道

| 角色 | 通知方式 | 响应期望 |
|------|---------|---------|
| EeiMoo（开发总控） | 飞书消息 | 工作时间 30min 内 |
| 长夜（运维模板维护） | 飞书消息 | 工作时间 1h 内 |

---

## 7. 附录：常用快捷命令

```bash
# 一键诊断（所有容器状态 + 健康 + 最近错误）
alias vote-diag='docker-compose -f deploy/docker-compose.yml ps && \
  echo "--- Health ---" && \
  curl -sk https://localhost/health && echo "" && \
  echo "--- Recent Errors ---" && \
  docker-compose -f deploy/docker-compose.yml logs --since 10m app 2>&1 | grep -i error | tail -5'

# 一键重启（app + nginx 平滑）
alias vote-reload='docker-compose -f deploy/docker-compose.yml up -d --no-deps app && \
  docker-compose -f deploy/docker-compose.yml exec nginx nginx -s reload'

# 查看实时投票统计
alias vote-stats='docker exec vote-pg psql -U vote_user -d vote_db -c \
  "SELECT COUNT(*) as total_votes, COUNT(DISTINCT user_id) as unique_users FROM votes;"'
```
