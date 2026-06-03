# 部署后冒烟测试检查单（EVO-002）

> **版本**：evo-v1 | **创建日期**：2026-06-01 | **负责人**：寻错🔍
>
> **使用说明**：每次部署到 staging/production 后，逐项执行本检查单。每项失败须按规定等级响应（阻断/告警/忽略）。
>
> **阻断** = 必须修复后才能上线，禁止继续发布流程。
> **告警** = 记录问题但允许继续发布，须在 24h 内跟进修复。
> **忽略** = 可观测到的非关键偏差，记录到建议清单。

---

## 检查项总览

| 编号 | 类别 | 检查项 | 默认等级 |
|------|------|--------|---------|
| SMK-01 | 数据库 | 数据库迁移确认 | 🔴 阻断 |
| SMK-02 | 数据库 | uuid_v7() 函数可用性 | 🔴 阻断 |
| SMK-03 | API | 投票创建接口 | 🔴 阻断 |
| SMK-04 | API | 投票提交接口 | 🔴 阻断 |
| SMK-05 | API | 投票结果查询接口 | 🔴 阻断 |
| SMK-06 | 数据库 | knex.raw() 计票查询格式 | 🔴 阻断 |
| SMK-07 | 中间件 | Redis-PG 数据同步 | 🟡 告警 |
| SMK-08 | 前端 | 页面可访问性 | 🔴 阻断 |
| SMK-09 | 基础设施 | 健康检查端点 | 🟡 告警 |
| SMK-10 | 基础设施 | Nginx 反向代理 | 🔴 阻断 |

---

## SMK-01：数据库迁移确认

### 检查内容
确认数据库所有迁移已执行，表结构、索引、约束、默认值与设计文档一致。

### 执行命令

```bash
# 1. 确认迁移状态（Knex）
docker compose -f deploy/docker-compose.yml exec app npx knex migrate:list 2>/dev/null

# 2. 校验核心表结构
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "\dt votes, options, user_votes"

# 3. 校验 votes 表列及默认值、约束
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'votes'
ORDER BY ordinal_position;
"

# 4. 校验索引存在
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('votes', 'options', 'user_votes')
ORDER BY tablename, indexname;
"
```

### 预期结果

- `votes`、`options`、`user_votes` 三张表全部存在
- `votes.status` 默认值为 `'active'`，NOT NULL，CHECK 约束 (`'active'`, `'closed'`)
- `votes.total_voters` 默认值为 `0`
- `votes.id` 默认值包含 `uuid_v7()` 调用
- `idx_votes_team_status`、`idx_votes_active_deadline`、`idx_options_vote_id`、`idx_user_votes_vote_id` 四个索引全部存在
- `uq_user_votes_vote_user` UNIQUE 约束存在
- `pgcrypto` 扩展已安装

### 失败处理

**🔴 阻断**：任何表/索引/约束缺失或结构不符，立即阻断发布，回滚迁移或修复 DDL。

---

## SMK-02：uuid_v7() 函数可用性

### 检查内容
验证 `uuid_v7()` 函数已创建且可正常调用，生成的 UUID 版本位为 7。

### 执行命令

```bash
# 1. 函数存在性检查
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT proname, pronamespace::regnamespace
FROM pg_proc
WHERE proname = 'uuid_v7';
"

# 2. 生成 UUID 并验证版本位
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT uuid_v7() AS generated_uuid;
"

# 3. 验证版本位 = 7（版本位在第 13 字符位置，应为 '7'）
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT substring(uuid_v7()::text, 15, 1) = '7' AS is_version_7;
"
```

### 预期结果

- 函数存在：返回 1 行，`proname = 'uuid_v7'`
- `generated_uuid` 返回有效 UUID 字符串（格式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
- `is_version_7` 返回 `t`（true）

### 失败处理

**🔴 阻断**：函数不存在或版本位不对，阻断发布。须确认 `001_init.sql` 迁移已完整执行。

---

## SMK-03：关键 API — 投票创建

### 检查内容
端到端验证：模拟用户通过 API 创建投票，确认 201 响应、返回数据结构完整。

### 执行命令

```bash
# 准备临时 token（MVP 阶段开发模式直接传递 user header）
TOKEN="dev-token-smoke-test"

# 创建投票
curl -sk -X POST https://localhost/api/votes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "[冒烟] 测试投票",
    "vote_type": "single",
    "vote_mode": "public",
    "deadline": "'$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)'",
    "total_voters": 24,
    "options": [
      {"content": "选项A", "sort_order": 0},
      {"content": "选项B", "sort_order": 1}
    ]
  }' | python3 -m json.tool

# 从输出中记录返回的 vote_id 和 option ids，用于后续测试
```

### 预期结果

- HTTP 状态码：`201 Created`
- 响应 `code` 字段为 `0`
- `data` 包含字段：`id`（UUID 格式）、`title`、`vote_type`、`status: "active"`、`deadline`、`options`（数组长度 = 2）、`created_at`
- 每个 option 包含 `id` 和 `content`

