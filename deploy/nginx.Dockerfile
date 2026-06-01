# ============================================================
# 团队即时投票工具 — Nginx Dockerfile
# 多阶段构建：前端编译 → Nginx 运行时镜像
# 目标：nginx:1.25-alpine + 前端静态资源 | 设计人：长夜 | 日期：2026-06-01
# ============================================================
#
# 构建：
#   docker build -f nginx.Dockerfile -t vote-nginx:latest .
#
# 运行上下文：
#   需要 client/ 目录存在（含 package.json / vite.config.ts / src/）
#   需要 nginx.conf 存在
# ============================================================

# ════════════════════════════════════════════════
# Stage 1: 前端构建（Vite + React + TypeScript）
# ════════════════════════════════════════════════
FROM node:20-alpine AS client-builder

WORKDIR /client

# 安装依赖
COPY client/package.json client/package-lock.json* ./
RUN npm ci --include=dev

# 复制源码并构建
COPY client/ ./
RUN npm run build
# 产出：/client/dist/

# ════════════════════════════════════════════════
# Stage 2: Nginx 运行时
# ════════════════════════════════════════════════
FROM nginx:1.25-alpine

# 删除默认配置
RUN rm -f /etc/nginx/conf.d/default.conf

# 注入自定义 Nginx 配置
COPY nginx.conf /etc/nginx/nginx.conf

# 注入前端构建产物
COPY --from=client-builder /client/dist /usr/share/nginx/html

# 创建 SSL 证书目录（运行时挂载实际证书）
RUN mkdir -p /etc/nginx/certs

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost/health || exit 1

# 暴露端口
EXPOSE 80 443

# 前台运行
CMD ["nginx", "-g", "daemon off;"]
