/**
 * `package.json`으로 Node 백엔드 프레임워크를 감지하고 확인한 주 버전과 대조한다.
 *
 * 감지는 프로젝트 루트 `package.json`의 의존성 선언으로만 한다(설치된 `node_modules`는 읽지 않는다). 확인한 주 버전
 * (Hono 4, Express 4·5, Fastify 4·5, @koa/router·koa-router 12–15, NestJS 10–12)이 아니거나 잠금 파일·범위로 정하지
 * 못하면 `route-framework-version-unknown:` 한계를 낸다. 경로 문법이 주 버전마다 다른 경우(Express, @koa/router)는 두
 * 문법이 같은 결과를 낼 때만 정적 사실로 낸다.
 */

import type { ProjectDependencies } from './dependency-versions.ts';

/** 감지한 프레임워크와 버전이다. */
export interface DetectedFrameworks {
  readonly hono?: { readonly major: number | undefined };
  readonly express?: { readonly major: number | undefined };
  readonly fastify?: { readonly major: number | undefined };
  readonly koa?: { readonly routerPackage: string | undefined; readonly routerMajor: number | undefined };
  readonly nest?: { readonly major: number | undefined; readonly adapters: readonly ('express' | 'fastify')[]; readonly expressMajor: number | undefined };
  /** `next` 의존성 선언 */
  readonly next: boolean;
  /** 라우트를 모델링하지 않는 서버 프레임워크 이름(정렬) */
  readonly unsupported: readonly string[];
  /** 확인한 주 버전과 다르거나 정하지 못한 패키지(정렬) */
  readonly unverified: readonly string[];
}

/** 확인한 주 버전이다. */
const VERIFIED_MAJORS: Readonly<Record<string, readonly number[]>> = {
  hono: [4],
  express: [4, 5],
  fastify: [4, 5],
  '@koa/router': [12, 13, 14, 15],
  'koa-router': [12, 13, 14],
  '@nestjs/core': [10, 11, 12],
};

/** 라우트를 모델링하지 않는 서버 프레임워크·확장이다. 선언만 있어도 `route-coverage:`로 알린다. */
const UNSUPPORTED_SERVER_PACKAGES = [
  '@adonisjs/core', '@feathersjs/feathers', '@hapi/hapi', '@hono/zod-openapi', '@tinyhttp/app', '@trpc/server', 'elysia', 'h3',
  'hapi', 'hyper-express', 'itty-router', 'micro', 'polka', 'restify', 'sails', 'ultimate-express',
];

/**
 * 의존성에서 프레임워크를 감지한다.
 *
 * @param dependencies 프로젝트 의존성
 * @returns 감지 결과
 */
export function detectFrameworks(dependencies: ProjectDependencies): DetectedFrameworks {
  const has = (name: string): boolean => dependencies.declared.has(name);
  const unverified = new Set<string>();
  const verify = (name: string): number | undefined => {
    const major = dependencies.majorOf(name);
    if (major === undefined || !VERIFIED_MAJORS[name]!.includes(major)) unverified.add(name);
    return major;
  };
  const routerPackage = ['@koa/router', 'koa-router'].find(has);
  const nestAdapters = (['express', 'fastify'] as const).filter((adapter) => has(`@nestjs/platform-${adapter}`));
  const nestMajor = has('@nestjs/core') ? verify('@nestjs/core') : undefined;
  return {
    ...(has('hono') ? { hono: { major: verify('hono') } } : {}),
    ...(has('express') ? { express: { major: verify('express') } } : {}),
    ...(has('fastify') ? { fastify: { major: verify('fastify') } } : {}),
    ...(has('koa') || routerPackage !== undefined ? { koa: { routerPackage, routerMajor: routerPackage === undefined ? undefined : verify(routerPackage) } } : {}),
    ...(has('@nestjs/core') ? { nest: { major: nestMajor, adapters: nestAdapters.length === 0 ? ['express'] : nestAdapters, expressMajor: nestExpressMajor(nestMajor) } } : {}),
    next: has('next'),
    unsupported: UNSUPPORTED_SERVER_PACKAGES.filter(has),
    unverified: [...unverified].sort(),
  };
}

/**
 * NestJS 주 버전의 Express 어댑터가 쓰는 Express 주 버전이다(@nestjs/platform-express 10은 express 4.21, 11·12는 5.2).
 *
 * @param nestMajor NestJS 주 버전
 * @returns Express 주 버전 또는 undefined
 */
function nestExpressMajor(nestMajor: number | undefined): number | undefined {
  if (nestMajor === 10) return 4;
  if (nestMajor === 11 || nestMajor === 12) return 5;
  return undefined;
}

/**
 * Node 백엔드 프레임워크를 하나라도 감지했는지 본다.
 *
 * @param detected 감지 결과
 * @returns 감지했으면 true
 */
export function hasNodeFramework(detected: DetectedFrameworks): boolean {
  return detected.hono !== undefined || detected.express !== undefined || detected.fastify !== undefined || detected.koa !== undefined || detected.nest !== undefined;
}
