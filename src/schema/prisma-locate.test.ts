import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { extractPersistenceFacts } from './extract.ts';
import { extractProject, factLines, prismaBase, withProject } from './testing.test.ts';

/** 모델 하나짜리 스키마다. */
const oneModel = (name: string): string => `model ${name} {\n  id Int @id\n}\n`;

/** Prisma 버전만 고정한 package.json·잠금 파일이다. */
const versionFiles = (version: string): Record<string, string> => ({
  'package.json': JSON.stringify({ dependencies: { prisma: version } }),
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/prisma': { version } } }),
});

/**
 * 추출 결과의 스키마 관계 채널만 뽑는다.
 *
 * @param files 프로젝트 파일
 * @returns `path channel` 목록
 */
function schemaChannels(files: Record<string, string>): string[] {
  return extractProject(files).facts
    .filter((fact) => fact.method === undefined && fact.location.path.endsWith('.prisma'))
    .map((fact) => `${fact.location.path} ${fact.channel}`);
}

test('설정의 schema 폴더는 하위 폴더까지 .prisma 파일을 모두 읽는다', () => {
  assert.deepEqual(schemaChannels({
    ...versionFiles('7.8.0'),
    'prisma.config.ts': "export default { schema: 'db' };\n",
    'db/main.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
    'db/models/a.prisma': oneModel('Alpha'),
    'db/models/deep/b.prisma': oneModel('Beta'),
    'db/models/notes.txt': 'model Ignored {}',
  }), ['db/models/a.prisma Alpha', 'db/models/deep/b.prisma Beta']);
});

test('설정이 없으면 schema.prisma를 prisma/schema.prisma보다 먼저 한 파일만 읽는다', () => {
  assert.deepEqual(schemaChannels({
    ...versionFiles('7.8.0'),
    'schema.prisma': oneModel('RootModel'),
    'prisma/schema.prisma': oneModel('NestedModel'),
    'prisma/other.prisma': oneModel('Other'),
  }), ['schema.prisma RootModel']);
});

test('.config/prisma.ts와 schema 없는 설정은 기본 위치로 간다', () => {
  assert.deepEqual(schemaChannels({
    ...versionFiles('7.8.0'),
    '.config/prisma.ts': "export default { migrations: { path: 'x' } };\n",
    'prisma/schema.prisma': oneModel('Nested'),
  }), ['prisma/schema.prisma Nested']);
});

test('package.json prisma.schema는 6.x 이하에서만 쓴다', () => {
  const files = (version: string): Record<string, string> => ({
    'package.json': JSON.stringify({ dependencies: { prisma: version }, prisma: { schema: 'db/app.prisma' } }),
    'db/app.prisma': oneModel('Legacy'),
    'prisma/schema.prisma': oneModel('Default'),
  });
  assert.deepEqual(schemaChannels(files('6.5.0')), ['db/app.prisma Legacy']);
  assert.deepEqual(schemaChannels(files('7.8.0')), ['prisma/schema.prisma Default']);
});

test('모노레포 패키지의 스키마도 찾고 조인 루트 기준 경로로 낸다', () => {
  assert.deepEqual(schemaChannels({
    'packages/api/package.json': JSON.stringify({ devDependencies: { prisma: '7.8.0' } }),
    'packages/api/prisma/schema.prisma': oneModel('ApiModel'),
    'packages/web/package.json': JSON.stringify({ dependencies: { react: '19' } }),
    'packages/web/prisma/schema.prisma': oneModel('NotPrisma'),
  }), ['packages/api/prisma/schema.prisma ~ApiModel'.replace('~', '')]);
});

test('읽지 못한 설정·없는 경로·의존만 있는 프로젝트는 limitation으로 알린다', () => {
  const unresolved = extractProject({ ...versionFiles('7.8.0'), 'prisma.config.ts': "export default { schema: process.env.SCHEMA };\n" });
  assert.ok(unresolved.limitations.some((line) => line.startsWith('unresolved-prisma-config: 1 ')));
  assert.ok(!unresolved.limitations.some((line) => line.startsWith('prisma-schema-not-found')));
  const missing = extractProject({ ...versionFiles('7.8.0'), 'prisma.config.ts': "export default { schema: 'nowhere' };\n" });
  assert.ok(missing.limitations.some((line) => line.startsWith('missing-prisma-schemas: 1 ')));
  const emptyFolder = extractProject({ ...versionFiles('7.8.0'), 'prisma.config.ts': "export default { schema: 'db' };\n", 'db/readme.md': '' });
  assert.ok(emptyFolder.limitations.some((line) => line.startsWith('missing-prisma-schemas: 1 ')));
  const none = extractProject(versionFiles('7.8.0'));
  assert.ok(none.limitations.some((line) => line.startsWith('prisma-schema-not-found: ')));
  assert.deepEqual(extractProject({ 'package.json': '{broken' }).limitations, []);
});

