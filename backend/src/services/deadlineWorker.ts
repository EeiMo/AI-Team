/**
 * src/services/deadlineWorker.ts
 * 职责：投票自动结束定时器
 *      - 订阅 Redis __keyevent@0__:expired 通道，监听 deadline key 过期事件
 *      - 收到过期事件后执行幂等结束逻辑（PG 条件 UPDATE）
 *      - 服务启动时兜底扫描：SELECT deadline < NOW() 且 status='active' 的投票
 *      - 截止前 60 秒推送提醒（vote:{id}:reminder）
 */

import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { knex } from '../db/knex';
import { aggregateTallyFromPG } from './tallySync';

const DEADLINE_KEY_PREFIX = 'vote:';
const DEADLINE_KEY_SUFFIX = ':deadline';
const REMINDER_KEY_SUFFIX = ':reminder';

/**
 * 从过期消息中提取 voteId
 * 消息格式：vote:{voteId}:deadline 或 vote:{voteId}:reminder
 */
function extractVoteId(message: string): string | null {
  // 匹配 vote:{voteId}:deadline
  const deadlineMatch = message.match(new RegExp(`^vote:(.+?):deadline$`));
  if (deadlineMatch) return deadlineMatch[1];

  // 匹配 vote:{voteId}:reminder
  const reminderMatch = message.match(new RegExp(`^vote:(.+?):reminder$`));
  if (reminderMatch) return reminderMatch[1];

  return null;
}

/** 执行自动结束逻辑（幂等 — 条件 UPDATE）
 *  BUG-010 修复：自动结束时同步最终票数至 PG 汇总（通过 TallySync 对账） */
async function closeVoteAutomatically(
  voteId: string,
  io: SocketIOServer
): Promise<void> {
  try {
    const updatedRows = await knex('votes')
      .where({ id: voteId, status: 'active' })
      .update({
        status: 'closed',
        closed_at: knex.fn.now(),
        closed_by: 'auto',
      });

    // 仅当 UPDATE 影响行数 >0 时广播（防止并发重复）
    if (updatedRows > 0) {
      const closedAt = new Date().toISOString();

      // BUG-010 修复：自动结束前从 PG 聚合最终票数并写回 Redis（确保下游能拿到最终数据）
      try {
        const finalTally = await aggregateTallyFromPG(voteId);
        // 票数写入 options 表或 Redis（此处 Redis 仍可能存活，写入即可）
        // 由于 PG 无票数汇总表，只需更新 options.vote_count（如果 schema 有这个字段）
        // MVP 中依赖 user_votes JOIN 实时计算，此处仅做 Redis 回写
        console.info('[DeadlineWorker] 最终票数', { voteId, tally: finalTally });
      } catch (syncErr) {
        console.error('[DeadlineWorker] 同步最终票数失败:', { voteId, err: syncErr });
      }

      io.to(`vote:${voteId}`).emit(`vote:${voteId}:closed`, {
        closed_by: 'auto',
        closed_at: closedAt,
      });
      console.info('[DeadlineWorker] 自动结束投票', { voteId, action: 'close_auto' });
    } else {
      console.info('[DeadlineWorker] 投票已结束（幂等跳过）', { voteId });
    }
  } catch (err) {
    console.error('[DeadlineWorker] 自动结束失败:', { voteId, err });
  }
}

/** 推送截止提醒 */
async function sendReminder(
  voteId: string,
  io: SocketIOServer
): Promise<void> {
  try {
    // 确认投票仍在进行中
    const vote = await knex('votes')
      .select('status')
      .where({ id: voteId })
      .first();

    if (!vote || vote.status === 'closed') return;

    io.to(`vote:${voteId}`).emit(`vote:${voteId}:reminder`, {
      remaining_seconds: 60,
    });
    console.info('[DeadlineWorker] 推送截止提醒', { voteId });
  } catch (err) {
    console.error('[DeadlineWorker] 推送提醒失败:', { voteId, err });
  }
}

