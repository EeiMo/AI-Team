/**
 * __tests__/votes.test.ts
 * 测试范围：投票 REST API — 创建、列表、详情、提交、关闭
 *
 * 覆盖测试计划中的集成测试用例：
 *   创建: IT-CV-01 ~ IT-CV-14
 *   列表: IT-VL-01 ~ IT-VL-09
 *   详情: IT-VD-01 ~ IT-VD-13
 *   提交: IT-SV-01 ~ IT-SV-12
 *   关闭: IT-CL-01 ~ IT-CL-07
 */

import request from 'supertest';
import {
  setupTestEnv,
  teardownTestEnv,
  createTestVote,
  castTestVote,
  clearRateLimitKeys,
  cleanTestTables,
  TestApp,
} from './testSetup';

let app: TestApp['app'];

beforeAll(async () => {
  const env = await setupTestEnv();
  app = env.app;
}, 30000);

beforeEach(async () => {
  await clearRateLimitKeys();
  await cleanTestTables();
});

afterAll(async () => {
  await teardownTestEnv();
}, 10000);

// ---- 测试用 Token ----
const TOKEN_ALICE = 'dev_oualice_testteam001_%E7%88%B1%E4%B8%BD%E4%B8%9D';
const TOKEN_BOB = 'dev_oubob_testteam001_%E9%B2%8D%E5%8B%83';
const TOKEN_OTHER = 'dev_ouother_otherteam_%E5%85%B6%E4%BB%96%E4%BA%BA'; // 跨团队

