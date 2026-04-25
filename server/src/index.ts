import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { runMigrations } from './db/migrate.js';
import { createSyncWorker } from './queue/sync.worker.js';
import { webhookRoutes } from './routes/webhook.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { contactRoutes } from './routes/contact.routes.js';
import { syncEventRoutes } from './routes/sync-event.routes.js';
import { adminRoutes } from './routes/admin.routes.js';

const server = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      config.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// Store raw body alongside parsed JSON for webhook signature verification
server.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body, done) => {
    try {
      (req as any).rawBody = body;
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

server.register(cors, {
  origin: config.NODE_ENV === 'production' ? false : true,
});

server.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Temporary OAuth callback for installing the Legacy App in the test portal.
// After installation is confirmed, this route can be removed.
server.get('/oauth/callback', async (request, reply) => {
  const { code } = request.query as { code?: string };
  if (!code) {
    return reply.status(400).send({ error: 'Missing code parameter' });
  }

  const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env['HUBSPOT_CLIENT_ID'] ?? '',
      client_secret: config.HUBSPOT_CLIENT_SECRET,
      redirect_uri: `${request.headers['x-forwarded-proto'] ?? 'http'}://${request.headers.host}/oauth/callback`,
      code,
    }),
  });

  const tokenData = await tokenRes.json();
  logger.info({ status: tokenRes.status }, 'OAuth token exchange complete');
  return reply.send({
    message: 'App installed successfully! Webhooks are now active.',
    status: tokenRes.status,
    data: tokenData,
  });
});

server.register(webhookRoutes);
server.register(authRoutes, { prefix: '/api' });
server.register(contactRoutes, { prefix: '/api' });
server.register(syncEventRoutes, { prefix: '/api' });
server.register(adminRoutes, { prefix: '/api' });

async function start() {
  try {
    await runMigrations();

    const worker = createSyncWorker();
    logger.info('Sync worker started');

    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Server running on http://localhost:${config.PORT}`);

    const shutdown = async () => {
      logger.info('Shutting down...');
      await worker.close();
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

start();
