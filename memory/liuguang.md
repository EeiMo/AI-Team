# 流光🎨 项目记忆 — 投票应用 v3

## 项目背景
投票应用 (vote-app)，v3 迭代方向：
1. 增加创建人删除投票功能
2. 优化前端美化

v2 已完成飞书 SSO 集成和 CI/CD 框架搭建。当前为 Kic-off 阶段。

## 代码库现状（2026-06-03）

### 页面路由
- `/login` — 简易登录页（飞书未就绪备用）
- `/auth/callback` — 飞书 OAuth 回调
- `/votes` — 投票列表（默认 active tab，支持分页加载）
- `/votes/new` — 创建投票表单
- `/votes/:id` — 投票详情（进行中/已结束两种视图）

### 组件
| 组件 | 功能 |
|------|------|
| VoteCard | 投票卡片（状态点、标签、进度条、倒计时） |
| OptionList | 选项列表（可选/只读） |
| ResultChart | ECharts 柱状图 |
| CountdownTimer | 倒计时组件 |
| NetworkBanner | 网络降级提示条 |

### 数据层
- Zustand: `useNetworkStore`（连接态/降级态）、`useFilterStore`（active/closed 筛选）
- Hooks: `useVotes`（列表分页）、`useVoteDetail`（详情+乐观更新+WS）、`useCreateVote`（表单+校验）、`useSocket`（Socket.IO 封装）

### 状态覆盖
每个数据请求遵循「isLoading → 骨架屏 / isEmpty → 空状态 / error → 错误提示 / data → 正常渲染」四态约定。

### 已覆盖功能
- 列表分页（20条/页，上拉加载更多）
- 投票提交（乐观更新+回滚）
- WebSocket 实时增量更新
- 发起者结束投票（含确认弹窗）
- 匿名投票隐私声明
- 截止提醒 Toast
- 表单校验（标题、选项重复、截止时间范围）
- 自定义截止时间弹窗
- 飞书 SSO token 注入（Axios 拦截器）
