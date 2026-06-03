import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { feishuAuth } from '../middleware/auth';

// jest.setup.ts 已设置 JWT_SECRET，此处保持一致
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-jest';

function signToken(userId: string, teamId: string, displayName: string): string {
  return jwt.sign(
    { user_id: userId, team_id: teamId, display_name: displayName },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(feishuAuth());
  app.get('/api/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
});

describe('Auth middleware', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(createApp()).get('/api/test');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40100);
  });

  it('returns 401 with empty Authorization header', async () => {
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', '');
    expect(res.status).toBe(401);
  });

  it('accepts JWT token and passes through', async () => {
    const token = signToken('ou_test_user', 'test_team', 'Test User');
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects expired JWT token', async () => {
    const token = jwt.sign(
      { user_id: 'ou_expired', team_id: 'team', display_name: 'Expired' },
      TEST_JWT_SECRET,
      { expiresIn: '0s' }
    );
    // 等 1 秒确保过期
    await new Promise(r => setTimeout(r, 1100));
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', `Bearer ${token}`);
    // TokenExpiredError → 直接抛出，不入 fallback
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40100);
  });

  it('allows malformed token in non-production via fallback', async () => {
    // 非生产环境，非 JWT 格式 token 通过 fallback 降级
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', 'Bearer not_a_valid_jwt');
    // 测试/开发环境：fallback 接受任意字符串
    expect(res.status).toBe(200);
  });

  it('rejects dev_ prefixed token in production mode', async () => {
    // 保存当前 env，切换到 production
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', 'Bearer dev_ou_test_user_test_team_Test%20User');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40100);
    process.env.NODE_ENV = savedEnv;
  });

  it('allows dev_ prefixed token in non-production via fallback', async () => {
    // dev_ 前缀在 step 1 中被移除后，fallback 按普通字符串处理
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', 'Bearer dev_ou_test_user_test_team_Test%20User');
    // 测试/开发环境：fallback 接受，不会专门解析 dev_ 格式
    expect(res.status).toBe(200);
  });

  it('sets req.user from valid JWT', async () => {
    const token = signToken('ou_alice', 'team001', 'Alice');
    const app = express();
    app.use(express.json());
    app.use(feishuAuth());
    app.get('/api/me', (req, res) => {
      res.json({ user: req.user });
    });
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      user_id: 'ou_alice',
      team_id: 'team001',
      display_name: 'Alice',
    });
  });
});
