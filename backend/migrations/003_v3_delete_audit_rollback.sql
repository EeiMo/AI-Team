-- ============================================================
-- migrations/003_v3_delete_audit_rollback.sql
-- 职责：v3 删除投票功能 — 回滚脚本
--       - 删除 votes 表新增的 3 列
--       - 删除 audit_logs 表
--       - 删除新增索引
-- ============================================================

-- 1. 删除 audit_logs 表（CASCADE 删除关联索引）
DROP TABLE IF EXISTS audit_logs CASCADE;

-- 2. 删除新增索引
DROP INDEX IF EXISTS idx_votes_del_flag;

-- 3. 回退 votes 表列变更
ALTER TABLE votes DROP COLUMN IF EXISTS del_flag;
ALTER TABLE votes DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE votes DROP COLUMN IF EXISTS deleted_by;
