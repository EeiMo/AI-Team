/**
 * src/services/voteService.ts
 * 职责：投票 CRUD 服务
 *      - createVote:    事务写 PG（votes + options） + 初始化 Redis tally + 设 deadline TTL
 *      - listVotes:     分页查询，按 team_id + status 过滤
 *      - getVoteDetail: 详情含 tally merged（Redis → PG 回退），字段级隐私过滤
 *      - closeVote:     手动结束（事务 + FOR UPDATE），WS 广播
 */

import crypto from 'crypto';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { knex } from '../db/knex';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { scheduleReminder } from './deadlineWorker';
import type {
  CreateVoteBody,
  VoteRow,
  OptionRow,
  OptionWithTally,
  VoteListItem,
  VoteListQuery,
  VoteListResponse,
  VoteDetailResponse,
  VoteResponse,
  CloseVoteResponse,
} from '../types';

// ---- 输入校验 ----

function validateCreateBody(body: CreateVoteBody): void {
  const { title, options, vote_type, vote_mode, deadline_minutes } = body;

  if (!title || title.trim().length === 0) {
    throw new AppError(40001, '参数校验失败', 'title 不能为空');
  }
  if (title.trim().length > 100) {
    throw new AppError(40001, '参数校验失败', 'title 不能超过 100 个字符');
  }
  if (!options || !Array.isArray(options) || options.length < 2 || options.length > 10) {
    throw new AppError(40002, '参数校验失败', 'options 数量须在 2-10 之间');
  }
  const trimmedOptions = options.map(o => o.trim());
  if (trimmedOptions.some(o => o.length === 0 || o.length > 50)) {
    throw new AppError(40001, '参数校验失败', '每个选项 1-50 字符');
  }
  if (new Set(trimmedOptions).size !== trimmedOptions.length) {
    throw new AppError(40003, '参数校验失败', '选项不可重复');
  }
  if (!['single', 'multi'].includes(vote_type)) {
    throw new AppError(40001, '参数校验失败', 'vote_type 须为 single 或 multi');
  }
  if (!['anonymous', 'public'].includes(vote_mode)) {
    throw new AppError(40001, '参数校验失败', 'vote_mode 须为 anonymous 或 public');
  }
  if (typeof deadline_minutes !== 'number' || deadline_minutes < 1 || deadline_minutes > 10080) {
    throw new AppError(40004, '参数校验失败', 'deadline_minutes 须在 1-10080 之间');
  }
}

