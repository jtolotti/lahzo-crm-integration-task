import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAdmin } from '../middleware/auth.middleware.js';
import * as rawWebhookRepo from '../repositories/raw-webhook.repository.js';
import * as syncEventRepo from '../repositories/sync-event.repository.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireAdmin);

  /**
   * GET /admin/webhooks — Paginated list of raw webhook payloads.
   */
  app.get('/admin/webhooks', async (request, reply) => {
    const { page = '1', limit = '20' } = request.query as Record<string, string>;
    const result = await rawWebhookRepo.findAll(parseInt(page, 10), parseInt(limit, 10));
    return reply.send({
      data: result.data,
      total: result.total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  });

  /**
   * GET /admin/webhooks/:id — Full raw webhook payload + headers.
   */
  app.get('/admin/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const webhook = await rawWebhookRepo.findById(id);
    if (!webhook) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.send(webhook);
  });

  /**
   * GET /admin/sync-events/:id/payload — Full sync event payload (for debugging).
   */
  app.get('/admin/sync-events/:id/payload', async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = await syncEventRepo.findById(id);
    if (!event) {
      return reply.status(404).send({ error: 'Sync event not found' });
    }
    return reply.send({
      id: event.id,
      event_type: event.event_type,
      direction: event.direction,
      payload: event.payload,
      error_message: event.error_message,
    });
  });
}
