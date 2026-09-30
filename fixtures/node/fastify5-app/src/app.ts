import Fastify from 'fastify';
import accounts from './plugins/accounts.ts';
import { sharedRoutes } from './plugins/shared.ts';

export function buildApp() {
  const app = Fastify();

  app.get('/', async () => 'h:home');
  app.get('/users/:id', async () => 'h:user-by-id');
  app.get('/users/me', async () => 'h:user-me');
  app.get('/files/*', async () => 'h:files');
  app.get('/opt/:page?', async () => 'h:optional-page');
  app.get('/range/:from-:to', async () => 'h:range');
  app.get('/report.:format', async () => 'h:report-format');
  app.all('/any', async () => 'h:any');
  app.route({
    method: 'GET',
    url: '/versioned',
    constraints: { version: '1.2.0' },
    handler: async () => 'h:versioned',
  });
  app.head('/Case', async () => 'h:case-head');
  app.get('/Case', async () => 'h:case');

  app.register(accounts, { prefix: '/accounts' });
  app.register(sharedRoutes, { prefix: '/ignored' });

  if (process.env.FASTIFY_DEBUG === '1') {
    app.get('/debug', async () => 'h:debug');
  }

  return app;
}
