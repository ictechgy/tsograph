import { Hono } from 'hono';
import { logger } from 'hono/logger';
import books from './routes/books.ts';
import { createAuthors } from './routes/authors.ts';
import { registerAdmin } from './routes/admin.ts';
import { handlers } from './lib/handlers.ts';
import { API_VERSION } from './lib/paths.ts';

const app = new Hono();

app.use('*', logger());
app.get('/', (c) => c.text('h:root'));
app.get('/health', handlers.health);

// 먼저 등록한 파라미터 라우트가 나중의 리터럴 라우트를 가린다(등록 순서).
app.get('/users/:id', (c) => c.text('h:user-by-id'));
app.get('/users/me', (c) => c.text('h:user-me'));

// next를 받는 핸들러는 요청을 다음 등록으로 넘길 수 있다.
app.get('/maybe', async (c, next) => {
  if (c.req.query('stop') === '1') return c.text('h:maybe-stop');
  await next();
});
app.get('/maybe', (c) => c.text('h:maybe-fallback'));

app.get('/files/*', (c) => c.text('h:files'));
app.all('/any', (c) => c.text('h:any'));
app.on('HEAD', '/head-only', (c) => c.text('h:head-only'));
app.get('/chain', (c) => c.text('h:chain-get')).post((c) => c.text('h:chain-post'));

const api = app.basePath(`/api/${API_VERSION}`);
api.route('/', books);
api.route('/', createAuthors());

const late = new Hono();
late.get('/early', (c) => c.text('h:late-early'));
app.route('/late', late);
late.get('/after', (c) => c.text('h:late-after'));

registerAdmin(app);

if (process.env.ENABLE_DEBUG === '1') {
  app.get('/debug', (c) => c.text('h:debug'));
}

const section = process.env.SECTION;
app.get(`/sections/${section}/items`, (c) => c.text('h:section-items'));

app.use('/terminal/*', (c) => c.text('h:terminal'));

export default app;
