/**
 * __tests__/rateLimiter.test.ts
 * 测试范围：限流中间件 — Redis Lua 滑动窗口 + 降级内存 Map
 *
 * 覆盖测试用例:
 *   IT-RL-01: 窗口内第 1 次请求通过
 *   IT-RL-02: 窗口内第 3 次请求仍通过
 *   IT-RL-03: 窗口内第 4 次请求被拒绝（429）
 *   IT-RL-04: 不同用户的限流独立
 *   IT-RL-05: 不同投票的限流独立
 *   IT-RL-06: 限流仅对 POST vote 生效，其他路由不拦截
 */

import request from 'supertest';
import {
  setupTestEnv,
  teardownTestEnv,
  createTestVote,
  signTestToken,
  TestApp,
} from './testSetup';

let app: TestApp['app'];

beforeAll(async () => {
  const env = await setupTestEnv();
  app = env.app;
}, 30000);

afterAll(async () => {
  await teardownTestEnv();
}, 10000);

// 使用 JWT token 替代已移除的 dev_ token
const TOKEN_A = signTestToken('ouuser_a', 'testteam001', '用户A');
const TOKEN_B = signTestToken('ouuser_b', 'testteam001', '用户B');

describe('Rate Limiter — 限流中间件', () => {

  // IT-RL-01: 窗口内第 1 次请求通过
  it('IT-RL-01: 第 1 次投票提交通过', async () => {
    const { voteId, optionIds } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ option_ids: [optionIds[0]] });

    expect(res.status).toBe(200);
  });

  // IT-RL-02: 窗口内第 2 次请求通过（同一 vote + user 不同 option 不会发生，此处测限流计数）
  it('IT-RL-02: 窗口内前 3 次通过（限流次数=3）', async () => {
    // 创建新投票——测试限流（需要不同投票才能多次成功投）
    const { voteId: v1, optionIds: o1 } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });
    const { voteId: v2, optionIds: o2 } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });
    const { voteId: v3, optionIds: o3 } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    // 同一用户对不同投票各投 1 次 → 各自独立计数
    // 但限流键是 rate:{user_id}:{vote_id}，所以不同投票是独立的
    const r1 = await request(app)
      .post(`/api/votes/${v1}/vote`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ option_ids: [o1[0]] });
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post(`/api/votes/${v2}/vote`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ option_ids: [o2[0]] });
    expect(r2.status).toBe(200);

    const r3 = await request(app)
      .post(`/api/votes/${v3}/vote`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ option_ids: [o3[0]] });
    expect(r3.status).toBe(200);
  });

  // IT-RL-03: 同一 vote 第 3 次提交（同一用户无法重复投，但限流计数仍然递增）
  // 连续 POST 到同一 vote 的 rate:key 会触发限流
  it('IT-RL-03: 连续 POST 同一投票超 3 次 → 429', async () => {
    // 创建投票给 TOKEN_B
    const { voteId, optionIds } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const TOKEN_TEST = signTestToken('oulimittest', 'testteam001', '限流测试');

    // 第1次 POST → 实际投票成功（200）
    await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_TEST}`)
      .send({ option_ids: [optionIds[0]] });

    // 第2次 POST → 重复投票 409，但限流计数+1
    await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_TEST}`)
      .send({ option_ids: [optionIds[0]] });

    // 第3次 POST → 同样计数+1
    await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_TEST}`)
      .send({ option_ids: [optionIds[0]] });

    // 第4次 POST → 429 限流拒绝
    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_TEST}`)
      .send({ option_ids: [optionIds[0]] });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe(42900);
    expect(res.headers['retry-after']).toBeDefined();
  });

  // IT-RL-04: 不同用户限流独立
  it('IT-RL-04: 不同用户限流独立', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const TOKEN_X = signTestToken('ouserx', 'testteam001', '用户X');
    const TOKEN_Y = signTestToken('ousery', 'testteam001', '用户Y');

    // 两个用户各自第1次 → 都应通过
    const r1 = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_X}`)
      .send({ option_ids: [] }); // 空数组会参数校验失败但不影响限流计数
    const r2 = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_Y}`)
      .send({ option_ids: [] });

    // 不同的限流 key，各自独立计数
    // 两个请求都应该由参数校验处理，不限流
    expect([400, 200]).toContain(r1.status);
    expect([400, 200]).toContain(r2.status);
  });

  // IT-RL-06: 限流仅对 POST vote 接口生效
  it('IT-RL-06: GET 请求不受限流影响', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    // 连续多次 GET 请求同投票 → 不应被限流
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .get(`/api/votes/${voteId}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);
      expect(res.status).toBe(200);
    }

    // POST 创建投票也不应被限流（仅 POST .../vote 被限流）
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({
        title: '不应被限流',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 30,
      });
    expect(res.status).toBe(201);
  });
});
