import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { exchangeCodeForTokens, isAuthorized } from '../adapters/hubspot/token-manager.js';

const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';

const SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.schemas.contacts.write',
].join(' ');

export async function hubspotAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /hubspot/auth — Redirect to HubSpot OAuth authorization page
   */
  app.get('/hubspot/auth', async (_request, reply) => {
    const params = new URLSearchParams({
      client_id: config.HUBSPOT_CLIENT_ID,
      redirect_uri: config.HUBSPOT_REDIRECT_URI,
      scope: SCOPES,
    });

    return reply.redirect(`${HUBSPOT_AUTH_URL}?${params.toString()}`);
  });

  /**
   * GET /hubspot/auth/callback — Exchange authorization code for tokens
   */
  app.get('/hubspot/auth/callback', async (request, reply) => {
    const { code } = request.query as { code?: string };

    if (!code) {
      return reply.status(400).send({ error: 'Missing authorization code' });
    }

    try {
      await exchangeCodeForTokens(
        code,
        config.HUBSPOT_CLIENT_ID,
        config.HUBSPOT_CLIENT_SECRET,
        config.HUBSPOT_REDIRECT_URI,
      );

      return reply.send({
        success: true,
        message: 'HubSpot connected successfully. You can close this page.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * GET /hubspot/auth/status — Check if HubSpot is connected
   */
  app.get('/hubspot/auth/status', async () => {
    return { authorized: isAuthorized() };
  });
}
