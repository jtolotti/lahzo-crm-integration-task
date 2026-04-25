import type { FastifyInstance } from 'fastify';
import { login } from '../services/auth.service.js';
import { UnauthorizedError } from '../domain/errors.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };

      try {
        const result = await login(email, password);
        return reply.send({
          token: result.token,
          user: result.user,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return reply.status(401).send({ error: err.message });
        }
        throw err;
      }
    },
  });
}
