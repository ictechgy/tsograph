/**
 * NestJS 추출 규칙(부트스트랩·버전·모듈 경로·어댑터)을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factLines, limitationsWith, packageJson, scanNodeProject } from './testing.test.ts';

/** 흔한 컨트롤러·모듈이다. */
const controllerFiles: Record<string, string> = {
  'src/items.controller.ts': [
    "import { Controller, Get, Post, Search } from '@nestjs/common';",
    "const BASE = 'items';",
    'class BaseController {',
    "  @Get('inherited')",
    "  inherited() { return 'i'; }",
    '}',
    '@Controller([BASE, `goods`])',
    'export class ItemsController extends BaseController {',
    '  @Get()',
    "  list() { return 'l'; }",
    '  @Post(process.env.P as string)',
    "  dynamic() { return 'd'; }",
    '  @Search()',
    "  search() { return 's'; }",
    '}',
  ].join('\n'),
  'src/root.controller.ts': "import { Controller, Get } from '@nestjs/common';\n@Controller()\nexport class RootController {\n  @Get(['a', 'b'])\n  ab() { return 'ab'; }\n}\n",
  'src/app.module.ts': [
    "import { Module } from '@nestjs/common';",
    "import { RouterModule } from '@nestjs/core';",
    "import { ItemsController } from './items.controller.js';",
    "import { RootController } from './root.controller.js';",
    '@Module({ controllers: [ItemsController] })',
    'export class ItemsModule {}',
    '@Module({ controllers: [RootController] })',
    'export class ChildModule {}',
    "@Module({ imports: [RouterModule.register([{ path: 'shop', module: ItemsModule, children: [{ path: 'child', module: ChildModule }] }])] })",
    'export class AppModule {}',
  ].join('\n'),
};

test('Fastify 어댑터·모듈 경로·배열 경로·상속 메서드·비표준 동사를 다룬다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ '@nestjs/core': '11.1.0', '@nestjs/common': '11.1.0', '@nestjs/platform-fastify': '11.1.0' }),
    ...controllerFiles,
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { FastifyAdapter } from '@nestjs/platform-fastify';\nimport { AppModule } from './app.module.js';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule, new FastifyAdapter());\n  app.setGlobalPrefix('/api/');\n}\nvoid bootstrap();\n",
  });
  assert.equal(document.dispatch, 'specificity');
  assert.deepEqual(factLines(document), [
    'GET root /api/shop/child/a strict',
    'GET root /api/shop/child/b strict',
    'GET root /api/shop/goods strict',
    'GET root /api/shop/goods/inherited strict',
    'GET root /api/shop/items strict',
    'GET root /api/shop/items/inherited strict',
    'POST root /api/shop/goods/{dynamic} - dynamic',
    'POST root /api/shop/items/{dynamic} - dynamic',
  ].sort().map((line) => line.replace('/{dynamic} - dynamic', '/{dynamic} - dynamic')));
  assert.equal(limitationsWith(document, 'route-coverage: 2 route registration(s) also accept HTTP verbs').length, 1);
});

test('부트스트랩이 없으면 base 앵커이고, 헤더 버전·routeResolutionStrategy는 순서를 싣지 않는다', async () => {
  const noBootstrap = await scanNodeProject({
    'package.json': packageJson({ '@nestjs/core': '10.4.0', '@nestjs/common': '10.4.0' }),
    ...controllerFiles,
  });
  assert.ok(noBootstrap.facts.every((fact) => fact.pathAnchor === 'base'));
  assert.equal(limitationsWith(noBootstrap, 'unresolved-route-prefix: no NestFactory.create()').length, 1);

  const header = await scanNodeProject({
    'package.json': packageJson({ '@nestjs/core': '12.0.0', '@nestjs/common': '12.0.0', '@nestjs/platform-express': '12.0.0' }),
    'src/v.controller.ts': "import { Controller, Get, Version } from '@nestjs/common';\n@Controller('v')\nexport class VController {\n  @Get('x')\n  @Version(['1', '2'])\n  x() { return 'x'; }\n  @Get('y')\n  y() { return 'y'; }\n}\n",
    'src/app.module.ts': "import { Module } from '@nestjs/common';\nimport { VController } from './v.controller.js';\n@Module({ controllers: [VController] })\nexport class AppModule {}\n",
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { VersioningType } from '@nestjs/common';\nimport { AppModule } from './app.module.js';\nexport async function create() {\n  const app = await NestFactory.create(AppModule, { routeResolutionStrategy: 'specificity' });\n  app.enableVersioning({ type: VersioningType.HEADER, header: 'X-V' });\n  return app;\n}\n",
  });
  assert.deepEqual(factLines(header), ['GET root /v/x optional ci narrowed', 'GET root /v/y optional ci']);
});

test('전역 접두사 제외(객체)·모르는 접두사·모르는 버전 설정을 다룬다', async () => {
  const base = {
    'package.json': packageJson({ '@nestjs/core': '12.1.0', '@nestjs/common': '12.1.0' }),
    'src/h.controller.ts': "import { Controller, Get, Post } from '@nestjs/common';\n@Controller('h')\nexport class HController {\n  @Get()\n  get() { return 'g'; }\n  @Post()\n  post() { return 'p'; }\n}\n",
    'src/app.module.ts': "import { Module } from '@nestjs/common';\nimport { HController } from './h.controller.js';\n@Module({ controllers: [HController] })\nexport class AppModule {}\n",
  };
  const excluded = await scanNodeProject({
    ...base,
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { RequestMethod } from '@nestjs/common';\nimport { AppModule } from './app.module.js';\nexport async function create() {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix('api', { exclude: [{ path: 'h', method: RequestMethod.GET }] });\n  app.enableVersioning({ type: VersioningType.URI, prefix: false, defaultVersion: '3' });\n  return app;\n}\nimport { VersioningType } from '@nestjs/common';\n",
  });
  assert.deepEqual(factLines(excluded), ['GET root /3/h optional #0 ci', 'POST root /api/3/h optional #1 ci']);
  const unknown = await scanNodeProject({
    ...base,
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module.js';\nexport async function create(options: object) {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix(process.env.PREFIX as string);\n  app.enableVersioning(options as never);\n  return app;\n}\n",
  });
  assert.deepEqual(factLines(unknown), ['GET base /h optional #0 ci', 'POST base /h optional #1 ci']);
});
