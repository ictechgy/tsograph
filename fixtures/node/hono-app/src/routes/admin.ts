import { Hono } from 'hono';

export function registerAdmin(app: Hono) {
  app.get('/admin/stats', (c) => c.text('h:admin-stats'));
  app.delete('/admin/cache', (c) => c.text('h:admin-cache'));
}
