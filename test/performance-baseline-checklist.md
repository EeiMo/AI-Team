# 性能基线测试检查单（EVO-013）

> **版本**：evo-v1 | **创建日期**：2026-06-01 | **负责人**：寻错🔍
>
> **使用说明**：每轮迭代必须执行本检查单中所有性能基准测试。首次执行建立基线值，后续迭代与基线对比，偏离告警阈值时触发调查。

---

## 测试前提条件

| 条件 | 要求 |
|------|------|
| 测试环境 | 与 staging 一致的独立环境（不可共用生产/共享 staging） |
| 数据库状态 | 预置 1000 条投票（含 options + user_votes），5 个 team_id |
| Redis 状态 | 正常（非降级），有预热过的 tally 数据 |
| 并发工具 | `wrk`、`k6` 或 `autocannon`，选一即可 |
| 测量工具 | `time`（Shell）、PG `EXPLAIN ANALYZE` |
| 采样次数 | 每项至少 3 次，取 P50 / P95 |

---

## 检查项总览

| 编号 | 类别 | 测试项 | 告警阈值 |
|------|------|--------|---------|
| PRF-01 | 连接池 | knex 连接池初始化基准耗时 | >30% 偏离 |
| PRF-02 | 查询 | 投票列表接口 P50/P95 | >30% 偏离 |
| PRF-03 | 查询 | 投票详情接口 P50/P95 | >30% 偏离 |
| PRF-04 | 查询 | 投票提交接口 P50/P95 | >30% 偏离 |
| PRF-05 | 并发 | 并发投票提交 10 并发 | >30% 偏离 |
| PRF-06 | 并发 | 并发投票提交 50 并发 | >30% 偏离 |
| PRF-07 | 并发 | 并发投票提交 100 并发 | >30% 偏离 |

---

## PRF-01：knex 连接池初始化基准耗时

### 测试目的
测量 knex 从 `initialize` 到首个连接就绪的耗时，识别连接池配置不当或 PG 连接延迟。

### 测试方法

```bash
# 方法一：在 app 启动日志中提取
docker compose -f deploy/docker-compose.yml logs app 2>&1 | grep -i 'knex\|connected\|pool\|database'

# 方法二：使用 knex 内置的 pool.afterCreate 钩子（需在测试环境临时注入）测量
# 在 knex.ts 中加入：
#   pool: {
#     afterCreate: (conn: any, done: any) => {
#       const startTime = Date.now();
#       conn.query('SELECT 1', () => {
#         console.log('[PERF] knex connection init took', Date.now() - startTime, 'ms');
#         done(null, conn);
#       });
#     }
#   }

# 方法三：用 time 命令测量冷启动到首次健康检查的时间
time docker compose -f deploy/docker-compose.yml up -d && \
  until curl -sk https://localhost/health 2>/dev/null; do sleep 0.5; done
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **连接池创建耗时** | `new knex(config)` → 首个连接就绪的耗时 |
| **平均连接获取耗时** | pool.acquire() 平均耗时（多次采样） |

### 基线记录

```
版本：_______
日期：_______

连接池创建耗时：____ ms（3 次平均）
min=2 连接获取耗时：____ ms（3 次平均）
max=20 连接获取耗时：____ ms（3 次平均）
```

### 告警阈值

> 🟡 **告警**：连接池创建耗时偏离基线 >30%（即 > 基线 × 1.3）
> 🔴 **阻断**：单次连接获取 > 500ms 或连续超时
>
> 偏离时应排查：PG 连接数是否接近上限、网络延迟是否异常、`KNEX_POOL_MIN/MAX` 配置是否合理。

---

## PRF-02：关键查询基线 — 投票列表

### 测试目的
测量 `GET /api/votes?status=active&page=1&size=20` 接口响应时间，建立 P50/P95 基线。

### 测试方法

```bash
TOKEN="dev-token-perf-test"
BASE_URL="https://localhost"

# 使用 wrk 进行 30 秒采样
wrk -t4 -c10 -d30s --latency \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/votes?status=active&page=1&size=20"

