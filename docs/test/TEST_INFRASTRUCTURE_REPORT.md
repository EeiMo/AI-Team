# 测试基础设施搭建报告
## 团队即时投票工具 v1.0 — 第二轮迭代

**执行日期**: 2026-06-02  
**执行人**: 寻错🔍

---

## 1. 后端测试基础设施

### 1.1 配置

| 项目 | 配置 |
|------|------|
| 测试框架 | Jest 29 + ts-jest |
| HTTP 测试 | Supertest |
| 数据库 | 真实 PostgreSQL 15 (localhost:5433) |
| 缓存 | 真实 Redis (localhost:6380) |
| 配置 | `backend/jest.config.ts` + `backend/jest.setup.ts` |

### 1.2 测试文件

| 文件 | 测试数 | 通过 | 说明 |
|------|--------|------|------|
| `src/__tests__/config.test.ts` | 13 | ✅ 13 | 环境变量配置验证 |
| `src/__tests__/health.test.ts` | 2 | ✅ 2 | 健康检查端点 |
| `src/__tests__/auth.test.ts` | 12 | ✅ 12 | SSO/Dev Token 认证 |
| `src/__tests__/votes.test.ts` | 32 | ⚠️ 28 | CRUD + 提交 + 关闭 |
| `src/__tests__/rateLimiter.test.ts` | 5 | ⚠️ 4 | 限流中间件 |
| **合计** | **56** | **52/56 (93%)** | |

### 1.3 已知未通过测试（4 条）

| 编号 | 测试名 | 问题 |
|------|--------|------|
| IT-SV-06 | 重复投票 → 409 | 返回 404，需排查防重逻辑 |
| IT-SV-07 | 已结束投票 → 403 | 返回 429（跨测试限流累积） |
| IT-SV-08 | 无效选项 → 400 | 返回 500（non-UUID option_id PG 校验失败） |
| IT-RL-02 | 窗口内前 3 次通过 | 返回 429（待排查 Redis LUA 计数） |

### 1.4 基础设施组件

- `jest.config.ts` — Jest 配置（ts-jest + junit reporter）
- `jest.setup.ts` — 环境变量注入（DATABASE_URL, REDIS_URL, JWT_SECRET）
- `src/__tests__/shared/db.ts` — 测试 Knex 单例（PG only, no SQLite fallback）
- `src/__tests__/testSetup.ts` — 测试环境（DDL 自动执行, 数据清理, 限流键清空）

---

## 2. 前端测试基础设施

### 2.1 配置

| 项目 | 配置 |
|------|------|
| 测试框架 | Vitest |
| React 测试 | @testing-library/react |
| DOM 环境 | jsdom |
| 配置 | `frontend/vitest.config.ts` + `src/test-setup.ts` |

### 2.2 测试文件

| 文件 | 测试数 | 通过 | 说明 |
|------|--------|------|------|
| `__tests__/Login.test.tsx` | 8 | ✅ 8 | 登录页（SSO + dev 表单） |
| `__tests__/store.test.ts` | 6 | ✅ 6 | Zustand 全局状态 |
| `pages/AuthCallback.test.tsx` | 8 | ✅ 8 | SSO 回调处理（已有） |
| `pages/Login.test.tsx` | 15 | ✅ 15 | 登录页综合测试（已有） |
| **合计** | **37** | **37/37 (100%)** | |

---

## 3. CI/CD 集成

### 3.1 变更内容

在 `deploy/ci-pipeline.yml` 的 `test` job 中新增：

1. **PostgreSQL 15 服务容器** — `/16-alpine`, 端口 5433, 健康检查
2. **Redis 7 服务容器** — `/7-alpine`, 端口 6380, 健康检查
3. **环境变量注入** — `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`
4. **测试报告上传** — `junit-*.xml` artifacts（保留 7 天）

### 3.2 流水线阶段

```
lint → test → build-image → push → deploy → smoke-test → (rollback)
```

- **PR 触发**: 仅 lint + test（不构建镜像）
- **main 合并**: 完整流水线
- **test 失败**: 阻止镜像构建和部署
- **smoke test 失败**: 自动回滚

---

## 4. 冒烟测试

### 4.1 脚本

`deploy/smoke-test.sh` — 基于 EVO-002 检查单的自动化脚本

**覆盖项目**:
- SMK-03: 投票创建 API
- SMK-04: 投票提交 API（含防重验证）
- SMK-05: 投票结果查询 API
- SMK-07: 限流中间件基本验证
- SMK-08: 前端页面可访问性
- SMK-09: 健康检查端点
- SMK-10: Nginx 反向代理 & CORS

**用法**:
```bash
BASE_URL=https://localhost SKIP_SSL_VERIFY=true ./deploy/smoke-test.sh
```

### 4.2 报告输出

- 文本报告: `docs/test/smoke-test-report-YYYYMMDD-HHMMSS.txt`
- JUnit XML: `docs/test/junit-backend.xml`, `docs/test/junit-frontend.xml`

---

## 5. 架构决策

1. **无 mock 数据库** — 所有测试连接真实 PG 15，使用 DATABASE_URL 环境变量
2. **测试数据清理** — `cleanTestTables()` 在 suite 级别清理，`clearRateLimitKeys()` 在 test 级别清理
3. **Dev token 格式** — 使用下划线分隔的 `dev_userId_teamId_displayName`（各段 URL-encoded，不含下划线）
4. **knex 客户端** — 显式指定 `client: 'pg'`，移除了 SQLite fallback

---

## 6. 下一步建议

1. **排查 IT-SV-06 防重逻辑** — 重复投票应返回 409 而非 404
2. **修复 IT-SV-08** — 对非 UUID option_id 进行前端校验，避免 PG 错误抛 500
3. **调试 IT-RL-02** — 检查 Redis LUA 脚本在连续新建投票场景下的计数逻辑
4. **跨测试限流隔离** — 考虑在 `beforeAll` 中重置 Redis rate keys
5. **前端测试扩展** — 增加 CreateVote、VoteDetail 页面测试
