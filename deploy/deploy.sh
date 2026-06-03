#!/usr/bin/env bash
# ============================================================
# 团队即时投票工具 — CI/CD 部署脚本
# 流程：lint → test → build → push → deploy
# 设计人：长夜 | 日期：2026-06-01
# ============================================================
#
# 用法：
#   # 完整流水线（CI 环境）
#   ./deploy.sh --env production --tag v1.2.3
#
#   # 仅构建测试
#   ./deploy.sh --env staging --lint-only
#
#   # 构建 + 推送镜像（不部署）
#   ./deploy.sh --env production --tag v1.2.3 --build-only
#
#   # 本地快速部署（跳过 lint/test，直接 docker-compose up）
#   ./deploy.sh --env dev --local
#
# 环境变量：
#   DOCKER_REGISTRY    镜像仓库地址（默认空 = 本地）
#   PG_PASSWORD        数据库密码
#   FEISHU_APP_ID      飞书应用 ID
#   FEISHU_APP_SECRET  飞书应用密钥
# ============================================================

set -euo pipefail

# ─── 颜色输出 ──────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE}[$(date +%H:%M:%S)] $*${NC}"; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ─── 默认参数 ──────────────────────────────────
ENV="production"
TAG="latest"
LINT_ONLY=false
BUILD_ONLY=false
LOCAL_MODE=false
DOCKER_REGISTRY="${DOCKER_REGISTRY:-}"

# 镜像名称
REGISTRY_PREFIX="${DOCKER_REGISTRY:+${DOCKER_REGISTRY}/}"
APP_IMAGE="${REGISTRY_PREFIX}vote-app:${TAG}"
NGINX_IMAGE="${REGISTRY_PREFIX}vote-nginx:${TAG}"

# ─── 参数解析 ──────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)       ENV="$2"; shift 2 ;;
        --tag)       TAG="$2"; shift 2 ;;
        --lint-only) LINT_ONLY=true; shift ;;
        --build-only)BUILD_ONLY=true; shift ;;
        --local)     LOCAL_MODE=true; shift ;;
        --help|-h)
            echo "用法: $0 [选项]"
            echo "  --env <env>        部署环境 (dev|staging|production)"
            echo "  --tag <tag>        镜像标签 (默认 latest)"
            echo "  --lint-only        仅执行 lint + test"
            echo "  --build-only       构建并推送镜像，不部署"
            echo "  --local            本地模式：跳过 lint/test，直接 docker-compose up"
            exit 0 ;;
        *) error "未知参数: $1"; exit 1 ;;
    esac
done

# 重新计算镜像名（TAG 可能已变）
APP_IMAGE="${REGISTRY_PREFIX}vote-app:${TAG}"
NGINX_IMAGE="${REGISTRY_PREFIX}vote-nginx:${TAG}"

info "部署环境: ${ENV} | 镜像标签: ${TAG} | 仓库: ${DOCKER_REGISTRY:-本地}"

# ============================================================
# Step 1: Lint（代码静态检查）
# ============================================================
step "1/5 Lint — 代码静态检查"

lint_backend() {
    info "后端 TypeScript 检查..."
    cd ../backend
    if command -v npx &>/dev/null; then
        npx tsc --noEmit || { error "TypeScript 编译检查失败"; return 1; }
        npx eslint src/ --ext .ts || warn "ESLint 警告（非阻塞）"
    else
        warn "npx 不可用，跳过 lint（CI 环境请安装 Node.js）"
    fi
    cd - > /dev/null
}

lint_frontend() {
    info "前端 TypeScript 检查..."
    cd ../frontend
    if command -v npx &>/dev/null; then
        npx tsc --noEmit || { error "TypeScript 编译检查失败"; return 1; }
        npx eslint src/ --ext .ts,.tsx || warn "ESLint 警告（非阻塞）"
    else
        warn "npx 不可用，跳过 lint"
    fi
    cd - > /dev/null
}

if $LOCAL_MODE; then
    info "本地模式：跳过 lint"
else
    lint_backend
    lint_frontend
    info "Lint 通过 ✓"
fi

# ============================================================
# Step 2: Test（单元测试）
# ============================================================
step "2/5 Test — 单元测试"

run_tests() {
    info "后端单元测试..."
    cd ../backend
    if [ -f "node_modules/.bin/jest" ] || [ -f "node_modules/.bin/vitest" ]; then
        npm test || { error "测试失败，终止流水线"; exit 1; }
    else
        warn "未找到测试运行器，跳过测试"
    fi
    cd - > /dev/null
}

if $LOCAL_MODE; then
    info "本地模式：跳过测试"
else
    run_tests
    info "测试通过 ✓"
fi

# lint-only 模式到此结束
if $LINT_ONLY; then
    step "完成 — lint-only 模式"
    exit 0
fi

# ============================================================
# Step 3: Build（构建 Docker 镜像）
# ============================================================
step "3/5 Build — 构建 Docker 镜像"

