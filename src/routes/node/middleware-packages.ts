/**
 * `use()`로 붙이는 패키지 미들웨어·플러그인을 분류한다: 요청을 넘기는 것(개수만 셈), 정적 파일(GET·HEAD 제공 경로),
 * 그 밖(선언 없는 경로를 응답할 수 있는 제공 경로).
 *
 * 목록에 없는 패키지는 응답할 수 있다고 본다(안전한 쪽). 넘긴다고 본 패키지도 코드를 실행해 확인한 것이 아니라 공개
 * 문서의 용도(헤더·본문 파싱·로깅·인증)로 분류한 것이다 — 요청을 끝내는 동작(인증 실패 401 등)은 라우트가 아니다.
 */

/** 요청을 다음으로 넘긴다고 보는 Express·Koa·Connect 미들웨어 패키지다. */
const PASS_THROUGH_PACKAGES = new Set([
  'body-parser', 'compression', 'connect-timeout', 'cookie-parser', 'cookie-session', 'cors', 'csurf', 'express-async-errors',
  'express-rate-limit', 'express-session', 'express-validator', 'express-winston', 'helmet', 'hpp', 'method-override', 'morgan',
  'multer', 'passport', 'pino-http', 'response-time', 'express-fileupload', 'express-useragent', 'request-ip',
  '@koa/bodyparser', '@koa/cors', 'koa-bodyparser', 'koa-body', 'koa-compress', 'koa-helmet', 'koa-logger', 'koa-session',
  'koa-json', 'koa-conditional-get', 'koa-etag', 'koa-ratelimit', '@koa/multer', 'koa-passport',
]);

/** Express 내장 미들웨어 중 요청을 넘기는 것(`express.json()` 등)이다. */
const EXPRESS_PASS_THROUGH_MEMBERS = new Set(['json', 'urlencoded', 'raw', 'text']);

/** 정적 파일을 GET·HEAD로 제공하는 미들웨어다: (패키지, 가져온 이름). `express.static`과 serve-static 등이다. */
const STATIC_BINDINGS: readonly [string, string][] = [
  ['express', 'static'],
  ['serve-static', 'default'],
  ['serve-static', '*'],
  ['koa-static', 'default'],
  ['koa-static', '*'],
  ['@koa/static', 'default'],
];

/** 분류 결과다. */
export type MiddlewareClass =
  | { readonly kind: 'pass-through' }
  | { readonly kind: 'static'; readonly description: string }
  | { readonly kind: 'provided'; readonly description: string };

/**
 * 패키지에서 가져온 미들웨어를 분류한다.
 *
 * @param module 패키지 이름
 * @param name 가져온 이름(`default`·`*`·이름 또는 `ns.member`의 member)
 * @returns 분류
 */
export function classifyPackageMiddleware(module: string, name: string): MiddlewareClass {
  if (STATIC_BINDINGS.some(([staticModule, staticName]) => staticModule === module && staticName === name)) {
    return { kind: 'static', description: `static files from ${module === 'express' ? 'express.static' : module}` };
  }
  if (module === 'express' && EXPRESS_PASS_THROUGH_MEMBERS.has(name)) return { kind: 'pass-through' };
  if (PASS_THROUGH_PACKAGES.has(rootPackage(module))) return { kind: 'pass-through' };
  return { kind: 'provided', description: `middleware from ${rootPackage(module)}` };
}

/**
 * 모듈 지정자의 패키지 이름이다(`a/b` → `a`, `@s/a/b` → `@s/a`).
 *
 * @param module 모듈 지정자
 * @returns 패키지 이름
 */
export function rootPackage(module: string): string {
  const parts = module.split('/');
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}
