# 安全初检报告 — 投票应用 v3「创建人删除投票」

> **版本**：v3  
> **审查人**：知微 🛡️  
> **日期**：2026-06-03  
> **审查范围**：v3 删除功能安全初检（API 权限模型、幂等性、审计日志、v2 P0 回归检查、依赖漏洞）  
> **审查方法**：架构文档审查 + 代码静态审查 + npm audit 依赖扫描  
> **关联文档**：ARCH_v3.md（安全设计章节 §9）、PRD_v3.md、SECURITY_REVIEW_v1.2.md

---

## 📋 结论摘要

**初检结论：⚠️ 有条件通过 — 存在 3 个阻断项，需修复后方可进入阶段五（安全渗透测试）**

### 阻断项（≤3 条）

| 编号 | 严重度 | 发现 | 状态 | 责任方 |
|------|--------|------|------|--------|
| **R-001 (CVE-001 回归)** | 🔴 P0 | `verifyFeishuToken()` 在 production 环境仍接受 `dev_` 前缀 token，v2 修复**未落地**，攻击者可绕过飞书 SSO 以任意身份调用 `/api/votes/:id` DELETE 及其他所有受保护 API | ❌ 未修复 | 凌霜 |
| **R-002** | 🔴 P0 | 架构设计 (ARCH_v3 §9.1.2) 缺失删除操作**对投票 status 的前置校验**——未要求在 DELETE 前检查是否仅允许 `closed` 状态删除，可能导致 active 投票在计票期间被意外销毁 | ⚠️ 设计缺陷 | 栖梧 / 凌霜 |
| **R-003** | 🔴 P0 | `audit_logs` 表 `user_id` / `team_id` 列类型为 `VARCHAR(64)` 而非 `UUID`，与 ARCH_v3 DDL (`UUID NOT NULL`) **不一致**，需文档同步或实现修正 | ⚠️ 设计漂移 | 凌霜 |

---

## 一、API 权限模型校验（ARCH_v3 §9.1.2）

### 1.1 鉴权设计合理性

| 检查项 | 状态 | 分析 |
|--------|------|------|
| `creator_id == req.user.user_id` 校验 | ✅ 设计合理 | 资源级权限，确保只有创建者可删除自己的投票 |
| `team_id == req.user.team_id` 校验 | ✅ 设计合理 | 防止跨团队越权：用户 A（team Alpha）无法删除用户 B（team Beta）的投票 |
| JWT 认证前置 | ✅ 合理 | 所有受保护 API 均需有效 Bearer JWT，DELETE 不例外 |
| 前端隐藏不替代后端鉴权 | ✅ 正确 | ARCH_v3 §4.2 确认后端独立执行校验，前端仅展示 UI 入口 |
| **FOR UPDATE / 事务保护缺失** | ⚠️ 缺失 | `closeVote` 使用 `select().forUpdate()` 的事务 + 行锁保护并发场景，但 DELETE API 架构中未提及事务 + FOR UPDATE。**建议**：删除操作应使用事务（PG UPDATE + audit INSERT），并在 SELECT vote 时使用 `FOR UPDATE` 防止并发竞态 |

### 1.2 🔴 R-002：删除操作状态校验缺失

| 检查项 | 当前设计 | 问题 |
|--------|----------|------|
| 删除前校验 `vote.status` | ❌ 缺失 | ARCH_v3 §4.2 鉴权流程仅校验 `creator_id + team_id + del_flag`，**未提及对 `vote.status` 的检查** |
| 删除允许的 status | 未决策 | Kick-off 建议仅允许 `closed` 状态删除（知微提议），但 PRD / ARCH 均**未明确**。若允许删除 active 投票，计票期间被销毁将导致：已投票用户参与记录失效、WS 实时计票中断、参与者困惑 |

**建议的 DELETE 鉴权流程（按优先级）**：
```
1. JWT 解析 → req.user
2. SELECT vote (FOR UPDATE) → 校验 vote 存在
3. vote.del_flag === TRUE → 幂等返回 code:0（零副作用）
4. vote.status NOT IN (可删除状态集) → 403（需明确状态白名单）
5. vote.creator_id !== req.user.user_id → 40303
6. vote.team_id !== req.user.team_id → 40304
7. 执行软删除
```

