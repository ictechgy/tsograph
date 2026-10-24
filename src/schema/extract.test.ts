import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import type { ExtractionResult } from './extract.ts';
import { MAX_SYNTAX_DEPTH } from './syntax-depth.ts';
import { extractProject, factLines, prismaBase } from './testing.test.ts';

/**
 * generator output만 바꾼 Prisma 프로젝트다. 생성 클라이언트 디렉터리와 이름만 같은 가짜 클라이언트도 둔다.
 *
 * @param output generator output 원문
 * @returns 프로젝트 파일
 */
function generatorOutputProject(output: string): Record<string, string> {
  return {
    ...prismaBase,
    'prisma/schema.prisma': prismaBase['prisma/schema.prisma']!.replace(
      '  provider = "prisma-client-js"\n',
      `  provider = "prisma-client-js"\n  output = "${output}"\n`,
    ),
    'src/a.ts': "import { PrismaClient } from '@prisma/client';\nconst prisma = new PrismaClient();\n"
      + "export const run = () => prisma.user.findMany({ select: { email: true } });\n"
      + "export const raw = () => prisma.$queryRawUnsafe('DELETE FROM audit_log');\n",
    'src/fake.ts': 'export class PrismaClient {}\n',
    'src/b.ts': "import { PrismaClient } from './fake';\nconst client = new PrismaClient();\nexport const list = () => client.post.findMany();\n",
    'src/generated/client.ts': "export const generated = 'SELECT * FROM generated_table';\n",
  };
}

/**
 * 소스(`src/`) 사실만 한 줄씩 뽑는다.
 *
 * @param result 추출 결과
 * @returns 사실 줄
 */
function sourceFactLines(result: ExtractionResult): string[] {
  return factLines(result).filter((line) => line.startsWith('src/'));
}

test('프로젝트 루트나 그 조상을 가리키는 generator output은 소스 제외·출처 판정에 쓰지 않고 알린다', () => {
  const generated = extractProject(generatorOutputProject('../src/generated'));
  const expected = sourceFactLines(generated);
  assert.ok(expected.some((line) => line.includes('audit_log')));
  assert.ok(!expected.some((line) => line.startsWith('src/generated/') || line.startsWith('src/b.ts')));
  assert.ok(!generated.limitations.some((line) => line.startsWith('unresolved-generator-outputs:')));
  for (const output of ['..', '../..']) {
    const result = extractProject(generatorOutputProject(output));
    const lines = sourceFactLines(result);
    assert.deepEqual(lines.filter((line) => line.startsWith('src/a.ts')), expected, output);
    assert.ok(!lines.some((line) => line.startsWith('src/b.ts')), output);
    assert.ok(result.limitations.includes('unresolved-generator-outputs: 1 Prisma generator output(s) resolve to the project root '
      + 'or one of its ancestors; they were not excluded from the source scan and imports of those clients are not traced'), output);
  }
});

test('schema parse-error limitation은 안전한 상대 파일 10개와 생략 수만 싣는다', () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 12; index++) {
    files[`src/bad${String(index).padStart(2, '0')}.ts`] = 'export const = ;\n';
  }
  // Windows에서도 생성할 수 있는 교환 금지 문자 U+2028로 같은 계수·출력 거부를 검증한다.
  const unsafeName = process.platform === 'win32' ? 'bad\u2028unsafe.ts' : 'bad\nunsafe.ts';
  files[`src/${unsafeName}`] = 'export const = ;\n';
  const result = extractProject(files);
  const limitation = result.limitations.find((line) => line.startsWith('parse-errors:'));
  assert.equal(limitation,
    'parse-errors: 12 source file(s) could not be parsed completely; '
    + 'files: ["src/bad00.ts","src/bad01.ts","src/bad02.ts","src/bad03.ts","src/bad04.ts",'
    + '"src/bad05.ts","src/bad06.ts","src/bad07.ts","src/bad08.ts","src/bad09.ts"]; omitted: 2');
  assert.ok(!limitation?.includes(unsafeName));
  assert.ok(result.limitations.includes(unsafeWalkNames(1)));
});

/**
 * 구문 깊이 상한을 넘는 파일들이다. 고치기 전에는 하나만 있어도 schema 전체가 스택 초과로 끝났다: 괄호는 파서, `||`
 * 사슬은 이름 해석기 Program의 TypeScript 바인더, 메서드 사슬은 tsograph 방문기가 넘쳤다.
 */