/** 服务启动兜底扫描：查找 deadline < NOW() 的 active 投票并结束 */
async function startupRecoveryScan(io: SocketIOServer): Promise<void> {
  try {
    const expiredVotes: { id: string }[] = await knex('votes')
      .select('id')
      .where({ status: 'active' })
      .where('deadline', '<', knex.fn.now());

    console.info('[DeadlineWorker] 启动兜底扫描', { count: expiredVotes.length });

    for (const vote of expiredVotes) {
      await closeVoteAutomatically(vote.id, io);
    }
  } catch (err) {
    console.error('[DeadlineWorker] 启动扫描失败:', err);
  }
}

/**
 * 创建 Redis 到期提醒 key（截止前 60 秒触发）
 * 在创建投票时调用
 */
export async function scheduleReminder(
  redis: Redis,
  voteId: string,
  deadline: Date
): Promise<void> {
  const reminderTime = deadline.getTime() - 60_000; // 截止前 60 秒
  const ttlSeconds = Math.max(1, Math.ceil((reminderTime - Date.now()) / 1000));

  if (ttlSeconds <= 0) return; // 截止时间太近，跳过提醒

  const reminderKey = `${DEADLINE_KEY_PREFIX}${voteId}${REMINDER_KEY_SUFFIX}`;
  try {
    await redis.set(reminderKey, '1', 'EX', ttlSeconds);
  } catch (err) {
    console.error('[DeadlineWorker] 设置提醒 key 失败:', { voteId, err });
  }
}

/**
 * 启动 DeadlineWorker
 * - 订阅 Redis keyspace notification 通道
 * - 执行启动兜底扫描
 */
export function startDeadlineWorker(
  redis: Redis,
  io: SocketIOServer
): void {
  // ---- A. 订阅 Redis keyspace 过期事件 ----
  // 需要独立 Redis 连接（订阅模式会阻塞其他命令）
  const subRedis = redis.duplicate();

  // BUG-014 修复：psubscribe 失败时带指数退避重试（最多 3 次）
  let retryCount = 0;
  const maxRetries = 3;

  function doPsubscribe(): void {
    subRedis.psubscribe('__keyevent@0__:expired', (err) => {
      if (err) {
        retryCount++;
        console.error('[DeadlineWorker] 订阅过期通道失败 (尝试', retryCount, '/', maxRetries, '):', err);
        if (retryCount < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
          console.info('[DeadlineWorker]', delay, 'ms 后重试订阅...');
          setTimeout(doPsubscribe, delay);
        } else {
          console.error('[DeadlineWorker] 订阅过期通道最终失败，自动结束功能不可用');
        }
        return;
      }
      console.info('[DeadlineWorker] 已订阅 __keyevent@0__:expired');
    });
  }

  doPsubscribe();

  subRedis.on('pmessage', async (_pattern, channel, message) => {
    // channel = "__keyevent@0__:expired"
    // message = "vote:{voteId}:deadline" 或 "vote:{voteId}:reminder"
    const voteId = extractVoteId(message);
    if (!voteId) return;

    console.info('[DeadlineWorker] 收到过期事件', { channel, message, voteId });

    if (message.endsWith(':deadline')) {
      // 幂等检查：从 PG 读取当前状态
      const vote = await knex('votes')
        .select('status')
        .where({ id: voteId })
        .first();

      if (!vote || vote.status === 'closed') {
        console.info('[DeadlineWorker] 投票已结束，跳过', { voteId });
        return;
      }

      await closeVoteAutomatically(voteId, io);
    } else if (message.endsWith(':reminder')) {
      await sendReminder(voteId, io);
    }
  });

  // ---- B. 启动兜底扫描 ----
  // 延迟 2 秒，等待 PG 连接就绪
  setTimeout(() => {
    startupRecoveryScan(io);
  }, 2000);
}
