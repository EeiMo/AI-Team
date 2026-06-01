# 数据观察计划 — 团队即时投票工具 v1.0

> **制定人**：知微 🛡️ · **日期**：2026-06-01  
> **关联文档**：PRD v1.1 · 架构 v1.1 第 10.4 节 · 安全渗透测试报告  
> **触发条件**：EeiMoo 通知上线完成后开始执行  
> **观察期**：上线后 1-3 天（根据实际流量密度调整）

---

## 一、观察总览

| 维度 | 周期 | 频率 |
|------|------|------|
| 每日检查清单 | Day 1 / Day 2 / Day 3 | 每日 10:00、16:00、22:00 三次巡检 |
| 实时告警 | 全程 | 飞书 Webhook 自动推送 |
| 数据验证 SQL | Day 1 22:00 首次执行，此后每 12h | 手动 SQL 查询 |
| 观察期报告 | 观察期结束后 4h 内产出 | 一次性提交 |

---

## 二、每日检查清单

### Day 1（上线当天）

| 时间 | 检查项 | 检查方法 | 判定标准 | 异常处置 |
|------|--------|----------|----------|----------|
| **上线后 30min** | 服务健康检查 | `curl https://<domain>/health` | `{status: "ok"}` 且 HTTP 200 | 若失败 → 通知长夜回滚 |
| **上线后 30min** | Redis / PG 连接 | `curl https://<domain>/health/metrics` 检查 `redis_degraded` | `redis_degraded === false` | 若 `true` → 检查 Redis 实例状态，同步通知长夜 |
| **上线后 30min** | WS 连通性 | 在飞书 WebView 中打开投票页面，观察 ECharts 是否渲染并实时更新 | 图表正常渲染，实时计数 ≥1 次更新 | 若持续 loading → 检查 Nginx WS 代理配置 |
| **上线后 1h** | 首票创建 | 通过飞书内入口创建一张测试投票 → 确认 5 个 API 均可达 | 创建→详情→列表→提交→结束 全部 200 | 任一端点异常 → 排查对应模块 |
| **10:00 巡检** | 第 1 组指标快照（见第三节） | 执行 SQL 快照 + 检查 metrics 端点 | 全部指标在阈值内（见第四节） | 超标项按告警规则通知 |
| **16:00 巡检** | 第 2 组指标快照 | 同上 | 同上 | 同上 |
| **22:00 巡检** | **首次数据验证 SQL**（见第五节） | 执行全部 6 条 SQL | 防重/幂等全部通过 | 对账偏差 >0 → 连夜排查 |

### Day 2（稳定观察）

| 时间 | 检查项 | 检查方法 | 判定标准 | 异常处置 |
|------|--------|----------|----------|----------|
| **10:00 巡检** | 指标快照 + 环比 Day 1 | 与 Day 1 同期数据对比 | 无异常趋势（单日波动 <30%） | 波动 >30% → 分析是否业务高峰/异常 |
| **10:00 巡检** | Redis 内存检查 | `INFO memory` 或 metrics 端点 | `used_memory` < 50% `maxmemory` | 若接近上限 → 检查 tally key 是否泄漏 |
| **16:00 巡检** | 指标快照 + WS 连接趋势 | 观察 `ws_connections` 是否随时间正常波动 | 无突然断崖式下跌 | 断崖 → 检查 Nginx/进程重启日志 |
| **22:00 巡检** | 数据验证 SQL（第二次） | 同 Day 1 22:00 | 同上 | 同上 |

### Day 3（收尾观察）

| 时间 | 检查项 | 检查方法 | 判定标准 | 异常处置 |
|------|--------|----------|----------|----------|
| **10:00 巡检** | 全量指标终检 | 与 Day 1-2 合并对比 | 3 天趋势无劣化 | 若有累积性劣化 → 深入分析 |
| **16:00 巡检** | 合规清理 SQL 干跑 | 执行 30 天/90 天清理 SQL（带 `EXPLAIN` / 仅统计） | 清理 SQL 可执行、返回预期行数 | 若语法/外键错误 → 修复后重新执行 |
| **22:00** | **产出入报告** | 按第六节模板填写 | — | — |

---

## 三、核心指标定义

