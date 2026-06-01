# 团队即时投票工具

轻量实时决策工具 —— 快速发起投票，团队成员即时参与，结果图表可视化。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + TypeScript + Vite 5 + ECharts |
| 后端 | Express 4 + TypeScript + Socket.IO 4 |
| 数据库 | PostgreSQL 15 |
| 缓存 | Redis 7 |
| 部署 | Docker Compose + Nginx |

## 项目结构

```
vote-app/
├── backend/            # Express + Socket.IO 后端
│   ├── src/
│   │   ├── middleware/ # auth, rateLimiter, errorHandler
│   │   ├── routes/     # REST API
│   │   ├── services/   # 投递/投票/截止/缓存同步
│   │   ├── ws/         # WebSocket 事件处理
│   │   └── db/         # Knex.js 连接
│   └── migrations/     # DDL SQL
├── frontend/           # React SPA 前端
│   └── src/
│       ├── pages/      # CreateVote, VoteDetail, VoteList
│       ├── components/ # ResultChart, OptionList, CountdownTimer, ...
│       ├── hooks/      # useSocket, useVoteDetail, useVotes, ...
│       └── services/   # API + Axios 拦截器
├── deploy/             # Docker Compose + Nginx + CI/CD
├── docs/               # PRD / 架构 / API 文档 / 测试报告 / 安全报告
└── README.md
```

## 快速启动

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入飞书 App ID/Secret 等信息
```

### 2. 一键部署

```bash
cd deploy
chmod +x deploy.sh backup.sh
./deploy.sh --env production --local
```

### 3. 访问

- 前端：`https://<your-domain>`
- 健康检查：`GET /api/health`

## 文档

- [PRD v1.1](docs/PRD_团队即时投票工具_v1.1.md)
- [架构设计 v1.1](docs/ARCH_团队即时投票工具_v1.1.md)
- [API 文档](docs/API_DOCUMENTATION.md)
- [测试报告](docs/test/TEST_PASS_REPORT.md)
- [安全检查报告](docs/security/SECURITY_PENTEST_REPORT.md)
- [架构图](docs/arch-diagram.html)

## 核心特性

- 🔒 飞书 SSO 登录（OAuth 2.0）
- 📊 实时投票结果（ECharts 柱状图）
- ⏱ 投票倒计时自动结束
- 🔐 四层防刷（身份绑定 + 滑动窗口限流 + 行为指纹 + 验证码兜底）
- 🕶 匿名/实名可配置
- ✅ 幂等投票（HINCRBY + PG UNIQUE 防重）
- 📡 WebSocket 结果实时推送
- 🐳 Docker Compose 一键部署
