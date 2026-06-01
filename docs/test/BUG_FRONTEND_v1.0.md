# 前端代码缺陷报告 — 团队即时投票工具

> 版本：v1.0 | 审查人：寻错 🔍 | 日期：2026-06-01
> 审查范围：流光前端代码全量 vs 架构 v1.1 + PRD v1.1

---

## 缺陷统计

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 🔴 P0 - 阻断 | 2 | 数据正确性问题，阻塞上线 |
| 🟠 P1 - 严重 | 2 | 数据一致性与可用性问题 |
| 🟡 P2 - 一般 | 4 | 体验与交互缺陷 |
| 🟢 P3 - 建议 | 2 | 代码质量/冗余 |
| **合计** | **10** | |

---

## 🔴 P0 — 阻断缺陷

### BUG-001：实名投票进行中时，图表不展示投票人信息

- **ID**：BUG-FE-001
- **严重度**：🔴 P0
- **文件**：`src/components/ResultChart.tsx`，第 ~50 行 tooltip formatter
- **现象**：
  ```typescript
  if (!isAnonymous && isClosed && dataItem && dataItem.voters.length > 0) {
  ```
  该条件要求 `!isAnonymous && isClosed` 同时满足才展示投票人，导致**实名投票在「进行中」状态时，hover 柱状图无任何投票人信息**。
- **预期**：PRD §5.3 明确要求"实名模式下：每个柱子右侧或 hover 可展开投票人列表（头像 + 姓名）"。架构 §4.2.3 规定 `voters` 字段在公开模式下始终返回（后端做权限过滤），前端不应附加 `isClosed` 条件。
- **修复建议**：将条件改为 `!isAnonymous`，移除 `&& isClosed`。投票人可见性由后端 API 的字段级过滤保障（匿名模式返回空数组），前端不应画蛇添足。
  ```typescript
  // 修复前
  if (!isAnonymous && isClosed && dataItem && dataItem.voters.length > 0)
  
  // 修复后
  if (!isAnonymous && dataItem && dataItem.voters.length > 0)
  ```

---

### BUG-002：乐观更新导致同一选项 WS 更新时票数重复计数

- **ID**：BUG-FE-002
- **严重度**：🔴 P0
- **文件**：
  - `src/hooks/useVoteDetail.ts`：第 ~90 行 `submitVote` 设置 `optimisticCounts`；第 ~62 行 `handleUpdate` 覆盖 `options[].count`
  - `src/components/ResultChart.tsx`：第 ~44 行计算 `chartData` 时将 `optimisticCounts` 叠加到 `options[].count`
- **现象**：用户 A 对选项 X 提交投票后，`optimisticCounts[X] = 1`。随后用户 B 也对选项 X 投票，WS 推送 `new_count`（已含 A 和 B 的票数）到 A，A 的 `handleUpdate` 将 `options[X].count = new_count`，但 `optimisticCounts[X]` 仍为 1。最终图表显示 `new_count + 1`，即 **A 的票被重复计算**。
- **复现步骤**：
  1. A 打开投票详情，选项 X 当前 5 票
  2. A 提交投票选 X → optimisticCounts[X]=1 → 图表显示 6 ✓
  3. B 提交投票选 X → A 收到 WS `vote:{id}:update` → options[X].count=7（5+A+B）
  4. 图表显示 7+1=8 ❌（预期 7）
- **预期**：乐观偏移只是对"服务端还没确认的本端投票"的临时修正。当服务端 WS 推送的 `new_count` 已包含本端投票时，不应再叠加乐观偏移。
- **修复建议**：在 `handleUpdate` 中，收到 WS 更新后立即清除对应 `option_id` 的乐观偏移：
  ```typescript
  const handleUpdate = useCallback((payload: WsVoteUpdate) => {
    setOptions((prev) =>
      prev.map((opt) =>
        opt.id === payload.option_id
          ? { ...opt, count: payload.new_count }
          : opt
      )
    );
    // 服务端计数已是权威值，清除乐观偏移
    setOptimisticCounts((prev) => {
      if (!(payload.option_id in prev)) return prev;
      const next = { ...prev };
      delete next[payload.option_id];
      return next;
    });
  }, []);
  ```
  或在 `submitVote` API 成功后直接重置 `optimisticCounts` 并将服务端返回的确认计数写入 `options`。

