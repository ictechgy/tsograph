// Hono 앱을 fixture 사본에서 불러와 요청을 보내고 등록된 라우트 표(`app.routes`)를 표본 요청으로 바꾼다.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { regexSample } from '../lib/samples.mjs';

/**
 * Hono `checkOptionalParameter`처럼 끝 선택 파라미터를 펼친다.
 *
 * @param {string} path 패턴
 * @returns {string[]} 패턴 목록
 */
function optionalPaths(path) {
  if (!path.endsWith('?') || !path.includes(':')) return [path];
  const results = [];
  let base = '';
  for (const segment of path.split('/')) {
    if (segment !== '' && !segment.includes(':')) base += `/${segment}`;
    else if (segment.includes(':')) {
      if (segment.endsWith('?')) {
        results.push(results.length === 0 && base === '' ? '/' : base);
        base += `/${segment.slice(0, -1)}`;
        results.push(base);
      } else base += `/${segment}`;
    }
  }
  return [...new Set(results)];
}

/**
 * Hono 패턴 하나를 표본 요청 경로로 바꾼다.
 *
 * @param {string} pattern 패턴
 * @returns {string[]} 요청 경로
 */
export function honoSamples(pattern) {
  if (pattern === '*' || pattern === '/*') return ['/', '/a/b'];
  if (pattern.endsWith('/*')) {
    const head = pattern.slice(0, -2) || '';
    return [head || '/', `${head}/`, `${head}/a/b`];
  }
  return optionalPaths(pattern).map((candidate) => candidate.split('/').map((segment) => {
    const match = /^:([^{}]+)(?:\{(.+)\})?$/.exec(segment);
    if (match === null) return segment;
    return match[2] === undefined ? 'p1' : regexSample(match[2]);
  }).join('/') || '/');
}

/**
 * fixture 사본의 Hono 앱을 불러온다.
 *
 * @param {string} copy fixture 사본 경로
 * @param {{module: string, export?: string}} entry 앱 모듈
 * @returns {Promise<object>} 드라이버
 */
export async function loadHono(copy, entry) {
  const module = await import(pathToFileURL(join(copy, entry.module)).href);
  const app = module[entry.export ?? 'default'];
  return {
    request: async (method, path) => {
      const response = await app.request(path, { method });
      return { status: response.status, body: method === 'HEAD' ? '' : await response.text() };
    },
    routeRequests: () => app.routes.flatMap((route) => honoSamples(route.path).map((path) => ({ method: route.method === 'ALL' ? 'GET' : route.method, path }))),
    close: async () => undefined,
  };
}
