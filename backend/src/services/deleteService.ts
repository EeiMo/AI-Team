/**
 * src/services/deleteService.ts
 * 职责：软删除投票服务
 *      - 鉴权：creator_id + team_id 双重校验
 *      - 幂等：已删除投票第 2 次 DELETE 返回 code: 0 幂等成功
 *      - 软删除：DB UPDATE del_flag = TRUE
 *      - Redis 清理：tally hash + deadline key
 *      - WS 广播：vote:{id}:deleted
 *      - WS 房间清理：io.in(room).socketsLeave(room)
 *      - 审计日志：写入 audit_logs 表
 */

import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { knex } from '../db/knex';
import { AppError } from '../middleware/errorHandler';
import { AuditService } from './auditService';
import type { ServerToClientEvents, ClientToServerEvents } from '../types';

export class DeleteService {
  private redis: Redis;
  private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  private auditService: AuditService;

  constructor(redis: Redis, io: SocketIOServer) {
    this.redis = redis;
    this.io = io;
    this.auditService = new AuditService();
  }

  /**
   * 删除投票（软删除）
   *
   * 流程：
   * 1. 查询 votes 表获取创建者、团队、当前 del_flag、标题
   * 2. 幂等检查（优先）：已删除 -> 返回 code: 0 幂等成功（减少无效 DB 查询后的权限检查）
   * 3. 投票不存在 -> 40401
   * 4. 鉴权：creator_id === current_user && team_id === current_team
   * 5. 执行软删除 DB UPDATE
   * 6. 后置异步：Redis 清理 + WS 广播 + WS 房间清理 + 审计日志
   */
  async deleteVote(
    voteId: string,
    currentUserId: string,
    currentTeamId: string,
    ip: string | null,
    userAgent: string | null
  ): Promise<void> {
    // ---- 1. 查询投票 ----
    const vote = await knex('votes')
      .select('id', 'creator_id', 'team_id', 'del_flag', 'title', 'status')
      .where({ id: voteId })
      .first();

    // ---- 3. 投票不存在（ID 从未创建） ----
    if (!vote) {
      throw new AppError(40401, '投票不存在');
    }

    // ---- 2. 幂等检查（优先）：已删除 -> 幂等成功，减少无效 DB 查询后的权限检查 ----
    if (vote.del_flag === true) {
      console.info('[DeleteService] 幂等删除，投票已删', { voteId, userId: currentUserId });
      return;
    }

    // ---- 4. 鉴权 ----
    if (vote.creator_id !== currentUserId) {
      throw new AppError(40303, '仅投票创建者可删除');
    }
    if (vote.team_id !== currentTeamId) {
      throw new AppError(40304, '无权删除此投票');
    }

    // ---- 5. 执行软删除 ----
    const now = new Date().toISOString();
    await knex('votes')
      .where({ id: voteId })
      .update({
        del_flag: true,
        deleted_at: now,
        deleted_by: currentUserId,
      });

    console.info('[DeleteService] 软删除成功', { voteId, userId: currentUserId, deletedAt: now });

    // ---- 6. 后置异步（非关键路径，失败不阻塞） ----

    // 6.1 Redis 清理
    this.cleanRedis(voteId);

    // 6.2 WS 广播 vote:{id}:deleted
    this.broadcastDeleted(voteId, currentUserId, now);

    // 6.3 WS 房间清理
    this.leaveAllSockets(voteId);

    // 6.4 审计日志
    this.auditService.logDeleteVote({
      entityId: voteId,
      userId: currentUserId,
      teamId: currentTeamId,
      ip,
      userAgent,
      detail: {
        vote_title: vote.title,
        vote_status: vote.status,
        deleted_at: now,
      },
    });
  }

  // ---- 私有方法 ----

  /** 清理 Redis tally hash & deadline key */
  private async cleanRedis(voteId: string): Promise<void> {
    try {
      const degraded = await this.redis.get('health:degraded');
      if (degraded === '1') {
        console.warn('[DeleteService] Redis 降级模式，跳过 Redis 清理');
        return;
      }

      const tallyKey = `vote:${voteId}:tally`;
      const deadlineKey = `vote:${voteId}:deadline`;

      const pipeline = this.redis.pipeline();
      pipeline.del(tallyKey);
      pipeline.del(deadlineKey);
      await pipeline.exec();

      console.info('[DeleteService] Redis 清理成功', { voteId, keys: [tallyKey, deadlineKey] });
    } catch (err) {
      console.error('[DeleteService] Redis 清理失败（不阻塞主流程）:', err);
    }
  }

  /** WS 广播删除事件 */
  private broadcastDeleted(voteId: string, deletedBy: string, deletedAt: string): void {
    try {
      const eventName = `vote:${voteId}:deleted` as const;
      // TypeScript 泛型约束：通过 dynamic emit 接口
      (this.io.to(`vote:${voteId}`) as any).emit(eventName, {
        vote_id: voteId,
        deleted_by: deletedBy,
        deleted_at: deletedAt,
      });
      console.info('[DeleteService] WS 广播 vote:{id}:deleted', { voteId });
    } catch (err) {
      console.error('[DeleteService] WS 广播失败（不阻塞主流程）:', err);
    }
  }

  /** 所有 sockets 离开该投票房间 */
  private async leaveAllSockets(voteId: string): Promise<void> {
    try {
      const room = `vote:${voteId}`;
      const sockets = await this.io.in(room).fetchSockets();
      for (const socket of sockets) {
        socket.leave(room);
      }
      console.info('[DeleteService] WS 房间清理完成', { voteId, socketsLeft: sockets.length });
    } catch (err) {
      console.error('[DeleteService] WS 房间清理失败（不阻塞主流程）:', err);
    }
  }
}
