# ============================================================
# 团队即时投票工具 — Node.js 后端 Dockerfile
# 多阶段构建：编译 → 运行时精简镜像
# 目标：Node.js 20 LTS Alpine | 设计人：长夜 | 日期：2026-06-01
# ============================================================
#
# 构建：
#   docker build -f app.Dockerfile -t vote-app:latest .
#
# 运行上下文：
#   需要 server/ 目录存在（含 package.json / tsconfig.json / src/）
# ============================================================

# ════════════════════════════════════════════════
# Stage 1: 编译阶段
# ════════════════════════════════════════════════
FROM node:20-alpine AS builder

WORKDIR /build

# 1. 安装依赖（含 devDependencies，TypeScript 编译需要）
COPY server/package.json server/package-lock.json* ./
RUN npm ci --include=dev

# 2. 复制源码并编译 TypeScript
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build

# 3. 仅保留运行时依赖（production）
#    编译完成后删掉 devDependencies，重新安装 production 依赖
#    避免将 devDeps 打进最终镜像
RUN npm prune --production

# ════════════════════════════════════════════════
# Stage 2: 运行时阶段
# ════════════════════════════════════════════════
FROM node:20-alpine

# 安全：创建非 root 用户
RUN addgroup -g 1001 vote && \
    adduser -u 1001 -G vote -D -s /bin/sh vote

WORKDIR /app

# 从 builder 复制编译产出的 JS 和运行时 node_modules
COPY --from=builder --chown=vote:vote /build/dist      ./dist
COPY --from=builder --chown=vote:vote /build/node_modules ./node_modules
COPY --from=builder --chown=vote:vote /build/package.json ./

# 切换非 root 用户
USER vote

# 暴露应用端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3001/health || exit 1

# 启动命令
CMD ["node", "dist/index.js"]
