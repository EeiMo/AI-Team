# 迁移验证清单

> 每次编写 database migration 后，必须完成以下全部验证项后方可提 PR。本清单基于真实生产事故归纳。

---

## 1. 本地完整迁移链重建

- [ ] **在本地重建空库跑完整迁移链（DROP + CREATE + MIGRATE）**

  **踩过的坑（P0-001）**：migration-003 新增了 `ALTER TABLE votes ADD COLUMN weight`，本地增量跑（在已有 migration-002 基础上）通过。但新成员入职初始化环境时从头跑迁移链，migration-002 创建的表结构与 migration-003 假设的不一致（migration-002 在上一次迭代被手动修过但未更新迁移文件），导致 migration-003 执行失败。

  **正确做法**：
  ```bash
  # 完整重建流程
  dropdb vote_app_dev --if-exists
  createdb vote_app_dev
  npx knex migrate:latest --env development
  # 确认所有迁移无报错，exit code = 0
  ```

---

## 2. 表结构一致性验证

- [ ] **验证迁移后表结构与预期一致（information_schema 比对）**

  **踩过的坑**：migration 执行成功、exit code 0，但 `varchar(255)` 因为编码问题实际创建为 `varchar(1020)`（PG 中 varchar(N) 在 UTF-8 下的行为差异）。代码层按 255 字符做截断，数据库实际能存 4 倍，数据不一致几个月后才暴露。

  **验证 SQL**：
  ```sql
  -- 导出实际表结构
  SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'votes'
  ORDER BY ordinal_position;

  -- 导出索引
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'votes';

  -- 导出约束
  SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid = 'votes'::regclass;
  ```

---

## 3. DEFAULT 值/函数/索引/约束生效验证

- [ ] **验证所有 DEFAULT 值/函数/索引/约束生效**

  **踩过的坑（P0-001）**：migration 中 `CREATE INDEX CONCURRENTLY` 语句，在本地单连接环境下执行成功。CI/CD 环境中迁移脚本在事务内执行（knex 默认包装），`CREATE INDEX CONCURRENTLY` 不能在事务内运行，静默跳过未创建索引。生产环境查询性能劣化，慢查询报警。

  **验证 SQL**：
  ```sql
  -- DEFAULT 值：插入空行确认默认值生效
  INSERT INTO votes DEFAULT VALUES RETURNING *;

  -- 索引：确认索引存在且可用
  SELECT * FROM pg_indexes WHERE tablename = 'votes';
  -- 额外确认索引是否有效（非 INVALID）
  SELECT indexrelid::regclass, indisvalid FROM pg_index
  WHERE indrelid = 'votes'::regclass;

  -- 约束：尝试插入违反约束的数据，确认被拒绝
  INSERT INTO votes (user_id, option_id) VALUES (NULL, NULL);
  -- 预期: ERROR: null value in column "user_id" violates not-null constraint
  ```

---

## 4. CI/CD 迁移执行确认

- [ ] **确认 CI/CD 中迁移步骤实际执行且有日志输出**

  **踩过的坑**：CI 配置中 `npm run migrate` 命令写成了 `npm run migrate || true`（加了 `|| true` 导致 exit code 始终为 0），迁移失败也不阻断流水线。连续两次部署迁移失败未发现，直到功能异常才排查出表结构未更新。

  **CI/CD 检查项**：
  ```yaml
  # CI 中必须：
  # 1. 不加 || true / || exit 0 之类容错
  # 2. 打印 migrate 完整输出
  # 3. 后面加一步验证迁移状态
  - run: npx knex migrate:latest
  - run: npx knex migrate:list   # 确认状态
  - run: npx knex migrate:status # 显示未执行迁移（应为空）
  ```

---

## 5. 迁移失败阻断部署

- [ ] **迁移失败（exit code != 0）是否阻断部署？**

  **踩过的坑**：CD 流水线中 migration 步骤和 deploy 步骤是平行 job（而非顺序依赖），迁移失败时部署仍然继续。新代码连上新数据库发现缺字段，部分请求 500，还有部分请求因为字段缺失触发了 ORM 的 silent fallback 写入了不完整数据。

  **CI/CD 正确配置**：
  ```yaml
  # migration 和 deploy 必须是顺序依赖：
  # migrate → (成功) → deploy
  # migrate → (失败) → 阻断，不执行 deploy
  jobs:
    migrate:
      steps: [...]
    deploy:
      needs: [migrate]  # migrate 成功后才执行
      steps: [...]
  ```

---

## 自查记录

| 日期 | 迁移文件 | 本地完整链 | 表结构比对 | 默认/索引/约束 | CI 日志确认 | 阻断验证 | 检查人 |
|------|---------|-----------|-----------|--------------|-----------|---------|--------|
|      |         |           |           |              |           |         |        |
|      |         |           |           |              |           |         |        |
