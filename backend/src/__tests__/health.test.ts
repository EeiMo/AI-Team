import request from 'supertest';
import express from 'express';

const app = express();
app.get('/api/health', async (_req, res) => {
  const uptime = process.uptime();
  res.json({
    status: 'ok',
    uptime,
    checks: {
      postgres: 'ok',
      redis: 'ok',
    },
  });
});

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes uptime and checks', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.uptime).toBeDefined();
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.postgres).toBe('ok');
    expect(res.body.checks.redis).toBe('ok');
  });
});
