import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from './testing.test.ts';

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
