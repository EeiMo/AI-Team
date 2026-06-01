/**
 * src/db/knex.ts
 * 职责：Knex 实例配置 — PG 连接池、日志、迁移目录
 */

import knexLib from 'knex';
import { config } from '../config';

export const knex = knexLib({
  client: 'pg',
  connection: config.DATABASE_URL,
  pool: {
    min: config.KNEX_POOL_MIN,
    max: config.KNEX_POOL_MAX,
  },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
  // 开发环境打印 SQL，生产关闭
  debug: config.NODE_ENV === 'development',
});
