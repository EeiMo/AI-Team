/**
 * __tests__/config.test.ts
 * 测试 config 模块的默认值和类型
 */

// 在导入前设置环境变量（需要模拟 process.env）
const originalEnv = { ...process.env };

describe('config 模块', () => {
  beforeEach(() => {
    // 重置环境变量
    process.env = { ...originalEnv };
    // 清除模块缓存以重新加载
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('应有默认端口 3001', () => {
    delete process.env.PORT;
    const { config } = require('../config');
    expect(config.PORT).toBe(3001);
  });

  it('应读取环境变量 PORT', () => {
    process.env.PORT = '8080';
    const { config } = require('../config');
    expect(config.PORT).toBe(8080);
  });

  it('FEISHU_APP_ID 默认为空字符串', () => {
    delete process.env.FEISHU_APP_ID;
    const { config } = require('../config');
    expect(config.FEISHU_APP_ID).toBe('');
  });

  it('应读取 FEISHU_APP_ID', () => {
    process.env.FEISHU_APP_ID = 'cli_abc123';
    const { config } = require('../config');
    expect(config.FEISHU_APP_ID).toBe('cli_abc123');
  });

  it('FEISHU_REDIRECT_URI 默认为空字符串', () => {
    delete process.env.FEISHU_REDIRECT_URI;
    const { config } = require('../config');
    expect(config.FEISHU_REDIRECT_URI).toBe('');
  });

  it('应读取 FEISHU_REDIRECT_URI', () => {
    process.env.FEISHU_REDIRECT_URI = 'https://eeimoo.cn/api/auth/feishu/callback';
    const { config } = require('../config');
    expect(config.FEISHU_REDIRECT_URI).toBe('https://eeimoo.cn/api/auth/feishu/callback');
  });

  it('JWT_SECRET 未设置时生成随机密钥（开发/测试环境）', () => {
    delete process.env.JWT_SECRET;
    const { config } = require('../config');
    expect(config.JWT_SECRET).toBeDefined();
    expect(config.JWT_SECRET.length).toBe(64); // randomBytes(32) → hex 64 字符
  });

  it('JWT_EXPIRES_IN 默认为 24h', () => {
    delete process.env.JWT_EXPIRES_IN;
    const { config } = require('../config');
    expect(config.JWT_EXPIRES_IN).toBe('24h');
  });

  it('OAUTH_STATE_TTL 默认为 600 秒', () => {
    delete process.env.OAUTH_STATE_TTL;
    const { config } = require('../config');
    expect(config.OAUTH_STATE_TTL).toBe(600);
  });

  it('应读取 REDIS_DEGRADE_THRESHOLD 默认值', () => {
    delete process.env.REDIS_DEGRADE_THRESHOLD;
    const { config } = require('../config');
    expect(config.REDIS_DEGRADE_THRESHOLD).toBe(3);
  });

  it('NODE_ENV 默认为 development', () => {
    delete process.env.NODE_ENV;
    const { config } = require('../config');
    expect(config.NODE_ENV).toBe('development');
  });

  it('FEISHU_AUTHORIZE_URL 默认值正确', () => {
    delete process.env.FEISHU_AUTHORIZE_URL;
    const { config } = require('../config');
    expect(config.FEISHU_AUTHORIZE_URL).toBe('https://open.feishu.cn/open-apis/authen/v1/authorize');
  });

  it('DATABASE_URL 未设置时返回空字符串（CVE 修复：已移除硬编码默认凭证）', () => {
    
    delete process.env.DATABASE_URL;
    const { config } = require('../config');
    expect(config.DATABASE_URL).toBe('');
  });
});
