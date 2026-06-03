/**
 * __tests__/testSetup.ts
 *
 * 测试基础设施 — PG 15 (localhost:5433) + Redis 7 (localhost:6380)
 * 数据隔离：每个 suite beforeAll 清理表 + afterAll 再次清理
 * Express 测试应用工厂
 */

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { testKnex } = require('./shared/db');
import jwt from 'jsonwebtoken';
import { feishuAuth } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rateLimiter';
import { errorHandler } from '../middleware/errorHandler';
import { VoteService } from '../services/voteService';
import { BallotService } from '../services/ballotService';
import { createVoteRouter } from '../routes/votes';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';

// Re-export testKnex for test files
export { testKnex };

/** 测试用 JWT 密钥（jest.setup.ts 中已初始化，此处保持一致） */
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-jest';

/** 生成测试用 JWT token */
export function signTestToken(userId: string, teamId: string, displayName: string): string {
  return jwt.sign(
    { user_id: userId, team_id: teamId, display_name: displayName },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Clear all rate limiter keys (call beforeEach in rate-limited tests) */
export async function clearRateLimitKeys(): Promise<void> {
  if (_testRedis) {
    try {
      const keys = await _testRedis.keys('rate:*');
      if (keys.length > 0) await _testRedis.del(keys);
    } catch {}
  }
}

// ---- Redis ----
let _testRedis: Redis;
export function getTestRedis(): Redis { return _testRedis; }

// ---- DDL + 清理 ----
let ddlDone = false;

async function ensureDDL(): Promise<void> {
  if (ddlDone) return;

  const isSQLite = (testKnex as any).client?.config?.client === 'better-sqlite3';

  if (!isSQLite) {
    // ── PostgreSQL DDL（真实连接时）──
    const dir = path.resolve(__dirname, '../../migrations');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      try { await testKnex.raw(sql); }
      catch (err: any) {
        if (!err.message?.includes('already exists') && err.code !== '42P07') throw err;
      }
    }
  } else {
    // ── SQLite 兼容 DDL（无 PG 密码时的回退方案）──
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS votes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        team_id TEXT NOT NULL,
        vote_type TEXT NOT NULL CHECK (vote_type IN ('single', 'multi')),
        vote_mode TEXT NOT NULL CHECK (vote_mode IN ('anonymous', 'public')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
        deadline TEXT NOT NULL,
        total_voters INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        closed_by TEXT CHECK (closed_by IN ('manual', 'auto')),
        del_flag INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        deleted_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_votes_team_status ON votes (team_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_votes_active_deadline ON votes (deadline, status)`,
      `CREATE TABLE IF NOT EXISTS options (
        id TEXT PRIMARY KEY,
        vote_id TEXT NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_options_vote_id ON options (vote_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS user_votes (
        id TEXT PRIMARY KEY,
        vote_id TEXT NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        selected_options TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (vote_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_votes_vote_id ON user_votes (vote_id)`,
    ]) {
      await testKnex.raw(stmt);
    }
  }

  ddlDone = true;
}

export async function cleanTestTables(): Promise<void> {
  await testKnex('audit_logs').del().catch(() => {});
  await testKnex('user_votes').del().catch(() => {});
  await testKnex('options').del().catch(() => {});
  await testKnex('votes').del().catch(() => {});
}

// ---- 测试数据助手 ----
export async function createTestVote(
  overrides: Partial<{
    id: string; title: string; creator_id: string; creator_name: string;
    team_id: string; vote_type: string; vote_mode: string; status: string;
    deadlineMinutes: number; total_voters: number; options: string[];
    del_flag?: boolean;
  }> = {}
): Promise<{ voteId: string; optionIds: string[] }> {
  const uuid = () => require('crypto').randomUUID();
  const voteId = overrides.id || uuid();
  const optionIds = (overrides.options || ['选项A', '选项B', '选项C'])
    .map(() => `${uuid()}`);

  await testKnex('votes').insert({
    id: voteId,
    title: overrides.title || '测试投票',
    creator_id: overrides.creator_id || 'oucreator001',
    creator_name: overrides.creator_name || '测试创建者',
    team_id: overrides.team_id || 'testteam001',
    vote_type: overrides.vote_type || 'single',
    vote_mode: overrides.vote_mode || 'anonymous',
    status: overrides.status || 'active',
    deadline: new Date(Date.now() + (overrides.deadlineMinutes ?? 60) * 60_000).toISOString(),
    total_voters: overrides.total_voters ?? 24,
    created_at: new Date().toISOString(),
    del_flag: overrides.del_flag ? 1 : 0,
  });

  const opts = overrides.options || ['选项A', '选项B', '选项C'];
  for (let i = 0; i < opts.length; i++) {
    await testKnex('options').insert({
      id: optionIds[i], vote_id: voteId, content: opts[i], sort_order: i,
    });
  }
  return { voteId, optionIds };
}

export async function castTestVote(voteId: string, userId: string, optionIds: string[]): Promise<void> {
  // knex pg 客户端自动将 JS 数组转换为 PG UUID[]
  await testKnex('user_votes').insert({
    id: require('crypto').randomUUID(),
    vote_id: voteId,
    user_id: userId,
    selected_options: optionIds,
    created_at: new Date().toISOString(),
  });
}

// ---- Express 测试应用 ----
export interface TestApp { app: express.Express; server: http.Server; io: SocketIOServer; }

export function createTestApp(): TestApp {
  const app = express();
  const server = http.createServer(app);
  app.use(cors());
  app.use(express.json());

  const auth = feishuAuth({ FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), checks: { postgres: 'ok', redis: 'ok' } }));

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
    path: '/ws', transports: ['websocket'], serveClient: false,
    pingInterval: 25_000, pingTimeout: 20_000,
  });

  const voteService = new VoteService(_testRedis, io);
  const ballotService = new BallotService(_testRedis, io);
  const { DeleteService } = require('../services/deleteService');
  const deleteService = new DeleteService(_testRedis, io);

  const apiRouter = express.Router();
  apiRouter.use(auth);
  apiRouter.use('/votes', createRateLimiter(_testRedis));
  apiRouter.use('/votes', createVoteRouter(voteService, ballotService, deleteService));
  app.use('/api', apiRouter);
  app.use('/api', errorHandler);
  return { app, server, io };
}

// ---- beforeAll / afterAll ----
export async function setupTestEnv(): Promise<TestApp> {
  _testRedis = new Redis({ host: 'localhost', port: 6380, lazyConnect: true });
  try {
    await _testRedis.connect();
    const keys = await _testRedis.keys('rate:*');
    if (keys.length > 0) await _testRedis.del(keys);
    await _testRedis.del('health:degraded');
  } catch { console.warn('[testSetup] Redis 不可用'); }

  // JWT_SECRET 由 jest.setup.ts 设置，此处不再覆盖

  await ensureDDL();
  await cleanTestTables();
  return createTestApp();
}

export async function teardownTestEnv(): Promise<void> {
  await cleanTestTables();
  if (_testRedis) {
    try {
      const keys = await _testRedis.keys('rate:*');
      if (keys.length > 0) await _testRedis.del(keys);
      await _testRedis.del('health:degraded');
    } catch {}
    await _testRedis.quit().catch(() => {});
  }
}