const deeplyNestedSources: Readonly<Record<string, string>> = {
  'src/deep/parens.ts': `export const p = ${'('.repeat(3_000)}1${')'.repeat(3_000)};\n`,
  'src/deep/logical.ts': `declare const a: boolean;\nexport const o = ${Array.from({ length: 3_000 }, () => 'a').join(' || ')};\n`,
  'src/deep/chain.ts': `declare const api: any;\nexport const v = api${'.get(1)'.repeat(3_000)};\n`,
};

test('구문 중첩이 상한을 넘는 소스는 그 파일만 parse-errors로 빼고 상한 안의 파일은 그대로 분석한다', () => {
  // `export const s = a + …;`의 깊이는 항 수 + 4라 이 파일은 상한과 같은 깊이다(빼지 않는다).
  const atLimit = Array.from({ length: MAX_SYNTAX_DEPTH - 4 }, () => '"a"').join(' + ');
  const result = extractProject({
    'src/ok.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport const users = () => pool.query('SELECT id FROM users');\n",
    'src/edge.ts': `import { Pool } from 'pg';\nconst pool = new Pool();\nexport const s = ${atLimit};\n`
      + "export const accounts = () => pool.query('SELECT id FROM accounts');\n",
    ...deeplyNestedSources,
  });
  const lines = factLines(result);
  assert.ok(lines.some((line) => line.startsWith('src/ok.ts:') && line.includes(' users ')), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('src/edge.ts:') && line.includes(' accounts ')), lines.join('\n'));
  assert.ok(!lines.some((line) => line.startsWith('src/deep/')));
  assert.deepEqual(result.limitations.filter((line) => line.startsWith('parse-errors:')), [
    `parse-errors: 3 source file(s) nest syntax more than ${MAX_SYNTAX_DEPTH} levels deep or overflow the parser's call stack and were not analyzed; `
      + 'files: ["src/deep/chain.ts","src/deep/logical.ts","src/deep/parens.ts"]; omitted: 0',
  ]);
});

test('D1 바인딩을 읽는 선언 파일이 구문 깊이 상한을 넘으면 그 파일만 parse-errors로 빼고 계속한다', () => {
  const result = extractProject({
    'worker-configuration.d.ts': `interface Env { MAIN_DB: D1Database; DEEP: ${'Array<'.repeat(3_000)}number${'>'.repeat(3_000)} }\n`,
    'src/ok.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport const users = () => pool.query('SELECT id FROM users');\n",
  });
  assert.ok(factLines(result).some((line) => line.startsWith('src/ok.ts:') && line.includes(' users ')));
  assert.deepEqual(result.limitations.filter((line) => line.startsWith('parse-errors:')), [
    `parse-errors: 1 source file(s) nest syntax more than ${MAX_SYNTAX_DEPTH} levels deep or overflow the parser's call stack and were not analyzed; `
      + 'files: ["worker-configuration.d.ts"]; omitted: 0',
  ]);
});

/**
 * 걷기가 건너뛴 금지 문자 이름의 limitation이다.
 *
 * @param count 건너뛴 이름 수
 * @returns limitation 문장
 */
function unsafeWalkNames(count: number): string {
  return `unsafe-names: ${count} file or directory name(s) contain characters the exchange format forbids and were skipped`;
}

test('금지 문자 이름의 소스·스키마 폴더·TypedSQL 파일은 사실 경로에 싣지 않고 unsafe-names:로 알린다', {
  skip: process.platform === 'win32',
}, () => {
  const result = extractProject({
    'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.0.0', pg: '8.0.0' } }),
    'prisma.config.ts': "export default { schema: 'prisma/schema' };\n",
    'prisma/schema/base.prisma': [
      'datasource db {', '  provider = "postgresql"', '}',
      'generator client {', '  provider = "prisma-client-js"', '  previewFeatures = ["typedSql"]', '}',
      'model User {', '  id Int @id', '  @@map("users")', '}', '',
    ].join('\n'),
    'prisma/schema/h\u007fidden.prisma': 'model Hidden {\n  id Int @id\n}\n',
    'prisma/schema/sql/q\u{2028}uery.sql': 'SELECT * FROM hidden_table\n',
    'prisma/schema/sql/visible.sql': 'SELECT * FROM visible_table\n',
    'src/ok.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport const list = () => pool.query('SELECT * FROM orders');\n",
    'src/a\u007fb.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport const hidden = () => pool.query('SELECT * FROM secrets');\n",
  });
  assert.deepEqual(result.facts.filter((fact) => !isSafeIdentifier(fact.location.path)), []);
  const lines = factLines(result);
  assert.ok(lines.some((line) => line.startsWith('src/ok.ts:') && line.includes(' orders')));
  assert.ok(lines.some((line) => line.startsWith('prisma/schema/sql/visible.sql:') && line.includes(' visible_table')));
  assert.ok(!lines.some((line) => line.includes('secrets') || line.includes('Hidden') || line.includes('hidden_table')));
  // 걷기는 자기가 모으는 소스만 세고, 걷기 밖에서 조립한 스키마·TypedSQL 경로의 사실은 수집기가 따로 센다.
  assert.ok(result.limitations.includes(unsafeWalkNames(1)));
  assert.ok(result.limitations.includes(
    'unsafe-names: 3 relation-use fact(s) were skipped because their file paths contain characters the exchange format forbids'));
});