# 或使用 autocannon
npx autocannon -d 30 -c 10 \
  -H "Authorization=Bearer $TOKEN" \
  "$BASE_URL/api/votes?status=active&page=1&size=20"

# 同时检查 PG 查询计划（确保使用索引）
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
EXPLAIN ANALYZE
SELECT * FROM votes
WHERE team_id = 'test-team-001' AND status = 'active'
ORDER BY created_at DESC
LIMIT 20;
"
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **P50 延迟** | 50% 请求的响应时间 |
| **P95 延迟** | 95% 请求的响应时间 |
| **QPS** | 每秒请求数 |
| **PG 查询计划** | 是否命中 `idx_votes_team_status` 索引 |

### 基线记录

```
版本：_______
日期：_______
预置数据量：____ 条 votes / ____ 条 user_votes

P50：____ ms
P95：____ ms
QPS：____ req/s
索引命中：[ ] idx_votes_team_status  [ ] 其他  [ ] 全表扫描
```

### 告警阈值

> 🟡 **告警**：P50 或 P95 偏离基线 >30%
> 🔴 **阻断**：PG 全表扫描（未命中索引）→ 须检查查询计划与索引定义
>
> 偏离时应排查：数据量是否异常增长、索引是否失效、N+1 查询、team_id 过滤是否下推到 PG。

---

## PRF-03：关键查询基线 — 投票详情

### 测试目的
测量 `GET /api/votes/:id` 接口（含 options + tally 聚合）响应时间。

### 测试方法

```bash
TOKEN="dev-token-perf-test"
BASE_URL="https://localhost"

# 先从列表中取一个 vote_id
VOTE_ID=$(curl -sk "$BASE_URL/api/votes?status=active&page=1&size=1" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['items'][0]['id'])")

# 使用 wrk 对详情接口压测（wrk 不支持动态 URL，改用 autocannon）
npx autocannon -d 30 -c 10 \
  -H "Authorization=Bearer $TOKEN" \
  "$BASE_URL/api/votes/$VOTE_ID"

# 同时获取 PG 查询计划
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
EXPLAIN ANALYZE
SELECT v.*, o.id as option_id, o.content, o.sort_order,
       (SELECT COUNT(*) FROM user_votes uv WHERE o.id = ANY(uv.selected_options) AND uv.vote_id = v.id) as vote_count
FROM votes v
LEFT JOIN options o ON o.vote_id = v.id
WHERE v.id = '$VOTE_ID'
ORDER BY o.sort_order;
"
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **P50 延迟** | 50% 详情查询响应时间 |
| **P95 延迟** | 95% 详情查询响应时间 |
| **Redis 命中率** | tally 从 Redis 读取的比例（非 PG 聚合） |

### 基线记录

```
版本：_______
日期：_______

P50：____ ms
P95：____ ms
Redis Tally 命中：[ ] 是  [ ] 否（走 PG 聚合）
```

### 告警阈值

> 🟡 **告警**：P50/P95 偏离基线 >30%
> 🟡 **告警**：Redis Tally 未命中导致每次走 PG 聚合查询 → 须排查 TallySync / Redis 降级

---

## PRF-04：关键查询基线 — 投票提交

### 测试目的
测量 `POST /api/votes/:id/vote` 接口（含写入 user_votes + 防重检查 + Redis tally 更新）响应时间。

### 测试方法

```bash
TOKEN="dev-token-perf-test"
BASE_URL="https://localhost"
VOTE_ID="<从列表取一个active投票ID>"
OPTION_ID="<从详情取一个option ID>"

# 使用 autocannon 对提交接口压测（注意限流 3次/60s，测试前关闭或调整 RATE_LIMIT_MAX）
npx autocannon -d 30 -c 5 \
  -m POST \
  -H "Authorization=Bearer $TOKEN" \
  -H "Content-Type=application/json" \
  -b "{\"selected_options\": [\"$OPTION_ID\"]}" \
  "$BASE_URL/api/votes/$VOTE_ID/vote"

