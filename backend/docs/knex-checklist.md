# knex 使用自查清单

> 每次使用 knex 操作数据库前必须逐项确认。本清单基于真实生产事故归纳。

---

## 1. `knex.raw()` 返回值结构确认

- [ ] **`knex.raw()` 返回值是否访问了 `.rows` 而非直接当数组？**

  **踩过的坑（P0-001）**：`knex.raw('SELECT ...')` 在不同 PG 驱动版本下返回值结构不同——某些版本返回 `{ rows: [...], rowCount: N }` 而非直接返回数组。代码写了 `result.map(...)` 直接当数组遍历，结果 `result` 是对象没有 `.map`，导致 `TypeError: result.map is not a function`，生产环境直接炸掉。

  **正确做法**：
  ```ts
  const result = await knex.raw('SELECT ...');
  const rows = result.rows ?? result;  // 兼容两种返回值格式
  ```

---

## 2. 返回值结构打印验证

- [ ] **是否打印了 `typeof result` 和 `result` 结构确认返回值格式？**

  **踩过的坑**：开发时未打印返回值结构，凭文档猜测格式，实际运行时结构完全不同。一行 `console.log(typeof result, JSON.stringify(result).slice(0, 200))` 就能避免的 bug，因为没打日志，定位花了一下午。

  **正确做法**：
  ```ts
  const result = await knex.raw('SELECT ...');
  console.log('[DEBUG] raw result type:', typeof result);
  console.log('[DEBUG] raw result keys:', Object.keys(result));
  console.log('[DEBUG] raw result sample:', JSON.stringify(result).slice(0, 500));
  ```

---

## 3. PG 版本间 raw() 返回值差异

- [ ] **是否对不同 PG 版本的 raw() 返回格式差异有了解？（PG 14/15/16）**

  **踩过的坑（P0-003）**：pg 驱动 8.x 与 7.x 对 `raw()` 返回值包装不同；PG 14 与 PG 16 在某些聚合函数返回格式上也有微妙差异。本地 PG 16 自测通过，CI/CD 用 PG 14 容器就报错。

  **正确做法**：
  - 本地开发 PG 版本与 CI/CD 保持一致（或用 Docker 指定版本）
  - 确认 `pg` npm 包版本号并锁定
  - 在 CI 日志中打印 `SELECT version()` 确认实际 PG 版本

---

## 4. 统一解包工具函数

- [ ] **建议：封装 `normalizeRawResult(result)` 工具函数统一解包**

  **为什么需要**：团队 3 个人用 knex，3 种解包方式，每次 code review 都要确认"你这里解包对了吗"。

  **推荐实现**：
  ```ts
  /**
   * 统一 knext.raw() 返回值解包
   * 兼容 pg 7.x / 8.x / 不同 PG 版本
   */
  function normalizeRawResult(result: any): any[] {
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.rows)) return result.rows;
    throw new Error(`Unexpected knex.raw() result structure: ${typeof result}`);
  }
  ```

---

## 5. 事务回滚处理

- [ ] **事务回滚逻辑是否在 catch 中正确处理？**

  **踩过的坑（P0-002）**：事务中第二个 SQL 执行失败，catch 块里只写了 `console.error` 没有显式 `trx.rollback()`，寄希望于连接释放时自动回滚。结果连接池复用导致脏数据提交，部分用户投票记录丢失。

  **正确做法**：
  ```ts
  const trx = await knex.transaction();
  try {
    await trx('votes').insert({ ... });
    await trx('vote_logs').insert({ ... }); // 若此处抛错
    await trx.commit();
  } catch (err) {
    await trx.rollback();  // 必须显式回滚
    throw err;             // 往上抛让调用方感知
  }
  ```

---

## 6. 连接池配置

- [ ] **连接池配置是否合理？**

  **踩过的坑**：默认连接池 `min:2, max:10`，高峰期 50 并发请求打满连接池，后续请求排队超时，表现为间歇性 503。排查时发现 knex 连接池配置被注释掉了"因为本地开发用不到"。

  **正确做法**：
  ```ts
  const knex = require('knex')({
    client: 'pg',
    connection: { ... },
    pool: {
      min: 2,
      max: 20,               // 根据并发量评估
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200,
    },
  });
  ```

---

## 自查记录

| 日期 | PR/MR | 检查人 | 全部通过 |
|------|-------|--------|---------|
|      |       |        |         |
|      |       |        |         |
