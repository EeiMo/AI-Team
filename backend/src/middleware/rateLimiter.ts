/**
 * src/middleware/rateLimiter.ts
 * 职责：滑动窗口限流 — 每人每投票每分钟最多 3 次提交
 *      - 主路径：Redis Sorted Set + Lua 原子脚本（先清理过期 → 再计数）
 *      - 降级路径：内存 Map（Redis 不可用时）
 *      - 定期清理降级 Map 中过期 entry（每 5 分钟）
 */

import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { config } from '../config';

const { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } = config;

// ============================================================
// Lua 脚本：原子清理 + 检查 + 记录（C-1 修正：先清理后计数）
// KEYS[1] = rate:{user_id}:{vote_id}
// ARGV[1] = now_ms
// ARGV[2] = window_ms
// ARGV[3] = max_requests
// 返回：0=OK，[earliest_timestamp, score] = 拒绝
// ============================================================
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local window_start = now - window

-- 1. 先清理窗口外的过期记录（关键：在计数前清理，消除 +1 误差）
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- 2. 计数当前窗口内的记录
local current = redis.call('ZCARD', key)

-- 3. 判断是否超限
if current >= max_requests then
  local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return earliest
end

-- 4. 未超限：记录本次请求，设 TTL = 窗口 + 5s 缓冲
redis.call('ZADD', key, now, now)
redis.call('EXPIRE', key, math.ceil((window + 5000) / 1000))
return 0
`;

// ============================================================
// 降级内存 Map（C-2：定期清理）
// ============================================================
const DEGRADE_MAP = new Map<string, number[]>();

// 每 5 分钟清理 >1 分钟未访问的 entry
const CLEANUP_INTERVAL = 5 * 60_000;
const ENTRY_MAX_AGE = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, records] of DEGRADE_MAP) {
    const recent = records.filter(t => now - t < ENTRY_MAX_AGE);
    if (recent.length === 0) {
      DEGRADE_MAP.delete(key);
    } else {
      DEGRADE_MAP.set(key, recent);
    }
  }
}, CLEANUP_INTERVAL).unref();

function degradeCheck(userId: string, voteId: string): number | [string, string] {
  const key = `${userId}:${voteId}`;
  const now = Date.now();
  const records = DEGRADE_MAP.get(key) || [];
  const valid = records.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_MAX) {
    return [valid[0].toString(), valid[0].toString()];
  }

  valid.push(now);
  DEGRADE_MAP.set(key, valid);
  return 0;
}

// ============================================================
// 限流中间件工厂
// ============================================================
export function createRateLimiter(redis: Redis) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 仅拦截 POST /api/votes/:id/vote
    // 注意：中间件挂载于 apiRouter.use('/votes', ...)，apiRouter 挂载于 app.use('/api', ...);
    // req.path = /:id/vote（Express Router 已剥离 /api 和 /votes 前缀）
    if (req.method !== 'POST' || !req.path.match(/^\/[^/]+\/vote$/)) {
      return next();
    }

    const userId = req.user!.user_id;
    const voteId = req.params.id;
    const key = `rate:${userId}:${voteId}`;
    const nowMs = Date.now().toString();

    let result: number | [string, string];

    // 检查 Redis 降级标志
    const degraded = await redis.get('health:degraded');
    if (degraded === '1') {
      result = degradeCheck(userId, voteId) as number | [string, string];
    } else {
      try {
        result = (await redis.eval(
          RATE_LIMIT_LUA, 1, key,
          nowMs,
          RATE_LIMIT_WINDOW_MS.toString(),
          RATE_LIMIT_MAX.toString()
        )) as number | [string, string];
      } catch (err) {
        // Redis 异常 → 激活降级标志 + 回退内存
        console.error('[RateLimiter] Redis 异常，降级为内存 Map:', err);
        await redis.set('health:degraded', '1', 'EX', 10).catch(() => {});
        result = degradeCheck(userId, voteId) as number | [string, string];
      }
    }

    if (result !== 0) {
      const earliestScore = Array.isArray(result) ? parseInt(result[1], 10) : 0;
      const retryAfter = Math.max(
        1,
        Math.ceil((earliestScore + RATE_LIMIT_WINDOW_MS - parseInt(nowMs, 10)) / 1000)
      );
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        code: 42900,
        message: '提交过于频繁，请稍后再试',
      });
      return;
    }

    next();
  };
}