### 3.1 指标清单

| 编号 | 指标名 | 定义 | 采集来源 | 采集频率 |
|------|--------|------|----------|----------|
| M01 | **投票创建数** | `COUNT(*) FROM votes WHERE created_at > $observation_start` | PG 直查 | 每巡检周期 |
| M02 | **投票参与数** | `COUNT(*) FROM user_votes WHERE created_at > $observation_start` | PG 直查 | 每巡检周期 |
| M03 | **匿名比例** | `COUNT(*) FROM votes WHERE vote_mode='anonymous' AND created_at > $obs_start` / 总创建数 | PG 直查 | 每巡检周期 |
| M04 | **参与率** | 每个投票的 `COUNT(user_votes) / votes.total_voters` 中位数 | PG 直查 | 每日 1 次 |
| M05 | **WS 当前连接数** | `io.engine.clientsCount` | `/health/metrics` | 每巡检周期 |
| M06 | **WS 断线率** | 1 小时内 WS 房间 `join`/`leave` 事件频次与连接数的比值 | metrics 端点 / WS 日志 | 实时监控 |
| M07 | **API 5xx 错误率** | `5xx 响应数 / 总请求数`（1min 窗口） | metrics 端点 / 飞书告警 | 实时监控 |
| M08 | **API 4xx 错误率** | `4xx 响应数 / 总请求数`（1min 窗口） | metrics 端点 | 每巡检周期 |
| M09 | **API P99 延迟** | `ballot_submitted P99 latencyMs` | 结构化日志 / metrics | 每巡检周期 |
| M10 | **投票提交 QPS** | 1min 滑动窗口内 `POST /api/votes/:id/vote` 请求数 | metrics | 每巡检周期 |
| M11 | **Redis 内存使用** | `used_memory_human` + `mem_fragmentation_ratio` | `redis-cli INFO memory` | 每日 2 次 |
| M12 | **Redis 降级状态** | `health:degraded` key 是否存在 | `/health/metrics` | 实时监控 |
| M13 | **PG 连接池** | active / idle 连接数 | `/health/metrics` | 每巡检周期 |
| M14 | **未结束过期投票数** | `COUNT(*) FROM votes WHERE status='active' AND deadline < NOW()` | PG 直查 | 每巡检周期 |
| M15 | **速率限制触发次数** | 429 错误码计数 (1min 窗口) | metrics / 日志 | 每巡检周期 |
| M16 | **自动/手动结束比** | `closed_by='auto'` 数 vs `closed_by='manual'` 数 | PG 直查 | 每日 1 次 |

### 3.2 关键上下文指标

| 编号 | 指标名 | 用途 |
|------|--------|------|
| C01 | 团队活跃用户数（估算） | 理解参与率分母。从飞书通讯录 API 获取或在首日手动填入 |
| C02 | 观察期内投票按时结束率 | `deadline < NOW()` 的 active 投票数 / 总投票数。检验 DeadlineWorker 健康度 |
| C03 | 多选 vs 单选比例 | 理解用户偏好分布 |

---

## 四、异常阈值与告警规则

### 4.1 实时告警（飞书 Webhook · 独立 `healthMonitor.ts` 模块）

依据架构第 10.4.3 节设计，每 30s 检查。

