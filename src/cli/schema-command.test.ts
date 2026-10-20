import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stackExhaustionFailure } from './command-result.ts';
import { createNodeFileSystem } from './file-system.ts';
import { runCli } from './run-cli.ts';
import { MAX_SCHEMA_OUTPUT_LENGTH, runSchemaCommand, type SchemaEnvironment } from './schema-command.ts';
import { runMainGuarded } from './testing.test.ts';
import type { RelationUseFact } from '../schema/relation-facts.ts';

const fixture = fileURLToPath(new URL('../../fixtures/schema/prisma-app/', import.meta.url));
const fixedNow = new Date('2026-09-27T00:00:00.000Z');

/**
 * 실제 파일 시스템과 고정 시계로 실행 환경을 만든다.
 *
 * @param overrides 바꿀 필드
 * @returns 실행 환경
 */
function environment(overrides: Partial<SchemaEnvironment> = {}): SchemaEnvironment {
  return { fileSystem: createNodeFileSystem(), toolVersion: '9.9.9', now: () => fixedNow, ...overrides };
}

test('합성 fixture를 결정적인 persistence 문서로 바꾼다', async () => {
  const first = await runSchemaCommand(['--project', fixture, '--format', 'json'], environment());
  const second = await runSchemaCommand(['--project', fixture], environment());
  assert.equal(first.exitCode, 0);
  assert.equal(first.standardOutput, second.standardOutput);
  const document = JSON.parse(first.standardOutput);
  assert.equal(document.format, 'bridge-facts');
  assert.equal(document.version, 1);
  assert.equal(document.platform, 'js');
  assert.equal(document.target, 'persistence');
  assert.equal(document.project, realpathSync(fixture));
  assert.equal(document.generatedAt, '2026-09-27T00:00:00.000Z');
  assert.deepEqual(document.tool, { name: 'tsograph', version: '9.9.9' });
  assert.ok(document.facts.every((fact: RelationUseFact) => fact.kind === 'relation-use' && !fact.location.path.startsWith('/')));
  const summary = document.facts.map((fact: RelationUseFact) => `${fact.channel}${fact.method === undefined ? '' : `.${fact.method}`}`);
  for (const expected of ['authors', 'authors.full_name', 'Book.search', '_BookToTag', '_BookToTag.A', 'Tag.label']) {
    assert.ok(summary.includes(expected), expected);
  }
  assert.ok(!summary.includes('ImportBatch'));
  // 소스 사실의 usr는 그래프 id(= qualifiedName), 스키마 선언·TypedSQL 사실의 usr는 그래프 노드가 아닌
  // 별도 이름공간(`#model:`·`#typedsql:`)이다. 심볼이 있는 사실은 모두 usr를 싣는다.
  const symbols = document.facts.filter((fact: RelationUseFact) => fact.symbol !== undefined)
    .map((fact: RelationUseFact) => `${fact.location.path} ${fact.symbol!.qualifiedName} ${fact.symbol!.usr}`);
  for (const expected of [
    'src/lib/books.ts src/lib/books.ts#listBooks src/lib/books.ts#listBooks',
    'prisma/schema/library.prisma Book prisma/schema/library.prisma#model:Book',
    'prisma/schema/library.prisma Author.fullName prisma/schema/library.prisma#model:Author.fullName',
    'prisma/schema/library.prisma Book.tags prisma/schema/library.prisma#model:Book.tags',
    'prisma/sql/booksByGenre.sql prisma/sql/booksByGenre.sql#booksByGenre prisma/sql/booksByGenre.sql#typedsql:booksByGenre',
  ]) {
    assert.ok(symbols.includes(expected), expected);
  }
  assert.ok(document.facts.every((fact: RelationUseFact) => fact.symbol === undefined || fact.symbol.usr !== undefined));
  assert.ok(!summary.includes('Book.legacy'));
  assert.deepEqual(document.limitations, [
    'ignored-prisma-elements: 1 @@ignore model(s) and 1 @ignore field(s) are not emitted',
    'unsupported-db-packages: 1 source file(s) use SQL packages outside the supported surface: kysely (1)',
    'dynamic-relation-names: 1 SQL argument(s), relation operand(s), or delegate access(es) were not statically readable; they are emitted as dynamic facts',
    'unresolved-client-receivers: 1 Prisma delegate call(s) use receivers that could not be traced to a PrismaClient; not emitted',
    'missing-relation-usrs: 2 relation-use fact(s) have source locations but no enclosing declaration name, so they carry no symbol and no usr',
  ]);
});

test('사실이 없으면 target은 null이다', async () => {
  const result = await runSchemaCommand(['--project', '.'], environment({
    extract: () => ({ facts: [], limitations: [], sourceModifiedAt: new Date('2026-01-01T00:00:00Z') }),
  }));
  const document = JSON.parse(result.standardOutput);
  assert.equal(document.target, null);
  assert.equal(document.sourceModifiedAt, '2026-01-01T00:00:00.000Z');
});

