import Koa from 'koa';
import Router from '@koa/router';
import { getItem, listItems } from './routes/items.ts';

const app = new Koa();
const api = new Router({ prefix: '/api' });

api.get('/items', listItems);
api.get('item', '/items/:id', getItem);
api.post('/items', (ctx) => { ctx.body = 'h:create-item'; });
api.put(['/items/:id', '/things/:id'], (ctx) => { ctx.body = 'h:replace-item'; });

// next로 넘기는 핸들러와 뒤의 등록
api.get('/users/:id', async (ctx, next) => {
  if (ctx.params.id === 'me') return next();
  ctx.body = 'h:user-by-id';
});
api.get('/users/me', (ctx) => { ctx.body = 'h:user-me'; });

// next 없는 파라미터 라우트가 뒤의 리터럴 라우트를 가린다.
api.get('/shadow/:x', (ctx) => { ctx.body = 'h:shadow-param'; });
api.get('/shadow/fixed', (ctx) => { ctx.body = 'h:shadow-fixed'; });

api.all('/any', (ctx) => { ctx.body = 'h:any'; });
api.get('/files/*path', (ctx) => { ctx.body = 'h:files'; });
api.get('/opt{/:page}', (ctx) => { ctx.body = 'h:optional-page'; });
api.get('/slash/', (ctx) => { ctx.body = 'h:slash'; });

const nested = new Router();
nested.get('/list', (ctx) => { ctx.body = 'h:nested-list'; });
nested.get('/', (ctx) => { ctx.body = 'h:nested-root'; });
api.use('/nested', nested.routes());
nested.get('/late', (ctx) => { ctx.body = 'h:nested-late'; });

if (process.env.KOA_DEBUG === '1') {
  api.get('/debug', (ctx) => { ctx.body = 'h:debug'; });
}

const region = process.env.REGION;
api.get(`/regions/${region}/stats`, (ctx) => { ctx.body = 'h:region-stats'; });

const strict = new Router({ strict: true, sensitive: true });
strict.get('/Exact/', (ctx) => { ctx.body = 'h:exact'; });
strict.get('/Plain', (ctx) => { ctx.body = 'h:plain'; });

app.use(api.routes());
app.use(api.allowedMethods());
app.use(strict.routes());

export default app;