---

## 🟠 P1 — 严重缺陷

### BUG-003：WS 重连后未触发全量数据重新拉取

- **ID**：BUG-FE-003
- **严重度**：🟠 P1
- **文件**：
  - `src/hooks/useSocket.ts`：第 ~76 行 `reconnect` 事件处理仅有注释"重连后由上层 useVoteDetail 全量拉取最新数据"
  - `src/hooks/useVoteDetail.ts`：第 ~75 行调用 `useSocket` 时未传递重连回调
- **现象**：WS 重连成功后，仅执行 `emit('join:vote')` 重新加入房间，**未触发全量数据 refetch**。断线期间其他用户的投票在重连后不会主动同步，只能等待下一次 WS 推送。
- **预期**：架构 §7.5 伪代码明确"重连后全量拉取当前投票状态重新渲染"。PRD AC-003-7 要求"重连后拉取全量数据 → 图表更新至最新"。
- **修复建议**：
  1. 在 `useSocket` 接口中增加 `onReconnect?: () => void` 回调 prop
  2. 在 `reconnect` 事件中调用 `callbacksRef.current.onReconnect?.()`
  3. 在 `useVoteDetail` 中传递 `onReconnect: fetchDetail` 给 `useSocket`

---

### BUG-004：投票详情页进度计数器未反映乐观更新

- **ID**：BUG-FE-004
- **严重度**：🟠 P1
- **文件**：`src/pages/VoteDetail.tsx`，第 ~100 行
- **现象**：
  ```typescript
  已投 {options.reduce((s, o) => s + (o.count ?? 0), 0)}/{vote.total_voters} 人
  ```
  该行使用 `options[].count` 直接求和，未叠加 `optimisticCounts`。用户提交投票后，图表柱状图已乐观 +1，但顶部的"已投 X/Y 人"计数器**仍为旧值**，直到 WS 推送更新或页面刷新。
- **预期**：进度计数器应与图表保持一致的乐观性，投票提交后立即 +1 更新。
- **修复建议**：
  ```typescript
  const votedCount = options.reduce((s, o) => s + (o.count ?? 0), 0)
    + Object.values(optimisticCounts).reduce((s, v) => s + v, 0);
  ```

---

## 🟡 P2 — 一般缺陷

### BUG-005：自定义截止时间使用原生 prompt()/alert()，缺乏可访问性

- **ID**：BUG-FE-005
- **严重度**：🟡 P2
- **文件**：`src/pages/CreateVote.tsx`，第 ~110 行「自定义」按钮 onClick
- **现象**：点击「自定义」后弹出浏览器原生 `prompt()` 输入框，校验失败用 `alert()` 提示。原生弹窗：
  - 不支持屏幕阅读器友好导航
  - 样式与飞书 UI 完全脱节
  - 移动端键盘可能不弹出数字键盘
- **预期**：PRD §5.2 要求"自定义弹数字键盘输入分钟数"，应使用受控的 `<input type="number">` 模态框或内联输入。
- **修复建议**：使用一个受控的数字输入组件（state 管理 visible + value），弹出层内嵌 `inputmode="numeric"` 输入框，校验错误以内联文案展示。

---

### BUG-006：投票卡片剩余时间展示使用非标准格式

