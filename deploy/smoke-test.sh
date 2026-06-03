#!/usr/bin/env bash
# ============================================================
# smoke-test.sh — 自动冒烟测试脚本
# 基于 EVO-002 smoke-test-checklist.md
# 版本: evo-v1 | 日期: 2026-06-02
#
# 用法:
#   BASE_URL=https://staging.example.com ./smoke-test.sh
#   SKIP_SSL_VERIFY=true BASE_URL=https://localhost ./smoke-test.sh
#
# 环境变量:
#   BASE_URL        目标服务地址（必填，如 https://localhost）
#   SKIP_SSL_VERIFY 跳过 SSL 验证（默认 false）
#   TIMEOUT         请求超时秒数（默认 10）
#   REPORT_DIR      报告输出目录（默认 docs/test）
# ============================================================

set -euo pipefail

# ── 配置 ──
BASE_URL="${BASE_URL:-http://localhost:3001}"
SKIP_SSL_VERIFY="${SKIP_SSL_VERIFY:-false}"
TIMEOUT="${TIMEOUT:-10}"
REPORT_DIR="${REPORT_DIR:-docs/test}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REPORT_FILE="${REPORT_DIR}/smoke-test-report-$(date -u +%Y%m%d-%H%M%S).txt"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ── 计数器 ──
PASSED=0
FAILED=0
WARNED=0
BLOCKED=0

# ── 初始化 ──
mkdir -p "${REPORT_DIR}"
CURL_OPTS="-s --max-time ${TIMEOUT}"
if [ "${SKIP_SSL_VERIFY}" = "true" ]; then
  CURL_OPTS="${CURL_OPTS} -k"
fi

# ── 日志函数 ──
log_header() {
  echo -e "\n${BLUE}━━━ $1 ━━━${NC}"
  echo "" >> "${REPORT_FILE}"
  echo "━━━ $1 ━━━" >> "${REPORT_FILE}"
}

log_pass() {
  echo -e "  ${GREEN}✓ PASS${NC} $1"
  echo "  ✓ PASS: $1" >> "${REPORT_FILE}"
  PASSED=$((PASSED + 1))
}

log_fail() {
  local level="${1:-阻断}"
  echo -e "  ${RED}✕ FAIL${NC} [${level}] $2"
  echo "  ✕ FAIL [${level}]: $2" >> "${REPORT_FILE}"
  FAILED=$((FAILED + 1))
  if [ "${level}" = "阻断" ]; then
    BLOCKED=$((BLOCKED + 1))
  fi
}

log_warn() {
  echo -e "  ${YELLOW}⚠ WARN${NC} $1"
  echo "  ⚠ WARN: $1" >> "${REPORT_FILE}"
  WARNED=$((WARNED + 1))
}

log_info() {
  echo -e "  ${BLUE}ℹ INFO${NC} $1"
  echo "  ℹ INFO: $1" >> "${REPORT_FILE}"
}

# ── 报告初始化 ──
cat > "${REPORT_FILE}" <<EOF
冒烟测试执行报告
==================
执行时间：${TIMESTAMP}
目标地址：${BASE_URL}
跳过SSL验证：${SKIP_SSL_VERIFY}
------------------------------------------------------------
EOF

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   冒烟测试 — 团队即时投票工具 v1.0  ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo -e "目标: ${BASE_URL}  | 时间: ${TIMESTAMP}"

# ════════════════════════════════════════════
# SMK-03: 投票创建 API
# ════════════════════════════════════════════
log_header "SMK-03: 投票创建 API"

CREATE_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
  -X POST "${BASE_URL}/api/votes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev_ousmoke_testteam001_smoke" \
  -d "{
    \"title\": \"[冒烟] 自动化测试投票\",
    \"vote_type\": \"single\",
    \"vote_mode\": \"public\",
    \"deadline_minutes\": 60,
    \"total_voters\": 24,
    \"options\": [
      \"选项A\",
      \"选项B\"
    ]
  }" 2>&1)

HTTP_CODE=$(echo "${CREATE_RESP}" | tail -1)
RESP_BODY=$(echo "${CREATE_RESP}" | sed '$d')

if [ "${HTTP_CODE}" = "201" ] || [ "${HTTP_CODE}" = "200" ]; then
  # 提取 vote_id
  VOTE_ID=$(echo "${RESP_BODY}" | grep -oP '"id"\s*:\s*"[^"]+"' | head -1 | grep -oP '"[^"]+"$' | tr -d '"')
  OPTION_A_ID=$(echo "${RESP_BODY}" | grep -oP '"id"\s*:\s*"[^"]+"' | sed -n '2p' | grep -oP '"[^"]+"$' | tr -d '"')
  
  if [ -n "${VOTE_ID}" ] && [ -n "${OPTION_A_ID}" ]; then
    log_pass "投票创建成功 | vote_id=${VOTE_ID} | http=${HTTP_CODE}"
  else
    log_fail "阻断" "投票创建返回了 201 但无法提取 vote_id/option_id"
    log_info "响应: ${RESP_BODY}"
  fi
