/**
 * src/config.ts
 * 职责：环境变量读取，集中管理与供给默认值
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // 服务端口
  PORT: parseInt(process.env.PORT || '3001', 10),

  // 数据库（CVE 修复：移除硬编码默认凭证；无配置时启动报错）
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379/0',

  // 飞书 SSO（MVP 开发阶段可留空，auth 中间件回退 dev 模式）
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',

  // 飞书 OAuth 回调地址（须在飞书开放平台后台配置安全域名）
  // staging: http://localhost:8443/api/auth/feishu/callback
  // production: https://eeimoo.cn/api/auth/feishu/callback
  FEISHU_REDIRECT_URI: process.env.FEISHU_REDIRECT_URI || '',

  // 前端首页 URL（SSO callback 成功后 302 跳转目标）
  // 默认 dev 模式为 localhost:5173，生产环境通过环境变量配置
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  // 飞书 OAuth 授权页基础 URL
  FEISHU_AUTHORIZE_URL: process.env.FEISHU_AUTHORIZE_URL || 'https://open.feishu.cn/open-apis/authen/v1/authorize',

  // JWT 密钥（用于签发 SSO 登录会话 token）
  // VUL-001：不再提供硬编码默认值；未设置时启动报错
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    const env = process.env.NODE_ENV || 'development';
    if (!secret) {
      // 测试和开发环境：用随机值代替，打印警告
      if (env === 'test' || env === 'development') {
        const randomSecret = require('crypto').randomBytes(32).toString('hex');
        console.warn('[Config] 警告：JWT_SECRET 未设置，已生成临时随机密钥（每次重启会话失效）');
        return randomSecret;
      }
      throw new Error('JWT_SECRET 环境变量未设置 — 生产环境必须配置此值');
    }
    return secret;
  })(),

  // JWT 有效期（默认 24 小时）
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',

  // OAuth state 参数 TTL（秒，默认 600 = 10 分钟）
  OAUTH_STATE_TTL: parseInt(process.env.OAUTH_STATE_TTL || '600', 10),

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
