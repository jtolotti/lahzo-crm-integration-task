import type { FastifyInstance } from 'fastify';
import { getCrmAdapter } from '../adapters/crm.factory.js';
import { ingestWebhook } from '../services/ingestion.service.js';
import { logger } from '../utils/logger.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /webhooks/hubspot
   *
   * Receives HubSpot webhook events. Must respond within ~5 seconds.
   * 1. Validate signature
   * 2. Persist raw payload
   * 3. Parse events, dedup, upsert contacts, enqueue jobs
   * 4. Return 200 immediately
   */
  app.post('/webhooks/hubspot', {
    config: {
      rawBody: true,
    },
    handler: async (request, reply) => {
      const adapter = getCrmAdapter();

      if (!adapter.validateWebhook(request)) {
        logger.warn('Invalid webhook signature — rejecting');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      const headers = request.headers as Record<string, unknown>;
      const result = await ingestWebhook(request.body, headers);

      return reply.status(200).send({
        status: 'accepted',
        accepted: result.accepted,
        duplicates: result.duplicates,
      });
    },
  });
}