else
  log_fail "阻断" "投票创建失败 | http=${HTTP_CODE}"
  log_info "响应: ${RESP_BODY}"
fi

# ════════════════════════════════════════════
# SMK-04: 投票提交 API
# ════════════════════════════════════════════
log_header "SMK-04: 投票提交 API"

if [ -n "${VOTE_ID:-}" ] && [ -n "${OPTION_A_ID:-}" ]; then
  # 4a: 首次提交
  SUBMIT_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
    -X POST "${BASE_URL}/api/votes/${VOTE_ID}/vote" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer dev_ousmoke_testteam001_smoke" \
    -d "{\"option_ids\": [\"${OPTION_A_ID}\"]}" 2>&1)
  
  SUBMIT_HTTP=$(echo "${SUBMIT_RESP}" | tail -1)
  
  if [ "${SUBMIT_HTTP}" = "200" ]; then
    log_pass "首次提交成功 | http=${SUBMIT_HTTP}"
  else
    log_fail "阻断" "首次提交失败 | http=${SUBMIT_HTTP}"
    log_info "响应: $(echo "${SUBMIT_RESP}" | sed '$d')"
  fi

  # 4b: 重复提交（防重）
  DUP_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
    -X POST "${BASE_URL}/api/votes/${VOTE_ID}/vote" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer dev_ousmoke_testteam001_smoke" \
    -d "{\"option_ids\": [\"${OPTION_A_ID}\"]}" 2>&1)
  
  DUP_HTTP=$(echo "${DUP_RESP}" | tail -1)
  
  if [ "${DUP_HTTP}" = "409" ]; then
    log_pass "防重生效 | http=${DUP_HTTP}"
  elif [ "${DUP_HTTP}" = "200" ]; then
    log_fail "阻断" "防重逻辑未生效！允许了重复提交"
  else
    log_warn "重复提交返回 ${DUP_HTTP}（预期 409）"
  fi
else
  log_fail "阻断" "跳过 SMK-04：无可用的 vote_id"
fi

# ════════════════════════════════════════════
# SMK-05: 投票结果查询 API
# ════════════════════════════════════════════
log_header "SMK-05: 投票结果查询 API"

if [ -n "${VOTE_ID:-}" ]; then
  DETAIL_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
    -X GET "${BASE_URL}/api/votes/${VOTE_ID}" \
    -H "Authorization: Bearer dev_ousmoke_testteam001_smoke" 2>&1)
  
  DETAIL_HTTP=$(echo "${DETAIL_RESP}" | tail -1)
  DETAIL_BODY=$(echo "${DETAIL_RESP}" | sed '$d')
  
  if [ "${DETAIL_HTTP}" = "200" ]; then
    # 检查是否包含 options 字段
    if echo "${DETAIL_BODY}" | grep -q 'options'; then
      log_pass "投票详情查询成功 | http=200 | 含 options 字段"
    else
      log_fail "阻断" "投票详情缺少 options 字段"
    fi
  else
    log_fail "阻断" "投票详情查询失败 | http=${DETAIL_HTTP}"
  fi
else
  log_fail "阻断" "跳过 SMK-05：无可用的 vote_id"
fi

# ════════════════════════════════════════════
# SMK-08: 前端页面可访问性
# ════════════════════════════════════════════
log_header "SMK-08: 前端页面可访问性"

# 测试多个关键页面
for PAGE in "/" "/login" "/votes" "/votes/create"; do
  PAGE_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
    -X GET "${BASE_URL}${PAGE}" -o /tmp/smoke-page.html 2>&1)
  PAGE_HTTP=$(echo "${PAGE_RESP}" | tail -1)
  
  if [ "${PAGE_HTTP}" = "200" ]; then
    # 检查 HTML 基本结构
    if grep -q '<div id="root"' /tmp/smoke-page.html 2>/dev/null; then
      PAGE_SIZE=$(wc -c < /tmp/smoke-page.html)
      if [ "${PAGE_SIZE}" -gt 100 ]; then
        log_pass "页面 ${PAGE} 可访问 | 大小=${PAGE_SIZE}bytes | 含 root 挂载点"
      else
        log_warn "页面 ${PAGE} HTTP 200 但内容过小 (${PAGE_SIZE}bytes)"
      fi
    else
      log_fail "阻断" "页面 ${PAGE} 缺少 <div id='root'> 挂载点"
    fi
  else
    log_fail "阻断" "页面 ${PAGE} 返回 HTTP ${PAGE_HTTP}"
  fi
