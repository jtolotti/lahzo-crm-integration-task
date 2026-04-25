import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.middleware.js';
import * as contactService from '../services/contact.service.js';
import { SyncStatus, EventDirection } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';
import * as syncEventRepo from '../repositories/sync-event.repository.js';
import * as contactRepo from '../repositories/contact.repository.js';
import { addSyncJob } from '../queue/sync.queue.js';

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * GET /contacts — List contacts with pagination and optional status filter.
   */
  app.get('/contacts', async (request, reply) => {
    const { page = '1', limit = '20', status } = request.query as Record<string, string>;

    const statusFilter = status && Object.values(SyncStatus).includes(status as SyncStatus)
      ? (status as SyncStatus)
      : undefined;

    const result = await contactService.getContacts(
      parseInt(page, 10),
      parseInt(limit, 10),
      statusFilter,
    );

    return reply.send({
      data: result.data,
      total: result.total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  });

  /**
   * GET /contacts/:id — Get a single contact with its sync events.
   */
  app.get('/contacts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const contact = await contactService.getContactOrThrow(id);
      const events = await syncEventRepo.findByContactId(id);

      return reply.send({ contact, events });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * POST /contacts/:id/resync — Re-trigger a full sync for a contact.
   */
  app.post('/contacts/:id/resync', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const contact = await contactService.getContactOrThrow(id);

      const syncEvent = await syncEventRepo.insert({
        contact_id: contact.id,
        hubspot_event_id: null,
        direction: EventDirection.INBOUND,
        event_type: 'manual.resync',
        payload: { triggeredBy: request.user.email },
        status: SyncStatus.RECEIVED,
        occurred_at: new Date(),
      });

      const jobId = await addSyncJob({
        syncEventId: syncEvent.id,
        contactId: contact.id,
        rawWebhookId: '',
        hubspotEventId: '',
      });

      return reply.send({ status: 'queued', jobId, syncEventId: syncEvent.id });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * GET /contacts/stats/summary — Status counts for dashboard.
   */
  app.get('/contacts/stats/summary', async (_request, reply) => {
    const counts = await contactRepo.getStatusCounts();
    return reply.send(counts);
  });
}