| 告警编号 | 告警名称 | 触发条件 | 严重级别 | 通知对象 | 处置建议 |
|----------|----------|----------|----------|----------|----------|
| ALRT-01 | **WS 连接突降** | `ws_connections` 1min 内下降 >50% | 🟡 P1 | EeiMoo + 长夜 | 1) 检查 Nginx 是否重启；2) 检查进程是否 crash；3) 检查飞书 WebView 是否有新版本兼容问题 |
| ALRT-02 | **API 5xx 错误率异常** | 1min 窗口 5xx 错误率 >1% | 🔴 P0 | EeiMoo + 长夜 + 凌霜 | 1) 检查进程日志 `docker logs vote-app --tail 200`；2) 检查 PG/Redis 是否可达；3) 验证 `npm audit` 无新增 CVE |
| ALRT-03 | **Redis 降级激活** | `health:degraded === true` | 🟡 P1 | EeiMoo + 长夜 | 1) 检查 Redis 实例状态；2) 验证 Redis 内存是否写满；3) 降级期间速率限制切换到内存 Map，功能不受影响但重启后限流状态丢失 |
| ALRT-04 | **PG 连接池耗尽** | `pg_pool_active === pg_pool_max` 持续 2min | 🔴 P0 | EeiMoo + 长夜 + 凌霜 | 1) 检查是否有慢查询阻塞；2) 检查连接是否泄漏（未释放）；3) 临时增加 `pool.max` 或重启释放 |
| ALRT-05 | **DeadlineWorker 异常** | `未结束的过期投票数 >5` | 🟡 P1 | EeiMoo + 凌霜 | 1) 检查 Redis Keyspace Notification 是否开启；2) 手动触发兜底扫描 SQL；3) 验证 `deadline_worker_error` 日志 |
| ALRT-06 | **API 4xx 错误率异常** | 1min 窗口 4xx 错误率 >10%（不含 429） | 🟢 P2 | EeiMoo + 知微 | 1) 分析 4xx 错误码分布（401/403/409）；2) 若 401 占比高 → 可能飞书 SSO 异常；3) 若 409 占比高 → 可能并发冲突或用户重复操作 |
| ALRT-07 | **速率限制大量触发** | 1min 窗口 429 数 >10 | 🟢 P2 | EeiMoo + 知微 | 1) 分析是否正常限流（高频投票）还是攻击行为；2) 检查触发 429 的 user_id 分布；3) 若单一 user_id 高频触发 → 可能自动化脚本 |

### 4.2 巡检阈值（非实时）

| 指标编号 | 指标 | 正常范围 | 警告阈值 | 严重阈值 |
|----------|------|----------|----------|----------|
| M03 | 匿名比例 | 10%-70% | <5% 或 >90%（可能默认值异常） | — |
| M04 | 参与率 | ≥50% | <40% | <20%（可能功能不可用） |
| M09 | API P99 延迟 | <2s | 2s-5s | >5s（可能 DB 瓶颈） |
| M11 | Redis 内存 | <60% maxmemory | 60%-80% | >80%（需清理残留 key） |
| M14 | 过期未结束投票数 | 0 | 1-5 | >5（DeadlineWorker 异常） |
| M15 | 429 触发数/h | <5 | 5-20 | >20（可能被刷或配置不当） |
| C02 | 投票按时结束率 | 100% | <100% | <90% |

---

## 五、数据验证 SQL

### 5.1 防刷有效性验证 — 并发重复投票检测

```sql
-- SQL-01: 检查是否存在同一用户在同一投票中的重复记录
-- UNIQUE(vote_id, user_id) 约束应杜绝此情况，此查询为二次验证
SELECT
    vote_id,
    user_id,
    COUNT(*) AS duplicate_count,
    ARRAY_AGG(id) AS record_ids
FROM user_votes
WHERE created_at > NOW() - INTERVAL '3 days'
GROUP BY vote_id, user_id
HAVING COUNT(*) > 1;

-- 预期结果：0 行（UNIQUE 约束生效，无重复）
-- 若出现非 0：PG UNIQUE 约束可能未正确创建 → 立即通知长夜检查 DDL
```

### 5.2 幂等键防重验证 — 双层防护对账

```sql
-- SQL-02: 检查同一用户对同一投票是否有多条非幂等操作记录
-- （比 SQL-01 更严格——检查所有相关表）
SELECT
    uv.vote_id,
    uv.user_id,
    uv.id AS user_vote_id,
    uv.created_at,
    v.status AS vote_status,
    v.vote_mode
FROM user_votes uv
JOIN votes v ON v.id = uv.vote_id
WHERE uv.created_at > NOW() - INTERVAL '3 days'
ORDER BY uv.vote_id, uv.user_id, uv.created_at;

-- 用途：手动抽查是否存在 `vote_id, user_id` 相同但 created_at 毫秒级不同的记录
-- 正常：每组 (vote_id, user_id) 仅 1 行
-- 异常：>1 行 → 表示仍有遗漏的并发保护缺陷
```

### 5.3 Redis ↔ PG 票数对账

