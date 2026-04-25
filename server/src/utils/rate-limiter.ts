import { redisConnection } from '../queue/connection.js';
import { logger } from './logger.js';

/**
 * Redis-backed sliding window rate limiter for outbound CRM API calls.
 * Separate from BullMQ's queue-level limiter — this wraps individual HTTP calls.
 *
 * Uses a sorted set with timestamps as scores. Each API call adds an entry.
 * Before calling, we check how many entries exist in the current window.
 */

const RATE_LIMIT_KEY = 'rate:hubspot:api';
const MAX_REQUESTS = 80;
const WINDOW_MS = 10000;

/**
 * Try to acquire a rate limit token. Returns true if the call is allowed.
 * If not allowed, returns the number of milliseconds to wait.
 */
export async function acquireToken(): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const pipeline = redisConnection.pipeline();
  pipeline.zremrangebyscore(RATE_LIMIT_KEY, '-inf', windowStart);
  pipeline.zcard(RATE_LIMIT_KEY);
  const results = await pipeline.exec();

  const count = (results?.[1]?.[1] as number) ?? 0;

  if (count >= MAX_REQUESTS) {
    const oldestResult = await redisConnection.zrange(RATE_LIMIT_KEY, 0, 0, 'WITHSCORES');
    const oldestTimestamp = oldestResult[1] ? parseInt(oldestResult[1], 10) : now;
    const retryAfterMs = oldestTimestamp + WINDOW_MS - now;

    logger.warn({ count, retryAfterMs }, 'Rate limit reached, must wait');
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 100) };
  }

  await redisConnection.zadd(RATE_LIMIT_KEY, now, `${now}:${Math.random()}`);
  await redisConnection.expire(RATE_LIMIT_KEY, Math.ceil(WINDOW_MS / 1000) + 1);

  return { allowed: true };
}

/**
 * Wait until a rate limit token is available, then acquire it.
 */
export async function waitForToken(): Promise<void> {
  let result = await acquireToken();
  while (!result.allowed) {
    const waitMs = result.retryAfterMs ?? 1000;
    logger.debug({ waitMs }, 'Waiting for rate limit token');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    result = await acquireToken();
  }
}
