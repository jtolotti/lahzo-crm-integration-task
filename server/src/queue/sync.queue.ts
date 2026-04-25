import { Queue } from 'bullmq';
import { redisConnection } from './connection.js';

export const SYNC_QUEUE_NAME = 'sync-events';

export interface SyncJobData {
  syncEventId: string;
  contactId: string;
  rawWebhookId: string;
  hubspotEventId: string;
}

export const syncQueue = new Queue<SyncJobData>(SYNC_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Enqueue a sync job for processing by the worker.
 */
export async function addSyncJob(data: SyncJobData): Promise<string> {
  const job = await syncQueue.add('process-sync', data, {
    jobId: `sync-${data.syncEventId}`,
  });
  return job.id!;
}
