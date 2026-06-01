# 测试通过报告 — 团队即时投票工具

> 版本：v1.0 | 测试人：寻错 🔍 | 日期：2026-06-01
> 依据：后端回归 `REGRESSION_BACKEND_v1.0.md` + 前端回归 `REGRESSION_FRONTEND_v1.0.md`

---

## 测试概况

| 维度 | 数据 |
|------|------|
| 总用例（缺陷回归验证） | 24 |
| ✅ 通过 | 24 |
| ❌ 失败 | 0 |
| 🚫 阻塞 | 0 |

### 按模块分布

| 模块 | 总用例 | 通过 | 失败 | 阻塞 |
|------|--------|------|------|------|
| 后端 | 14 | 14 | 0 | 0 |
| 前端 | 10 | 10 | 0 | 0 |

---

## 缺陷修复与验证汇总

### P0 — 阻断缺陷（4/4 已修复 ✅）

| ID | 模块 | 描述 | 验证结果 |
|----|------|------|----------|
| BUG-001 | 后端 | 限流中间件路径匹配失效 → 速率限制完全不生效 | ✅ 正则修正为 `/^\/[^/]+\/vote$/`，匹配 Express Router 剥离前缀后的 `req.path` |
| BUG-002 | 后端 | 创建投票未调度截止提醒 → `scheduleReminder` 永不触发 | ✅ `createVote()` 中新增 `await scheduleReminder()` 调用 |
| BUG-FE-001 | 前端 | 实名投票进行中时图表不展示投票人信息 | ✅ `ResultChart.tsx` 条件移除 `&& isClosed`，仅保留 `!isAnonymous` |
| BUG-FE-002 | 前端 | 乐观更新 + WS 更新 → 票数重复计数 | ✅ `handleUpdate` 中 WS 推送后立即清除对应 `optimisticCounts` |

### P1 — 严重缺陷（7/7 已修复 ✅）

| ID | 模块 | 描述 | 验证结果 |
|----|------|------|----------|
| BUG-003 | 后端 | WS `join:vote` 无团队级权限校验 | ✅ 加入房间前查询 `votes.team_id` 与 `socket.data.team_id` 比对 |
| BUG-004 | 后端 | WS 认证中间件生产模式未实际验签 | ✅ 调用真实 `verifyFeishuToken(token)`，不再截断字符串 |
| BUG-005 | 后端 | `tallySync.ts` 服务缺失 | ✅ 文件已创建，每 5 秒从 PG 聚合票数写回 Redis，启动时首执行 |
| BUG-006 | 后端 | `redisHealth.ts` 服务缺失 | ✅ 文件已创建，每秒 PING，连续 3 次失败降级/3 次成功恢复 |
| BUG-007 | 后端 | `idempotency_key` 幂等键未实现 | ✅ 创建投票 + 提交投票均支持幂等键，Redis 缓存 24h |
| BUG-FE-003 | 前端 | WS 重连后未触发全量数据重新拉取 | ✅ `useSocket` 新增 `onReconnect` 回调，重连后触发 `fetchDetail()` |
| BUG-FE-004 | 前端 | 进度计数器未反映乐观更新 | ✅ 求和表达式增加 `Object.values(optimisticCounts).reduce(...)` |

### P2 — 一般缺陷（9/9 已修复 ✅）

| ID | 模块 | 描述 | 验证结果 |
|----|------|------|----------|
| BUG-008 | 后端 | Redis tally 初始化竞态 → 票数覆盖清零 | ✅ `initRedisTally` 调用移至 PG 事务之前（投票不可见窗口） |
| BUG-009 | 后端 | UUID v4 替代 v7 → 失去时间有序性 | ✅ 自行实现符合 RFC 9562 的 UUID v7（48-bit 毫秒时间戳） |
| BUG-010 | 后端 | 自动结束未同步最终票数至 PG | ✅ 调用 `aggregateTallyFromPG()` 获取最终票数并日志记录 |
| BUG-011 | 后端 | WS 广播 `new_count` 非 HINCRBY 返回值 | ✅ `incrementTally` 返回 HINCRBY 值数组，不再二次 `HGET` |
| BUG-012 | 后端 | 提交投票仅靠 status 拒绝，无 deadline 校验 | ✅ `FOR UPDATE` 新增 `deadline` 字段，增加时间比较条件 |
| BUG-FE-005 | 前端 | 自定义截止时间使用原生 `prompt()/alert()` | ✅ 替换为受控模态框 `<input type="number" inputMode="numeric">` |
| BUG-FE-006 | 前端 | 投票卡片剩余时间格式非标准 | ✅ `getRemaining()` 返回 `mm:ss` 格式，与 `CountdownTimer` 一致 |
| BUG-FE-007 | 前端 | 投票提交失败缺少具体错误分类 | ✅ 按 `ApiError.code` 分类（409/403/429/network），UI 差异化展示 |
| BUG-FE-008 | 前端 | WS deadline reminder 事件未被消费 | ✅ `onReminder` 回调设置 toast 状态，页面顶部展示提醒 |

### P3 — 建议缺陷（4/4 已修复 ✅）

| ID | 模块 | 描述 | 验证结果 |
|----|------|------|----------|
| BUG-013 | 后端 | 多选广播每选项重复 `fetchSockets` | ✅ `fetchSockets()` 提取到 `for` 循环外，仅调用一次 |
| BUG-014 | 后端 | `psubscribe` 失败无重试机制 | ✅ 指数退避重试（最多 3 次），上限 10 秒 |
| BUG-FE-009 | 前端 | store 中 `isConnected` 字段从未更新（死代码） | ✅ `connect`/`disconnect`/`reconnect` 事件中正确调用 `setConnected` |
| BUG-FE-010 | 前端 | 手动结束投票可能触发重复 `fetchDetail` | ✅ 直接用 API 响应更新本地状态，不再重复调用 `fetchDetail` |

---

## 附加观察（非阻塞项）

| # | 位置 | 描述 | 严重度 |
|---|------|------|--------|
| 1 | `src/services/ballotService.ts:160-163` | `submitVote()` 末尾存在两个连续 `return` 语句，第二个永远不可达。功能正确但属代码质量问题，建议在后续编码规范迭代中清理。 | 🟢 P3 |

---

## 结论

### ✅ 通过（Go）

全部 24 个缺陷回归验证通过，阻塞项归零：

- 🔴 P0 阻断：4/4 已修复（限流失效、提醒丢失、实名投票人展示、乐观更新重复计数）
- 🟠 P1 严重：7/7 已修复（WS 权限校验、验签调用、缺失服务补齐、幂等键全链路、重连数据同步、进度计数器）
- 🟡 P2 一般：9/9 已修复（竞态消除、UUID v7、最终票数对账、HINCRBY 返回值、deadline 双重校验、自定义输入模态框、时间格式标准化、错误分类提示、提醒事件消费）
- 🟢 P3 建议：4/4 已修复（`fetchSockets` 去重、psubscribe 重试、死代码激活、冗余请求消除）

**质量判定：Go ✅** — 代码质量达到提测标准，无阻断项，可进入阶段六 Go/No-Go 评审。

---

## 遗留风险

无明显遗留风险。附加观察项 #1（冗余 return 语句）为 P3 代码质量问题，不影响功能正确性，建议纳入后续编码规范迭代统一清理。
