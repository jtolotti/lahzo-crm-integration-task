import { Worker, Job } from 'bullmq';
import { redisConnection } from './connection.js';
import { SYNC_QUEUE_NAME, type SyncJobData } from './sync.queue.js';
import { processEvent } from '../services/sync.service.js';
import { logger } from '../utils/logger.js';

/**
 * Process a sync job: delegates to the sync service for full
 * orchestration (dedup → stale check → fetch → enrich → writeback).
 */
async function processJob(job: Job<SyncJobData>): Promise<void> {
  logger.info(
    { jobId: job.id, syncEventId: job.data.syncEventId, contactId: job.data.contactId },
    'Processing sync job',
  );

  await processEvent(job.data.syncEventId);
}

export function createSyncWorker(): Worker<SyncJobData> {
  const worker = new Worker<SyncJobData>(SYNC_QUEUE_NAME, processJob, {
    connection: redisConnection,
    concurrency: 5,
    limiter: {
      max: 80,
      duration: 10000,
    },
  });

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message, attempt: job?.attemptsMade },
      'Job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'Worker error');
  });

  return worker;
}
