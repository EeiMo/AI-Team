# 后端自测报告

> 项目：投票应用 v3
> 测试日期：2026-06-03
> 测试环境：Node.js + TypeScript + Jest (ts-jest) + PostgreSQL 15 + Redis 7

---

## 执行摘要

- **测试套件总数**: 5
- **测试用例总数**: 66
- **通过**: 66
- **失败**: 0
- **通过率**: 100%

所有已有测试回归通过 + 新增的 DELETE 相关 10 个用例全部通过。

---

## 测试覆盖范围

### 1. 创建投票 (IT-CV-01 ~ IT-CV-13)
| ID | 描述 | 结果 |
|----|------|------|
| IT-CV-01 | 正常创建单选实名投票 | ✅ |
| IT-CV-02 | 正常创建多选匿名投票 | ✅ |
| IT-CV-03 | 最少 2 个选项 | ✅ |
| IT-CV-04 | 最多 10 个选项 | ✅ |
| IT-CV-05 | 标题 100 字符 | ✅ |
| IT-CV-06 | 截止 1 分钟 | ✅ |
| IT-CV-07 | title 为空 → 400 | ✅ |
| IT-CV-08 | 选项重复 → 400 | ✅ |
| IT-CV-09 | 选项有空字符串 → 400 | ✅ |
| IT-CV-11 | 未认证 → 401 | ✅ |
| IT-CV-12 | deadline_minutes=10080 | ✅ |
| IT-CV-13 | deadline_minutes=10081 → 400 | ✅ |

### 2. 投票列表 (IT-VL-01 ~ IT-VL-08)
| ID | 描述 | 结果 |
|----|------|------|
| IT-VL-01 | 列表显示本团队进行中投票 | ✅ |
| IT-VL-02 | 无已结束投票时返回空列表 | ✅ |
| IT-VL-03 | 分页参数生效 | ✅ |
| IT-VL-08 | 跨团队不可见 | ✅ |

### 3. 投票详情 (IT-VD-01 ~ IT-VD-12)
| ID | 描述 | 结果 |
|----|------|------|
| IT-VD-01 | 匿名模式 voters 为空 | ✅ |
| IT-VD-02 | 实名模式返回 voters | ✅ |
| IT-VD-03 | 无人投票时 count=0 | ✅ |
| IT-VD-08 | has_voted=true | ✅ |
| IT-VD-09 | has_voted=false | ✅ |
| IT-VD-12 | 不存在的投票 → 404 | ✅ |

### 4. 提交投票 (IT-SV-01 ~ IT-SV-08)
| ID | 描述 | 结果 |
|----|------|------|
| IT-SV-01 | 正常单选提交 | ✅ |
| IT-SV-02 | 正常多选提交 | ✅ |
| IT-SV-05 | option_ids 为空 → 400 | ✅ |
| IT-SV-06 | 重复投票 → 409 | ✅ |
| IT-SV-07 | 已结束投票 → 403 | ✅ |
| IT-SV-08 | option_id 不属于本投票 → 400 | ✅ |

### 5. 结束投票 (IT-CL-01 ~ IT-CL-05)
| ID | 描述 | 结果 |
|----|------|------|
| IT-CL-01 | 发起者手动结束 | ✅ |
| IT-CL-02 | 非发起者 → 403 | ✅ |
| IT-CL-04 | 已结束投票 → 409 | ✅ |
| IT-CL-05 | 不存在的投票 → 404 | ✅ |

### 6. 删除投票 — 新增 ⭐
| ID / 描述 | 描述 | 结果 |
|-----------|------|------|
| AC-301-1 | 创建者删除 active 投票 → 200 | ✅ |
| AC-301-2 | 创建者删除 closed 投票 → 200 | ✅ |
| AC-301-7 | 幂等：已删除再次删除 → code:0 | ✅ |
| AC-301-6 | 非创建者删除 → 403 | ✅ |
| AC-301-8 | 跨团队删除 → 403 | ✅ |
| — | 不存在的投票 → 404 | ✅ |
| AC-301-5 | 列表页默认不显示已删除投票 | ✅ |
| — | 已删除投票详情页可访问，返回 deleted: true | ✅ |
| — | 已删除投票不可投票 → 403 | ✅ |
| — | 审计日志记录 DELETE_VOTE | ✅ |

### 7. 其他
| 测试 | 结果 |
|------|------|
| 速率限制（5 个用例） | ✅ |
| 认证中间件（4 个用例） | ✅ |
| 健康检查（2 个用例） | ✅ |
| Config 模块（13 个用例） | ✅ |

---

## 新增功能验证清单

### ✅ 数据库迁移（003_votes_soft_delete）
- [x] votes.del_flag 列（BOOLEAN NOT NULL DEFAULT FALSE）
- [x] votes.deleted_at / deleted_by 列
- [x] idx_votes_del_flag 索引
- [x] audit_logs 表 + 索引
- [x] 回滚迁移文件（003_votes_soft_delete.down.sql）
- [x] SQLite 兼容 DDL（测试回退）

### ✅ DELETE API
- [x] `DELETE /api/votes/:id` 路由
- [x] 鉴权：creator_id + team_id 双重校验
- [x] 幂等：已删除投票第二次请求返回 code:0
- [x] 软删除：UPDATE del_flag = TRUE
- [x] 已结束投票也可删除

### ✅ GET /api/votes 过滤
- [x] 列表页默认过滤 del_flag = FALSE
- [x] 已删除投票不在列表中

### ✅ GET /api/votes/:id 新增字段
- [x] 返回 `deleted: boolean`

### ✅ WS 事件
- [x] 新增 `vote:{id}:deleted` 事件
- [x] 服务端删除后执行 room socketsLeave

### ✅ /api/health 端点
- [x] 返回 status/uptime/checks(postgres, redis)
- [x] 两个服务均正常时 status=ok

### ✅ 审计日志
- [x] 删除操作写入 audit_logs：action=DELETE_VOTE
- [x] detail 包含 vote_title / vote_status

### ✅ 类型安全
- [x] TypeScript 编译通过（tsc --noEmit 无错误）
- [x] VoteRow 新增 del_flag / deleted_at / deleted_by 字段
- [x] AuditLogRow 接口定义
- [x] WsVoteDeletedPayload 接口定义
- [x] ServerToClientEvents 新增 deleted 事件

---

## 已知问题 / 待办

- Redis 清理和审计日志当前采用异步非关键路径（best-effort），极端情况下可能遗漏
- WS 房间清理（socketsLeave）当前在服务端广播后异步执行，可能存在短暂竞态
- 测试环境使用 PostgreSQL 15，SQLite 回退模式下的 del_flag 测试仅在 PG 上验证

---

*报告版本: v1.0 | 生成时间: 2026-06-03 08:47 GMT+8*