# 检查 PG 写入性能
docker compose -f deploy/docker-compose.yml exec pg psql -U vote_user -d vote_db -c "
SELECT schemaname, relname, n_tup_ins, n_tup_upd, n_tup_hot_upd
FROM pg_stat_user_tables
WHERE relname = 'user_votes';
"
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **P50 延迟** | 50% 提交请求的响应时间 |
| **P95 延迟** | 95% 提交请求的响应时间 |
| **防重检查耗时占比** | 与总耗时的比例 |

### 基线记录

```
版本：_______
日期：_______

P50：____ ms
P95：____ ms
防重检查命中率：____%（有历史投票的请求比例）
```

### 告警阈值

> 🟡 **告警**：P50/P95 偏离基线 >30%
> 🔴 **阻断**：写入 user_votes 触发死锁或唯一约束冲突误报

---

## PRF-05：并发投票提交 — 10 并发

### 测试目的
模拟 10 个用户同时提交同一投票的不同选项，测量响应时间分布和错误率。

### 测试方法

```bash
BASE_URL="https://localhost"
VOTE_ID="<取一个active投票>"

# 准备 10 个不同的模拟 user_id 和 token
# 使用 k6 脚本或 shell 并发

for i in $(seq 1 10); do
  curl -sk -X POST "$BASE_URL/api/votes/$VOTE_ID/vote" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-user-$i" \
    -d "{\"selected_options\": [\"$OPTION_ID\"]}" \
    -o /dev/null -w "User-$i: HTTP %{http_code} Time %{time_total}s\n" &
done
wait

# k6 脚本方式（推荐）：
# k6 run -e VOTE_ID="$VOTE_ID" -e BASE_URL="$BASE_URL" test/perf/concurrent-vote-10.js
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **成功率** | HTTP 200 / 总请求数 |
| **P50 延迟** | 10 个并发的 P50 |
| **P95 延迟** | 10 个并发的 P95 |
| **P99 延迟** | 10 个并发的 P99 |
| **错误分布** | 429（限流）/ 409（重复）/ 500（异常） |
| **PG 死锁数** | `pg_stat_database.deadlocks` 增量 |

### 基线记录

```
版本：_______
日期：_______

成功率：____%（_/10）
P50：____ ms
P95：____ ms
P99：____ ms
错误：429=____, 409=____, 500=____
PG 死锁增量：____
```

### 告警阈值

> 🟡 **告警**：成功率 < 95%
> 🟡 **告警**：P95 偏离 10 并发基线 >30%
> 🔴 **阻断**：出现 500 错误或 PG 死锁

---

## PRF-06：并发投票提交 — 50 并发

### 测试目的
模拟中高并发场景（团队全员同时投票），识别连接池和数据库瓶颈。

### 测试方法

```bash
# k6 脚本：模拟 50 VU 并发执行
# k6 run -e VOTE_ID="$VOTE_ID" -e BASE_URL="$BASE_URL" test/perf/concurrent-vote-50.js

# 或使用 autocannon
npx autocannon -d 15 -c 50 \
  -m POST \
  -H "Content-Type=application/json" \
  -H "Authorization=Bearer test-user-{{$}}" \
  -b "{\"selected_options\": [\"$OPTION_ID\"]}" \
  "$BASE_URL/api/votes/$VOTE_ID/vote"
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **成功率** | HTTP 200 / 总请求数 |
| **P50/P95/P99** | 50 并发的延迟分布 |
| **knex 连接池峰值** | 同时活跃的连接数 |
| **PG 连接峰值** | `pg_stat_activity` 中活跃连接数 |

### 基线记录

```
版本：_______
日期：_______

成功率：____%
P50/P95/P99：____ / ____ / ____ ms
knex 池峰值使用：____ / ____（pool.max）
PG 活跃连接峰值：____
错误分布：429=____, 409=____, 500=____
```

### 告警阈值

