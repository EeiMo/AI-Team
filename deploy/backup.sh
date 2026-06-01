#!/usr/bin/env bash
# ============================================================
# 团队即时投票工具 — PostgreSQL 每日备份脚本
# 方案：pg_dump + gzip + 7天保留 + 快速恢复 SOP
# 设计人：长夜 | 日期：2026-06-01
# ============================================================
#
# 用法：
#   # 手动执行一次备份
#   sudo ./backup.sh
#
#   # 安装 cron 定时任务（每天凌晨 3:00 执行）
#   sudo ./backup.sh --install-cron
#
#   # 列出已有备份
#   ./backup.sh --list
#
#   # 恢复最近一次备份
#   ./backup.sh --restore
# ============================================================

set -euo pipefail

# ─── 配置（按需修改）───────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/vote-app/backups/pg}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
CONTAINER="${CONTAINER:-vote-pg}"
PG_USER="${PG_USER:-vote_user}"
PG_DB="${PG_DB:-vote_db}"
LOG_FILE="${LOG_FILE:-/var/log/vote-backup.log}"

# ─── 颜色输出 ──────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[BACKUP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[BACKUP]${NC} $*"; }
error() { echo -e "${RED}[BACKUP]${NC} $*"; }

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

# ─── 函数：执行备份 ────────────────────────────
do_backup() {
    mkdir -p "${BACKUP_DIR}"
    local TIMESTAMP
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local BACKUP_FILE="${BACKUP_DIR}/vote_db_${TIMESTAMP}.sql.gz"

    log "开始备份 → ${BACKUP_FILE}"

    # 检查容器是否运行
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        error "容器 ${CONTAINER} 未运行，备份失败"
        exit 1
    fi

    # 通过 docker exec 执行 pg_dump（无需暴露 PG 端口到宿主机）
    # --no-owner:       忽略 ownership（恢复时可能用不同用户）
    # --no-acl:         忽略权限 grant/revoke
    # --clean:          生成 DROP 语句（恢复时先清再建）
    # --if-exists:      DROP 配合 IF EXISTS（避免恢复报错）
    docker exec "${CONTAINER}" \
        pg_dump -U "${PG_USER}" -d "${PG_DB}" \
        --no-owner --no-acl --clean --if-exists \
        | gzip > "${BACKUP_FILE}"

    local FILE_SIZE
    FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
    log "备份完成: vote_db_${TIMESTAMP}.sql.gz (${FILE_SIZE})"

    # 清理过期备份（保留最近 RETENTION_DAYS 天）
    local DELETED
    DELETED=$(find "${BACKUP_DIR}" -name "vote_db_*.sql.gz" -mtime +"${RETENTION_DAYS}" -print -delete | wc -l)
    if [ "${DELETED}" -gt 0 ]; then
        log "清理过期备份: ${DELETED} 份"
    fi
}

# ─── 函数：列出备份 ────────────────────────────
list_backups() {
    echo "=========================================="
    echo "  备份列表 (${BACKUP_DIR})"
    echo "=========================================="
    if [ -d "${BACKUP_DIR}" ] && [ "$(ls -1 "${BACKUP_DIR}"/vote_db_*.sql.gz 2>/dev/null | wc -l)" -gt 0 ]; then
        ls -1lh "${BACKUP_DIR}"/vote_db_*.sql.gz 2>/dev/null | awk '{print "  "$6, $7, $8"\t"$5"\t"$NF}'
    else
        echo "  (无备份文件)"
    fi
    echo ""
}

