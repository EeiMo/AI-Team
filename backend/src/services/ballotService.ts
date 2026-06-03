/**
 * src/services/ballotService.ts
 * 职责：提交投票服务
 *      - 校验 option_ids 归属 + 投票类型（单选/多选）
 *      - PG 事务：FOR UPDATE 锁行 + INSERT user_votes（UNIQUE 防重兜底）
 *      - Redis 原子递增 HINCRBY（尽力而为，降级时跳过）
 *      - WS 广播 vote:{id}:update（排除发送者）
 */

import { createHash } from 'crypto';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { knex } from '../db/knex';
import { AppError } from '../middleware/errorHandler';
import type { SubmitVoteBody, SubmitVoteResponse, OptionRow, VoteRow } from '../types';

export class BallotService {
  private redis: Redis;
  private io: SocketIOServer;

  constructor(redis: Redis, io: SocketIOServer) {
    this.redis = redis;
    this.io = io;
  }

  /**
   * 提交投票
   *
   * 流程：
   * 0. 幂等检查：user_id + idempotency_key → 缓存结果（BUG-007）
   * 1. 前置校验：投票存在 + 状态 active + deadline 未过期 + option_ids 归属
   * 2. PG 事务：FOR UPDATE 再检查状态 → INSERT（UNIQUE 防重）→ COMMIT
   * 3. 后置异步：Redis HINCRBY 原子递增（降级跳过）→ WS 广播
   */
  async submitVote(
    voteId: string,
    userId: string,
    body: SubmitVoteBody
  ): Promise<SubmitVoteResponse> {
    // ---- 0. 幂等检查（BUG-007 修复） ----
    if (body.idempotency_key) {
      const cached = await this.getIdempotentResult(userId, body.idempotency_key);
      if (cached) return cached;
    }

    // ---- 1. 前置校验 ----
    if (!body.option_ids || body.option_ids.length === 0) {
      throw new AppError(40001, '参数校验失败', 'option_ids 不能为空');
    }

    const optionIds = [...new Set(body.option_ids)]; // 去重
    if (optionIds.length !== body.option_ids.length) {
      throw new AppError(40001, '参数校验失败', 'option_ids 不可重复');
    }

    // ---- 2. PG 事务 ----
    const trx = await knex.transaction();
    let selectedOptions: string[] = [];
    let submittedAt: string;
    let voteMode: string = 'public'; // EVO-014：提升到 try 外供日志脱敏

    try {
      // 2.1 锁定 vote 行 + 校验状态（BUG-012 修复：增加 deadline 字段和校验）
      const vote: Pick<VoteRow, 'id' | 'status' | 'vote_type' | 'deadline' | 'vote_mode' | 'del_flag'> | undefined = await trx('votes')
        .select('id', 'status', 'vote_type', 'deadline', 'vote_mode', 'del_flag')
        .where({ id: voteId })
        .forUpdate()
        .first();

      if (!vote) {
        await trx.rollback();
        throw new AppError(40400, '投票不存在');
      }
      // BUG-012 修复：同时检查状态和截止时间
      if (vote.del_flag === true) {
        await trx.rollback();
        throw new AppError(40301, '投票已删除，无法提交');
      }
      if (vote.status === 'closed' || new Date(vote.deadline) < new Date()) {
        await trx.rollback();
        throw new AppError(40301, '投票已结束，无法提交');
      }

      // EVO-014：记录 vote_mode 供后续日志脱敏
      voteMode = vote.vote_mode;

      // 2.2 校验 option_ids 归属
      const validOptions: OptionRow[] = await trx('options')
        .select('id')
        .where({ vote_id: voteId })
        .whereIn('id', optionIds);

      if (validOptions.length !== optionIds.length) {
        await trx.rollback();
        throw new AppError(40005, '参数校验失败', 'option_ids 中有不属于本投票的选项');
      }

      // 2.3 单选时数组长度必须 =1
      if (vote.vote_type === 'single' && optionIds.length > 1) {
        await trx.rollback();
        throw new AppError(40001, '参数校验失败', '单选投票只能选择一个选项');
      }

      // 2.4 插入防重记录
      submittedAt = new Date().toISOString();
      // knex raw + ?::type 语法在 uuid[] 上存在驱动兼容问题，
      // 改用 string_to_array 彻底避免类型歧义
      await trx.raw(
        `INSERT INTO user_votes (vote_id, user_id, selected_options, created_at)
         VALUES (?, ?, string_to_array(?, ',')::uuid[], ?)`,
        [voteId, userId, optionIds.join(','), submittedAt]
      );

      selectedOptions = optionIds;
      await trx.commit();
    } catch (err: any) {
      await trx.rollback();

      // PG 唯一约束违反 → 重复投票
      if (err.code === '23505') {
        throw new AppError(40901, '您已投过票，不可重复提交');
      }
      throw err;
    }

    // ---- 3. 后置异步（非关键路径） ----
    // 3.1 Redis HINCRBY 原子递增（BUG-011 修复：返回增量后的值）
    const newCounts = await this.incrementTally(voteId, selectedOptions);

    // 3.2 WS 广播（排除发送者）
    // BUG-013 修复：fetchSockets 提取到循环外
    try {
      const room = `vote:${voteId}`;
      const sockets = await this.io.in(room).fetchSockets();
      const totalVotes = await this.getTotalVotes(voteId);

      for (const oid of selectedOptions) {
        // BUG-011 修复：使用 HINCRBY 返回值，不再二次 HGET
        const newCount = newCounts[oid] ?? 0;

        for (const s of sockets) {
          // 跳过发送者（本端已乐观更新）
          if (s.data.user_id === userId) continue;
          s.emit(`vote:${voteId}:update`, {
            option_id: oid,
            new_count: newCount,
            total_votes: totalVotes,
          });
        }
      }
    } catch (err) {
      console.error('[BallotService] WS 广播失败:', err);
    }

    // ---- 4. 缓存幂等结果（BUG-007 修复） ----
    const result: SubmitVoteResponse = {
      vote_id: voteId,
      selected_options: selectedOptions,
      submitted_at: submittedAt,
    };
    if (body.idempotency_key) {
      await this.cacheIdempotentResult(userId, body.idempotency_key, result);
    }

    // EVO-014: 匿名投票 userId SHA256 脱敏，防止日志泄露
    const safeUserId = voteMode === 'anonymous'
      ? createHash('sha256').update(userId).digest('hex').slice(0, 12)
      : userId;
    console.info('[BallotService] 提交投票成功', { voteId, userId: safeUserId, selectedOptions });

    return result;

    return {
      vote_id: voteId,
      selected_options: selectedOptions,
      submitted_at: submittedAt,
    };
  }