### 1.3 错误码完整性

| 错误码 | 含义 | 设计状态 | 评注 |
|--------|------|----------|------|
| 40303 | 仅创建者可删除 | ✅ | 合理 |
| 40304 | 无权删除此投票（跨团队） | ✅ | 合理 |
| 40401 | 投票不存在（ID 从未创建） | ✅ | 合理 |
| 40305 | 投票已被删除（禁止继续投票） | ✅ | 已有定义，用于 POST /vote |
| **缺失** | 投票状态不允许删除 | ❌ | 对应 R-002，需补充新错误码（如 40306） |

---

## 二、删除 API 幂等性安全分析

### 2.1 幂等性设计评估

| 检查项 | 设计 | 状态 | 分析 |
|--------|------|------|------|
| 已删除投票再次 DELETE | 返回 `200 { code: 0, message: '投票已删除' }` | ✅ 正确 | 幂等成功响应，符合 REST 幂等性原则 |
| 不存在 ID 的 DELETE | 返回 `404 { code: 40401, message: '投票不存在' }` | ✅ 正确 | 非幂等，但符合语义 |
| 幂等校验检查 `del_flag` | 第 4 步校验 `vote.del_flag === TRUE → 幂等返回` | ✅ 正确 | 使用 del_flag 做幂等检查，无需额外幂等键 |
| 幂等场景下零副作用 | 跳过 PG UPDATE、Redis DEL、WS emit、audit INSERT | ✅ 应为零副作用 | 需确认实现中幂等分支不执行任何写操作 |

### 2.2 并发安全分析

**无事务保护时的并发竞态**：
```
t1: req-1 SELECT votes WHERE id=X → del_flag=FALSE
t2: req-2 SELECT votes WHERE id=X → del_flag=FALSE  ← 同时通过！
t3: req-1 UPDATE votes SET del_flag=TRUE
t4: req-2 UPDATE votes SET del_flag=TRUE  ← 无用但无害
t5: req-1 INSERT audit_logs → 1 条审计
t6: req-2 INSERT audit_logs → 2 条审计 ← 重复记录！
t7: req-1 WS emit(deleted)
t8: req-2 WS emit(deleted) ← 重复广播！
```

**影响**：
1. 审计日志重复写入（破坏审计完整性）
2. WS 重复广播（前端收到两次 `deleted` 事件，闪烁）
3. Redis DEL 重复（无害，浪费一次往返）

**解决方案**：
- 使用事务 + `FOR UPDATE` 行锁（同 `closeVote` 方案）
- `INSERT INTO audit_logs` 与 `UPDATE votes` 在同一事务
- WS emit 和 Redis DEL 在事务提交后执行

---

## 三、审计日志记录完整性校验

### 3.1 audit_logs 表设计校验

| 检查项 | ARCH_v3 DDL | 实际迁移脚本 (003_v3_delete_audit.sql) | 状态 |
|--------|------------|--------------------------------------|------|
| action | `VARCHAR(50)` | ✅ `VARCHAR(50)` | 一致 |
| entity_type | `VARCHAR(50)` | ✅ `VARCHAR(50)` | 一致 |
| entity_id | `UUID NOT NULL` | ✅ `UUID NOT NULL` | 一致 |
| user_id | `UUID NOT NULL FK → users(id)` | ⚠️ `VARCHAR(64) NOT NULL` — 注释为"飞书 user_id 原始值（如 ou_xxx）" | 🔴 R-003 |
| team_id | `UUID NOT NULL` | ⚠️ `VARCHAR(64) NOT NULL` — 注释为"飞书 tenant_key" | 🔴 R-003 |
| ip | `VARCHAR(45) NOT NULL` | ✅ `VARCHAR(45) NOT NULL DEFAULT ''` | 一致 |
| user_agent | `TEXT NOT NULL` | ✅ `TEXT NOT NULL DEFAULT ''` | 一致 |
| detail | `JSONB NULL` | ✅ `JSONB` | 一致 |
| created_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | ✅ | 一致 |
| **缺少：删除前投票 status** | — | ❌ 未包含 | 建议新增，便于审计回溯 |
| **缺少：投票标题 (title)** | — | ❌ 未包含 | 建议新增，避免 JOIN 查询 |

