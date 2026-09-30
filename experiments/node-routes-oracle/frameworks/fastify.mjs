// Fastify 앱을 fixture 사본에서 만들어 `inject`로 요청을 보내고, find-my-way `on` 호출을 기록해 라우트 표를 만든다.
//
// Fastify는 등록한 전체 URL(접두사 포함)을 공개 API로 돌려주지 않으므로, 앱을 만들기 전에 사본의 find-my-way
// `Router.prototype.on`을 감싸 (method, path)를 모은다. 라우팅 동작은 바꾸지 않는다.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { regexSample } from '../lib/samples.mjs';

/**
 * find-my-way 패턴의 표본 경로다.
 *
 * @param {string} pattern 패턴
 * @returns {string[]} 표본
 */
function samples(pattern) {
  const optional = /(\/:[^/()]*?)\?(\/?)$/.exec(pattern);
  const variants = optional === null ? [pattern] : [pattern.replace(optional[0], `${optional[1]}${optional[2]}`), pattern.replace(optional[0], optional[2]) || '/'];
  return variants.map((entry) => (entry === '*' ? '/a/b' : entry)
    .replace(/:(\w+)\(((?:\\.|[^)])*)\)/g, (_, name, regex) => regexSample(regex))
    .replace(/::/g, '\u0000')
    .replace(/:\w+/g, 'p1')
    .replace(/\u0000/g, ':')
    .replace(/\*$/, 'a/b'));
}

/**
 * fixture 사본의 Fastify 앱을 만든다.
 *
 * @param {string} copy fixture 사본
 * @param {{module: string, factory: string}} entry 앱 모듈과 팩토리 이름
 * @returns {Promise<object>} 드라이버
 */
export async function loadFastify(copy, entry) {
  const require = createRequire(join(copy, 'node_modules/fastify/package.json'));
  const Router = require('find-my-way');
  const registered = [];
  const originalOn = Router.prototype.on;
  Router.prototype.on = function on(method, path, ...rest) {
    for (const verb of [].concat(method)) registered.push({ method: verb, path });
    return originalOn.call(this, method, path, ...rest);
  };
  const module = await import(pathToFileURL(join(copy, entry.module)).href);
  const app = (module[entry.factory] ?? module.default?.[entry.factory])();
  await app.ready();
  return {
    request: async (method, path) => {
      const response = await app.inject({ method, url: path });
      return { status: response.statusCode, body: method === 'HEAD' ? '' : response.body };
    },
    routeRequests: () => registered.filter((route) => route.method !== 'HEAD').flatMap((route) => samples(route.path).map((path) => ({ method: route.method, path }))),
    close: async () => {
      Router.prototype.on = originalOn;
      await app.close();
    },
  };
}
