import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExtractionResult } from '../extract.ts';
import { extractProject } from '../testing.test.ts';

/**
 * 사실을 `path:line:column channel[.method][ dyn] @usr` 한 줄로 바꾼다(ORM 테스트용, usr 기준).
 *
 * @param result 추출 결과
 * @returns 문자열 목록
 */
export function usrLines(result: ExtractionResult): string[] {
  return result.facts.map((fact) => {
    const where = `${fact.location.path}:${fact.location.line}:${fact.location.column}`;
    const what = fact.method === undefined ? fact.channel : `${fact.channel}.${fact.method}`;
    return `${where} ${what}${fact.dynamic ? ' dyn' : ''} @${fact.symbol?.usr ?? ''}`;
  });
}

/**
 * 합성 프로젝트를 추출해 usr 기준 줄을 돌려준다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @returns 문자열 목록
 */
export function ormLines(files: Record<string, string>): string[] {
  return usrLines(extractProject(files));
}

test('usr 기준 줄은 선언 이름공간 usr를 보인다', () => {
  const lines = ormLines({ 'src/t.ts': "import { sqliteTable } from 'drizzle-orm/sqlite-core';\nexport const t = sqliteTable('t', {});\n" });
  assert.deepEqual(lines, ['src/t.ts:2:30 t @src/t.ts#model:t']);
});