/** UUID v7 — RFC 9562 时间有序 UUID */
function uuidV7(): string {
  const ms = Date.now();
  const rand = crypto.randomBytes(10);
  const tsHex = ms.toString(16).padStart(12, '0').slice(-12);
  const randAHex = (rand.readUInt16BE(0) & 0x0FFF).toString(16).padStart(3, '0');
  rand[2] = (rand[2] & 0x3F) | 0x80;
  const randBHex = rand.slice(2).toString('hex');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8)}-7${randAHex}-${randBHex.slice(0, 4)}-${randBHex.slice(4)}`;
}

// ============================================================
// VoteService
// ============================================================

export class VoteService {
  private redis: Redis;
  private io: SocketIOServer;

  constructor(redis: Redis, io: SocketIOServer) {
    this.redis = redis;
    this.io = io;
  }

  /**
   * 创建投票
   * - PG 事务：写入 votes + options（N 条）
   * - Redis：初始化 HSET vote:{id}:tally（全部 option 设 0）
   * - Redis：SET vote:{id}:deadline（带 TTL）
   */
  async createVote(
    body: CreateVoteBody,
    userId: string,
    userName: string,
    teamId: string,
    totalVoters: number
  ): Promise<VoteResponse> {
    validateCreateBody(body);

    // BUG-007 修复：幂等检查
    if (body.idempotency_key) {
      const cached = await this.getIdempotentCreateResult(userId, body.idempotency_key);
      if (cached) return cached;
    }

    const voteId = uuidV7();
    const optionIds = body.options.map(() => uuidV7());
    const deadline = new Date(Date.now() + body.deadline_minutes * 60_000);
    const now = new Date();

    // BUG-008 修复：在 PG 事务前初始化 Redis tally（此时投票不可见，无竞态窗口）
    // 如果 PG 事务后失败，Redis 中有残留的 0 值 Hash，无危害（下次 TallySync 可清理）
    await this.initRedisTally(voteId, optionIds);

    // PG 事务
    const trx = await knex.transaction();
    try {
      // 插入投票主表
      await trx('votes').insert({
        id: voteId,
        title: body.title.trim(),
        creator_id: userId,
        creator_name: userName,
        team_id: teamId,
        vote_type: body.vote_type,
        vote_mode: body.vote_mode,
        status: 'active',
        deadline: deadline.toISOString(),
        total_voters: totalVoters,
        created_at: now.toISOString(),
      });

      // 批量插入选项
      const optionRows = body.options.map((content, i) => ({
        id: optionIds[i],
        vote_id: voteId,
        content: content.trim(),
        sort_order: i,
      }));
      await trx('options').insert(optionRows);

      await trx.commit();

      // Redis 初始化（事务前已执行，此处跳过；参见 BUG-008 修复）

      // 设置 deadline TTL（秒）
      const ttlSeconds = Math.ceil((deadline.getTime() - Date.now()) / 1000);
      if (ttlSeconds > 0) {
        await this.redis.set(
          `vote:${voteId}:deadline`,
          deadline.toISOString(),
          'EX',
          ttlSeconds
        );
      }

      // BUG-002 修复：调度截止前 60 秒提醒
      await scheduleReminder(this.redis, voteId, deadline);

      console.info('[VoteService] 创建投票成功', { voteId, userId, teamId });

      const result: VoteResponse = {
        vote: {
          id: voteId,
          title: body.title.trim(),
          creator_id: userId,
          creator_name: userName,
          team_id: teamId,
          vote_type: body.vote_type,
          vote_mode: body.vote_mode,
          status: 'active',
          deadline: deadline.toISOString(),
          total_voters: totalVoters,
          created_at: now.toISOString(),
          closed_at: null,
          closed_by: null,
          options: optionRows,
        },
      };

      // BUG-007 修复：缓存幂等结果
      if (body.idempotency_key) {
        await this.cacheIdempotentCreateResult(userId, body.idempotency_key, result);
      }

      return result;
    } catch (err: any) {
      await trx.rollback();
      throw err;
    }
  }

  /**
   * 投票列表 — 分页 + 按 status 筛选
   */
  async listVotes(
    teamId: string,
    query: VoteListQuery
  ): Promise<VoteListResponse> {
    const status = query.status || 'active';
    const page = Math.max(1, query.page || 1);
    const size = Math.min(100, Math.max(1, query.size || 20));
    const offset = (page - 1) * size;

    const [{ count }] = await knex('votes')
      .where({ team_id: teamId, status })
      .count<{ count: string }[]>('* as count');
    const total = parseInt(count, 10);

    const rows: VoteRow[] = await knex('votes')
      .where({ team_id: teamId, status })
      .orderBy('created_at', 'desc')
      .limit(size)
      .offset(offset);

    // 批量获取每个投票的投票数
    const voteIds = rows.map(r => r.id);
    const voteCounts: Record<string, number> = {};
    if (voteIds.length > 0) {
      const cntRows = await knex('user_votes')
        .select('vote_id')
        .whereIn('vote_id', voteIds)
        .count<{ vote_id: string; count: string }[]>('* as count')
        .groupBy('vote_id');
      for (const r of cntRows) {
        voteCounts[r.vote_id] = parseInt(r.count, 10);
      }
    }

    const items: VoteListItem[] = rows.map(r => ({
      id: r.id,
      title: r.title,
      creator_id: r.creator_id,
      creator_name: r.creator_name,
      team_id: r.team_id,
      vote_type: r.vote_type,
      vote_mode: r.vote_mode,
      status: r.status,
      deadline: r.deadline,
      total_voters: r.total_voters,
      vote_count: voteCounts[r.id] || 0,
      created_at: r.created_at,
    }));

    return { items, total, page, size };
  }

  /**
   * 投票详情 — 含 tally（Redis 优先，PG 回退），字段级隐私过滤
   */
  async getVoteDetail(
    voteId: string,
    userId: string
  ): Promise<VoteDetailResponse> {
    // 查询投票主表
    const vote: VoteRow | undefined = await knex('votes').where({ id: voteId }).first();
    if (!vote) {
      throw new AppError(40400, '投票不存在');
    }

    // 查询选项
    const options: OptionRow[] = await knex('options')
      .where({ vote_id: voteId })
      .orderBy('sort_order', 'asc');

    // 查询当前用户是否已投
    const myVote = await knex('user_votes')
      .where({ vote_id: voteId, user_id: userId })
      .first();
    const hasVoted = !!myVote;
    const mySelectedOptions: string[] = myVote ? myVote.selected_options : [];

    // 获取 tally（Redis 优先，PG 回退）
    const tally = await this.getTally(voteId, options.map(o => o.id));

    // 获取 voters 信息（仅公开 + 已结束 或 请求者是发起者）
    const votersMap = await this.getVotersMap(voteId, vote, userId);

    // 组装选项
    const optionsWithTally: OptionWithTally[] = options.map(o => ({
      id: o.id,
      content: o.content,
      sort_order: o.sort_order,
      count: tally[o.id] || 0,
      voters: votersMap[o.id] || [],
    }));

    return {
      vote: { ...vote, options: optionsWithTally },
      has_voted: hasVoted,
      my_selected_options: mySelectedOptions,
    };
  }

  /**
   * 手动结束投票
   * - 事务内 FOR UPDATE + 权限校验
   * - 事务外：删除 deadline key + WS 广播
   */
  async closeVote(
    voteId: string,
    userId: string,
    teamId: string
  ): Promise<CloseVoteResponse> {
    const trx = await knex.transaction();
    let closedAt: string;

    try {
      const row = await trx('votes')
        .select('id', 'status', 'creator_id', 'team_id')
        .where({ id: voteId })
        .forUpdate()
        .first();

      if (!row) {
        await trx.rollback();
        throw new AppError(40400, '投票不存在');
      }
      if (row.status === 'closed') {
        await trx.rollback();
        throw new AppError(40902, '投票已结束');
      }
      if (row.creator_id !== userId) {
        await trx.rollback();
        throw new AppError(40302, '仅投票发起者可结束投票');
      }
      if (row.team_id !== teamId) {
        await trx.rollback();
        throw new AppError(40302, '无操作权限');
      }

      closedAt = new Date().toISOString();
      await trx('votes')
        .where({ id: voteId })
        .update({
          status: 'closed',
          closed_at: closedAt,
          closed_by: 'manual',
        });

      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // 事务外后置操作
    await this.redis.del(`vote:${voteId}:deadline`).catch(() => {});

    this.io.to(`vote:${voteId}`).emit(`vote:${voteId}:closed`, {
      closed_by: 'manual',
      closed_at: closedAt,
    });

    console.info('[VoteService] 手动结束投票', { voteId, userId });

    return {
      vote_id: voteId,
      status: 'closed',
      closed_by: 'manual',
      closed_at: closedAt,
    };
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /** BUG-007 修复：幂等检查 — 查询创建投票的缓存结果 */
  private async getIdempotentCreateResult(
    userId: string,
    idempotencyKey: string
  ): Promise<VoteResponse | null> {
    try {
      const cacheKey = `idempotent:create:${userId}:${idempotencyKey}`;
      const raw = await this.redis.get(cacheKey);
      if (raw) return JSON.parse(raw) as VoteResponse;
    } catch {
      // 幂等检查失败不影响正常流程
    }
    return null;
  }

  /** BUG-007 修复：缓存创建投票的幂等结果（TTL 24h） */
  private async cacheIdempotentCreateResult(
    userId: string,
    idempotencyKey: string,
    result: VoteResponse
  ): Promise<void> {
    try {
      const cacheKey = `idempotent:create:${userId}:${idempotencyKey}`;
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
    } catch {
      // 缓存失败不影响正常流程
    }
  }

  /** 初始化 Redis tally Hash */
  private async initRedisTally(voteId: string, optionIds: string[]): Promise<void> {
    try {
      const degraded = await this.redis.get('health:degraded');
      if (degraded === '1') return;

      const tallyKey = `vote:${voteId}:tally`;
      const fields: string[] = [];
      for (const oid of optionIds) {
        fields.push(oid, '0');
      }
      await this.redis.hset(tallyKey, ...fields);
    } catch (err) {
      console.error('[VoteService] Redis tally 初始化失败:', err);
      await this.redis.set('health:degraded', '1', 'EX', 10).catch(() => {});
    }
  }

  /** 获取 tally：Redis 优先，PG 回退 */
  private async getTally(
    voteId: string,
    optionIds: string[]
  ): Promise<Record<string, number>> {
    try {
      const degraded = await this.redis.get('health:degraded');
      if (degraded === '1') return this.getTallyFromPG(voteId, optionIds);

      const tallyKey = `vote:${voteId}:tally`;
      const raw = await this.redis.hgetall(tallyKey);

      // Redis 有数据则直接返回
      if (raw && Object.keys(raw).length > 0) {
        const tally: Record<string, number> = {};
        for (const [oid, count] of Object.entries(raw)) {
          tally[oid] = parseInt(count, 10) || 0;
        }
        // 补齐缺失的 option（创建后新增场景，MVP 无此场景但预留）
        for (const oid of optionIds) {
          if (!(oid in tally)) tally[oid] = 0;
        }
        return tally;
      }

      // Redis 数据为空 → PG 回退重建
      return this.getTallyFromPG(voteId, optionIds);
    } catch {
      return this.getTallyFromPG(voteId, optionIds);
    }
  }

  /** 从 PG 聚合票数 */
  private async getTallyFromPG(
    voteId: string,
    optionIds: string[]
  ): Promise<Record<string, number>> {
    const tally: Record<string, number> = {};
    for (const oid of optionIds) tally[oid] = 0;

    const rows: { option_id: string; count: string }[] = await knex.raw(
      `SELECT o.id as option_id, COUNT(uv.id)::text as count
       FROM options o
       LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
       WHERE o.vote_id = ?
       GROUP BY o.id`,
      [voteId]
    );
    for (const r of rows) {
      tally[r.option_id] = parseInt(r.count, 10) || 0;
    }
    return tally;
  }

  /**
   * 获取 voters 映射（字段级隐私过滤）
   * - anonymous + active → 空数组
   * - anonymous + closed → 空数组（仍不暴露）
   * - public + 请求者是发起者 → 包含 voters
   * - public + 请求者是普通参与者 → 包含 voters（公开投票信息透明）
   */
  private async getVotersMap(
    voteId: string,
    vote: VoteRow,
    requesterId: string
  ): Promise<Record<string, { user_id: string; user_name: string }[]>> {
    const empty: Record<string, { user_id: string; user_name: string }[]> = {};

    // 匿名模式下始终返回空
    if (vote.vote_mode === 'anonymous') return empty;

    // 实名模式下获取投票人
    const rows = await knex('user_votes').where({ vote_id: voteId });
    const map: Record<string, { user_id: string; user_name: string }[]> = {};

    for (const r of rows) {
      for (const oid of r.selected_options) {
        if (!map[oid]) map[oid] = [];
        map[oid].push({
          user_id: r.user_id,
          // MVP: creator_name 仅在发起者记录中存在，其他用户作为 user_id 展示
          user_name: r.user_id === vote.creator_id ? vote.creator_name : r.user_id,
        });
      }
    }
    return map;
  }
}