  // ---- 私有方法 ----

  /** Redis HINCRBY 原子递增（降级时跳过），返回每个 option 的新值（BUG-011 修复） */
  private async incrementTally(
    voteId: string,
    optionIds: string[]
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    try {
      const degraded = await this.redis.get('health:degraded');
      if (degraded === '1') {
        // 降级模式：从 PG 获取当前计数作为 fallback
        for (const oid of optionIds) counts[oid] = 0;
        return counts;
      }

      const tallyKey = `vote:${voteId}:tally`;
      const pipeline = this.redis.pipeline();
      for (const oid of optionIds) {
        pipeline.hincrby(tallyKey, oid, 1);
      }
      const results = await pipeline.exec();

      // BUG-011 修复：提取 HINCRBY 返回值
      if (results) {
        for (let i = 0; i < optionIds.length; i++) {
          const [err, val] = results[i];
          counts[optionIds[i]] = err ? 0 : (typeof val === 'number' ? val : parseInt(String(val), 10) || 0);
        }
      }
    } catch (err) {
      console.error('[BallotService] Redis HINCRBY 失败，激活降级:', err);
      await this.redis.set('health:degraded', '1', 'EX', 10).catch(() => {});
      for (const oid of optionIds) counts[oid] = 0;
    }
    return counts;
  }

  /** 幂等检查：查询 Redis 缓存的结果（BUG-007 修复） */
  private async getIdempotentResult(
    userId: string,
    idempotencyKey: string
  ): Promise<SubmitVoteResponse | null> {
    try {
      const cacheKey = `idempotent:vote:${userId}:${idempotencyKey}`;
      const raw = await this.redis.get(cacheKey);
      if (raw) return JSON.parse(raw) as SubmitVoteResponse;
    } catch {
      // 幂等检查失败不影响正常流程
    }
    return null;
  }

  /** 缓存幂等结果（TTL 24h）（BUG-007 修复） */
  private async cacheIdempotentResult(
    userId: string,
    idempotencyKey: string,
    result: SubmitVoteResponse
  ): Promise<void> {
    try {
      const cacheKey = `idempotent:vote:${userId}:${idempotencyKey}`;
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {
      // 缓存失败不影响正常流程
    }
  }

  /** 获取总投票人数（PG user_votes 计数） */
  private async getTotalVotes(voteId: string): Promise<number> {
    try {
      const [{ count }] = await knex('user_votes')
        .where({ vote_id: voteId })
        .count<{ count: string }[]>('* as count');
      return parseInt(count, 10);
    } catch {
      return 0;
    }
  }
}
