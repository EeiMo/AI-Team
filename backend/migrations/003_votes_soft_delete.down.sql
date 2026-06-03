-- ============================================================
-- migrations/003_votes_soft_delete.down.sql (DOWN / 回滚)
-- 职责：撤销 003_votes_soft_delete.sql 的所有变更
-- ============================================================

-- 1. 删除 audit_logs 表
DROP TABLE IF EXISTS audit_logs;

-- 2. 删除 votes 表新增字段
ALTER TABLE votes
  DROP COLUMN IF EXISTS del_flag,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS deleted_by;

-- 3. 删除索引（DROP COLUMN 自动移除，但有命名索引时显式删除更稳妥）
DROP INDEX IF EXISTS idx_votes_del_flag;
