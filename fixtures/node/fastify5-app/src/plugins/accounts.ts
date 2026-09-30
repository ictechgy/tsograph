import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

async function listAccounts(request: FastifyRequest, reply: FastifyReply) {
  return 'h:list-accounts';
}

export default async function accounts(app: FastifyInstance) {
  app.get('/', listAccounts);
  app.get('/:id', async () => 'h:get-account');
  app.get('/:id(^\\d+$)/audit', async () => 'h:account-audit');
  app.post('/', { schema: {} }, async () => 'h:create-account');
  app.route({ method: ['PUT', 'PATCH'], url: '/:id', handler: async () => 'h:update-account' });
  app.register(async (nested) => {
    nested.get('/summary', async () => 'h:nested-summary');
  }, { prefix: '/reports' });
}
