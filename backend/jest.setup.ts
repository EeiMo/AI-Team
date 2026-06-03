/**
 * jest.setup.ts
 * 测试环境变量注入 — 连接真实 PG 15 on localhost:5433
 *
 * 本文件通过 jest.config.ts 的 setupFiles 在测试开始前执行。
 * 注意："***" 在本环境中是真实密码，不是占位符。
 */

// ── 测试环境 ──
process.env.NODE_ENV = 'test';

// ── 数据库（真实 PG 15 on localhost:5433）──
// PG password from staging env
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://vote_user:vote_dev_pass@localhost:5433/vote_db';

// ── JWT 测试密钥 ──
process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-for-jest';
process.env.JWT_EXPIRES_IN = process.env.TEST_JWT_EXPIRES_IN || '24h';

// ── 飞书 SSO（测试环境留空，走 dev token 降级）──
process.env.FEISHU_APP_ID = process.env.TEST_FEISHU_APP_ID || '';
process.env.FEISHU_APP_SECRET = process.env.TEST_FEISHU_APP_SECRET || '';

// ── Redis（连接真实 Redis）──
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6380';

// ── 团队配置 ──
process.env.TEAM_TOTAL_MEMBERS = process.env.TEST_TEAM_TOTAL_MEMBERS || '24';

// ── 端口（避免冲突）──
process.env.PORT = process.env.TEST_PORT || '0';