# ─── 函数：恢复备份 ────────────────────────────
do_restore() {
    local RESTORE_FILE="${1:-}"

    # 未指定文件 → 使用最近一次备份
    if [ -z "${RESTORE_FILE}" ]; then
        RESTORE_FILE=$(ls -1t "${BACKUP_DIR}"/vote_db_*.sql.gz 2>/dev/null | head -1)
        if [ -z "${RESTORE_FILE}" ]; then
            error "未找到备份文件"
            exit 1
        fi
        info "自动选择最近备份: $(basename "${RESTORE_FILE}")"
    fi

    if [ ! -f "${RESTORE_FILE}" ]; then
        error "备份文件不存在: ${RESTORE_FILE}"
        exit 1
    fi

    echo ""
    warn "⚠️  即将执行恢复操作，这会覆盖当前数据库！"
    warn "   备份文件: ${RESTORE_FILE}"
    warn "   目标容器: ${CONTAINER}"
    echo ""
    read -r -p "确认恢复？输入 YES 继续: " confirm
    if [ "${confirm}" != "YES" ]; then
        info "已取消"
        exit 0
    fi

    # 恢复 SOP（见下方注释）
    log "━━━━━━ 开始数据库恢复 ━━━━━━"
    log "备份文件: ${RESTORE_FILE}"

    # 1. 停止应用（防止恢复期间写入冲突）
    info "Step 1/3: 停止 app 容器..."
    docker-compose stop app 2>/dev/null || \
        docker stop vote-app 2>/dev/null || \
        warn "app 容器可能未运行，继续..."

    # 2. 执行恢复
    info "Step 2/3: 恢复数据库..."
    gunzip -c "${RESTORE_FILE}" | docker exec -i "${CONTAINER}" \
        psql -U "${PG_USER}" -d "${PG_DB}"

    if [ $? -eq 0 ]; then
        log "数据库恢复成功 ✓"
    else
        error "数据库恢复失败！检查日志"
        exit 1
    fi

    # 3. 重建 Redis 缓存
    info "Step 3/3: 启动 app（TallySync 自动重建 Redis 缓存）..."
    docker-compose start app 2>/dev/null || \
        docker start vote-app 2>/dev/null

    log "━━━━━━ 恢复完成 ━━━━━━"
    info "app 启动后 TallySync 将从 PG 全量重建 Redis tally 缓存"
}

# ─── 函数：安装 cron 定时任务 ──────────────────
install_cron() {
    local SCRIPT_PATH
    SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
    local CRON_FILE="/etc/cron.d/vote-pg-backup"

    cat > "/tmp/vote-pg-backup-cron" << CRONEOF
# vote-pg-backup: 每天凌晨 3:00 备份 PostgreSQL
# 日志输出到 /var/log/vote-backup.log
0 3 * * * root ${SCRIPT_PATH} >> /var/log/vote-backup.log 2>&1
CRONEOF

    if [ "$(id -u)" -eq 0 ]; then
        mv "/tmp/vote-pg-backup-cron" "${CRON_FILE}"
        chmod 644 "${CRON_FILE}"
        info "Cron 已安装: ${CRON_FILE}"
        info "备份时间: 每天 03:00"
        info "备份目录: ${BACKUP_DIR}"
        info "保留天数: ${RETENTION_DAYS} 天"
        info "日志文件: ${LOG_FILE}"
    else
        echo ""
        warn "需要 root 权限安装 cron。请手动执行："
        echo ""
        echo "  sudo cp /tmp/vote-pg-backup-cron ${CRON_FILE}"
        echo "  sudo chmod 644 ${CRON_FILE}"
        echo ""
        # 输出 crontab 行供手动添加
        echo "或手动添加到 crontab："
        echo "  0 3 * * * ${SCRIPT_PATH} >> /var/log/vote-backup.log 2>&1"
    fi
}

# ─── 主入口 ────────────────────────────────────
case "${1:-}" in
    --list|-l)
        list_backups
        ;;
    --restore|-r)
        do_restore "${2:-}"
        ;;
    --install-cron)
        install_cron
        ;;
    --help|-h)
        echo "用法: $0 [选项]"
        echo ""
        echo "  (无参数)         执行一次备份"
        echo "  --list, -l       列出已有备份"
        echo "  --restore [文件]  恢复备份（不指定则用最近一次）"
        echo "  --install-cron    安装 cron 每日定时备份"
        echo "  --help, -h        显示帮助"
        echo ""
        echo "配置（环境变量）："
        echo "  BACKUP_DIR       备份目录 (默认 /opt/vote-app/backups/pg)"
        echo "  RETENTION_DAYS   保留天数 (默认 7)"
        echo "  CONTAINER        PG 容器名 (默认 vote-pg)"
        echo ""
        echo "━━━━ 恢复 SOP（3 句话）━━━━"
        echo "  1. sudo ./backup.sh --restore     # 停止 app + 解压恢复"
        echo "  2. docker-compose start app       # app 启动后 TallySync 自动重建 Redis"
        echo "  3. curl -k https://localhost/health  # 验证服务正常"
        exit 0
        ;;
    "")
        do_backup
        log "备份流程结束"
        ;;
    *)
        error "未知选项: $1"
        echo "使用 --help 查看帮助"
        exit 1
        ;;
esac