### 3.2 🔴 R-003：类型不一致分析

| 影响 | 说明 |
|------|------|
| `users` 表 `id` 列为 UUID | `audit_logs.user_id` 存 `ou_xxx` 字符串，无法直接 JOIN，审计查询需额外映射 |
| ARCH_v3 声明为 UUID | 架构文档与实际迁移脚本不一致，导致后续维护困惑 |

**建议**：
- 若有意存储飞书原始 `user_id`（`ou_xxx`），需同步更新 ARCH_v3 DDL 定义，并增加 `users.id UUID ↔ 飞书 user_id` 映射说明
- 或者统一为 UUID 外键关系，在 `audit_logs` 中存储 `users.id`

### 3.3 审计日志写入时机

| 项 | 设计 | 安全意义 |
|----|------|----------|
| UPDATE → INSERT 在同一事务 | ✅ | 若 audit INSERT 失败，UPDATE 应回滚，保持原子性 |
| 先 UPDATE 后 INSERT | ✅ | 避免 audit 先写入后 UPDATE 失败，造成虚假审计记录 |

**需确认**：deleteService 实现中是否使用 Knex 事务包裹 `UPDATE` + `INSERT audit_logs`。

---

## 四、v2 P0 漏洞修复不可被回退检查

### 4.1 🔴 R-001：CVE-001 Dev Token Production Bypass 回归

**发现时间**：SECURITY_REVIEW_v1.2 §1.6 SSO-20  
**当前代码行**：`middleware/auth.ts:24-30`

```typescript
// verifyFeishuToken() 第 1 步 —— 无 NODE_ENV 守卫
if (token.startsWith(DEV_TOKEN_PREFIX)) {   // ← 生产环境同样生效
  const parts = token.slice(DEV_TOKEN_PREFIX.length).split('_');
  return {
    user_id: parts[0] || 'ou_dev_user_001',
    team_id: parts[1] || 'dev_team_001',
    display_name: parts[2] || '开发用户',
  };
}
```

**攻击向量**（仍有效）：
```bash
# 攻击者构造任意 dev_ 前缀 token，在生产环境绕过飞书 SSO
curl -H "Authorization: Bearer dev_ou_eviluser_teamX_冒充者" \
     https://prod.example.com/api/votes

# 利用 v3 DELETE 以受害者身份删除投票
curl -X DELETE \
     -H "Authorization: Bearer dev_ou_victim_victimTeam_Admin" \
     https://prod.example.com/api/votes/<victim-vote-id>
```

**修复要求**：在 `verifyFeishuToken()` 开头添加：
```typescript
if (config.NODE_ENV === 'production' && token.startsWith(DEV_TOKEN_PREFIX)) {
  throw new Error('Production environment rejects dev tokens');
}
```

### 4.2 v1.2 其他修复回归检查

| 编号 | v1.2 发现 | 当前代码状态 | 风险 |
|------|-----------|-------------|------|
| SSO-19 | dev/login 路由 NODE_ENV 检查 | ✅ 仍存在 | 未回归，但已被 R-001 bypass |
| SSO-21 | JWT token 前缀日志输出 | ⚠️ 维持原状（routes/auth.ts） | 🟡 未修复但非阻断 |
| LOG-04 | voteService.ts:161 userId 日志 | ⚠️ 仍输出原始 userId | 🟡 未修复但非阻断 |
| LOG-05 | voteService.ts:356 userId 日志 | ⚠️ 仍输出原始 userId | 🟡 未修复但非阻断 |
| LOG-06 | ws/handlers.ts:50-62 userId 日志 | ⚠️ 仍输出原始 userId | 🟡 未修复但非阻断 |

---

## 五、依赖漏洞扫描

### 5.1 后端依赖

| 扫描源 | 漏洞 | 严重度 | 影响 | 修复建议 |
|--------|------|--------|------|----------|
| `uuid` < 11.1.1 | GHSA-w5hq-g745-h8pq — Missing buffer bounds check in v3/v5/v6 when buf is provided | 🟡 Moderate | 后端 `uuid` v10.0.0 存在 buffer 边界检查缺失，可能造成内存越界 | `npm install uuid@11.1.1`（安全升级，无 breaking change 到大版本 11） |