test('프로젝트 밖 스키마와 스키마 폴더의 심볼릭 링크는 읽지 않고 센다', () => {
  withProject({ 'outside/schema.prisma': oneModel('Outside'), 'app/package.json': JSON.stringify({ dependencies: { prisma: '7.8.0' } }) }, (root) => {
    mkdirSync(join(root, 'app', 'db'));
    symlinkSync(join(root, 'outside', 'schema.prisma'), join(root, 'app', 'db', 'linked.prisma'));
    const inFolder = extractPersistenceFacts(join(root, 'app'));
    assert.deepEqual(inFolder.facts, []);
    assert.ok(inFolder.limitations.some((line) => line.startsWith('skipped-symlinks: 1 ')));
  });
  withProject({ 'outside/schema.prisma': oneModel('Outside'), 'app/prisma.config.ts': "export default { schema: '../outside/schema.prisma' };\n" }, (root) => {
    const outside = extractPersistenceFacts(join(root, 'app'));
    assert.deepEqual(outside.facts, []);
    assert.ok(outside.limitations.some((line) => line.startsWith('schema-outside-project: 1 ')));
  });
});

test('MongoDB datasource는 사실을 내지 않고 이름 규칙 불확정은 limitation이다', () => {
  const mongo = extractProject({
    ...versionFiles('7.8.0'),
    'prisma/schema.prisma': 'datasource db {\n  provider = "mongodb"\n}\n' + oneModel('Doc'),
    'src/a.ts': "import { PrismaClient } from '@prisma/client';\nnew PrismaClient().doc.findMany();\n",
  });
  assert.deepEqual(mongo.facts, []);
  assert.ok(mongo.limitations.some((line) => line.startsWith('non-relational-stores: the Prisma datasource provider is mongodb')));
  const unknown = extractProject({ 'prisma/schema.prisma': oneModel('Order') + oneModel('item'), 'package.json': '{}' });
  assert.deepEqual(factLines(unknown), [
    'prisma/schema.prisma:1:7 Order dyn @Order',
    'prisma/schema.prisma:4:7 item @item',
    'prisma/schema.prisma:5:3 item.id @item.id',
  ]);
  assert.ok(unknown.limitations.some((line) => line.startsWith('prisma-naming-unverified: no Prisma package version was found in a lockfile or package.json; 1 table name(s)')));
  const family = extractProject({ ...prismaBase, 'pnpm-lock.yaml': "packages:\n  '@prisma/orm-family-sql@8.0.0-rc.5':\n" });
  assert.ok(family.limitations.some((line) => line.startsWith('prisma-8-surface-unscanned: ')));
  assert.ok(factLines(family).includes('prisma/schema.prisma:13:7 Post dyn @Post'));
});

test('TypedSQL 파일은 previewFeatures에 typedSql이 있을 때만 읽는다', () => {
  const schema = (features: string): string => `generator client {\n  provider = "prisma-client-js"\n  previewFeatures = [${features}]\n}\n${oneModel('Report')}`;
  const sql = { 'prisma/sql/topReports.sql': 'SELECT * FROM "Report" r\nJOIN {missing} ON true\n' };
  const on = extractProject({ ...versionFiles('7.8.0'), 'prisma/schema.prisma': schema('"typedSql"'), ...sql });
  assert.deepEqual(factLines(on).filter((line) => line.includes('.sql')), [
    'prisma/sql/topReports.sql:1:1 SELECT * FROM "Report" r JOIN {missing} ON true dyn @prisma/sql/topReports.sql#topReports',
    'prisma/sql/topReports.sql:1:10 Report @prisma/sql/topReports.sql#topReports',
  ]);
  const off = extractProject({ ...versionFiles('7.8.0'), 'prisma/schema.prisma': schema(''), ...sql });
  assert.deepEqual(factLines(off).filter((line) => line.includes('.sql')), []);
  const unresolved = extractProject({
    ...versionFiles('7.8.0'),
    'prisma.config.ts': "export default { schema: 'prisma/schema.prisma', typedSql: { path: dir } };\n",
    'prisma/schema.prisma': schema('"typedSql"'),
    'generator.prisma': '',
  });
  assert.ok(unresolved.limitations.some((line) => line.startsWith('unresolved-typed-sql: 1 ')));
});

test('리터럴이 아닌 generator output은 limitation으로 알린다', () => {
  const result = extractProject({
    ...versionFiles('7.8.0'),
    'prisma/schema.prisma': `generator client {\n  provider = "prisma-client"\n  output = env("OUT")\n}\n${oneModel('Thing')}`,
  });
  assert.ok(result.limitations.some((line) => line.startsWith('unresolved-generator-outputs: 1 ')));
});