### 失败处理

**🔴 阻断**：返回非 201、code 非 0、或返回数据结构不完整，阻断发布。

---

## SMK-04：关键 API — 投票提交

### 检查内容
使用 SMK-03 创建的投票，提交投票并校验防重逻辑。

### 执行命令

```bash
# 使用上一步获取的 vote_id 和 option_id
VOTE_ID="<SMK-03返回的vote_id>"
OPTION_A_ID="<第一个option的id>"
TOKEN="dev-token-smoke-test"

# 提交投票
curl -sk -X POST "https://localhost/api/votes/$VOTE_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"selected_options\": [\"$OPTION_A_ID\"]}" | python3 -m json.tool

# 重复提交（验证防重）
curl -sk -X POST "https://localhost/api/votes/$VOTE_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"selected_options\": [\"$OPTION_A_ID\"]}" | python3 -m json.tool
```

### 预期结果

- 首次提交：HTTP 200，`code: 0`，成功消息
- 重复提交：HTTP 409 Conflict 或 `code` 错误码（如 40900），提示"已投票"或"重复提交"

### 失败处理

**🔴 阻断**：首次提交失败，或防重逻辑未生效（允许重复提交），阻断发布。

---

## SMK-05：关键 API — 投票结果查询

### 检查内容
查询投票详情，确认计票数据与提交一致。

### 执行命令

```bash
VOTE_ID="<SMK-03返回的vote_id>"
TOKEN="dev-token-smoke-test"

# 查询投票详情
curl -sk "https://localhost/api/votes/$VOTE_ID" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### 预期结果

- HTTP 200，`code: 0`
- 返回数据包含 `options` 数组，每个 option 有 `vote_count` 字段
- 此前提交的选项 `vote_count` > 0，未提交的选项 `vote_count` = 0
- `total_voters`、`status` 等字段正确

### 失败处理

**🔴 阻断**：返回数据缺少计票字段或计票数据与实际提交不匹配，阻断发布。须排查 BallotService / VoteService 聚合逻辑。

---

## SMK-06：knex.raw() 返回路径覆盖 — 计票查询

### 检查内容
直接通过 knex.raw() 执行计票聚合查询，验证 `result.rows` 返回格式正确（非 PostgreSQL 裸 driver 格式）。

### 执行命令

```bash
VOTE_ID="<SMK-03返回的vote_id>"

# 通过后端日志或临时脚本验证 knex.raw 返回格式
# 方式一：使用 curl 调用后端暴露的调试端点（如有）
curl -sk "https://localhost/api/votes/$VOTE_ID/debug-tally" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null

# 方式二：直接在 PG 中执行等价查询对比
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT o.id AS option_id, COUNT(uv.id) AS count
FROM options o
LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
WHERE o.vote_id = '$VOTE_ID'
GROUP BY o.id;
"

# 方式三：检查 app 日志中 TallySync 聚合结果
docker compose -f deploy/docker-compose.yml logs app --tail=50 | grep -i 'tally\|aggregate'
```

### 预期结果

- `knex.raw()` 或等价 SQL 返回的行中，`count` 为数字类型（非字符串）
- PG 直接查询的 `count` 为 `bigint`（显示为纯数字）
- TallySync 日志显示正常同步（无 `NaN`、无 `undefined`）

### 失败处理

**🔴 阻断**：knex.raw() 返回 `count` 为字符串导致 parseInt 异常、或 TallySync 输出 NaN，阻断发布。须检查 knex 版本与 PG 驱动类型映射。

---

## SMK-07：Redis-PG 数据同步验证

### 检查内容
确认投票提交后，Redis tally 数据与 PG user_votes 表数据一致。

### 执行命令

```bash
VOTE_ID="<SMK-03返回的vote_id>"

# 1. 查询 PG 聚合票数
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -t -c "
SELECT o.id, COUNT(uv.id)
FROM options o
LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
WHERE o.vote_id = '$VOTE_ID'
GROUP BY o.id
ORDER BY o.id;
"

# 2. 查询 Redis tally
docker compose -f deploy/docker-compose.yml exec redis redis-cli HGETALL "vote:${VOTE_ID}:tally"

# 3. 等待一次同步周期（默认 5s），再次对比
sleep 6
docker compose -f deploy/docker-compose.yml exec redis redis-cli HGETALL "vote:${VOTE_ID}:tally"
```

### 预期结果

- PG 聚合与 Redis HGETALL 结果中的 option_id → count 映射完全一致
- 同步后数据一致（允许 5s 延迟窗口内的短暂不一致）

### 失败处理

**🟡 告警**：同步延迟超过 5s 仍不一致，或 Redis tally 有缺失/多余 key。记录日志告警，不阻断发布，但须在 24h 内排查 TallySync 逻辑。

---

## SMK-08：前端页面可访问性

### 检查内容
确认关键前端页面可正常加载，无 JS 错误、无白屏。

### 执行命令

```bash
BASE_URL="https://localhost"

