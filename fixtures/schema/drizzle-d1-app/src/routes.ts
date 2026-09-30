import { type Context, Hono } from 'hono';

import { createDb } from './db/client';
import { authorPostCounts, listUsers, userFeed } from './db/queries';
import type { Env } from './env';

/** 라우트 문맥 타입이다. */
type AppContext = Context<{ Bindings: Env }>;

export async function getUsers(c: AppContext) {
  const db = createDb(c.env.DB);
  return c.json(await listUsers(db));
}

export async function getFeed(c: AppContext) {
  const db = createDb(c.env.DB);
  return c.json(await userFeed(db, Number(c.req.param('id'))));
}

export async function getStats(c: AppContext) {
  const published = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM blog_posts WHERE published_on IS NOT NULL').first();
  const perAuthor = await createDb(c.env.DB).all(authorPostCounts());
  return c.json({ published, perAuthor });
}

export async function recordAudit(c: AppContext) {
  const { DB } = c.env;
  await DB.prepare(`insert into audit_log (event, actor_id) values (?, ?)`).bind('visit', 1).run();
  return c.body(null, 204);
}

const app = new Hono<{ Bindings: Env }>();
app.get('/users', getUsers);
app.get('/users/:id/feed', getFeed);
app.get('/stats', getStats);
app.post('/audit', recordAudit);

export default app;
