# 长夜🚀 项目记忆 — 投票应用 v3

## 本轮关键产出

**时间**：2026-06-03 01:37 CST  
**阶段**：一·Kick-off  
**产出**：Kick-off 对齐发言

### Kick-off 要点

#### 基础设施评估
- v3 增量迭代，无架构变更，无需新增中间件或调整网络拓扑
- 现有 Docker Compose（Nginx + Node + PG 15 + Redis 7）保持不动
- 唯一变化：新增删除 API 可能引入新的 DB migration，需关注

#### 风险识别
1. **数据完整性风险**：删除投票涉及级联操作（投票记录、选项、用户结果），需确认硬删/软删策略，migration 必须附带回滚脚本
2. **回归风险**：前端美化无 infra 影响，但删除 API 需要冒烟测试 + CI 回归，确保 Docker 构建不因新依赖失败

#### 角色边界
- ✅ 我该做：CI/CD 维护 / 环境管理 / 部署 & 回滚 / 评审部署方案 / 运维回溯
- ❌ 我不该做：前端 UI 决策 / 业务逻辑 / 数据保留策略 / 生产环境随意操作

#### 对团队的要求
- 栖梧：架构设计明确删除的 DB 方案，附回滚 migration
- 凌霜：新依赖提前通知更新 Dockerfile
- 寻错：staging 上覆盖删除+回滚的端到端用例

### 架构复审结果（2026-06-03 08:46 CST）

| 阶段 | 结论 | 说明 |
|------|------|------|
| 阶段三·架构复审 | **通过** | 栖梧已修订，3 条阻断项全部回应。Staging 资源写死 2vCPU/4GiB（已修复）。CI/CD 为老板决策+人工验收 checklist 替代，不做阻断。生产 docker-compose 已确认。

#### 复审要点
- ✅ Staging 资源「最低 2 vCPU / 4 GiB Mem」已写死
- ✅ /api/health 端点 + Docker healthcheck 已补全
- ✅ DELETE 幂等性补全（第 2 次 code:0）
- ✅ WS 房间清理 + sticky session 标注
- ✅ 生产 docker-compose + 回滚方案 3 条完备
- ⚠️ CI/CD 按老板决策不做修复，人工验收 checklist 替代

### 后续待跟进
- 等待 EeiMoo 分发环境准备任务包（架构方案注明无环境变更，只需执行 DB migration）