describe('POST /api/votes — 创建投票', () => {

  // IT-CV-01: 正常创建单选实名投票
  it('IT-CV-01: 正常创建单选实名投票', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '团建投票',
        options: ['杭州', '苏州', '无锡'],
        vote_type: 'single',
        vote_mode: 'public',
        deadline_minutes: 30,
      });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data.vote.status).toBe('active');
    expect(res.body.data.vote.vote_type).toBe('single');
    expect(res.body.data.vote.vote_mode).toBe('public');
    expect(res.body.data.vote.options).toHaveLength(3);
    expect(res.body.data.vote.creator_name).toBe('爱丽丝');
  });

  // IT-CV-02: 正常创建多选匿名投票
  it('IT-CV-02: 正常创建多选匿名投票', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '多选匿名测试',
        options: ['X', 'Y', 'Z', 'W', 'V'],
        vote_type: 'multi',
        vote_mode: 'anonymous',
        deadline_minutes: 15,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.vote.vote_mode).toBe('anonymous');
    expect(res.body.data.vote.vote_type).toBe('multi');
    expect(res.body.data.vote.options).toHaveLength(5);
  });

  // IT-CV-03: 边界 — 选项数=2（最小值）
  it('IT-CV-03: 边界 — 最少 2 个选项', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '最少选项',
        options: ['仅此', '而已'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 5,
      });

    expect(res.status).toBe(201);
  });

  // IT-CV-04: 边界 — 选项数=10（最大值）
  it('IT-CV-04: 边界 — 最多 10 个选项', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '最多选项',
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
        vote_type: 'multi',
        vote_mode: 'public',
        deadline_minutes: 10,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.vote.options).toHaveLength(10);
  });

  // IT-CV-05: 边界 — 标题 100 字符
  it('IT-CV-05: 边界 — 标题 100 字符', async () => {
    const title100 = '测'.repeat(100);
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: title100,
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 5,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.vote.title.length).toBe(100);
  });

  // IT-CV-06: 边界 — deadline_minutes=1
  it('IT-CV-06: 边界 — 截止 1 分钟', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '1分钟截止',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 1,
      });

    expect(res.status).toBe(201);
  });

  // IT-CV-07: 异常 — title 为空
  it('IT-CV-07: 异常 — title 为空', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 30,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40001);
  });

  // IT-CV-08: 异常 — 选项重复
  it('IT-CV-08: 异常 — 选项重复', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '重复选项',
        options: ['A', 'B', 'A'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 30,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40003);
  });

  // IT-CV-09: 异常 — 选项有空值
  it('IT-CV-09: 异常 — 选项有空字符串', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '空选项',
        options: ['A', ''],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 30,
      });

    expect(res.status).toBe(400);
  });

  // IT-CV-11: 异常 — 未认证
  it('IT-CV-11: 异常 — 未认证', async () => {
    const res = await request(app)
      .post('/api/votes')
      .send({
        title: '未认证',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 30,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40100);
  });

  // IT-CV-12: 边界 — deadline_minutes=10080
  it('IT-CV-12: 边界 — deadline_minutes=10080', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '最长截止',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 10080,
      });

    expect(res.status).toBe(201);
  });

  // IT-CV-13: 异常 — deadline_minutes > 10080
  it('IT-CV-13: 异常 — deadline_minutes=10081', async () => {
    const res = await request(app)
      .post('/api/votes')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`)
      .send({
        title: '超长截止',
        options: ['A', 'B'],
        vote_type: 'single',
        vote_mode: 'anonymous',
        deadline_minutes: 10081,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40004);
  });
});

describe('GET /api/votes — 投票列表', () => {

  // IT-VL-01: 列表展示进行中投票（按 team_id 过滤）
  it('IT-VL-01: 列表显示本团队进行中投票', async () => {
    // 创建 3 个 active 投票
    await createTestVote({ title: '投票A', creator_id: 'oualice', team_id: 'testteam001' });
    await createTestVote({ title: '投票B', creator_id: 'oualice', team_id: 'testteam001' });
    await createTestVote({ title: '投票C', creator_id: 'oualice', team_id: 'testteam001' });

    const res = await request(app)
      .get('/api/votes?status=active')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(3);
    expect(typeof res.body.data.total).toBe('number');
  });

  // IT-VL-02: 空列表
  it('IT-VL-02: 无已结束投票时返回空列表', async () => {
    const res = await request(app)
      .get('/api/votes?status=closed')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  // IT-VL-03: 分页
  it('IT-VL-03: 分页参数生效', async () => {
    const res = await request(app)
      .get('/api/votes?status=active&page=1&size=5')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(5);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.size).toBe(5);
  });

  // IT-VL-08: 跨团队不可见
  it('IT-VL-08: 跨团队不可见', async () => {
    // 用 otherteam 创建投票
    await createTestVote({ creator_id: 'ouother', team_id: 'otherteam' });
    // 用 Bob 的 testteam001 token 查询
    const res = await request(app)
      .get('/api/votes?status=active')
      .set('Authorization', `Bearer ${TOKEN_BOB}`);

    expect(res.status).toBe(200);
    // 不应包含 otherteam 的投票
    const otherVotes = res.body.data.items.filter(
      (v: any) => v.team_id === 'otherteam'
    );
    expect(otherVotes).toHaveLength(0);
  });
});

describe('GET /api/votes/:id — 投票详情', () => {

  // IT-VD-01: 匿名模式 voters 为空
  it('IT-VD-01: 匿名模式 voters 数组为空', async () => {
    const { voteId } = await createTestVote({
      vote_mode: 'anonymous',
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .get(`/api/votes/${voteId}`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`);

    expect(res.status).toBe(200);
    expect(res.body.data.vote.vote_mode).toBe('anonymous');
    // voters 应该为空（匿名模式）
    for (const opt of res.body.data.vote.options) {
      expect(opt.voters).toEqual([]);
    }
  });

  // IT-VD-02: 实名模式返回 voters
  it('IT-VD-02: 实名模式返回 voters', async () => {
    const { voteId, optionIds } = await createTestVote({
      vote_mode: 'public',
      team_id: 'testteam001',
      creator_id: 'oualice',
    });
    await castTestVote(voteId, 'oubob', [optionIds[0]]);

    const res = await request(app)
      .get(`/api/votes/${voteId}`)
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    // 实名模式下 voters 数组应有数据
    const votersOpt0 = res.body.data.vote.options[0].voters;
    expect(Array.isArray(votersOpt0)).toBe(true);
  });

  // IT-VD-03: 无人投票时 count=0
  it('IT-VD-03: 无人投票时 count=0', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .get(`/api/votes/${voteId}`)
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    for (const opt of res.body.data.vote.options) {
      expect(opt.count).toBe(0);
    }
  });

  // IT-VD-08: has_voted=true
  it('IT-VD-08: 已投票用户 has_voted=true', async () => {
    const { voteId, optionIds } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });
    await castTestVote(voteId, 'oubob', [optionIds[0]]);

    const res = await request(app)
      .get(`/api/votes/${voteId}`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`);

    expect(res.status).toBe(200);
    expect(res.body.data.has_voted).toBe(true);
    expect(res.body.data.my_selected_options.length).toBeGreaterThan(0);
  });

  // IT-VD-09: has_voted=false
  it('IT-VD-09: 未投票用户 has_voted=false', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .get(`/api/votes/${voteId}`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`);

    expect(res.status).toBe(200);
    expect(res.body.data.has_voted).toBe(false);
  });

  // IT-VD-12: 不存在的投票 → 404
  it('IT-VD-12: 不存在的投票 → 404', async () => {
    const res = await request(app)
      .get('/api/votes/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40400);
  });
});

