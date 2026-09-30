// Express 4·5 앱을 fixture 사본에서 불러와 로컬 포트로 요청을 보내고, 라우터 스택을 걸어 라우트 표를 만든다.
//
// Express는 `use()` 레이어에 붙인 경로 문자열을 보존하지 않으므로, 앱을 불러오기 전에 사본의 Router·application `use`를
// 감싸 새 레이어에 경로(`__path`)와 붙인 앱(`__app`)을 적어 둔다. 라우팅 동작은 바꾸지 않는다.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { serveLocally } from '../lib/http.mjs';
import { pte8Samples, regexSample } from '../lib/samples.mjs';

/**
 * 사본의 Express 라우터 `use`를 감싼다.
 *
 * @param {string} copy fixture 사본
 * @param {number} major Express 주 버전
 */
function instrument(copy, major) {
  const require = createRequire(join(copy, 'package.json'));
  const routerProto = major === 4 ? require('express/lib/router/index.js') : require(require.resolve('router', { paths: [join(copy, 'node_modules/express')] })).prototype;
  const application = require('express/lib/application.js');
  const originalUse = routerProto.use;
  routerProto.use = function use(...args) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof first === 'function' ? '/' : args[0];
    for (const layer of this.stack.slice(before)) layer.__path = path;
    return result;
  };
  const originalAppUse = application.use;
  application.use = function use(...args) {
    const result = originalAppUse.apply(this, args);
    const router = this._router ?? this.router;
    const apps = args.flat(Infinity).filter((entry) => typeof entry === 'function' && entry.handle && entry.set);
    const mounted = router.stack.filter((layer) => layer.name === 'mounted_app' && layer.__app === undefined);
    mounted.slice(-apps.length).forEach((layer, index) => { layer.__app = apps[index]; });
    return result;
  };
}

/**
 * 라우터 스택을 걸어 (method, 패턴) 목록을 만든다.
 *
 * @param {object} router 라우터
 * @param {string} prefix 붙인 경로
 * @param {object[]} out 결과
 */
export function collect(router, prefix, out) {
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]);
      for (const path of [].concat(layer.route.path)) {
        if (typeof path !== 'string') continue;
        for (const method of methods) out.push({ method: method === '_all' ? 'ALL' : method.toUpperCase(), pattern: joinPath(prefix, path) });
      }
    } else if (typeof layer.__path === 'string') {
      const child = layer.__app !== undefined ? (layer.__app._router ?? layer.__app.router) : Array.isArray(layer.handle?.stack) ? layer.handle : undefined;
      if (child !== undefined) collect(child, joinPath(prefix, layer.__path), out);
      else out.push({ method: 'ALL', pattern: joinPath(prefix, layer.__path), open: true });
    }
  }
}

/**
 * 붙인 경로와 자식 경로를 잇는다.
 *
 * @param {string} prefix 붙인 경로
 * @param {string} path 자식 경로
 * @returns {string} 이은 경로
 */
function joinPath(prefix, path) {
  if (prefix === '' || prefix === '/') return path;
  return path === '/' ? prefix : `${prefix.replace(/\/$/, '')}${path}`;
}

/**
 * Express 4 패턴의 표본 경로다.
 *
 * @param {string} pattern 패턴
 * @returns {string[]} 표본
 */
function samples4(pattern) {
  if (pattern === '*') return ['/a/b'];
  let variants = [pattern];
  variants = variants.flatMap((entry) => (/\/:\w+\?/.test(entry) ? [entry.replace(/\/:(\w+)\?/, '/:$1'), entry.replace(/\/:\w+\?/, '')] : [entry]));
  return variants.map((entry) => entry
    .replace(/:(\w+)\(((?:\\.|[^)])*)\)/g, (_, name, regex) => regexSample(regex.replace(/\\\\/g, '\\')))
    .replace(/:\w+\*/g, 'a/b')
    .replace(/:\w+/g, 'p1')
    .replace(/\*/g, 'a/b') || '/');
}

/**
 * fixture 사본의 Express 앱을 불러온다.
 *
 * @param {string} copy fixture 사본
 * @param {{module: string, export?: string, major: number}} entry 앱 모듈
 * @returns {Promise<object>} 드라이버
 */
export async function loadExpress(copy, entry) {
  instrument(copy, entry.major);
  const module = await import(pathToFileURL(join(copy, entry.module)).href);
  const app = entry.export === undefined ? (module.default ?? module) : module[entry.export];
  const server = await serveLocally(app);
  return {
    request: server.request,
    routeRequests: () => {
      const routes = [];
      collect(app._router ?? app.router, '', routes);
      const sample = entry.major === 4 ? samples4 : pte8Samples;
      return routes.flatMap((route) => sample(route.pattern).flatMap((path) => {
        const method = route.method === 'ALL' ? 'GET' : route.method;
        return route.open ? [{ method, path }, { method, path: `${path.replace(/\/$/, '')}/x` }] : [{ method, path }];
      }));
    },
    close: server.close,
  };
}