# 1. 首页/登录页
curl -sk "$BASE_URL/login" -o /dev/null -w "HTTP %{http_code} | Size %{size_download}B | Time %{time_total}s\n"

# 2. 投票列表页
curl -sk "$BASE_URL/votes" -o /dev/null -w "HTTP %{http_code} | Size %{size_download}B | Time %{time_total}s\n"

# 3. 创建投票页
curl -sk "$BASE_URL/votes/create" -o /dev/null -w "HTTP %{http_code} | Size %{size_download}B | Time %{time_total}s\n"

# 4. 检查 HTML 中是否包含根元素挂载点
curl -sk "$BASE_URL/login" | grep -o '<div id="root"' | head -1

# 5. 检查静态资源是否可访问（JS / CSS bundle）
curl -sk "$BASE_URL/login" | grep -oP 'src="(/assets/[^"]+)"' | head -3
```

### 预期结果

- `/login`、`/votes`、创建投票页 均返回 HTTP 200
- 响应包含 `<div id="root">` 挂载点
- 页面 Size > 0 且包含 JS bundle 引用
- 无 404/500 错误

### 失败处理

**🔴 阻断**：任一页面返回 404/500、或无 `<div id="root">` 挂载点，阻断发布。须检查前端构建产物和 Nginx 配置。

---

## SMK-09：健康检查端点

### 检查内容
确认健康检查端点正常响应，返回服务状态。

### 执行命令

```bash
# HTTP 健康检查
curl -sk https://localhost/health | python3 -m json.tool

# 检查 PG 连接
docker compose -f deploy/docker-compose.yml exec pg pg_isready -U vote_user -d vote_db

# 检查 Redis
docker compose -f deploy/docker-compose.yml exec redis redis-cli PING
```

### 预期结果

- `/health` 返回 HTTP 200，`{"status":"ok"}`
- `pg_isready` 返回 `accepting connections`
- `redis-cli PING` 返回 `PONG`

### 失败处理

**🟡 告警**：Health 端点返回非 200 或 PG/Redis 连接异常。记录告警，不阻断发布（若为暂时性可自动恢复），但若持续 >5min 则升级为阻断。

---

## SMK-10：Nginx 反向代理连通性

### 检查内容
验证 Nginx 正确代理 API 请求到后端 app，HTTPS 终止正常。

### 执行命令

```bash
# 1. 验证 HTTPS 终止
curl -skI https://localhost/api/votes 2>&1 | head -5

# 2. 验证 CORS 头
curl -skI https://localhost/api/votes \
  -H "Origin: https://example.com" 2>&1 | grep -i 'access-control'

# 3. 验证 WebSocket 升级头传递（Socket.IO）
curl -skI https://localhost/ \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" 2>&1 | head -10

# 4. Nginx 配置检测
docker compose -f deploy/docker-compose.yml exec nginx nginx -t
```

### 预期结果

- `/api/votes` 返回 HTTP 200（或 401 缺少 token）
- 响应中包含 `Access-Control-Allow-Origin` 或 `Access-Control-Allow-Credentials` 头
- WebSocket 升级响应正常（不报 400/426）
- `nginx -t` 返回 `syntax is ok` / `test is successful`

### 失败处理

**🔴 阻断**：Nginx 配置语法错误、API 代理不通（502/504）、CORS 头缺失导致前端跨域请求被拦截，阻断发布。

---

## 执行记录模板

执行冒烟测试后填写：

```
冒烟测试执行记录
==================
日期：____年__月__日
部署版本：_______
环境：[ ] Staging  [ ] Production
执行人：_______

| 编号 | 检查项 | 结果 | 备注 |
|------|--------|------|------|
| SMK-01 | 数据库迁移确认 | [ ]通过 [ ]失败 |      |
| SMK-02 | uuid_v7() 函数 | [ ]通过 [ ]失败 |      |
| SMK-03 | 投票创建 API   | [ ]通过 [ ]失败 |      |
| SMK-04 | 投票提交 API   | [ ]通过 [ ]失败 |      |
| SMK-05 | 投票结果 API   | [ ]通过 [ ]失败 |      |
| SMK-06 | knex.raw() 计票| [ ]通过 [ ]失败 |      |
| SMK-07 | Redis-PG 同步  | [ ]通过 [ ]失败 |      |
| SMK-08 | 前端页面访问   | [ ]通过 [ ]失败 |      |
| SMK-09 | 健康检查       | [ ]通过 [ ]失败 |      |
| SMK-10 | Nginx 代理     | [ ]通过 [ ]失败 |      |

综合判定：[ ] 通过 — 可继续发布  [ ] 未通过 — 阻断项 __ 项，须修复后重新执行
```