- **ID**：BUG-FE-006
- **严重度**：🟡 P2
- **文件**：`src/components/VoteCard.tsx`，第 ~15 行 `getRemaining()` 函数
- **现象**：剩余时间展示格式为"3分钟"、"45秒"、"2小时"等中文描述，而 PRD §5.1 线框明确要求 `剩余 05:30`（**mm:ss 格式**）。
- **预期**：卡片标签行显示 mm:ss 倒计时格式，与详情页计时器风格一致。
- **修复建议**：
  ```typescript
  const getRemaining = (): string => {
    if (!isActive) return '已结束';
    const diff = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  ```

---

### BUG-007：投票提交失败缺少具体错误分类提示

- **ID**：BUG-FE-007
- **严重度**：🟡 P2
- **文件**：
  - `src/hooks/useVoteDetail.ts`：第 ~90 行 `submitVote` 的 `catch` 块
  - `src/pages/VoteDetail.tsx`：第 ~56 行 `handleSubmitVote`
- **现象**：无论服务端返回 409（重复投票）、403（投票已结束）、429（速率限制）还是网络超时，前端统一显示"投票失败，请稍后重试"。违背 PRD AC-003-9：重复投票应 toast "您已投过票"，投票已结束应切换页面状态。
- **修复建议**：
  1. 在 `useVoteDetail.submitVote` 的 catch 块中解析 `ApiError.code`：
     - `40901` → throw specific error / return `{ ok: false, reason: 'duplicate' }`
     - `40301` → throw specific / return `{ ok: false, reason: 'closed' }`
     - `42900` → throw specific / return `{ ok: false, reason: 'rate_limited' }`
  2. 在 `VoteDetail.handleSubmitVote` 中根据 error.reason 分类展示：
     - duplicate → toast "您已投过票，不可重复提交"
     - closed → 页面切换到已结束视图
     - rate_limited → toast "操作过于频繁，请稍后再试"
     - network → "网络异常，请稍后重试"

---

### BUG-008：WS deadline reminder 事件未被消费

- **ID**：BUG-FE-008
- **严重度**：🟡 P2
- **文件**：
  - `src/hooks/useVoteDetail.ts`：第 ~75 行 `useSocket` 调用未传递 `onReminder`
  - `src/hooks/useSocket.ts`：第 ~88 行监听 `vote:{id}:reminder`，但 callback 为 undefined
- **现象**：服务端推送的 `vote:{id}:reminder` 事件在前端被静默丢弃。虽然 `CountdownTimer` 已独立处理 ≤60s 视觉变化，但 PRD §4.3 状态流转图明确要求"结束前 1 分钟 WS 推送「即将结束」提醒"。该事件可用于 toast 通知或音效提示等辅助 UI。
- **预期**：收到 reminder 事件后，页面应有可感知的提醒（如顶部 toast "投票即将在 1 分钟后结束"）。
- **修复建议**：在 `useVoteDetail` 中增加 `onReminder` 回调，收到事件后设置一个 `showReminderToast` 状态，在 UI 中展示短暂 toast。

---

## 🟢 P3 — 建议改进

### BUG-009：store 中 isConnected 字段从未更新（死代码）

- **ID**：BUG-FE-009
- **严重度**：🟢 P3
- **文件**：`src/store/index.ts` — `NetworkState.isConnected`；对比 `src/hooks/useSocket.ts`
- **现象**：`useNetworkStore` 定义了 `isConnected` / `setConnected`，但 `useSocket` 中仅调用 `setDegraded`，从未调用 `setConnected`。`isConnected` 始终为初始值 `true`，且无任何消费者读取它。
- **修复建议**：在 `useSocket` 的 `connect` 事件中调用 `setConnected(true)`，`disconnect` 事件中调用 `setConnected(false)`；或在 `NetworkBanner` 中也使用 `isConnected` 提供更精细的 UI 状态。如果不需要，移除该字段以减少维护负担。

---

### BUG-010：手动结束投票可能触发重复 fetchDetail 调用

- **ID**：BUG-FE-010
- **严重度**：🟢 P3
- **文件**：`src/hooks/useVoteDetail.ts`
  - 第 ~110 行 `closeVote` 成功后调用 `await fetchDetail()`
  - 第 ~68 行 `handleClosed`（WS 回调）也调用 `fetchDetail()`
