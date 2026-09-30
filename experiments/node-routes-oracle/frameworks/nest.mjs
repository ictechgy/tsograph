// NestJS 앱을 fixture 사본에서 만든다. 데코레이터는 Node 타입 제거로 실행할 수 없으므로 TypeScript로 사본의 `src`를
// `dist`로 변환(`experimentalDecorators`·`emitDecoratorMetadata`)한 뒤 불러온다. 요청은 Express 어댑터 인스턴스를 로컬 포트에
// 띄워 보내고, 라우트 표는 Express 라우터 스택으로 만든다.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { serveLocally } from '../lib/http.mjs';
import { pte8Samples } from '../lib/samples.mjs';
import { collect } from './express.mjs';

const ts = createRequire(import.meta.url)('typescript');

/**
 * 사본의 `src/**\/*.ts`를 `dist`의 ESM JavaScript로 바꾼다.
 *
 * @param copy fixture 사본
 */
function transpile(copy) {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]));
  for (const file of walk(join(copy, 'src')).filter((path) => path.endsWith('.ts'))) {
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true },
      fileName: file,
    }).outputText;
    const target = join(copy, 'dist', relative(join(copy, 'src'), file)).replace(/\.ts$/, '.js');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
  }
}

/**
 * fixture 사본의 NestJS 앱을 만든다.
 *
 * @param {string} copy fixture 사본
 * @param {{module: string, factory: string}} entry 부트스트랩 모듈(dist 기준)과 팩토리 이름
 * @returns {Promise<object>} 드라이버
 */
export async function loadNest(copy, entry) {
  transpile(copy);
  const module = await import(pathToFileURL(join(copy, entry.module)).href);
  const app = await module[entry.factory]();
  await app.init();
  const instance = app.getHttpAdapter().getInstance();
  const server = await serveLocally(instance);
  return {
    request: server.request,
    routeRequests: () => {
      const routes = [];
      collect(instance._router ?? instance.router, '', routes);
      return routes.filter((route) => !route.open).flatMap((route) => pte8Samples(route.pattern).map((path) => ({ method: route.method === 'ALL' ? 'GET' : route.method, path })));
    },
    close: async () => {
      await server.close();
      await app.close();
    },
  };
}
