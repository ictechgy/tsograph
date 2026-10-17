import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExtractionResult } from './extract.ts';
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
  files['src/bad\nunsafe.ts'] = 'export const = ;\n';
  const result = extractProject(files);
  const limitation = result.limitations.find((line) => line.startsWith('parse-errors:'));
  assert.equal(limitation,
    'parse-errors: 13 source file(s) could not be parsed completely; '
    + 'files: ["src/bad00.ts","src/bad01.ts","src/bad02.ts","src/bad03.ts","src/bad04.ts",'
    + '"src/bad05.ts","src/bad06.ts","src/bad07.ts","src/bad08.ts","src/bad09.ts"]; omitted: 3');
  assert.ok(!limitation?.includes('\nunsafe'));
});
