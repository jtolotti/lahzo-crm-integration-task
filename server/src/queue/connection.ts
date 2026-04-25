import IORedis from 'ioredis';
import { config } from '../config.js';

/**
 * Shared Redis connection for BullMQ.
 * maxRetriesPerRequest must be null for BullMQ compatibility.
 */
export const redisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
