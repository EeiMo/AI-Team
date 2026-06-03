# 投票应用 v3 — API 接口文档

> 本文档覆盖所有后端 REST API 及 WebSocket 事件。

---

## 通用规范

### 基础 URL

| 环境 | URL |
|------|-----|
| 开发 | `http://localhost:3001/api` |
| 生产 | 待部署后确定 |

### 认证方式

所有 API（`/api/health` 除外）需要在 `Authorization` Header 中携带 Bearer Token：

```
Authorization: Bearer <token>
```

Token 类型：
- **开发/测试**：`dev_{user_id}_{team_id}_{display_name}`（仅非生产环境有效）
- **生产**：飞书 SSO JWT（通过 OAuth 流程获取）

### 统一响应格式

```json
{
  "code": 0,        // 0=成功，其他为错误码
  "message": "...", // 可选，错误描述
  "detail": "...",  // 可选，详细校验失败原因
  "data": { ... }   // 可选，响应数据
}
```

### 错误码

| 范围 | 含义 |
|------|------|
| 0 | 成功 |
| 40000-40099 | 参数校验失败 |
| 40100 | 未认证 / 登录过期 |
| 40300-40399 | 无操作权限 |
| 40400-40499 | 资源不存在 |
| 40900-40999 | 冲突（重复操作等） |
| 42900 | 请求频率超限 |
| 50000 | 服务器内部错误 |

### 通用错误码表

| 错误码 | 说明 | HTTP 状态码 |
|--------|------|-------------|
| 0 | 成功 | 200/201 |
| 40001 | 参数校验失败 | 400 |
| 40002 | 选项数量不在 2-10 范围 | 400 |
| 40003 | 选项不可重复 | 400 |
| 40004 | deadline_minutes 不在 1-10080 范围 | 400 |
| 40005 | option_ids 中有不属于本投票的选项 | 400 |
| 40100 | 未登录或登录已过期 | 401 |
| 40301 | 投票已结束，无法操作 | 403 |
| 40302 | 仅投票发起者可执行此操作 | 403 |
| 40303 | 仅投票创建者可执行此操作 | 403 |
| 40304 | 无权操作此投票（跨团队） | 403 |
| 40400 | 投票不存在 | 404 |
| 40401 | 投票不存在（ID 从未创建） | 404 |
| 40901 | 已投过票，不可重复提交 | 409 |
| 40902 | 投票已结束 | 409 |
| 42900 | 请求频率超限 | 429 |
| 50000 | 服务器内部错误 | 500 |

---

## 1. 健康检查

### `GET /api/health`

无需认证。