test('게이트가 열리기 전에 사용 스캔을 기록하고 트리를 놓은 파일도 드라이버 게이트가 읽은 SQL 리터럴을 다시 세지 않는다', () => {
  // a.ts는 주석의 `'pg'` 글자 때문에 게이트를 열 법한 파일로 먼저 파싱되지만, import가 './db'뿐이라 게이트를 열지 않는다.
  // 그래서 그때의 빈 출처 표로 사용 스캔을 기록하고 트리를 놓는다. 게이트는 db.ts가 열고, ORM 단계가 다시 파싱한 a.ts
  // 트리에서 소문자 SQL 리터럴을 읽어 소비한다. 그 기록을 그대로 쓰면 게이트 없는 스캔이 그 리터럴을 건너뛴 수로 센다.
  const result = extractProject({
    'package.json': JSON.stringify({ dependencies: { pg: '8.13.0' } }),
    'src/a.ts': "// 아래 풀은 'pg' 드라이버다.\nimport { pool } from './db';\nexport function listUsers() {\n"
      + "  return pool.query('select id from users');\n}\n",
    'src/db.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
  });
  assert.deepEqual(factLines(result), ['src/a.ts:4:21 users @src/a.ts#listUsers']);
  assert.deepEqual(result.limitations, []);
});

/**
 * 클라이언트를 `length`번 재수출한 사슬 끝에서 delegate를 쓰는 Prisma 프로젝트다.
 *
 * @param length 재수출 단계 수
 * @returns 프로젝트 파일
 */
function reexportChainProject(length: number): Record<string, string> {
  const files: Record<string, string> = {
    ...prismaBase,
    'src/c0.ts': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n",
    'src/use.ts': `import { db } from './c${length}';\nexport function users() {\n  return db.user.findMany();\n}\n`,
  };
  for (let index = 1; index <= length; index++) files[`src/c${index}.ts`] = `export { db } from './c${index - 1}';\n`;
  return files;
}

test('출처 고정점은 라운드마다 바뀐 칸을 읽은 모듈만 다시 계산해도 반복 상한의 경계가 그대로다', () => {
  // 라운드 r에서 c_r이 클라이언트가 된다. 상한 16라운드(0~15) 안에 14단계 사슬은 수렴을 확인하고, 15단계는 마지막
  // 라운드에서야 끝이 풀려 수렴을 확인하지 못하며, 16단계는 끝이 풀리지 않는다.
  const truncated = 'provenance-truncated: client provenance did not converge within the re-export round limit; some clients may be untraced';
  const unresolved = 'unresolved-client-receivers: 1 Prisma delegate call(s) use receivers that could not be traced to a PrismaClient; not emitted';
  const converged = extractProject(reexportChainProject(14));
  assert.deepEqual(sourceFactLines(converged), ['src/use.ts:3:13 users @src/use.ts#users']);
  assert.ok(!converged.limitations.includes(truncated));
  const lastRound = extractProject(reexportChainProject(15));
  assert.deepEqual(sourceFactLines(lastRound), ['src/use.ts:3:13 users @src/use.ts#users']);
  assert.ok(lastRound.limitations.includes(truncated));
  const beyond = extractProject(reexportChainProject(16));
  assert.deepEqual(sourceFactLines(beyond), []);
  assert.ok(beyond.limitations.includes(truncated));
  assert.ok(beyond.limitations.includes(unresolved));
});
