'use strict';

const Koa = require('koa');
const Router = require('@koa/router');

const app = new Koa();
const router = new Router({ prefix: '/v1' });

router.get('/users/:id?', (ctx) => { ctx.body = 'h:user-optional'; });
router.get('/files/:path*', (ctx) => { ctx.body = 'h:files-any'; });
router.get('/docs/:path+', (ctx) => { ctx.body = 'h:docs-some'; });
router.get('/num/:id(\\d+)', (ctx) => { ctx.body = 'h:number'; });
router.get('/file-:name', (ctx) => { ctx.body = 'h:file-name'; });
router.get('/report.:ext', (ctx) => { ctx.body = 'h:report-ext'; });
router.get('/slash/', (ctx) => { ctx.body = 'h:slash'; });
router.post('/', (ctx) => { ctx.body = 'h:root-post'; });

app.use(router.routes());

module.exports = app;
