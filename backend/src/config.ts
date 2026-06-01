/**
 * src/config.ts
 * 职责：环境变量读取，集中管理与供给默认值
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // 服务端口
  PORT: parseInt(process.env.PORT || '3001', 10),

  // 数据库
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://vote_user:vote_pass@localhost:5432/vote_db',

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379/0',

  // 飞书 SSO（MVP 开发阶段可留空，auth 中间件回退 dev 模式）
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',

  // 团队总人数快照降级值（飞书通讯录 API 不可用时回退）
  TEAM_TOTAL_MEMBERS: parseInt(process.env.TEAM_TOTAL_MEMBERS || '0', 10),

  // Redis 降级阈值：连续 PING 失败 N 次触发降级
  REDIS_DEGRADE_THRESHOLD: parseInt(process.env.REDIS_DEGRADE_THRESHOLD || '3', 10),

  // 速率限制
  RATE_LIMIT_WINDOW_MS: 60_000,   // 60 秒滑动窗口
  RATE_LIMIT_MAX: 3,               // 窗口内最多 3 次提交

  // Tally 同步间隔
  TALLY_SYNC_INTERVAL_MS: 5_000,   // 5 秒

  // Knex 连接池
  KNEX_POOL_MIN: parseInt(process.env.KNEX_POOL_MIN || '2', 10),
  KNEX_POOL_MAX: parseInt(process.env.KNEX_POOL_MAX || '20', 10),

  // 节点环境
  NODE_ENV: process.env.NODE_ENV || 'development',
} as const;