### 5.2 前端依赖

| 扫描源 | 漏洞 | 严重度 | 影响 | 修复建议 |
|--------|------|--------|------|----------|
| `esbuild` <= 0.24.2 | GHSA-67mh-4wv8-2f99 — esbuild enables any website to send any requests to the dev server and read the response | 🟡 Moderate | 开发服务器 CSRF 攻击，仅影响开发环境（`vite dev` 或 `npm run dev`） | `npm install vite@latest`，这会拉取含修复的 esbuild 版本 |

### 5.3 扫描总览

| 维度 | 结果 |
|------|------|
| 后端 moderate 漏洞 | 1 个（`uuid`，可修复） |
| 前端 moderate 漏洞 | 2 个（`esbuild/vite`，开发环境影响，可修复） |
| 高/严重度漏洞 | 0 个 |
| CI/CD npm audit 门禁 | ❌ 缺失（老板决策本轮不修复 CI/CD），依赖漏洞依赖人工检查 |

---

## 六、v3 实现安全要求清单（给凌霜）

以下清单供凌霜实现 `deleteService.ts` / `auditService.ts` 时参照：

### 6.1 deleteService.ts 实现要求

- [ ] `DELETE /api/votes/:id` 完整签名校验（§1.2 流程）
- [ ] 事务 + FOR UPDATE 保护（§2.2）
- [ ] 幂等：del_flag=TRUE → 零副作用返回 code:0
- [ ] PG UPDATE votes SET del_flag, deleted_at, deleted_by
- [ ] INSERT INTO audit_logs（与 UPDATE 同事务）
- [ ] Redis DEL vote:{id}:tally（失败不阻塞，仅 console.error）
- [ ] Redis DEL vote:{id}:deadline（失败不阻塞，仅 console.error）
- [ ] WS emit `vote:{id}:deleted`（失败不阻塞，仅 console.warn）
- [ ] `io.in(vote:{id}).socketsLeave(vote:{id})`（房间清理）

### 6.2 auditService.ts 实现要求

- [ ] `log(action, entity_type, entity_id, user_id, team_id, ip, user_agent, detail?)`
- [ ] 写入 `audit_logs` 表
- [ ] action 命名规范：`delete_vote`, `close_vote`（统一全小写）
- [ ] detail JSONB 包含：被删投票 status（如 `{"vote_status":"closed"}`）
- [ ] 不记录匿名投票的投票人信息（脱敏原则）

### 6.3 GET /api/votes 变更要求

- [ ] 默认 WHERE 追加 `AND del_flag = FALSE`
- [ ] 可选参数 `?include_deleted=true`（审计用途，不暴露给前端）

### 6.4 POST /api/votes/:id/vote 变更要求

- [ ] 前置校验 `del_flag=TRUE` → 返回 40305

### 6.5 POST /api/votes/:id/close 变更要求

- [ ] 前置校验 `del_flag=TRUE` → 返回 404

---

## 七、依赖修复清单

| 包 | 当前版本 | 修复版本 | 命令 | 影响范围 |
|---|---------|---------|------|---------|
| `uuid` (backend) | 10.0.0 | >= 11.1.1 | `npm install uuid@11.1.1` | 仅后端，无 breaking change（v10→v11 API 兼容） |
| `vite` (frontend) | 6.x | 最新 | `npm install vite@latest` | 仅前端开发依赖，生产镜像不包含 |

---

## 八、安全初检总评分

| 维度 | 评级 | 说明 |
|------|------|------|
| API 权限模型 | ⚠️ 有条件通过 | R-002（status 校验缺失）+ FOR UPDATE 缺失需修复 |
| 幂等性设计 | ✅ 设计合理 | 幂等策略正确，但需通过 FOR UPDATE 防护并发场景 |
| 审计日志 | ⚠️ 有条件通过 | R-003（类型不一致）+ 建议补充 status/title 字段 |
| v2 P0 回归 | ❌ 未通过 | R-001（CVE-001 生产环境 dev token bypass 未修复） |
| 依赖漏洞 | 🟡 中风险 | 3 个 moderate 漏洞，可修复 |

---

*知微 🛡️ · 2026-06-03 · 安全初检 v3*
