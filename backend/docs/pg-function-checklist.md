# PG 自定义函数/存储过程验证清单

> 每个自定义 PG 函数或存储过程在上线前，必须完成以下全部验证项。本清单基于真实生产事故归纳。

---

## 1. 单元验证（≥3 组输入/输出）

- [ ] **在 psql 中执行 ≥3 组输入/输出的单元验证**

  **踩过的坑（P0-002）**：`calculate_vote_weight()` 函数写好后在代码里直接调用，从未在 psql 中单独验证过。实际上传参顺序与函数定义不一致，但代码里 ORM 按对象 key 传参恰好绕过了这个问题，代码层自测通过。迁移到新环境后 ORM 版本变化导致传参顺序变化，函数静默返回了错误结果——计票权重全是 1.0。

  **正确做法**：
  ```sql
  -- 至少准备 3 组验证用例
  SELECT calculate_vote_weight(user_id => 'uuid-1', vote_type => 'up');
  -- 预期: 1.0

  SELECT calculate_vote_weight(user_id => 'uuid-2', vote_type => 'up');
  -- 预期: 2.0（VIP 用户）

  SELECT calculate_vote_weight(user_id => 'uuid-3', vote_type => 'down');
  -- 预期: -1.0
  ```

---

## 2. 边界值验证

- [ ] **验证边界值（空输入、超长字符串、特殊字符、NULL）**

  **踩过的坑**：`sanitize_vote_comment()` 函数声称"安全处理用户输入"，但未测试过 `NULL` 输入。生产环境中某用户提交了空评论，函数内部 `NULL.length` 直接抛异常，导致整个投票事务回滚。

  **边界值 checklist**：
  ```sql
  -- 空输入
  SELECT sanitize_vote_comment('');         -- 预期: ''
  SELECT sanitize_vote_comment(NULL);        -- 预期: NULL（或 ''）

  -- 超长字符串
  SELECT sanitize_vote_comment(repeat('x', 10000));  -- 预期: 截断至 1000 字符

  -- 特殊字符
  SELECT sanitize_vote_comment(E'\x00\x1b\n\r');     -- 预期: 去除控制字符

  -- Unicode / Emoji
  SELECT sanitize_vote_comment('🎉👍🏽🇨🇳');           -- 预期: 保留（或业务定义行为）
  ```

---

## 3. 非标量类型转换测试

- [ ] **对 `bytea`、`jsonb` 等非标量类型必须写转换测试（`decode()` vs `::bytea`）**

  **踩过的坑（P0-003）**：`store_vote_signature()` 函数接收 `bytea` 类型签名数据。开发时用 `'deadbeef'::bytea` 测试通过。生产环境中传入 hex 字符串时发现 `::bytea` 把字符串当作字面量而非 hex 解码，签名存储全是乱码。正确做法应该是 `decode('deadbeef', 'hex')`。

  **转换测试矩阵**：
  ```sql
  -- bytea: 必须对比 decode() 和 ::bytea 两种方式
  SELECT 'deadbeef'::bytea;              -- 行为：字面量转 bytea
  SELECT decode('deadbeef', 'hex');      -- 行为：hex 解码 → 正确
  SELECT decode('hello', 'escape');      -- 行为：escape 格式

  -- jsonb: 必须验证嵌套、数组、null 字段
  SELECT '{"a": [1, null]}'::jsonb;      -- null 保留
  SELECT jsonb_build_object('a', NULL);  -- NULL 值被省略

  -- 跨类型转换
  SELECT my_json_field::text IS NULL;    -- jsonb NULL vs SQL NULL
  ```
  **关键教训**：不要假设 `::type` 的行为与专用转换函数一致。

---

## 4. DEFAULT 场景验证

- [ ] **验证函数在 DEFAULT 场景下的行为（如 `uuid_v7()` 作为主键默认值）**

  **踩过的坑**：表定义 `id uuid DEFAULT uuid_v7()`。本地 PG 16 + `pg_uuidv7` 扩展测试通过。CI/CD 使用 Supabase PG 15 镜像，未安装扩展，建表不报错但 INSERT 时 `uuid_v7` 不存在导致失败。发现时已经部署到预发环境。

  **验证方法**：
  ```sql
  -- 1. 确认扩展已安装
  SELECT * FROM pg_extension WHERE extname = 'pg_uuidv7';

  -- 2. 插入不指定默认列的记录
  INSERT INTO votes (user_id, option_id) VALUES ('...', '...') RETURNING id;
  -- 确认 id 被正确填充且格式为 UUIDv7

  -- 3. 在目标 PG 版本上重复验证
  -- 如果扩展不可用，是否有 fallback：gen_random_uuid()?
  ```

---

## 5. 已有数据兼容性

- [ ] **函数修改后必须验证对已有数据的兼容性**

  **踩过的坑**：修改 `calculate_vote_count()` 新增了参数，认为"SQL 函数默认参数向下兼容"。但已有视图 `user_vote_stats` 依赖该函数且未传新参数，刷新视图时报错 `function calculate_vote_count(integer) does not exist`——PostgreSQL 的函数重载是按签名匹配的，不是按参数名匹配。

  **验证方法**：
  ```sql
  -- 1. 查找所有依赖该函数的对象
  SELECT routines.routine_name, routines.routine_type
  FROM information_schema.routines
  WHERE routine_definition ILIKE '%your_function_name%'
  UNION
  SELECT table_name, 'VIEW' FROM information_schema.views
  WHERE view_definition ILIKE '%your_function_name%';

  -- 2. 在包含历史数据的副本上运行函数
  -- 3. 对比修改前后输出是否一致（等价修改除外）
  ```

---

## 自查记录

| 日期 | 函数名 | 用例数 | 边界覆盖 | 非标量测试 | DEFAULT 测试 | 兼容性 | 检查人 |
|------|--------|--------|---------|-----------|-------------|--------|--------|
|      |        |        |         |           |             |        |        |
|      |        |        |         |           |             |        |        |
