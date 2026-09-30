import { Hono } from 'hono';

import { admin } from './admin';
import { insertPost } from './db';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

// 모듈 최상위 인라인 핸들러: 안의 relation-use는 핸들러 노드에 귀속한다.
app.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name FROM users').all();
  return c.json(results);
});

// 인라인 핸들러가 이름 있는 함수를 부른다.
app.post('/posts', async (c) => {
  await insertPost(c.env.DB, await c.req.text());
  return c.body(null, 201);
});

// 테이블에 닿지 않는 핸들러는 같은 파일의 다른 핸들러 코드를 끌어오지 않는다.
app.get('/health', (c) => c.text('ok'));

app.route('/admin', admin);

export default app;