> 🟡 **告警**：成功率 < 90%
> 🟡 **告警**：P95 偏离基线 >30%
> 🔴 **阻断**：连接池耗尽（pool.max 达到上限且排队超时）
> 🔴 **阻断**：PG 连接数接近 `max_connections` 上限

---

## PRF-07：并发投票提交 — 100 并发

### 测试目的
模拟极端并发场景，确认系统降级能力（限流生效、不崩溃）。

### 测试方法

```bash
# k6 脚本：模拟 100 VU，验证限流和排队行为
# k6 run -e VOTE_ID="$VOTE_ID" test/perf/concurrent-vote-100.js

# 或使用 autocannon
npx autocannon -d 10 -c 100 \
  -m POST \
  -H "Content-Type=application/json" \
  -H "Authorization=Bearer test-user-{{$}}" \
  -b "{\"selected_options\": [\"$OPTION_ID\"]}" \
  "$BASE_URL/api/votes/$VOTE_ID/vote"
```

### 指标定义

| 指标 | 说明 |
|------|------|
| **成功率** | （非 5xx）/ 总请求数（预期有部分 429） |
| **限流生效率** | 429 响应 / 超限请求 |
| **无崩溃** | app 进程未 OOM / 未重启 |
| **P95 延迟** | 在忽略限流拒绝后的实际处理请求延迟 |

### 基线记录

```
版本：_______
日期：_______

成功率（非 5xx）：____%
限流拒绝（429）：____ 次
500 错误：____ 次
app 重启/OOM：[ ] 是 [ ] 否
P95（成功请求）：____ ms
```

### 告警阈值

> 🟡 **告警**：出现 500 错误
> 🔴 **阻断**：app 进程崩溃 / OOM kill
> 🟡 **告警**：限流未生效（无 429，所有请求直接打到后端导致崩溃）
>
> 偏离时应排查：RATE_LIMIT_MAX 配置、rateLimiter 中间件逻辑、knex 连接池是否耗尽。

---

## 性能基线汇总表

每轮迭代完成后更新此表：

| 指标 | v1 基线 | v2 实测 | 偏差 | 告警 |
|------|---------|---------|------|------|
| knex 连接池初始化 | ___ms | ___ms | ___% | [ ] |
| 投票列表 P50 | ___ms | ___ms | ___% | [ ] |
| 投票列表 P95 | ___ms | ___ms | ___% | [ ] |
| 投票详情 P50 | ___ms | ___ms | ___% | [ ] |
| 投票详情 P95 | ___ms | ___ms | ___% | [ ] |
| 投票提交 P50 | ___ms | ___ms | ___% | [ ] |
| 投票提交 P95 | ___ms | ___ms | ___% | [ ] |
| 10并发成功率 | ___% | ___% | ___% | [ ] |
| 50并发成功率 | ___% | ___% | ___% | [ ] |
| 100并发成功率 | ___% | ___% | ___% | [ ] |

---

## 测试执行记录模板

```
性能基线测试执行记录
====================
日期：____年__月__日
版本：_______
环境：[ ] Staging  [ ] Performance Lab
执行人：_______

| 编号 | 测试项 | 基线值 | 本次值 | 偏差 | 告警 | 备注 |
|------|--------|--------|--------|------|------|------|
| PRF-01 | 连接池初始化 | ___ms | ___ms | ___% | [ ] |      |
| PRF-02 | 列表 P50/P95 | ___/___ms | ___/___ms | ___% | [ ] |      |
| PRF-03 | 详情 P50/P95 | ___/___ms | ___/___ms | ___% | [ ] |      |
| PRF-04 | 提交 P50/P95 | ___/___ms | ___/___ms | ___% | [ ] |      |
| PRF-05 | 10并发 | ___% | ___% | ___% | [ ] |      |
| PRF-06 | 50并发 | ___% | ___% | ___% | [ ] |      |
| PRF-07 | 100并发 | ___% | ___% | ___% | [ ] |      |

综合判定：[ ] 全部通过 — 无告警  [ ] 有告警 — 告警 __ 项，需跟进  [ ] 有阻断 — 阻断 __ 项，须修复
```