**响应 200**：
```json
{
  "status": "ok",           // "ok" 或 "degraded"
  "uptime": 123.45,
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

---

## 2. 创建投票

### `POST /api/votes`

**请求体**：
```json
{
  "title": "团建地点投票",
  "options": ["杭州", "苏州", "无锡"],
  "vote_type": "single",           // "single" | "multi"
  "vote_mode": "public",           // "public" | "anonymous"
  "deadline_minutes": 60,          // 1-10080
  "total_voters": 24,              // 可选，默认从环境变量读取
  "idempotency_key": "..."         // 可选，幂等键（24h 内重复请求返回缓存结果）
}
```

**响应 201**：
```json
{
  "code": 0,
  "data": {
    "vote": {
      "id": "019e8af8-0563-7f9d-a303-25ee6e6f22f9",
      "title": "团建地点投票",
      "creator_id": "ou_abc123",
      "creator_name": "张三",
      "team_id": "tnt_xyz",
      "vote_type": "single",
      "vote_mode": "public",
      "status": "active",
      "deadline": "2026-06-03T09:47:00.000Z",
      "total_voters": 24,
      "created_at": "2026-06-03T08:47:00.000Z",
      "closed_at": null,
      "closed_by": null,
      "del_flag": false,
      "deleted_at": null,
      "deleted_by": null,
      "options": [
        { "id": "uuid-1", "content": "杭州", "sort_order": 0 },
        { "id": "uuid-2", "content": "苏州", "sort_order": 1 },
        { "id": "uuid-3", "content": "无锡", "sort_order": 2 }
      ]
    }
  }
}
```

---

## 3. 投票列表

### `GET /api/votes?status=active&page=1&size=20`

**查询参数**：
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| status | `active` / `closed` | `active` | 筛选状态 |
| page | number | 1 | 页码 |
| size | number | 20 | 每页条数（max 100） |

默认过滤 `del_flag = FALSE`（不显示已删除投票）。

**响应 200**：
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": "019e8af8-0563-...",
        "title": "团建地点投票",
        "creator_id": "ou_abc123",
        "creator_name": "张三",
        "team_id": "tnt_xyz",
        "vote_type": "single",
        "vote_mode": "public",
        "status": "active",
        "deadline": "2026-06-03T09:47:00.000Z",
        "total_voters": 24,
        "vote_count": 5,
        "created_at": "2026-06-03T08:47:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

---

## 4. 投票详情

### `GET /api/votes/:id`

已删除投票仍可访问（用于显示"已删除"占位页）。

**响应 200**：
```json
{
  "code": 0,
  "data": {
    "vote": {
      "id": "019e8af8-0563-...",
      "title": "团建地点投票",
      "creator_id": "ou_abc123",
      "creator_name": "张三",
      "team_id": "tnt_xyz",
      "vote_type": "single",
      "vote_mode": "public",
      "status": "active",
      "deadline": "2026-06-03T09:47:00.000Z",
      "total_voters": 24,
      "created_at": "2026-06-03T08:47:00.000Z",
      "closed_at": null,
      "closed_by": null,
      "del_flag": false,
      "deleted_at": null,
      "deleted_by": null,
      "options": [
        {
          "id": "uuid-1",
          "content": "杭州",
          "sort_order": 0,
          "count": 3,
          "voters": [
            { "user_id": "ou_bob", "user_name": "李四" }
          ]
        }
      ]
    },
    "has_voted": true,
    "my_selected_options": ["uuid-1"],
    "deleted": false        // 新增：映射 del_flag
  }
}
```

**匿名模式**：voters 数组始终为 `[]`。

---

## 5. 提交投票

### `POST /api/votes/:id/vote`

**请求体**：
```json
{
  "option_ids": ["uuid-1"],
  "idempotency_key": "..."   // 可选，幂等键
}
```

- 单选投票 `option_ids` 数组长度必须为 1
- 多选投票 `option_ids` 数组长度 1 至选项总数
- 重复投票返回 `code: 40901`

**响应 200**：
```json
{
  "code": 0,
  "data": {
    "vote_id": "019e8af8-0563-...",
    "selected_options": ["uuid-1"],
    "submitted_at": "2026-06-03T08:50:00.000Z"
  }
}
```

---

## 6. 结束投票

### `POST /api/votes/:id/close`

仅投票发起者可操作。已结束投票返回 `code: 40902`。

**响应 200**：
```json
{
  "code": 0,
  "data": {
    "vote_id": "019e8af8-0563-...",
    "status": "closed",
    "closed_by": "manual",
    "closed_at": "2026-06-03T08:51:00.000Z"
  }
}
```

---

## 7. 删除投票（软删除）⭐ 新增

### `DELETE /api/votes/:id`

**权限**：仅创建者可操作（`creator_id == current_user` + team_id 双重鉴权）。

**幂等**：相同请求再次调用返回 `code: 0` 幂等成功。

**行为**：
- 软删除：DB 中 `del_flag = TRUE`
- Redis：清理 tally hash + deadline key
- WS 广播：`vote:{id}:deleted` 事件
- WS 房间清理：所有 sockets 离开该投票房间
- 审计日志：写入 `audit_logs` 表

**响应 200**：
```json
{
  "code": 0,
  "message": "投票已删除"
}
```

**响应 403**（非创建者）：
```json
{
  "code": 40303,
  "message": "仅投票创建者可删除"
}
```

---

## 8. WebSocket 事件

### 连接

```
ws://localhost:3001/ws
```

认证方式：连接时传入 `auth.token`。

### 客户端事件

| 事件 | 载荷 | 说明 |
|------|------|------|
| `join:vote` | `{ vote_id: string }` | 加入投票房间 |
| `leave:vote` | `{ vote_id: string }` | 离开投票房间 |

### 服务端事件

| 事件 | 载荷 | 说明 |
|------|------|------|
| `vote:{id}:update` | `{ option_id, new_count, total_votes }` | 投票计数更新 |
| `vote:{id}:closed` | `{ closed_by, closed_at }` | 投票结束 |
| `vote:{id}:reminder` | `{ remaining_seconds }` | 截止前 60 秒提醒 |
| `vote:{id}:deleted` ⭐ | `{ vote_id, deleted_by, deleted_at }` | 投票被删除 |

---

## 9. 删除后影响

| 场景 | 行为 |
|------|------|
| GET /api/votes 列表 | 默认过滤已删除投票 |
| GET /api/votes/:id 详情 | 仍可访问，返回 `deleted: true` |
| POST /api/votes/:id/vote | 已删除投票无法投票（403） |
| POST /api/votes/:id/close | 已删除投票无法关闭（404） |
| DELETE /api/votes/:id | 幂等：第二次调用返回 code:0 |
| WS `join:vote` | 已删除投票的房间已清理 |
| WS `vote:{id}:deleted` | 房间内客户端收到事件后可跳转占位页 |

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-03 | v3.0 | 新增 DELETE API、软删除、审计日志、WS deleted 事件、health 增强、详情 deleted 字段 |

---

*文档版本: v3.0 | 最后更新: 2026-06-03*