- **现象**：发起者手动结束投票后：
  1. `closeVote()` API 成功 → 主动调用 `fetchDetail()` 第 1 次
  2. 服务端 WS 广播 `vote:{id}:closed` → `handleClosed` 触发 `fetchDetail()` 第 2 次
  两次 `fetchDetail` 几乎同时触发，产生冗余请求。
- **影响**：功能正确（最终一致性），但浪费一次 HTTP 请求和一次 React 状态更新。不影响数据正确性。
- **修复建议**：`closeVote` 成功后直接用服务端返回的 `{ status: 'closed', closed_by: 'manual', closed_at }` 更新本地 `vote` 状态，不必再调 `fetchDetail`。让 WS 的 `handleClosed` 负责全量刷新以覆盖其他在线用户。

---

## 无害确认项（无缺陷）

以下检查项经审查确认符合架构/PRD 要求，无缺陷：

| 检查项 | 结论 | 说明 |
|--------|------|------|
| API 路径与架构 §4 一致 | ✅ | `/api/votes`、`/api/votes/:id`、`/api/votes/:id/vote`、`/api/votes/:id/close` 全部对齐 |
| WS 事件名与架构 §7 一致 | ✅ | `vote:{id}:update`、`vote:{id}:closed`、`vote:{id}:reminder` 全部对齐 |
| 匿名模式不渲染 user_id/voters | ✅ | backend 过滤 + ResultChart 条件检查双重防护 |
| 倒计时 ≤60s 红色脉冲 / ≤10s 大号闪烁 | ✅ | CountdownTimer 正确处理 `isWarning` / `isCritical` 状态 |
| 断网 Banner 显示/隐藏 | ✅ | NetworkBanner 基于 `isDegraded` 正确显隐 |
| 创建表单校验（标题≤100、选项 2-10、非空、不重复） | ✅ | useCreateVote.validate() 正确覆盖所有校验规则 |
| 创建表单字段/布局与 PRD §5.2 线框一致 | ✅ | 标题、选项增删、分段控制器、截止预设一一对齐 |
| 匿名模式创建页隐私声明 | ✅ | AC-008-3：选择匿名时显示蓝色提示条 |
| 投票详情匿名隐私声明 | ✅ | AC-008-1：进行中+匿名+未投票时显示 |
| 已投票锁定只读 | ✅ | disabled=true + "投票已提交，不可更改" |
| 结束投票二次确认弹窗 | ✅ | "确定结束投票吗？结束后所有人不可再投票。" |
| 发起者可见结束按钮，非发起者不可见 | ✅ | `isCreator` 控制渲染 |
| 401 清除 token | ✅ | api.ts 拦截器 |
| 429 限流处理 | ✅ | api.ts 解析 Retry-After header（记录日志） |
| ECharts 按需引入 bar 模块 | ✅ | 仅注册 BarChart + 必要组件 |

---

## 审查总结

| 维度 | 评价 |
|------|------|
| 架构对齐度 | ⚠️ 核心 API/WS 事件名匹配，但 WS 重连逻辑与架构设计存在偏差（BUG-003） |
| 数据正确性 | ❌ 乐观更新与 WS 更新叠加导致票数重复计算（BUG-002）阻断上线 |
| 交互还原度 | ⚠️ 实名投票人信息在 active 状态缺失（BUG-001），剩余时间格式不统一（BUG-006） |
| 错误处理 | ⚠️ 投票提交错误未分类（BUG-007），WS reminder 被丢弃（BUG-008） |
| 代码质量 | ✅ 类型定义完整，组件职责清晰，无明显内存泄漏 |

**Go/No-Go 建议**：🔴 **No-Go** — BUG-001 和 BUG-002 为阻断级数据正确性缺陷，必须在测试前修复。BUG-003/004 建议在首次修复中一并解决。
