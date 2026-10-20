import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPrismaConfig } from './prisma-config.ts';

test('default export 설정 객체의 리터럴 schema·typedSql.path를 읽는다', () => {
  assert.deepEqual(readPrismaConfig('prisma.config.ts', "import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: 'db/schema.prisma', typedSql: { path: 'db/sql' } });\n"), {
    schema: { kind: 'literal', value: 'db/schema.prisma' },
    typedSqlPath: { kind: 'literal', value: 'db/sql' },
  });
  assert.deepEqual(readPrismaConfig('prisma.config.ts', "const config = { 'schema': `db` } satisfies object;\nexport default (config as object);\n").schema,
    { kind: 'literal', value: 'db' });
  assert.deepEqual(readPrismaConfig('prisma.config.cjs', "module.exports = { migrations: {} };\n"), {
    schema: { kind: 'absent' },
    typedSqlPath: { kind: 'absent' },
  });
});

test('리터럴이 아닌 값·펼침·단축 속성·default export 없음은 읽지 못함이다', () => {
  const unresolved = { kind: 'unresolved' };
  assert.deepEqual(readPrismaConfig('prisma.config.ts', "import path from 'node:path';\nexport default { schema: path.join('a', 'b'), typedSql: base };\n"),
    { schema: unresolved, typedSqlPath: unresolved });
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'export default { ...shared, typedSql: { ...x } };\n'), { schema: unresolved, typedSqlPath: unresolved });
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'const schema = "a";\nexport default { schema };\n').schema, unresolved);
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'export const config = { schema: "a" };\n'), { schema: unresolved, typedSqlPath: unresolved });
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'export default make();\n').schema, unresolved);
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'let c = { schema: "a" };\nexport default c;\n').schema, unresolved);
  assert.deepEqual(readPrismaConfig('prisma.config.ts', 'export default a.b;\n').schema, unresolved);
  assert.deepEqual(readPrismaConfig('prisma.config.mjs', 'exports.x = 1;\nexport default { typedSql: "x" };\n').typedSqlPath, unresolved);
});

test('파서가 스택을 넘기거나 구문 깊이 상한을 넘는 설정은 읽지 못함이고 명령을 멈추지 않는다', () => {
  const unresolved = { kind: 'unresolved' };
  const parens = `export default { schema: ${'('.repeat(3_000)}"a"${')'.repeat(3_000)} };\n`;
  const concatenation = `export default { schema: ${Array.from({ length: 3_000 }, () => '"a"').join(' + ')} };\n`;
  for (const text of [parens, concatenation]) {
    assert.deepEqual(readPrismaConfig('prisma.config.ts', text), { schema: unresolved, typedSqlPath: unresolved });
  }
});
