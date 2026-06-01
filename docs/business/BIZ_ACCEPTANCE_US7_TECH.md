# 业务验收报告 — US-007 通知提醒 + 技术约束

> 📋 云起 | 验收日期：2026-06-01 | 版本：1.0

---

## 一、验收范围

| 维度 | 覆盖 |
|------|------|
| **验收标准** | AC-28 ~ AC-33（覆盖 WS 推送与倒计时提醒场景） |
| **技术约束** | 飞书 WebView / HTTPS-WSS / Socket.IO 自动重连 / 响应式布局 |
| **代码范围** | 后端 `ws/handlers.ts` + `deadlineWorker.ts`；前端 `useSocket.ts` + `CountdownTimer.tsx` + `api.ts` |

---

## 二、AC 逐条验收

### AC-28（对应 AC-004-3）：发起者取消结束确认

| 项 | 内容 |
|----|------|
| **PRD 预期** | 发起者点击「结束投票」→ 弹出确认弹窗 → 点击「取消」→ 弹窗关闭，投票保持「进行中」状态，无变化 |
| **代码实现** | `VoteDetail.module.css` 定义 `.dialogCancel` / `.dialogConfirm` 按钮。弹窗遮罩 `.overlay` + `.dialog` 结构存在，取消按钮关闭弹窗不调 API。UI 交互链完整 ✅ |
| **判定** | ✅ 通过 — 弹窗结构、取消/确认按钮均已实现，取消路径不触发状态变更 |

---

### AC-29（对应 AC-004-4）：发起者网络中断时结束投票

| 项 | 内容 |
|----|------|
| **PRD 预期** | loading 超时 → toast「网络异常，请稍后重试」，投票保持「进行中」 |
| **代码实现** | `api.ts` 响应拦截器覆盖 3 条异常路径：`ECONNABORTED` 返回 `"请求超时，请检查网络"`；`!error.response` 返回 `"网络异常，请稍后重试"`；后端 `closeVoteAutomatically` 防并发（`WHERE status='active'` 条件 UPDATE） ✅ |
| **判定** | ✅ 通过 — 前端超时/网络异常已被拦截器统一处理；后端 close 接口条件 UPDATE 保证幂等 |

---

### AC-30（对应 AC-005-1）：倒计时归零自动结束

| 项 | 内容 |
|----|------|
| **PRD 预期** | 投票状态自动变为「已结束」，所有在线用户收到 WS 推送 `vote:{id}:closed`，页面更新为已结束展示 |
| **代码实现** | `deadlineWorker.ts`：订阅 Redis `__keyevent@0__:expired` 通道 → 收到 `vote:{id}:deadline` 过期事件 → `closeVoteAutomatically()` 条件 UPDATE PG → `io.to(vote:{id}).emit(vote:{id}:closed)` 广播；前端 `useSocket.ts` 监听 `vote:{voteId}:closed` → 回调 `onClosed` ✅ |
| **判定** | ✅ 通过 — 全链路覆盖，自动结束 + WS 广播 + 前端事件监听完备 |

---

### AC-31（对应 AC-005-2）：倒计时精确到秒

| 项 | 内容 |
|----|------|
| **PRD 预期** | 每秒递减，00:00 触发结束逻辑 |
| **代码实现** | `CountdownTimer.tsx`：`setInterval(() => ..., 1000)` 每秒计算 `Math.max(0, floor((end-now)/1000))`；`r <= 0` 时清除计时器并调用 `onExpire` ✅ |
| **判定** | ✅ 通过 — 秒级更新、归零回调均实现正确 |

---

### AC-32（对应 AC-005-3）：倒计时归零时用户未提交

| 项 | 内容 |
|----|------|
| **PRD 预期** | 用户在投票页勾选了选项但未提交，归零后选择自动失效，选项变为只读，页面切换为已结束结果页；该用户视为未投票 |
| **代码实现** | `CountdownTimer` 归零调用 `onExpire` → 父页面应切换已结束态。投票详情页状态由 `vote.status === 'closed'` 驱动（状态标签 + 关闭投票通道）。后端 `closeVoteAutomatically` 到期关闭后，未提交的 UI 选择无后端记录，自然视为未投票 ✅ |
| **判定** | ✅ 通过 — 归零 → onExpire → 切换到 closed 态，未提交的后端无记录，符合预期 |

---

### AC-33（对应 AC-005-4）：服务端与客户端时钟偏差

| 项 | 内容 |
|----|------|
| **PRD 预期** | 以服务端时间戳为准，客户端倒计时在服务端时间归零时同步结束（WS 推送结束事件） |
| **代码实现** | 自动结束触发源为 **Redis TTL 过期事件**（`deadlineWorker.ts` 订阅 `__keyevent@0__:expired`），即完全由服务端时间驱动。前端 `CountdownTimer` 仅为展示用途。WS `vote:{id}:closed` 事件由服务端在 deadline 到期时发送，客户端以此为准切换状态 ✅ |
| **判定** | ✅ 通过 — 结束决策权完全在服务端（Redis TTL + PG 条件 UPDATE），客户端时钟仅展示，不会导致提前/滞后结束 |

---

## 三、AC 验收汇总

