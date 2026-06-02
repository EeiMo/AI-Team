# 接口文档 — 团队即时投票工具

> 版本：v1.2 | 撰写人：凌霜 | 日期：2026-06-02
> 变更：v1.2 新增飞书 SSO 认证接口 + CI/CD 健康检查
> 基础 URL：`https://<domain>/api`

---

## 一、通用规范

### 请求头

| Header | 必填 | 说明 |
|--------|------|------|
| Authorization | 是* | `Bearer <token>` — 认证路由（/api/auth/*）和健康检查（/health）无需此头 |
| Content-Type | 是 | `application/json` |

### Token 类型

后端支持三种 Bearer token 格式，按优先级自动识别：

| 类型 | 格式 | 说明 |
|------|------|------|
| Dev Token | `dev_<user_id>_<team_id>_<name>` | 开发环境专用，字段内不可含下划线 |
| SSO JWT | `eyJ...` | 飞书 SSO 登录后签发，有效期 24h（默认） |
| 飞书 Access Token | `t-g104...` | 直接使用飞书 user_access_token（生产） |

### 通用响应格式

```json
{ "code": 0, "data": {} }
```
code=0 成功，非 0 参见错误码总表。

### 通用错误码

| code | HTTP | 含义 |
|------|------|------|
| 0 | 200/201 | 成功 |
| 40001-40005 | 400 | 参数校验失败（见 detail） |
| 40100 | 401 | 未认证 / token 过期 |
| 40301 | 403 | 投票已结束 |
| 40302 | 403 | 无操作权限 |
| 40400 | 404 | 资源不存在 |
| 40901 | 409 | 重复投票 |
| 40902 | 409 | 投票已结束（冲突） |
| 42900 | 429 | 速率限制（Retry-After） |
| 50000 | 500 | 服务器内部错误 |
| 50001 | 500 | 飞书凭证未配置 |
| 50002 | 500 | 飞书 API 调用失败 |

---

## 二、认证接口（飞书 SSO）🆕 v1.2

### 2.0 飞书 OAuth 流程

```
前端 → GET /api/auth/feishu/redirect → 返回飞书授权页 URL
前端跳转到飞书授权页 → 用户授权 → 飞书回调
飞书 → GET /api/auth/feishu/callback?code=xxx&state=xxx → 后端返回 JWT
前端存储 JWT → 后续 API 请求携带 Authorization: Bearer <JWT>
```

### 2.0.1 获取授权页 URL

| 项目 | 内容 |
|------|------|
| 方法 | GET |
| 路径 | `/api/auth/feishu/redirect` |
| 认证 | 否（白名单） |

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "redirect_url": "https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_xxx&redirect_uri=https%3A%2F%2Feeimoo.cn%2Fapi%2Fauth%2Ffeishu%2Fcallback&state=abc123...&page_type=pc"
  }
}
```

**错误**：50001（飞书凭证未配置）

### 2.0.2 OAuth 回调

| 项目 | 内容 |
|------|------|
| 方法 | GET |
| 路径 | `/api/auth/feishu/callback` |
| 认证 | 否（白名单，由飞书回调） |
| 参数 | `code` (授权码), `state` (CSRF token) |

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "user_id": "ou_abc123def456",
      "team_id": "2ed263bf...",
      "display_name": "张三",
      "avatar_url": "https://..."
    },
    "expires_in": 7200
  }
}
```

**错误**：400（state 过期或缺失）/ 401（code 无效）/ 500（飞书 API 异常）

> ⚠️ **回调地址必须在飞书开放平台后台「安全域名」中配置：**
> - staging: `http://localhost:8443/api/auth/feishu/callback`
> - production: `https://eeimoo.cn/api/auth/feishu/callback`

### 2.0.3 Dev 模式登录（仅非生产环境）

| 项目 | 内容 |
|------|------|
| 方法 | POST |
| 路径 | `/api/auth/dev/login` |
| 认证 | 否 |

**请求体**（所有字段可选）：
```json
{
  "user_id": "ou_dev_user_001",
  "team_id": "dev_team_001",
  "display_name": "开发用户"
}
```

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "token": "dev_ou_dev_user_001_dev_team_001_%E5%BC%80%E5%8F%91%E7%94%A8%E6%88%B7",
    "user": {
      "user_id": "ou_dev_user_001",
      "team_id": "dev_team_001",
      "display_name": "开发用户"
    }
  }
}
```

**错误**：403（生产环境不可用）

---

## 三、REST 接口（投票业务）

### 3.1 创建投票

| 项目 | 内容 |
|------|------|
| 方法 | POST |
| 路径 | `/api/votes` |
| 认证 | 是 |

**请求体**：
```json
{
  "title": "Sprint 24 团建去哪儿？",
  "options": ["杭州西湖", "苏州园林", "无锡太湖", "南京中山陵"],
  "vote_type": "single",
  "vote_mode": "anonymous",
  "deadline_minutes": 30
}
```

**字段约束**：
- `title`: string, 1-100 字符，必填
- `options`: string[], 2-10 项，每项 1-50 字符，不可重复
- `vote_type`: `"single"` | `"multi"`, 必填
- `vote_mode`: `"anonymous"` | `"public"`, 必填
- `deadline_minutes`: number, 1-10080, 必填

**成功响应** (201)：
```json
{
  "code": 0,
  "data": {
    "vote": {
      "id": "0192e8a1-...",
      "title": "...",
      "creator_id": "ou_abc123",
      "creator_name": "张三",
      "team_id": "2ed263bf...",
      "vote_type": "single",
      "vote_mode": "anonymous",
      "status": "active",
      "deadline": "2026-06-01T16:20:00.000Z",
      "total_voters": 24,
      "created_at": "...",
      "closed_at": null,
      "closed_by": null,
      "options": [
        { "id": "...", "content": "杭州西湖", "sort_order": 0 }
      ]
    }
  }
}
```

---

### 3.2 投票列表

| 项目 | 内容 |
|------|------|
| 方法 | GET |
| 路径 | `/api/votes?status=active&page=1&size=20` |

**查询参数**：`status`=active|closed（默认 active），`page`≥1，`size`=1-100（默认 20）

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "items": [{ "id": "...", "title": "...", "vote_count": 8, ... }],
    "total": 15, "page": 1, "size": 20
  }
}
```

---

### 3.3 投票详情

| 项目 | 内容 |
|------|------|
| 方法 | GET |
| 路径 | `/api/votes/:id` |

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "vote": { "...", "options": [{"id":"...", "content":"...", "count": 5, "voters": [] }] },
    "has_voted": false,
    "my_selected_options": []
  }
}
```

**voters 隐私规则**：
- anonymous 模式 → 永远 `[]`
- public 模式 → 包含 `{ user_id, user_name }` 列表

---

### 3.4 提交投票

| 项目 | 内容 |
|------|------|
| 方法 | POST |
| 路径 | `/api/votes/:id/vote` |

**请求体**：`{ "option_ids": ["uuid1"] }` — 单选长度=1，所有 ID 须属于该投票

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "vote_id": "...",
    "selected_options": ["uuid1"],
    "submitted_at": "2026-06-01T15:51:30.000Z"
  }
}
```

**错误**：400（校验失败）/ 403（已结束）/ 409（重复投票）/ 429（限流）

---

### 3.5 结束投票

| 项目 | 内容 |
|------|------|
| 方法 | POST |
| 路径 | `/api/votes/:id/close` |
| 权限 | 仅发起者 |

**成功响应** (200)：
```json
{
  "code": 0,
  "data": {
    "vote_id": "...",
    "status": "closed",
    "closed_by": "manual",
    "closed_at": "2026-06-01T15:55:00.000Z"
  }
}
```

---

## 四、CI/CD 端点 🆕 v1.2

### 4.1 健康检查

| 项目 | 内容 |
|------|------|
| 方法 | GET |
| 路径 | `/health` |
| 认证 | 否 |

**成功响应** (200)：
```json
{
  "status": "ok",
  "timestamp": "2026-06-02T01:30:00.000Z"
}
```

CI/CD 流水线中用于：部署后冒烟测试、负载均衡器存活检查。

### 4.2 测试

```bash
# 安装依赖
npm install

# 运行所有测试（jest + supertest）
npm test

# 持续监测模式
npm run test:watch

# 类型检查
npm run typecheck
```

---

## 五、WebSocket 事件

**连接路径**：`wss://<domain>/ws`（auth: `{ token: "<token>" }`）

### 客户端 → 服务端

| 事件 | Payload |
|------|---------|
| `join:vote` | `{ vote_id: "..." }` |
| `leave:vote` | `{ vote_id: "..." }` |

### 服务端 → 客户端

| 事件 | Payload | 触发 |
|------|---------|------|
| `vote:{id}:update` | `{ option_id, new_count, total_votes }` | 他人投票后广播 |
| `vote:{id}:closed` | `{ closed_by, closed_at }` | 投票结束 |
| `vote:{id}:reminder` | `{ remaining_seconds: 60 }` | 截止前 60 秒 |

---

## 六、数据库变更（v1.2 新增）

### 6.1 users 表（`migrations/002_users.sql`）

```sql
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_v7(),
    user_id       VARCHAR(64) NOT NULL,       -- 飞书 open_id
    team_id       VARCHAR(64) NOT NULL,       -- 飞书 tenant_key
    display_name  VARCHAR(100) NOT NULL,      -- 用户姓名快照
    avatar_url    VARCHAR(500),               -- 飞书头像 URL
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users (user_id);
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users (team_id);
```

**行为**：首次飞书 SSO 登录时自动 INSERT，再次登录更新 last_login_at + display_name + avatar_url。
