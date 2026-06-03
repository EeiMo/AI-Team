-- ============================================================
-- migrations/003_v3_delete_audit.sql
-- 职责：v3 创建人删除投票功能 — DB 增量迁移
--       - votes 表新增 del_flag / deleted_at / deleted_by
--       - 新增 audit_logs 表
--       - 新增索引
-- ============================================================

-- ============================================================
-- 1. votes 表变更：软删除支持
-- ============================================================

-- del_flag: BOOLEAN, DEFAULT FALSE, NOT NULL
ALTER TABLE votes ADD COLUMN IF NOT EXISTS del_flag BOOLEAN DEFAULT FALSE NOT NULL;

-- deleted_at: 删除时间戳
ALTER TABLE votes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- deleted_by: 执行删除的用户飞书 user_id
ALTER TABLE votes ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(64);

COMMENT ON COLUMN votes.del_flag IS 'FALSE=未删除, TRUE=已删除';
COMMENT ON COLUMN votes.deleted_at IS '软删除时间戳';
COMMENT ON COLUMN votes.deleted_by IS '执行删除的用户飞书 user_id';

-- 列表查询索引：按 team_id + del_flag 过滤
CREATE INDEX IF NOT EXISTS idx_votes_del_flag ON votes (team_id, del_flag);


-- ============================================================
-- 2. audit_logs 表：操作审计日志
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_v7(),
    action      VARCHAR(50) NOT NULL,          -- 'delete_vote', 'close_vote'
    entity_type VARCHAR(50) NOT NULL,          -- 'vote'
    entity_id   UUID NOT NULL,                 -- 被操作实体 ID
    user_id     VARCHAR(64) NOT NULL,          -- 操作人飞书 user_id
    team_id     VARCHAR(64) NOT NULL,          -- 操作人团队
    ip          VARCHAR(45) NOT NULL DEFAULT '', -- 客户端 IP（支持 IPv6）
    user_agent  TEXT NOT NULL DEFAULT '',       -- User-Agent
    detail      JSONB,                         -- 扩展信息（删除时投票状态等）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_logs IS '操作审计日志表，记录敏感操作（删除、关闭等）';
COMMENT ON COLUMN audit_logs.user_id IS '飞书 user_id 原始值（如 ou_xxx），非 users.id UUID';
COMMENT ON COLUMN audit_logs.team_id IS '飞书 tenant_key';

-- 按操作类型 + 时间查询（审计常用）
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs (action, created_at DESC);

-- 按被操作实体查询
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- 按操作人查询
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id, created_at DESC);

-- 按团队查询
CREATE INDEX IF NOT EXISTS idx_audit_logs_team ON audit_logs (team_id, created_at DESC);
