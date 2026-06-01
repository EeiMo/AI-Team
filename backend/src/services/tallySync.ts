/**
 * src/services/tallySync.ts
 * 职责：Redis → PG 定期票数对账
 *      - 每 TALLY_SYNC_INTERVAL_MS 从 PG user_votes 聚合票数
 *      - 全量写回 Redis tally Hash（幂等覆盖）
 *      - 跳过降级状态（Redis 不可用时不执行）
 */

import Redis from 'ioredis';
import { knex } from '../db/knex';
import { config } from '../config';

/**
 * 从 PG 聚合指定投票的票数
 */
export async function aggregateTallyFromPG(voteId: string): Promise<Record<string, number>> {
  const result = await knex.raw(
    `SELECT o.id as option_id, COUNT(uv.id)::text as count
     FROM options o
     LEFT JOIN user_votes uv ON o.id = ANY(uv.selected_options) AND uv.vote_id = o.vote_id
     WHERE o.vote_id = ?
     GROUP BY o.id`,
    [voteId]
  );

  const rows: { option_id: string; count: string }[] = result.rows;

  const tally: Record<string, number> = {};
  for (const r of rows) {
    tally[r.option_id] = parseInt(r.count, 10) || 0;
  }
  return tally;
}

/**
 * 将票数写回 Redis tally Hash
 */
async function writeTallyToRedis(
  redis: Redis,
  voteId: string,
  tally: Record<string, number>
): Promise<void> {
  const tallyKey = `vote:${voteId}:tally`;
  const fields: string[] = [];
  for (const [oid, count] of Object.entries(tally)) {
    fields.push(oid, count.toString());
  }
  if (fields.length > 0) {
    await redis.hset(tallyKey, ...fields);
  }
}

/**
 * 执行一轮全量同步：遍历所有 active 投票，从 PG 聚合 → 写回 Redis
 */
async function syncAllActiveVotes(redis: Redis): Promise<void> {
  try {
    // 检查降级标志
    const degraded = await redis.get('health:degraded');
    if (degraded === '1') {
      return; // Redis 不可用，跳过
    }

    // 获取所有 active 投票
    const activeVotes: { id: string }[] = await knex('votes')
      .select('id')
      .where({ status: 'active' });

    if (activeVotes.length === 0) return;

    // 逐个对账（小数据集下全量，大规模可改为增量/分片）
    for (const vote of activeVotes) {
      const pgTally = await aggregateTallyFromPG(vote.id);
      await writeTallyToRedis(redis, vote.id, pgTally);
    }
  } catch (err) {
    console.error('[TallySync] 同步失败:', err);
  }
}

/**
 * 启动 TallySync 定时器
 * - 每 config.TALLY_SYNC_INTERVAL_MS 执行一轮全量同步
 * - 返回 cleanup 函数用于停止
 */
export function startTallySync(redis: Redis): () => void {
  console.info('[TallySync] 启动，同步间隔:', config.TALLY_SYNC_INTERVAL_MS, 'ms');

  const interval = setInterval(() => {
    syncAllActiveVotes(redis);
  }, config.TALLY_SYNC_INTERVAL_MS).unref();

  // 首次启动时立即执行一次
  syncAllActiveVotes(redis);

  return () => clearInterval(interval);
}
