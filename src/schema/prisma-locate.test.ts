import assert from 'node:assert/strict';
import { constants, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { extractPersistenceFacts, type ExtractionResult } from './extract.ts';
import { extractProject, factLines, prismaBase, withProject } from './testing.test.ts';

/** 모델 하나짜리 스키마다. */
const oneModel = (name: string): string => `model ${name} {\n  id Int @id\n}\n`;

/** Prisma 버전만 고정한 package.json·잠금 파일이다. */
const versionFiles = (version: string): Record<string, string> => ({
  'package.json': JSON.stringify({ dependencies: { prisma: version } }),
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/prisma': { version } } }),
});

/** 프로젝트 밖에만 있는 모델이다. 사실에 이 이름이 나오면 링크를 따라간 것이다. */
const outsideModel = 'model OutsideSecret {\n  id Int @id\n  apiKey String\n}\n';

/** 프로젝트 밖에만 있는 TypedSQL 파일 내용이다. */
const outsideSql = 'SELECT * FROM outside_secret_table\n';

/** TypedSQL을 켠 저장소 안 스키마다. */
const typedSqlSchema = `generator client {\n  provider = "prisma-client-js"\n  previewFeatures = ["typedSql"]\n}\n${oneModel('InRepo')}`;

/** 링크를 따라가지 않았을 때 하나만 남는 skipped-symlinks 문장이다. */
const oneSkippedSymlink = 'skipped-symlinks: 1 symbolic link(s) were not followed';

/**
 * 임시 디렉터리에 프로젝트 루트 `app/`과 형제인 프로젝트 밖 `outside/`를 만들고, 링크를 건 뒤 `app/`을 추출한다.
 *
 * @param files 임시 디렉터리 기준 경로 → 내용(`app/` 쪽에는 Prisma 7.8.0 버전 파일이 더해진다)
 * @param links 임시 디렉터리 기준 링크 경로 → 대상 경로
 * @returns `app/`의 추출 결과
 */
function extractLinkedApp(files: Record<string, string>, links: Record<string, string>): ExtractionResult {
  const versions = Object.entries(versionFiles('7.8.0')).map(([path, text]) => [`app/${path}`, text]);
  return withProject({ ...Object.fromEntries(versions), ...files }, (root) => {
    for (const [link, target] of Object.entries(links)) {
      mkdirSync(dirname(join(root, link)), { recursive: true });
      symlinkSync(join(root, target), join(root, link));
    }
    return extractPersistenceFacts(join(root, 'app'));
  });
}

/**
 * 프로젝트 밖 이름이 든 사실 채널만 뽑는다.
 *
 * @param result 추출 결과
 * @returns 채널 목록(링크를 따라가지 않았으면 비어 있다)
 */
function outsideChannels(result: ExtractionResult): string[] {
  return result.facts.map((fact) => fact.channel).filter((channel) => /outside/iu.test(channel));
}

/**
 * skipped-symlinks limitation만 뽑는다.
 *
 * @param result 추출 결과
 * @returns limitation 목록
 */
function symlinkLines(result: ExtractionResult): string[] {
  return result.limitations.filter((line) => line.startsWith('skipped-symlinks:'));
}

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

test('중간 디렉터리 링크를 거친 Prisma 설정·스키마·TypedSQL은 읽지 않고 한 번만 센다', {
  skip: process.platform === 'win32',
}, () => {
  const outside = {
    'outside/prisma/schema.prisma': outsideModel,
    'outside/prisma/sql/leak.sql': outsideSql,
    'outside/sql/leak.sql': outsideSql,
    'outside/notes.txt': outsideModel,
    'outside/config/prisma.ts': "export default { schema: 'schema.prisma' };\n",
    'outside/config/schema.prisma': outsideModel,
  };
  const typedSqlConfig = "export default { schema: 'prisma/schema.prisma', typedSql: { path: 'queries/sql' } };\n";
  const cases: [string, Record<string, string>, Record<string, string>, boolean][] = [
    ['기본 위치 prisma/ 링크', {}, { 'app/prisma': 'outside/prisma' }, false],
    ['.config/ 링크의 설정 파일', {}, { 'app/.config': 'outside/config' }, false],
    ['설정 schema 경로의 중간 링크', { 'app/prisma.config.ts': "export default { schema: 'ext/notes.txt' };\n" }, { 'app/ext': 'outside' }, false],
    ['설정 schema 폴더 링크', { 'app/prisma.config.ts': "export default { schema: 'db' };\n" }, { 'app/db': 'outside/prisma' }, false],
    ['TypedSQL 기본 디렉터리 링크', { 'app/prisma/schema.prisma': typedSqlSchema }, { 'app/prisma/sql': 'outside/sql' }, true],
    ['설정 typedSql.path의 중간 링크', { 'app/prisma.config.ts': typedSqlConfig, 'app/prisma/schema.prisma': typedSqlSchema }, { 'app/queries': 'outside' }, true],
  ];
  for (const [name, files, links, hasRepoSchema] of cases) {
    const result = extractLinkedApp({ ...outside, ...files }, links);
    assert.deepEqual(outsideChannels(result), [], name);
    assert.deepEqual(symlinkLines(result), [oneSkippedSymlink], name);
    assert.ok(!result.limitations.some((line) => line.startsWith('missing-prisma-schemas:')), name);
    assert.equal(result.facts.some((fact) => fact.channel === 'InRepo'), hasRepoSchema, name);
  }
});

test('걷기가 들어가지 않는 경로의 링크도 세고 스키마 폴더 안 링크는 걷기와 이중으로 세지 않는다', {
  skip: process.platform === 'win32',
}, () => {
  const hidden = extractLinkedApp({
    'app/prisma.config.ts': "export default { schema: 'prisma/schema.prisma', typedSql: { path: '.db/sql' } };\n",
    'app/prisma/schema.prisma': typedSqlSchema,
    'app/.db/readme.md': '',
    'outside/sql/leak.sql': outsideSql,
  }, { 'app/.db/sql': 'outside/sql' });
  assert.deepEqual(outsideChannels(hidden), []);
  assert.deepEqual(symlinkLines(hidden), [oneSkippedSymlink]);
  const folder = extractLinkedApp({
    'app/prisma.config.ts': "export default { schema: 'db' };\n",
    'app/db/main.prisma': oneModel('InRepo'),
    'outside/schema.prisma': outsideModel,
  }, { 'app/db/linked.prisma': 'outside/schema.prisma' });
  assert.deepEqual(factLines(folder), ['db/main.prisma:1:7 InRepo @InRepo', 'db/main.prisma:2:3 InRepo.id @InRepo.id']);
  assert.deepEqual(symlinkLines(folder), [oneSkippedSymlink]);
});

test('마지막 요소 링크 스키마는 지금처럼 읽기에서 거부해 읽지 못한 파일로 센다', {
  skip: !constants.O_NOFOLLOW,
}, () => {
  const result = extractLinkedApp({ 'outside/schema.prisma': outsideModel }, { 'app/prisma/schema.prisma': 'outside/schema.prisma' });
  assert.deepEqual(outsideChannels(result), []);
  assert.ok(result.limitations.includes('unreadable-sources: 1 file(s) and 0 directory entr(ies) could not be read and were skipped'));
  assert.deepEqual(symlinkLines(result), [oneSkippedSymlink]);
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
