-- ============================================================
-- migrations/003_votes_soft_delete.sql (UP)
-- 职责：软删除迁移
--       1. votes 表新增 del_flag/deleted_at/deleted_by 字段
--       2. 新增 audit_logs 表
--       3. 现有数据 del_flag 默认 FALSE
-- ============================================================

-- 1. votes 表新增字段
ALTER TABLE votes
  ADD COLUMN IF NOT EXISTS del_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(64);

COMMENT ON COLUMN votes.del_flag IS '软删除标记: FALSE=未删除, TRUE=已删除';
COMMENT ON COLUMN votes.deleted_at IS '删除时间戳';
COMMENT ON COLUMN votes.deleted_by IS '执行删除操作的用户 ID（飞书 user_id）';

-- 索引：过滤已删除投票
CREATE INDEX IF NOT EXISTS idx_votes_del_flag ON votes (del_flag);

-- 2. 新增 audit_logs 表
CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_v7(),
    action      VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id   UUID NOT NULL,
    user_id     VARCHAR(64) NOT NULL,
    team_id     VARCHAR(64) NOT NULL,
    ip          VARCHAR(45),
    user_agent  TEXT,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_logs IS '审计日志表';
COMMENT ON COLUMN audit_logs.action IS '操作类型，如 DELETE_VOTE';
COMMENT ON COLUMN audit_logs.entity_type IS '操作对象类型，如 vote';
COMMENT ON COLUMN audit_logs.entity_id IS '操作对象 ID';
COMMENT ON COLUMN audit_logs.user_id IS '操作人用户 ID';
COMMENT ON COLUMN audit_logs.team_id IS '操作人所在团队 ID';
COMMENT ON COLUMN audit_logs.detail IS '额外信息 JSON，如 {vote_title, vote_status}';

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
