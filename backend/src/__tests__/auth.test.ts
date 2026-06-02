import request from 'supertest';
import express from 'express';
import { feishuAuth } from '../middleware/auth';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.JWT_SECRET;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(feishuAuth());
  app.get('/api/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

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

  it('accepts dev token and passes through', async () => {
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', 'Bearer dev_ou_test_user_test_team_Test%20User');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('falls back to raw token parsing in non-production mode', async () => {
    // When JWT_SECRET is set, malformed JWT fails verification
    // but in test/dev mode, the middleware falls through to raw token parsing
    process.env.JWT_SECRET = 'test-jwt-secret';
    const res = await request(createApp())
      .get('/api/test')
      .set('Authorization', 'Bearer not.valid.jwt');
    // Non-prod mode: fallback parsing accepts anything
    expect(res.status).toBe(200);
    delete process.env.JWT_SECRET;
  });
});
