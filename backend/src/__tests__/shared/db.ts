/**
 * __tests__/shared/db.ts
 * 测试专用 PG 连接单例
 *
 * 使用 default export 以确保 ts-jest 兼容性
 * 连接同库投票 vote_db（localhost:5433）
 */

import knexLib from 'knex';
import type { Knex } from 'knex';

const dbUrl = process.env.DATABASE_URL || 'postgresql://vote_user:vote_dev_pass@localhost:5433/vote_db';

const testKnex: Knex = knexLib({
  client: 'pg',
  connection: dbUrl,
  pool: { min: 1, max: 3 },
  migrations: { directory: './migrations', tableName: 'knex_migrations' },
});

export { testKnex };
export default testKnex;