test('잘못된 호출은 64, 읽을 수 없는 프로젝트·과대 출력은 2다', async () => {
  for (const args of [[], ['x'], ['--project'], ['--project', '.', '--format', 'yaml'], ['--unknown']]) {
    assert.equal((await runSchemaCommand(args, environment())).exitCode, 64, JSON.stringify(args));
  }
  const help = await runSchemaCommand(['--help'], environment());
  assert.equal(help.exitCode, 0);
  assert.match(help.standardOutput, /^Usage: tsograph schema/u);
  const missing = await runSchemaCommand(['--project', '/nonexistent/tsograph-project'], environment());
  assert.equal(missing.exitCode, 2);
  assert.doesNotMatch(missing.standardError, /nonexistent/u);
  const file = await runSchemaCommand(['--project', fileURLToPath(import.meta.url)], environment());
  assert.equal(file.exitCode, 2);
  const unsafe = await runSchemaCommand(['--project', '.'], environment({
    fileSystem: { ...createNodeFileSystem(), realPath: async () => '/tmp/a\u0085b', status: async () => ({ kind: 'directory', size: 0, modifiedAt: fixedNow }) },
  }));
  assert.equal(unsafe.exitCode, 2);
  const fact: RelationUseFact = { kind: 'relation-use', channel: 'x'.repeat(1024), dynamic: false, location: { path: 'a.ts', line: 1, column: 1 } };
  const huge = await runSchemaCommand(['--project', '.'], environment({
    extract: () => ({ facts: Array.from({ length: Math.ceil(MAX_SCHEMA_OUTPUT_LENGTH / 1024) }, () => fact), limitations: [], sourceModifiedAt: undefined }),
  }));
  assert.equal(huge.exitCode, 2);
  assert.match(huge.standardError, /exceed/u);
  const many = await runSchemaCommand(['--project', '.'], environment({
    extract: () => ({ facts: Array.from({ length: 100_001 }, () => fact), limitations: [], sourceModifiedAt: undefined }),
  }));
  assert.equal(many.exitCode, 2);
  assert.match(many.standardError, /100000 relation-use facts/u);
});

test('추출 중 스택 초과는 공용 원인 문구의 2이고 다른 RangeError는 내부 오류로 전파한다', async () => {
  const exhausted = await runSchemaCommand(['--project', '.'], environment({
    extract: () => { throw new RangeError('Maximum call stack size exceeded'); },
  }));
  assert.deepEqual(exhausted, stackExhaustionFailure());
  await assert.rejects(runSchemaCommand(['--project', '.'], environment({
    extract: () => { throw new RangeError('Map maximum size exceeded'); },
  })), { name: 'RangeError', message: 'Map maximum size exceeded' });
});

test('분배기가 schema 명령과 도움말을 안다', async () => {
  const env = { fileSystem: createNodeFileSystem(), toolVersion: '1.0.0', now: () => fixedNow };
  assert.match((await runCli(['--help'], env)).standardOutput, /schema {7}Extract Prisma/u);
  assert.match((await runCli(['help', 'schema'], env)).standardOutput, /^Usage: tsograph schema/u);
  assert.equal((await runCli(['schema'], env)).exitCode, 64);
});

/**
 * 파일마다 구문 트리를 놓는지 보는 자식의 V8 힙 상한(MiB)이다. 아래 합성 프로젝트(소스 약 3.8 Mi 문자)는 모든 트리를
 * 끝까지 붙잡던 구조에서 힙 160 MiB로도 OOM(종료 134)으로 끝났고 224 MiB에서야 문서를 냈다. 파일마다 트리를 놓는
 * 구조는 48 MiB에서 끝난다(TypeScript 적재분과 소스 텍스트가 대부분이다). 양쪽에 두 배쯤 여유를 둔 값이다.
 */
const RELEASE_CHILD_HEAP_MIB = 96;

/** 힙 상한 검사 프로젝트의 합성 서비스 파일 수다(파일당 약 4.8 K 문자). */
const RELEASE_SERVICE_FILES = 800;

/**
 * 관계 사용이 없는 합성 서비스 파일 하나의 내용이다(메서드 24개, 약 4.8 K 문자).
 *
 * @param index 파일 번호
 * @returns 파일 내용
 */
function syntheticServiceSource(index: number): string {
  const lines = [`export class Service${index} {`];
  for (let method = 0; method < 24; method++) {
    lines.push(`  method${method}(id: number, label: string) {`);
    lines.push(`    const value = { id: id + ${method}, name: label + '-${index}', tags: ['a${method}', 'b${index}'] };`);
    lines.push(`    return value.tags.length > ${method} ? value : { ...value, id: value.id * 2 };`);
    lines.push('  }');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

test('ORM 게이트가 닫힌 프로젝트는 파일마다 구문 트리를 놓아, 모든 트리를 합친 크기보다 작은 힙에서도 같은 문서를 낸다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-schema-heap-')));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'heap-app', private: true }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/query.ts'), "export function listUsers(run: (sql: string) => unknown) {\n  return run('SELECT id FROM users');\n}\n");
    for (let index = 0; index < RELEASE_SERVICE_FILES; index++) writeFileSync(join(root, 'src', `m${index}.ts`), syntheticServiceSource(index));
    const run = await runMainGuarded(['schema', '--project', root], [`--max-old-space-size=${RELEASE_CHILD_HEAP_MIB}`]);
    assert.equal(run.stopped, undefined);
    assert.equal(run.status, 0, run.stderr.slice(0, 400));
    const document = JSON.parse(run.stdout);
    assert.deepEqual(document.facts.map((fact: RelationUseFact) => `${fact.location.path}:${fact.location.line} ${fact.channel}`), ['src/query.ts:2 users']);
    assert.deepEqual(document.limitations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
