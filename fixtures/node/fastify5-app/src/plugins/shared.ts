import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

export const sharedRoutes = fp(async (app: FastifyInstance) => {
  app.get('/shared/ping', async () => 'h:shared-ping');
});
