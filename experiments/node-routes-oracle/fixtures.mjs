// 오라클이 기록하는 fixture 목록과 앱 불러오기 방법이다.

import { loadExpress } from './frameworks/express.mjs';
import { loadFastify } from './frameworks/fastify.mjs';
import { loadHono } from './frameworks/hono.mjs';
import { loadKoa } from './frameworks/koa.mjs';
import { loadNest } from './frameworks/nest.mjs';

/** fixture 명세 목록이다. */
export const FIXTURES = [
  { name: 'hono-app', framework: 'hono', load: (copy) => loadHono(copy, { module: 'src/index.ts' }) },
  { name: 'hono-loose-app', framework: 'hono', load: (copy) => loadHono(copy, { module: 'src/index.ts' }) },
  // cors()는 OPTIONS 사전 요청에 직접 응답한다(isthmus는 OPTIONS 호출을 options-any로 잇는다). 그래서 OPTIONS 탐침은 뺀다.
  { name: 'express4-app', framework: 'express', skipMethods: ['OPTIONS'], load: (copy) => loadExpress(copy, { module: 'src/app.js', major: 4 }) },
  { name: 'express5-app', framework: 'express', load: (copy) => loadExpress(copy, { module: 'src/app.ts', major: 5 }) },
  { name: 'koa-app', framework: 'koa', load: (copy) => loadKoa(copy, { module: 'src/app.ts' }) },
  { name: 'koa13-app', framework: 'koa', load: (copy) => loadKoa(copy, { module: 'src/app.js', export: 'default', grammar: 6 }) },
  { name: 'fastify5-app', framework: 'fastify', load: (copy) => loadFastify(copy, { module: 'src/app.ts', factory: 'buildApp' }) },
  { name: 'fastify4-app', framework: 'fastify', load: (copy) => loadFastify(copy, { module: 'src/app.js', factory: 'build' }) },
  { name: 'nest-app', framework: 'nest', load: (copy) => loadNest(copy, { module: 'dist/main.js', factory: 'createApp' }) },
];
