/**
 * src/services/redisHealth.ts
 * 职责：Redis 主动健康监测
 *      - 每秒 PING Redis
 *      - 连续 N 次失败 → SET health:degraded（降级）
 *      - 连续 M 次成功 → DEL health:degraded（恢复）
 *      - 在启动时同步检测一次，确保初始状态正确
 */

import Redis from 'ioredis';
import { config } from '../config';

const { REDIS_DEGRADE_THRESHOLD } = config;
const RECOVERY_THRESHOLD = 3; // 连续 3 次成功即恢复
const PING_INTERVAL_MS = 1_000; // 1 秒

interface HealthState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  degraded: boolean;
}

/**
 * 启动 Redis 主动健康监测
 * - 返回 cleanup 函数
 */
export async function startRedisHealth(redis: Redis): Promise<() => void> {
  const state: HealthState = {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    degraded: false,
  };

  // 启动时同步检测一次当前降级状态
  try {
    const degraded = await redis.get('health:degraded');
    state.degraded = degraded === '1';
    if (state.degraded) {
      console.warn('[RedisHealth] 启动时检测到降级标志已存在');
    }
  } catch {
    // Redis 不可达，默认为降级
    state.degraded = true;
    console.warn('[RedisHealth] 启动时 Redis 不可达，标记为降级');
  }

  console.info('[RedisHealth] 启动健康监测', {
    degradeThreshold: REDIS_DEGRADE_THRESHOLD,
    recoveryThreshold: RECOVERY_THRESHOLD,
    pingInterval: PING_INTERVAL_MS,
  });

  const interval = setInterval(async () => {
    try {
      await redis.ping();
      // PING 成功
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses++;

      if (state.degraded && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
        // 恢复：清除降级标志
        await redis.del('health:degraded');
        state.degraded = false;
        state.consecutiveSuccesses = 0;
        console.info('[RedisHealth] Redis 已恢复，降级标志已清除');
      }
    } catch (err) {
      // PING 失败
      state.consecutiveSuccesses = 0;
      state.consecutiveFailures++;

      if (!state.degraded && state.consecutiveFailures >= REDIS_DEGRADE_THRESHOLD) {
        // 触发降级
        try {
          await redis.set('health:degraded', '1', 'EX', 30).catch(() => {});
        } catch {
          // redis.set 也失败 — 降级已生效（其他模块的 read/write catch 会兜底）
        }
        state.degraded = true;
        console.error('[RedisHealth] Redis 连续', REDIS_DEGRADE_THRESHOLD, '次 PING 失败，已降级');
      }
    }
  }, PING_INTERVAL_MS).unref();

  return () => clearInterval(interval);
}
