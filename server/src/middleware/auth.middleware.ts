import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type TokenPayload } from '../services/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: TokenPayload;
  }
}

/**
 * Fastify preHandler hook that validates the Authorization header.
 * Attaches the decoded user to request.user on success.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token = header.slice(7);

  try {
    request.user = verifyToken(token);
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

/**
 * Fastify preHandler hook that requires the authenticated user to have 'admin' role.
 * Must be registered AFTER requireAuth.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.user?.role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
}