```sql
-- SQL-03: 将 PG 中实际投票记录汇总为各 option 票数，与 ECharts 展示对比
SELECT
    o.id AS option_id,
    o.content,
    o.vote_id,
    COUNT(uv.id) AS pg_tally_count,
    v.status,
    v.vote_mode
FROM options o
LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
JOIN votes v ON v.id = o.vote_id
WHERE v.created_at > NOW() - INTERVAL '3 days'
GROUP BY o.id, o.content, o.vote_id, v.status, v.vote_mode
ORDER BY v.vote_mode, pg_tally_count DESC;

-- 验证方法：
--   1. 随机选择 3-5 个投票
--   2. 在飞书前端查看 ECharts 对应选项票数
--   3. 与 pg_tally_count 对比
-- 预期：完全一致
-- 偏差 >0 → Redis HINCRBY 计数可能异常，触发对账修复
```

### 5.4 速率限制有效性验证

```sql
-- SQL-04: 检查高密度投票提交——如果某用户在短时间内提交了多个投票，可能绕过了限流
SELECT
    user_id,
    vote_id,
    selected_options,
    created_at,
    LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_submit_time,
    EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at))) AS seconds_since_prev
FROM user_votes
WHERE created_at > NOW() - INTERVAL '3 days'
ORDER BY user_id, created_at;

-- 检查：是否存在 `seconds_since_prev < 60` 且 >0 的记录
-- 注意：不同 vote_id 的提交不受限流影响（限流 key 为 rate:{user_id}:{vote_id}）
-- 真正要关注的是同一 user_id + vote_id 在 60s 内的重复提交（由 UNIQUE 约束防止）
-- 若同 vote_id 出现两次 → 严重问题
```

### 5.5 Redis Tally Key 残留检查

```sql
-- SQL-05: 查找已关闭投票中 Redis tally key 可能未清理的情况
-- 需要在 Redis 侧配合执行：KEYS vote:*:tally
-- 然后与 PG 中 closed 状态的投票交叉比对
--
-- PG 侧查询：列出已关闭投票
SELECT id, title, closed_at, closed_by, deadline
FROM votes
WHERE status = 'closed'
  AND closed_at > NOW() - INTERVAL '3 days'
ORDER BY closed_at DESC;

-- Redis 侧验证（需在 Redis CLI 执行）：
--   对比 `KEYS vote:*:tally` 返回的 vote_id 列表
--   若某些 vote_id 在 PG 中 status='closed' 但在 Redis 中 still 存在 tally key
--   → 表示 RET-03 未修复，需手动执行 Redis `DEL vote:<id>:tally` 清理

-- 统计可能残留的 key 数（也可通过 Redis `INFO keyspace` 对比预期数量）
```

### 5.6 30 天匿名关联清除计划 — 干跑验证

```sql
-- SQL-06A: 统计届时将清除的匿名投票关联记录数（干跑+确认，30天后执行）
SELECT
    uv.vote_id,
    uv.user_id,
    uv.created_at AS vote_submitted_at,
    v.created_at AS vote_created_at,
    v.vote_mode,
    v.title
FROM user_votes uv
JOIN votes v ON v.id = uv.vote_id
WHERE v.vote_mode = 'anonymous'
  AND v.created_at < NOW() - INTERVAL '30 days';

-- 观察期内预期结果：0 行（刚上线不到 30 天）
-- 此 SQL 在生产 30 天后将被用于：
--   DELETE FROM user_votes WHERE vote_id IN (
--     SELECT id FROM votes WHERE vote_mode = 'anonymous' AND created_at < NOW() - INTERVAL '30 days'
--   );
-- 执行前务必确认 user_votes 的 ON DELETE CASCADE 不会影响 votes 主表
-- （user_votes 的外键为 REFERENCES votes(id) ON DELETE CASCADE，方向是从 votes 到 user_votes，
--  删除 user_votes 行不会级联到 votes，此清理安全）
```

