/**
 * src/ws/handlers.ts
 * 职责：WebSocket 事件处理
 *      - join:vote    → socket.join(`vote:{vote_id}`)
 *      - leave:vote   → socket.leave(`vote:{vote_id}`)
 *      - 权限校验：确认用户 token 有效
 */

import { Socket } from 'socket.io';
import { knex } from '../db/knex';
import { verifyFeishuToken } from '../middleware/auth';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';

/**
 * 注册 WS 事件处理器
 */
export function registerWsHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>
): void {
  const userId = socket.data.user_id;
  const teamId = socket.data.team_id;

  console.info('[WS] 客户端连接', {
    socketId: socket.id,
    userId,
    teamId,
  });

  // ---- 加入投票房间 ----
  socket.on('join:vote', async ({ vote_id }) => {
    if (!vote_id) {
      console.warn('[WS] join:vote 缺少 vote_id', { socketId: socket.id });
      return;
    }

    // BUG-003 修复：团队权限校验 — 用户只能加入本团队的投票房间
    try {
      const vote = await knex('votes').select('team_id').where({ id: vote_id }).first();
      if (!vote || vote.team_id !== socket.data.team_id) {
        console.warn('[WS] 跨团队 join 尝试', { socketId: socket.id, vote_id, teamId });
        return;
      }
    } catch (err) {
      console.error('[WS] join:vote 校验失败:', err);
      return;
    }

    const room = `vote:${vote_id}`;
    socket.join(room);
    console.info('[WS] 加入房间', { socketId: socket.id, userId, room });
  });

  // ---- 离开投票房间 ----
  socket.on('leave:vote', ({ vote_id }) => {
    if (!vote_id) {
      console.warn('[WS] leave:vote 缺少 vote_id', { socketId: socket.id });
      return;
    }

    const room = `vote:${vote_id}`;
    socket.leave(room);
    console.info('[WS] 离开房间', { socketId: socket.id, userId, room });
  });

  // ---- 断开连接 ----
  socket.on('disconnect', (reason) => {
    console.info('[WS] 客户端断开', {
      socketId: socket.id,
      userId,
      reason,
    });
  });
}

/**
 * WS 认证中间件：校验 token（与 REST auth 共用）
 * 注入 socket.data = { user_id, team_id, display_name }
 */
export async function wsAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('缺少认证 token'));
    }

    // 调用 verifyFeishuToken 进行验签
    const user = await verifyFeishuToken(token);
    socket.data.user_id = user.user_id;
    socket.data.team_id = user.team_id;
    socket.data.display_name = user.display_name;
    next();
  } catch (err) {
    next(new Error('认证失败'));
  }
}
