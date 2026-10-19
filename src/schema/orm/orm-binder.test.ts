import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ormLines } from './testing.test.ts';

test('서로를 require로 재수출하는 모듈의 export 표는 끝없이 펼치지 않고 순환 멤버를 모르는 값으로 둔다', () => {
  const lines = ormLines({
    'src/db.ts': [
      "import { Pool } from 'pg';",
      "import * as a from './a';",
      "const { y } = require('./b');",
      'const pool = new Pool();',
      'export async function q() {',
      "  await a.x.query('select * from cycle_x');",
      "  await y.query('select * from cycle_y');",
      "  return pool.query('select * from ok_rows');",
      '}',
      '',
    ].join('\n'),
    'src/a.ts': "export const x = require('./b').x;\nexport const { y } = require('./b');\n",
    'src/b.ts': "export const x = require('./a').x;\nexport const y = require('./a').y;\n",
  });
  assert.deepEqual(lines, ['src/db.ts:8:21 ok_rows @src/db.ts#q']);
});
