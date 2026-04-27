import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { runMigrations } from './db/migrate.js';
import { createSyncWorker } from './queue/sync.worker.js';
import { pool } from './db/client.js';
import { redisConnection } from './queue/connection.js';
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
      const str = body as string;
      (req as any).rawBody = str;
      done(null, str ? JSON.parse(str) : null);
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

server.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const statusCode = error.statusCode ?? 500;

  if (statusCode >= 500) {
    server.log.error(error, 'Unhandled server error');
  }

  return reply.status(statusCode).send({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    ...(config.NODE_ENV !== 'production' && { detail: error.message }),
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
      await pool.end();
      await redisConnection.quit();
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