done

# ════════════════════════════════════════════
# SMK-09: 健康检查端点
# ════════════════════════════════════════════
log_header "SMK-09: 健康检查端点"

HEALTH_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" "${BASE_URL}/health" 2>&1)
HEALTH_HTTP=$(echo "${HEALTH_RESP}" | tail -1)
HEALTH_BODY=$(echo "${HEALTH_RESP}" | sed '$d')

if [ "${HEALTH_HTTP}" = "200" ]; then
  if echo "${HEALTH_BODY}" | grep -q '"status"\s*:\s*"ok"'; then
    log_pass "健康检查通过 | status=ok"
  else
    log_warn "健康检查 HTTP 200 但 status 字段异常"
    log_info "响应: ${HEALTH_BODY}"
  fi
else
  log_fail "告警" "健康检查失败 | http=${HEALTH_HTTP}"
fi

# ════════════════════════════════════════════
# SMK-10: Nginx 反向代理 / CORS
# ════════════════════════════════════════════
log_header "SMK-10: Nginx 反向代理 & CORS"

# 检查 API 代理
API_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
  -H "Origin: https://example.com" \
  -I "${BASE_URL}/api/votes" 2>&1)
API_HTTP=$(echo "${API_RESP}" | tail -1)
API_HEADERS=$(echo "${API_RESP}" | sed '$d')

if [ "${API_HTTP}" = "200" ] || [ "${API_HTTP}" = "401" ] || [ "${API_HTTP}" = "403" ]; then
  log_pass "API 代理可达 | http=${API_HTTP}"
else
  log_fail "阻断" "API 代理不可达 | http=${API_HTTP}"
fi

# 检查 CORS 头
if echo "${API_HEADERS}" | grep -qi 'access-control'; then
  log_pass "CORS 头存在"
else
  log_warn "响应中未检测到 Access-Control-* 头"
fi

# ════════════════════════════════════════════
# SMK-07: 限流中间件基本验证
# ════════════════════════════════════════════
log_header "SMK-07: 限流中间件基本验证"

if [ -n "${VOTE_ID:-}" ]; then
  # 快速连续发送多次请求验证限流存在
  RATE_LIMITED=false
  for i in $(seq 1 5); do
    RL_RESP=$(curl ${CURL_OPTS} -w "\n%{http_code}" \
      -X POST "${BASE_URL}/api/votes/${VOTE_ID}/vote" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer dev_ousmokerate_testteam001_rate" \
      -d "{\"option_ids\": [\"${OPTION_A_ID}\"]}" 2>&1)
    RL_HTTP=$(echo "${RL_RESP}" | tail -1)
    if [ "${RL_HTTP}" = "429" ]; then
      RATE_LIMITED=true
      break
    fi
  done
  
  if [ "${RATE_LIMITED}" = "true" ]; then
    log_pass "限流功能正常触发 | 检测到 429"
  else
    log_warn "连续 5 次请求未触发限流（可能窗口内允许更多请求）"
  fi
else
  log_warn "跳过 SMK-07：无可用的 vote_id"
fi

# ════════════════════════════════════════════
# 汇总报告
# ════════════════════════════════════════════
log_header "汇总报告"

SUMMARY_PASS=true
if [ "${BLOCKED}" -gt 0 ]; then
  SUMMARY_PASS=false
fi

cat >> "${REPORT_FILE}" <<EOF
------------------------------------------------------------
测试结果汇总
------------------------------------------------------------
通过: ${PASSED}  |  失败: ${FAILED}  |  警告: ${WARNED}  |  阻断: ${BLOCKED}
------------------------------------------------------------
EOF

echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "通过: ${GREEN}${PASSED}${NC} | 失败: ${RED}${FAILED}${NC} | 警告: ${YELLOW}${WARNED}${NC} | 阻断: ${RED}${BLOCKED}${NC}"
echo ""

if [ "${SUMMARY_PASS}" = "true" ]; then
  echo -e "${GREEN}✅ 冒烟测试通过${NC} — 阻断项 0 个"
  echo "✅ 冒烟测试通过 — 阻断项 0 个" >> "${REPORT_FILE}"
else
  echo -e "${RED}❌ 冒烟测试未通过${NC} — 阻断项 ${BLOCKED} 个，须修复后重新执行"
  echo "❌ 冒烟测试未通过 — 阻断项 ${BLOCKED} 个" >> "${REPORT_FILE}"
fi

echo ""
echo -e "报告: ${REPORT_FILE}"
echo ""

# 返回码：有阻断项 → 非0
if [ "${BLOCKED}" -gt 0 ]; then
  exit 1
fi
exit 0
