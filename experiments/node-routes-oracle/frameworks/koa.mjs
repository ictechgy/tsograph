// Koa 앱을 fixture 사본에서 불러와 로컬 포트로 요청을 보내고, 앱 미들웨어의 라우터 스택으로 라우트 표를 만든다.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { serveLocally } from '../lib/http.mjs';
import { pte6Samples, pte8Samples } from '../lib/samples.mjs';

/**
 * fixture 사본의 Koa 앱을 불러온다.
 *
 * @param {string} copy fixture 사본
 * @param {{module: string, export?: string, grammar?: 6 | 8}} entry 앱 모듈과 라우터 경로 문법
 * @returns {Promise<object>} 드라이버
 */
export async function loadKoa(copy, entry) {
  const module = await import(pathToFileURL(join(copy, entry.module)).href);
  const app = module[entry.export ?? 'default'];
  app.silent = true;
  const server = await serveLocally(app.callback());
  return {
    request: server.request,
    routeRequests: () => app.middleware
      .filter((middleware) => middleware.router !== undefined)
      .flatMap((middleware) => middleware.router.stack)
      .filter((layer) => typeof layer.path === 'string' && layer.methods.length > 0)
      .flatMap((layer) => (entry.grammar === 6 ? pte6Samples : pte8Samples)(layer.path).flatMap((path) => layer.methods.filter((method) => method !== 'HEAD').slice(0, 3).map((method) => ({ method, path })))),
    close: server.close,
  };
}