```sql
-- SQL-06B: 90 天全量数据保留清理计划（干跑）
SELECT
    v.id AS vote_id,
    v.title,
    v.created_at,
    v.status,
    COUNT(uv.id) AS user_vote_count
FROM votes v
LEFT JOIN user_votes uv ON uv.vote_id = v.id
WHERE v.created_at < NOW() - INTERVAL '90 days'
GROUP BY v.id, v.title, v.created_at, v.status
ORDER BY v.created_at;

-- 预期：0 行（刚上线 <90 天）
-- 90 天后生产清理 SQL（已验证 ON DELETE CASCADE 级联安全）：
--   DELETE FROM votes WHERE created_at < NOW() - INTERVAL '90 days';
-- 执行时机：建议配置 pg_cron 每日凌晨 3:00 自动执行
```

### 5.7 跨团队数据隔离验证

```sql
-- SQL-07: 验证 votes 中所有记录的 team_id 都非空且格式正确
SELECT
    team_id,
    COUNT(*) AS vote_count
FROM votes
WHERE created_at > NOW() - INTERVAL '3 days'
GROUP BY team_id
ORDER BY vote_count DESC;

-- 检查：
--   1. 无 NULL team_id
--   2. team_id 数量与部署团队数一致（单团队部署=1）
--   3. 若出现未知 team_id → 可能跨团队渗透或配置错误
```

---

## 六、数据观察报告模板

```markdown
# 数据观察报告 — 团队即时投票工具 v1.0

> **观察人**：知微 🛡️  
> **观察周期**：YYYY-MM-DD HH:00 ~ YYYY-MM-DD HH:00（共 N 天）  
> **报告日期**：YYYY-MM-DD

---

## 一、核心指标概览

| 指标 | Day 1 | Day 2 | Day 3 | 合计/均值 | 判定 |
|------|-------|-------|-------|-----------|------|
| 投票创建数 (M01) | | | | | ✅/⚠️ |
| 投票参与数 (M02) | | | | | ✅/⚠️ |
| 匿名比例 (M03) | | | | | ✅/⚠️ |
| 中位参与率 (M04) | | | | | ✅/⚠️ |
| WS 连接数峰值 (M05) | | | | | ✅/⚠️ |
| WS 断线率 (M06) | | | | | ✅/⚠️ |
| API 5xx 错误数/率 (M07) | | | | | ✅/⚠️ |
| API 4xx 错误数/率 (M08) | | | | | ✅/⚠️ |
| API P99 延迟 (M09) | | | | | ✅/⚠️ |
| 投票提交 QPS 峰值 (M10) | | | | | ✅/⚠️ |
| Redis 内存峰值 (M11) | | | | | ✅/⚠️ |
| Redis 降级？(M12) | | | | | ✅/⚠️ |
| PG 连接池峰值 (M13) | | | | | ✅/⚠️ |
| 过期未结束投票数 (M14) | | | | | ✅/⚠️ |
| 速率限制触发次数 (M15) | | | | | ✅/⚠️ |
| 自动/手动结束比 (M16) | | | | | ✅/⚠️ |

## 二、数据验证结果

| SQL 编号 | 验证项 | 执行时间 | 结果 | 说明 |
|----------|--------|----------|------|------|
| SQL-01 | 防重检查 (UNIQUE) | | ✅/❌ | |
| SQL-02 | 幂等对账 | | ✅/❌ | |
| SQL-03 | Redis↔PG 票数对账 | | ✅/❌ | |
| SQL-04 | 限流有效性 | | ✅/❌ | |
| SQL-05 | Redis tally 残留 | | ✅/❌ | |
| SQL-06A | 30天匿名清除干跑 | | ✅/❌ | |
| SQL-06B | 90天全量清除干跑 | | ✅/❌ | |
| SQL-07 | 跨团队隔离 | | ✅/❌ | |

## 三、告警记录

| 时间 | 告警编号 | 内容 | 严重级别 | 处置过程 | 状态 |
|------|----------|------|----------|----------|------|
| | | | | | ✅ 已恢复 / ⚠️ 观察中 / ❌ 待修复 |

## 四、异常发现

（逐条描述观察期中发现的任何非预期行为、数据趋势异常或潜在风险）

### 4.1 安全问题

- 

### 4.2 性能问题

- 

### 4.3 数据一致性问题

- 

### 4.4 业务指标异常

- 

## 五、数据趋势判断

### 5.1 用户行为趋势

- 投票创建节奏：[工作日集中 / 均匀分布 / 无明显模式]
- 匿名偏好：[高于预期 / 符合预期 / 低于预期]
- 参与率趋势：[上升 / 稳定 / 下降]

### 5.2 系统健康趋势

- 错误率走势：[平稳 / 上升 → 需关注 / 下降 → 已修复]
- 延迟走势：[稳定 / 波动 / 劣化]
- 资源使用走势：[充足 / 接近阈值 / 已达告警]

### 5.3 关键判断

- 系统是否达到 PRD 目标？
  - 投票创建耗时 ≤30s：[是/否/未测量]
  - 投票参与率 ≥80%：[是/否]
  - 首屏加载 ≤500ms：[是/否/未测量]
  - 实时推送延迟 ≤2s：[是/否/未测量]

## 六、建议

### 6.1 紧急修复项（P0）

- 

### 6.2 短期改进项（P1）

- 

### 6.3 中期优化项（P2）

- 

### 6.4 埋点/监控增强建议

- 

## 七、结论

- 数据观察结论：[✅ 正常通过 / ⚠️ 存在需关注项 / ❌ 存在阻断项]
- 是否建议继续线上运营：[是/否]
- 下一轮观察是否需要延长观察期：[是（理由）/否]

---

> 🛡️ **知微签字** · YYYY-MM-DD  
> 📋 抄送：EeiMoo（PM）、长夜（架构）
```

