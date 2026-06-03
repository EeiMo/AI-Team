-- ============================================================
-- migrations/002_users.sql
-- 职责：用户表 — 飞书 SSO 登录自动创建
--       记录用户首次登录及最后登录时间
-- ============================================================

-- 用户表（首次 SSO 登录自动创建记录）
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_v7(),
    user_id       VARCHAR(64) NOT NULL,              -- 飞书 open_id / user_id
    team_id       VARCHAR(64) NOT NULL,              -- 飞书 tenant_key
    display_name  VARCHAR(100) NOT NULL,             -- 用户姓名快照
    avatar_url    VARCHAR(500),                      -- 飞书头像 URL
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS '用户表，首次飞书 SSO 登录时自动创建';
COMMENT ON COLUMN users.user_id IS '飞书 open_id 或 user_id';
COMMENT ON COLUMN users.team_id IS '飞书 tenant_key（团队标识）';
COMMENT ON COLUMN users.display_name IS '登录快照姓名，后续未知晓改名';
COMMENT ON COLUMN users.last_login_at IS '最近一次登录时间';

-- 唯一索引：同一飞书用户不可重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users (user_id);

-- 按团队查询用户列表
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users (team_id);