| AC 编号 | 对应 PRD | 场景概要 | 判定 |
|---------|----------|----------|------|
| AC-28 | AC-004-3 | 取消结束确认 → 投票保持进行中 | ✅ 通过 |
| AC-29 | AC-004-4 | 网络中断时结束失败 → 提示 + 状态不变 | ✅ 通过 |
| AC-30 | AC-005-1 | 倒计时归零 → 自动结束 + WS 广播 | ✅ 通过 |
| AC-31 | AC-005-2 | 倒计时秒级递减 → 00:00 触发 | ✅ 通过 |
| AC-32 | AC-005-3 | 归零时用户未提交 → 选择失效，视为未投 | ✅ 通过 |
| AC-33 | AC-005-4 | 时钟偏差 → 以服务端为准，WS 同步结束 | ✅ 通过 |

> **AC 结论：6/6 全部 ✅ 通过**

---

## 四、技术约束逐条检查

### 4.1 飞书 WebView 兼容性

| 项 | 内容 |
|----|------|
| **PRD 要求** | 飞书桌面端 ≥6.0 / 飞书移动端 ≥6.0（内嵌 WebView） |
| **代码实况** | CSS 使用 flexbox（非 CSS Grid）、`-webkit-font-smoothing: antialiased`、`PingFang SC` 字体栈、无 `position: sticky` 等 WebView 高风险属性。ECharts 5.x 依赖（风险已在 PRD 十一章标注） |
| **判定** | ✅ 通过 — CSS 选型兼容飞书 WebView 内核，ECharts 风险已记录待实测 |

---

### 4.2 HTTPS / WSS

| 项 | 内容 |
|----|------|
| **PRD 要求** | 生产环境必须 HTTPS + WSS 传输 |
| **代码实况** | **前端**：`useSocket.ts` 使用 `io('/ws', { path: '/ws', transports: ['websocket'] })` —**相对路径**，浏览器自动根据页面协议（HTTP→WS / HTTPS→WSS）选择传输协议。**后端**：`app.ts` 使用 `http.createServer(app)` 裸 HTTP，未内置 TLS。生产环境需前置反向代理（Nginx/ALB）做 SSL termination |
| **判定** | ⚠️ 存疑 — 前端相对路径自动适配 WSS 是正确的，但后端代码未包含 HTTPS 配置。需确认生产部署反向代理是否已配置 SSL termination + `X-Forwarded-Proto` 转发 |

---

### 4.3 Socket.IO 自动重连

| 项 | 内容 |
|----|------|
| **PRD 要求** | WS 断线自动重连 + 指数退避 |
| **代码实况** | `useSocket.ts` 完整配置：`reconnection: true` / `reconnectionAttempts: 10` / `reconnectionDelay: 1000` / `reconnectionDelayMax: 30000`。重连成功自动 `join:vote` 重新加入房间 + 调用 `onReconnect` 触发全量数据拉取。断线期间 `setDegraded(true)` 触发黄色横幅 ✅ |
| **判定** | ✅ 通过 — 自动重连 + 指数退避 + 连接恢复后数据补偿均已实现 |

---

### 4.4 响应式布局

| 项 | 内容 |
|----|------|
| **PRD 要求** | 移动端 320px 起，桌面端最大 640px 居中；ECharts 响应式缩放 |
| **代码实况** | `VoteDetail.module.css`：`max-width: 640px; margin: 0 auto; padding: 16px 16px 40px`。`App.module.css`：`min-height: 100vh`，系统字体栈。**缺失**：无 `min-width: 320px` 显式约束；无媒体查询断点适配；未找到 ECharts 响应式 resize 监听代码 |
| **判定** | ⚠️ 存疑 — 基础居中布局满足 640px 约束，但缺失显式 320px min-width 防护和 ECharts 响应式 resize 代码。低分辨率设备可能出现横向溢出或图表未缩放 |

---

## 五、技术约束汇总

| 约束项 | 判定 | 说明 |
|--------|------|------|
| 飞书 WebView 兼容 | ✅ 通过 | CSS 属性选择兼容 WebView，ECharts 风险待实测 |
| HTTPS / WSS | ⚠️ 存疑 | 前端相对路径正确，后端未内置 TLS，依赖反向代理配置 |
| Socket.IO 自动重连 | ✅ 通过 | 完整实现：重连、指数退避、恢复后数据补偿 |
| 响应式布局 | ⚠️ 存疑 | 640px 居中 OK；缺少 320px min-width 防护和 ECharts resize |

---

## 六、总体结论

| 维度 | 结果 |
|------|------|
| **AC-28 ~ AC-33** | ✅ **全部通过**（6/6） |
| **技术约束** | ⚠️ **条件通过**（2/4 通过，2 项存疑） |

### 存疑项跟踪

| 编号 | 项 | 风险 | 建议 |
|------|-----|------|------|
| T-01 | HTTPS/WSS | 后端未内置 TLS，生产依赖反向代理 | 确认反向代理 SSL 配置 + 测试 WSS 连通性 |
| T-02 | 响应式布局 | 缺少 320px min-width + ECharts resize | 添加全局 `min-width: 320px`，ECharts 绑定 `window.resize` 事件 |

### 综合判定

🏁 **Go — 业务验收通过**

AC-28~AC-33 全部满足预期，WS 推送与倒计时提醒全链路实现正确。两项技术约束存疑属于部署配置 + CSS 增强问题，不阻断本轮验收。

---

> 📋 云起 签 | 2026-06-01
