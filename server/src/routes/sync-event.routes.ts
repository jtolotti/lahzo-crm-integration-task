import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.middleware.js';
import * as syncEventRepo from '../repositories/sync-event.repository.js';
import { addSyncJob } from '../queue/sync.queue.js';
import { SyncStatus } from '../domain/types.js';


export async function syncEventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * GET /sync-events/failures — List recent failed sync events.
   */
  app.get('/sync-events/failures', async (request, reply) => {
    const { limit = '50' } = request.query as Record<string, string>;

    const events = await syncEventRepo.findRecentFailures(parseInt(limit, 10));
    return reply.send({ data: events });
  });

  /**
   * POST /sync-events/:id/retry — Re-trigger processing for a failed sync event.
   */
  app.post('/sync-events/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };

    const event = await syncEventRepo.findById(id);
    if (!event) {
      return reply.status(404).send({ error: `Sync event ${id} not found` });
    }

    if (event.status !== SyncStatus.FAILED) {
      return reply.status(409).send({
        error: `Cannot retry event with status "${event.status}". Only failed events can be retried.`,
      });
    }

    await syncEventRepo.updateStatus(id, SyncStatus.RECEIVED);

    const jobId = await addSyncJob({
      syncEventId: id,
      contactId: event.contact_id,
      rawWebhookId: '',
      hubspotEventId: event.hubspot_event_id ?? '',
    });

    return reply.send({
      status: 'queued',
      jobId,
      syncEventId: id,
    });
  });
}
