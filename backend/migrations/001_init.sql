-- ============================================================
-- migrations/001_init.sql
-- 职责：团队即时投票工具 MVP 完整 DDL（PostgreSQL 15）
--      含 UUID v7 函数、votes / options / user_votes 表、索引
-- ============================================================

-- 扩展：pgcrypto（uuid_v7 函数需要 gen_random_bytes 辅助）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- UUID v7 生成函数（时间有序，利于 B-tree 索引）
-- ============================================================
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE
  v_time timestamp with time zone := clock_timestamp();
  v_secs bigint := floor(extract(epoch from v_time) * 1000);
  v_usec bigint := extract(microseconds from v_time)::bigint % 1000;
  v_rand1 bigint := (floor(random() * 65536))::bigint;
  v_rand2 bigint := (floor(random() * 4294967296))::bigint;
BEGIN
  RETURN encode(set_byte(
      set_byte(
        lpad(to_hex((v_secs * 1000 + v_usec)::bigint), 12, '0')::bytea
        || lpad(to_hex(v_rand1), 4, '0')::bytea
        || lpad(to_hex(v_rand2), 8, '0')::bytea,
        6, (get_byte(decode(lpad(to_hex(v_rand1), 4, '0'), 'hex'), 0) & 15) | 112
      ),
      8, (get_byte(decode(lpad(to_hex(v_rand2), 8, '0'), 'hex'), 0) & 63) | 128
    ), 'hex')::uuid;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 表定义
-- ============================================================

-- 1. votes 表：投票主表
CREATE TABLE votes (
    id            UUID PRIMARY KEY DEFAULT uuid_v7(),
    title         VARCHAR(100) NOT NULL,
    creator_id    VARCHAR(64) NOT NULL,              -- 飞书 user_id（如 ou_abc123def456），非 UUID
    creator_name  VARCHAR(100) NOT NULL,             -- 创建者姓名快照（创建时从 SSO 提取）
    team_id       VARCHAR(64) NOT NULL,              -- 飞书 tenant_key，团队标识
    vote_type     VARCHAR(10) NOT NULL CHECK (vote_type IN ('single', 'multi')),
    vote_mode     VARCHAR(10) NOT NULL CHECK (vote_mode IN ('anonymous', 'public')),
    status        VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    deadline      TIMESTAMPTZ NOT NULL,
    total_voters  INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    closed_by     VARCHAR(10) CHECK (closed_by IN ('manual', 'auto'))
);

COMMENT ON TABLE votes IS '投票主表';
COMMENT ON COLUMN votes.creator_id IS '飞书 user_id 原始值，非 UUID';
COMMENT ON COLUMN votes.creator_name IS '创建者姓名快照，后续改名不影响历史投票';
COMMENT ON COLUMN votes.team_id IS '飞书 tenant_key，用于团队级权限校验';
COMMENT ON COLUMN votes.total_voters IS '创建时刻的团队总人数快照';
COMMENT ON COLUMN votes.closed_by IS 'manual=手动结束, auto=自动到期';

-- 按 team + 状态 + 创建时间查询（列表页高频查询，跨团队部署安全）
CREATE INDEX idx_votes_team_status ON votes (team_id, status, created_at DESC);

-- 启动扫描：查找到期未结束投票
CREATE INDEX idx_votes_active_deadline ON votes (deadline) WHERE status = 'active';


-- 2. options 表：投票选项
CREATE TABLE options (
    id         UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id    UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    content    VARCHAR(50) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_options_vote_id ON options (vote_id, sort_order);


-- 3. user_votes 表：投票记录（防重核心）
CREATE TABLE user_votes (
    id               UUID PRIMARY KEY DEFAULT uuid_v7(),
    vote_id          UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    user_id          VARCHAR(64) NOT NULL,           -- 飞书 user_id (如 ou_xxx)
    selected_options UUID[] NOT NULL,                 -- PostgreSQL 原生数组
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_votes_vote_user UNIQUE (vote_id, user_id)
);

COMMENT ON TABLE user_votes IS '用户投票记录';
COMMENT ON COLUMN user_votes.selected_options IS '用户选中的选项 ID 数组，单选时长度为1';

CREATE INDEX idx_user_votes_vote_id ON user_votes (vote_id);

-- user_votes + options JOIN 可汇总出最终票数（与 Redis 对账用）
-- SELECT o.id, COUNT(uv.id) as cnt
-- FROM options o
-- LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
-- WHERE o.vote_id = $1
-- GROUP BY o.id;
