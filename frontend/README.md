# 团队即时投票 — 前端

React + Vite + TypeScript 单页应用。

## 快速开始

```bash
npm install
npm run dev       # 开发服务器 http://localhost:5173
npm run build     # 构建产物 → dist/
npm run preview   # 预览构建产物
npm test          # 运行单元测试
```

## 环境变量

在项目根目录创建 `.env`、`.env.development`、`.env.production` 文件：

| 变量 | 说明 | 可选值 | 默认值 |
|------|------|--------|--------|
| `VITE_API_BASE` | 后端 API 地址 | `http://localhost:3001` (dev), `https://eeimoo.cn` (prod) | `http://localhost:3001` |
| `VITE_AUTH_MODE` | 登录方式 | `sso` \| `dev` | `sso` |

### .env.development（示例）

```
VITE_API_BASE=http://localhost:3001
VITE_AUTH_MODE=dev
```

### .env.production（示例）

```
VITE_API_BASE=https://eeimoo.cn
VITE_AUTH_MODE=sso
```

## 飞书 SSO 登录流程

1. 用户点击「飞书登录」按钮
2. 前端跳转到 `/api/auth/feishu/redirect`（后端 302 → 飞书授权页）
3. 用户在飞书侧完成授权
4. 飞书回调 → 前端 `/auth/callback?code=xxx&state=xxx`
5. `AuthCallback` 组件调用 `/api/auth/feishu/callback` 换取 token
6. token 存入 `localStorage`（key: `feishu_token`）
7. 自动跳转到投票列表 `/votes`

### Dev 降级模式

`VITE_AUTH_MODE=dev` 时显示手动登录表单（输入用户 ID + 昵称），生成 `dev_` 前缀 token。生产模式 (`sso`) 下也可通过「开发人员入口」按钮展开。

## 目录结构

```
src/
  pages/
    Login.tsx          # 登录页（SSO + dev）
    AuthCallback.tsx   # 飞书 OAuth 回调处理
    VoteList.tsx       # 投票列表
    CreateVote.tsx     # 创建投票
    VoteDetail.tsx     # 投票详情
  components/          # 通用组件
  hooks/               # 自定义 hooks
  services/
    api.ts            # Axios 实例 + 拦截器 + SSO API
  store/              # Zustand 全局状态
  types/              # TypeScript 类型定义
  test/
    setup.ts           # Vitest 初始化
```

## 构建产物部署

构建产物通过 nginx serve，无需前端独立容器：

```nginx
location / {
    root /path/to/vote-app/frontend/dist;
    try_files $uri $uri/ /index.html;
}
location /api {
    proxy_pass https://localhost:8443;
}
location /ws {
    proxy_pass https://localhost:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 测试

```bash
npx vitest run          # 单次运行
npx vitest              # watch 模式
npx vitest --ui         # 浏览器 UI
```

测试文件：`src/pages/Login.test.tsx`、`src/pages/AuthCallback.test.tsx`
