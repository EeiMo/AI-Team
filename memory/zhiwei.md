# 知微🛡️ 项目记忆 — 投票应用 v3

## 项目背景
投票应用 (vote-app)，v3 迭代方向：
1. 增加创建人删除投票功能（设计为软删除）
2. 优化前端美化

## 安全初检完成（2026-06-03）— security_review_v3.md
### 初检结论：⚠️ 有条件通过
**产出**：`docs/security/security_review_v3.md`

### 3 个阻断项
| 编号 | 严重度 | 发现 | 责任方 |
|------|--------|------|--------|
| **R-001** | 🔴 P0 | CVE-001 回归：`verifyFeishuToken()` production 环境仍接受 `dev_` token，v2 修复未落地 | 凌霜 |
| **R-002** | 🔴 P0 | DELETE 操作缺失 `vote.status` 前置校验（active 投票能否删待决策） | 栖梧/凌霜 |
| **R-003** | 🔴 P0 | `audit_logs` DDL 中 `user_id`/`team_id` 类型为 VARCHAR(64) 而非 ARCH_v3 声明的 UUID | 凌霜 |

### 关键发现（非阻断）
- DELETE 缺少 FOR UPDATE 事务锁（并发场景下审计日志重复写入）
- `uuid` backend（moderate）、`esbuild/vite` frontend（2 moderate）需升级
- v1.2遗留 LOG-04~07 userId 日志脱敏仍未修复（非 P0，标记中风险）

### 当前状态
- **阶段五·渗透测试完成**（2026-06-03）— 产出 docs/security/penetration_test_v3.md
- v3 删除功能代码在**工作树**中实现（未提交），main 分支仍处于 revert 状态
- R-001（dev_ token 漏洞）已验证 — ✅ 已修复（auth.ts 重写，dev_token 分支完全移除）
- R-002（DELETE 缺少 status 前置校验）已验证 — ✅ 已修复（ballotService.ts/voteService.ts 增加 del_flag 检查）
- R-003（audit_logs user_id/team_id 类型）— ❌ 未修复
- **新发现 P1 PEN-001**：审计日志写入失败 silent catch，无告警
- **新发现 P2 PEN-002**：已删投票幂等绕过鉴权 → 信息泄露

### 协作提醒
- 工作树变更需要一次性 commit（注意：前一个 commit 是 revert）
- 待修复项目：R-003（ARCH_v3 文档 vs 实现不一致）
- 待优化：审计日志告警机制、幂等鉴权顺序
