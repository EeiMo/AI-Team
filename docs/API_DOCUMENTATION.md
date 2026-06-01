# 接口文档 — 团队即时投票工具

> 版本：v1.1 | 撰写人：凌霜 | 日期：2026-06-01
> 基础 URL：`https://<domain>/api`

---

## 一、通用规范

### 请求头

| Header | 必填 | 说明 |
|--------|------|------|
| Authorization | 是 | `Bearer <feishu_token>` |
| Content-Type | 是 | `application/json` |

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

---

## 二、REST 接口

### 2.1 创建投票

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

### 2.2 投票列表

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

### 2.3 投票详情

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

### 2.4 提交投票

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

### 2.5 结束投票

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

## 三、WebSocket 事件

**连接路径**：`wss://<domain>/ws`（auth: `{ token: "<feishu_token>" }`）

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

## 四、数据库变更

### 新增表

参见 `migrations/001_init.sql`：

```sql
-- 1. votes 表（含 creator_name 快照、team_id 索引）
CREATE TABLE votes (
    id UUID PRIMARY KEY DEFAULT uuid_v7(),
    title VARCHAR(100) NOT NULL,
    creator_id VARCHAR(64) NOT NULL,
    creator_name VARCHAR(100) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    vote_type VARCHAR(10) NOT NULL CHECK (...),
    vote_mode VARCHAR(10) NOT NULL CHECK (...),
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (...),
    deadline TIMESTAMPTZ NOT NULL,
    total_voters INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    closed_by VARCHAR(10) CHECK (closed_by IN ('manual', 'auto'))
);

-- 2. options 表
CREATE TABLE options (
    id UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    content VARCHAR(50) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- 3. user_votes 表（UNIQUE 防重）
CREATE TABLE user_votes (
    id UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL,
    selected_options UUID[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_votes_vote_user UNIQUE (vote_id, user_id)
);
```