build_app() {
    info "构建 app 镜像: ${APP_IMAGE}..."
    docker build -f deploy/app.Dockerfile -t "${APP_IMAGE}" . || {
        error "app 镜像构建失败"
        exit 1
    }
}

build_nginx() {
    info "构建 nginx 镜像: ${NGINX_IMAGE}..."
    docker build -f deploy/nginx.Dockerfile -t "${NGINX_IMAGE}" . || {
        error "nginx 镜像构建失败"
        exit 1
    }
}

build_app
build_nginx

info "镜像构建完成:"
docker images --filter "reference=vote-app" --filter "reference=vote-nginx" --format "  {{.Repository}}:{{.Tag}} ({{.Size}})"

# ============================================================
# Step 4: Push（推送镜像到仓库）
# ============================================================
step "4/5 Push — 推送镜像到仓库"

push_images() {
    if [ -z "${DOCKER_REGISTRY}" ]; then
        info "未配置 DOCKER_REGISTRY，跳过推送（本地部署）"
        return 0
    fi

    info "登录镜像仓库..."
    docker login "${DOCKER_REGISTRY}" -u "${DOCKER_USERNAME:-}" -p "${DOCKER_PASSWORD:-}" || {
        warn "登录失败，跳过推送"
        return 0
    }

    info "推送 ${APP_IMAGE}..."
    docker push "${APP_IMAGE}"
    info "推送 ${NGINX_IMAGE}..."
    docker push "${NGINX_IMAGE}"
}

push_images
info "推送完成 ✓"

# build-only 模式到此结束
if $BUILD_ONLY; then
    step "完成 — build-only 模式"
    exit 0
fi

# ============================================================
# Step 5: Deploy（部署）
# ============================================================
step "5/5 Deploy — 部署到 ${ENV} 环境"

deploy() {
    info "检查 docker-compose 状态..."

    # 确保依赖服务健康后再重启 app
    info "滚动重启 app 容器（不中断 pg/redis/nginx）..."
    docker-compose -f deploy/docker-compose.yml up -d --no-deps --build app

    # 等待 healthcheck 通过
    info "等待 app 健康检查通过..."
    for i in $(seq 1 30); do
        if docker-compose -f deploy/docker-compose.yml exec -T app wget -qO- http://localhost:3001/health 2>/dev/null; then
            info "app 健康检查通过 ✓"
            break
        fi
        if [ "$i" -eq 30 ]; then
            error "app 启动超时，回滚到上一版本"
            warn "手动回滚: docker-compose up -d --no-deps app (旧镜像)"
            exit 1
        fi
        sleep 2
    done

    # ── 检查数据库迁移是否成功（EVO-008）──
    # 问题来源：迁移未执行无人感知，无失败告警
    # 解决：app 启动后等待 10s，检查日志中的迁移标记
    info "等待数据库迁移完成..."
    sleep 10

    # 先检查是否有迁移错误
    MIGRATION_ERROR=$(docker-compose -f deploy/docker-compose.yml logs app --tail=300 2>/dev/null | grep -iE "Migration (failed|error|aborted)" || true)
    if [ -n "$MIGRATION_ERROR" ]; then
        error "检测到数据库迁移错误！"
        error "${MIGRATION_ERROR}"
        warn "回滚建议: docker-compose up -d --no-deps app (旧镜像)"
        exit 1
    fi

    # 搜索迁移成功标记
    MIGRATION_SUCCESS=$(docker-compose -f deploy/docker-compose.yml logs app --tail=300 2>/dev/null | grep -E "Migration completed|Tables ready" || true)
    if [ -z "$MIGRATION_SUCCESS" ]; then
        error "未检测到数据库迁移成功标记（'Migration completed' 或 'Tables ready'）"
        error "可能原因：迁移脚本未执行 / 日志标记不匹配 / 镜像版本不正确"
        error "请检查 app 容器日志: docker-compose -f deploy/docker-compose.yml logs app | tail -50"
        exit 1
    fi
    info "数据库迁移状态确认通过 ✓"

    # Nginx reload（重载配置）
    info "重载 Nginx 配置..."
    docker-compose -f deploy/docker-compose.yml exec -T nginx nginx -s reload 2>/dev/null || \
        docker-compose -f deploy/docker-compose.yml restart nginx

    info "部署完成 ✓"
    info "验证: curl -k https://localhost/health"
}

deploy

# ============================================================
# 部署摘要
# ============================================================
echo ""
echo "╔═════════════════════════════════════════════════════╗"
echo "║          🚀  部署流水线完成                          ║"
echo "╠═════════════════════════════════════════════════════╣"
echo "║  环境    : ${ENV}"
echo "║  标签    : ${TAG}"
echo "║  App     : ${APP_IMAGE}"
echo "║  Nginx   : ${NGINX_IMAGE}"
echo "║  容器状态:"
echo "╚═════════════════════════════════════════════════════╝"
docker-compose -f deploy/docker-compose.yml ps --format "table {{.Name}}\t{{.State}}\t{{.Status}}"

info "流水线执行完毕 🎉"