---

## 七、附录

### A. 巡检快照记录表（供日常填写）

| 巡检时间 | M01 创建 | M02 参与 | M03 匿名% | M05 WS | M07 5xx | M11 Redis MB | M14 过期 | M15 429 | 备注 |
|----------|----------|----------|-----------|--------|---------|-------------|---------|---------|------|
| Day1 10:00 | | | | | | | | | |
| Day1 16:00 | | | | | | | | | |
| Day1 22:00 | | | | | | | | | |
| Day2 10:00 | | | | | | | | | |
| Day2 16:00 | | | | | | | | | |
| Day2 22:00 | | | | | | | | | |
| Day3 10:00 | | | | | | | | | |
| Day3 16:00 | | | | | | | | | |

### B. 快速命令速查

```bash
# 健康检查
curl https://<domain>/health

# 指标暴露点
curl https://<domain>/health/metrics | jq .

# Redis 内存
docker exec vote-redis redis-cli INFO memory | grep -E "used_memory_human|mem_fragmentation_ratio|maxmemory"

# Redis Key 数量
docker exec vote-redis redis-cli DBSIZE

# PostgreSQL 直连
docker exec -it vote-pg psql -U vote_user -d vote_db

# 检查 expired-but-active 投票
docker exec -it vote-pg psql -U vote_user -d vote_db \
  -c "SELECT id, title, deadline FROM votes WHERE status='active' AND deadline < NOW();"

# 应用日志（最近 100 行）
docker logs vote-app --tail 100

# Nginx 日志
docker logs vote-nginx --tail 100
```

### C. 对已知安全发现项的观察追踪

| 安全报告编号 | 发现 | 观察期关注点 |
|-------------|------|-------------|
| F-01 | `getVoteDetail` 无 team_id 校验 | 若部署后修复，验证无跨团队 4xx；若未修复，统计是否有不同 team_id 的请求进入（通过 SQL-07 监控） |
| F-02 | Redis tally key 未在投票结束时删除 | 通过 SQL-05 监控残留 key 数量；观察 Redis 内存是否线性增长 |
| F-03 | WS Origin 未显式校验 | 若部署后修复，观察 WS 连接日志中 Origin 白的命中率；若未修复，通过 `docker logs vote-app` 观察是否有非飞书域名的 WS 连接尝试 |
| RET-03 | Redis tally key 残留 | 与 F-02 同，重点关注 Redis 内存趋势 |
| PEN-03 | 跨团队详情泄露风险 | 修复后通过 SQL-07 验证 team_id 隔离 |
| PEN-18 | 无 IP 维度限流 | 观察是否有单一 IP 通过多个 user_id 提交（需应用层日志辅助，MVP 期不强制） |

---

> 📋 **文档版本**：v1.0 · **制定人**：知微 🛡️  
> 📋 **送达**：EeiMoo（PM） · 待上线完成后开始执行