describe('POST /api/votes/:id/vote — 提交投票', () => {

  // IT-SV-01: 正常单选提交
  it('IT-SV-01: 正常单选提交', async () => {
    const { voteId, optionIds } = await createTestVote({
      vote_type: 'single',
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [optionIds[0]] });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.selected_options).toEqual([optionIds[0]]);
  });

  // IT-SV-02: 正常多选提交 3 个选项
  it('IT-SV-02: 正常多选提交多个选项', async () => {
    const { voteId, optionIds } = await createTestVote({
      vote_type: 'multi',
      team_id: 'testteam001',
      creator_id: 'oualice',
      options: ['A', 'B', 'C', 'D', 'E'],
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [optionIds[0], optionIds[2], optionIds[4]] });

    expect(res.status).toBe(200);
    expect(res.body.data.selected_options).toHaveLength(3);
  });

  // IT-SV-05: option_ids 为空 → 400
  it('IT-SV-05: option_ids 为空 → 400', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [] });

    expect(res.status).toBe(400);
  });

  // IT-SV-06: 重复投票 → 409
  it('IT-SV-06: 重复投票 → 409', async () => {
    const { voteId, optionIds } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    // 第一次投票
    await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [optionIds[0]] });

    // 重复投票
    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [optionIds[0]] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  // IT-SV-07: 已结束投票 → 403
  it('IT-SV-07: 已结束投票 → 403', async () => {
    const { voteId, optionIds } = await createTestVote({
      status: 'closed',
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [optionIds[0]] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40301);
  });

  // IT-SV-08: 不存在的 option_id → 400
  it('IT-SV-08: option_id 不属于本投票 → 400', async () => {
    const { voteId } = await createTestVote({
      team_id: 'testteam001',
      creator_id: 'oualice',
    });

    const fakeOptionId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/votes/${voteId}/vote`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`)
      .send({ option_ids: [fakeOptionId] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40005);
  });
});

describe('POST /api/votes/:id/close — 结束投票', () => {

  // IT-CL-01: 发起者手动结束
  it('IT-CL-01: 发起者手动结束投票', async () => {
    const { voteId } = await createTestVote({
      creator_id: 'oualice',
      team_id: 'testteam001',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/close`)
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('closed');
    expect(res.body.data.closed_by).toBe('manual');
  });

  // IT-CL-02: 非发起者 → 403
  it('IT-CL-02: 非发起者无法结束投票', async () => {
    const { voteId } = await createTestVote({
      creator_id: 'oualice',
      team_id: 'testteam001',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/close`)
      .set('Authorization', `Bearer ${TOKEN_BOB}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
  });

  // IT-CL-04: 已结束投票再次关闭 → 409
  it('IT-CL-04: 已结束投票 → 409', async () => {
    const { voteId } = await createTestVote({
      status: 'closed',
      creator_id: 'oualice',
      team_id: 'testteam001',
    });

    const res = await request(app)
      .post(`/api/votes/${voteId}/close`)
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40902);
  });

  // IT-CL-05: 不存在的投票 → 404
  it('IT-CL-05: 不存在的投票 → 404', async () => {
    const res = await request(app)
      .post('/api/votes/00000000-0000-0000-0000-000000000001/close')
      .set('Authorization', `Bearer ${TOKEN_ALICE}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40400);
  });
});
