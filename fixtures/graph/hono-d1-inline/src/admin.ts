import { Hono } from 'hono';

import type { Env } from './env';

// 체인 등록(RPC 스타일): 핸들러는 `admin.….get("/audit")` 노드다.
export const admin = new Hono<{ Bindings: Env }>().get('/audit', async (c) => {
  const rows = await c.env.DB.prepare('SELECT event FROM audit_log').all();
  return c.json(rows.results);
});
