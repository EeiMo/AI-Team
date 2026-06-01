/**
 * src/app.ts
 * 职责：应用入口
 *      - Express 4 + Socket.IO 4 集成
 *      - 中间件注册：cors / json / 飞书 SSO auth / 速率限制 / 错误处理
 *      - 路由挂载
 *      - WS 初始化 + 事件处理器
 *      - 启动 DeadlineWorker
 *      - 健康检查端点
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';

import { config } from './config';
import { feishuAuth } from './middleware/auth';
import { createRateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { VoteService } from './services/voteService';
import { BallotService } from './services/ballotService';
import { startDeadlineWorker } from './services/deadlineWorker';
import { startTallySync } from './services/tallySync';
import { startRedisHealth } from './services/redisHealth';
import { createVoteRouter } from './routes/votes';
import { registerWsHandlers, wsAuthMiddleware } from './ws/handlers';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

async function main(): Promise<void> {
  // ---- 初始化 Redis ----
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null; // 停止重试
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  try {
    await redis.connect();
    console.info('[App] Redis 连接成功');
  } catch (err) {
    console.error('[App] Redis 连接失败，将以降级模式运行:', err);
  }

  // ---- 初始化 Express ----
  const app = express();

  // 基础中间件
  app.use(cors());
  app.use(express.json());

  // 飞书 SSO 认证中间件（全局，白名单路由除外）
  const auth = feishuAuth({
    FEISHU_APP_ID: config.FEISHU_APP_ID,
    FEISHU_APP_SECRET: config.FEISHU_APP_SECRET,
  });

  // 健康检查端点（无需认证）
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ---- 路由 ----
  // API 路由需要认证
  const apiRouter = express.Router();
  apiRouter.use(auth); // 所有 /api/* 都要飞书 SSO

  // 创建 HTTP 服务器（供 Socket.IO 共享）
  const server = http.createServer(app);

  // 初始化 Socket.IO（在 API 路由注册前创建，以便 VoteService 引用）
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
    path: '/ws',
    transports: ['websocket'], // MVP 仅 WebSocket
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  // Socket.IO 认证中间件
  io.use(wsAuthMiddleware);

  // Socket.IO 连接事件
  io.on('connection', (socket) => {
    registerWsHandlers(socket);
  });

  // 初始化服务
  const voteService = new VoteService(redis, io);
  const ballotService = new BallotService(redis, io);

  // 速率限制中间件（加在 auth 之后，路由之前）
  const rateLimiter = createRateLimiter(redis);
  apiRouter.use('/votes', rateLimiter);

  // 投票路由
  const voteRouter = createVoteRouter(voteService, ballotService);
  apiRouter.use('/votes', voteRouter);

  // 挂载 API 路由
  app.use('/api', apiRouter);

  // 全局错误处理（挂在 API 路由后）
  app.use('/api', errorHandler);

  // ---- 启动 DeadlineWorker ----
  startDeadlineWorker(redis, io);

  // ---- 启动 Redis 健康监测 (BUG-006) ----
  const stopRedisHealth = await startRedisHealth(redis);

  // ---- 启动 TallySync 定期对账 (BUG-005) ----
  const stopTallySync = startTallySync(redis);

  // ---- 启动 HTTP 服务 ----
  server.listen(config.PORT, () => {
    console.info(`[App] 服务已启动 http://localhost:${config.PORT}`);
    console.info(`[App] 环境: ${config.NODE_ENV}`);
    console.info(`[App] WebSocket 路径: /ws`);
  });

  // ---- 优雅关闭 ----
  const shutdown = async (signal: string) => {
    console.info(`[App] 收到 ${signal} 信号，准备关闭...`);
    stopRedisHealth();
    stopTallySync();
    io.close();
    server.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[App] 启动失败:', err);
  process.exit(1);
});
