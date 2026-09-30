'use strict';

const fastify = require('fastify');

function build() {
  const app = fastify({ ignoreTrailingSlash: true, caseSensitive: false });

  app.get('/Status', async () => 'h:status');
  app.get('/items/:id', async () => 'h:get-item');
  app.post('/items', async () => 'h:create-item');

  app.register(async function admin(instance) {
    instance.get('/', async () => 'h:admin-root');
    instance.get('/users', async () => 'h:admin-users');
  }, { prefix: 'admin' });

  return app;
}

module.exports = { build };
