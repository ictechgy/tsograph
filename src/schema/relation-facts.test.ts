import assert from 'node:assert/strict';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectProjectFiles } from './project-files.ts';
import { MAX_SOURCE_BYTES, ProjectReader } from './project-reader.ts';
import { dynamicChannel, MAX_DYNAMIC_CHANNEL_LENGTH, RelationFactSink } from './relation-facts.ts';
import { decodeUtf8, SourceText } from './source-text.ts';
import { withProject } from './testing.test.ts';

test('사실 수집기는 제어 문자 이름을 세고 같은 사실을 한 번만 남기며 정렬한다', () => {
  const text = new SourceText('ab\n한글 x\n');
  const sink = new RelationFactSink();
  const base = { dynamic: false, text, symbol: 'a.ts#f' };
  sink.add({ ...base, channel: 'b', path: 'b.ts', offset: 0, symbolIsGraphId: true });
  sink.add({ ...base, channel: 'a', path: 'a.ts', offset: 6, method: 'col' });
  sink.add({ ...base, channel: 'a', path: 'a.ts', offset: 6, method: 'col' });
  sink.add({ ...base, channel: 'a', path: 'a.ts', offset: 6 });
  sink.add({ ...base, channel: 'a', path: 'a.ts', offset: 6, dynamic: true, symbol: 'bad\u2028symbol' });
  sink.add({ ...base, channel: 'bad\u0000', path: 'a.ts', offset: 0 });
  sink.add({ ...base, channel: '  ', path: 'a.ts', offset: 0 });
  sink.add({ ...base, channel: 'ok', method: '\u0085', path: 'a.ts', offset: 0 });
  assert.equal(sink.invalidNames, 3);
  assert.equal(sink.size, 4);
  assert.deepEqual(sink.sorted().map((fact) => [fact.location, fact.channel, fact.method, fact.dynamic, fact.symbol]), [
    [{ path: 'a.ts', line: 2, column: 8 }, 'a', undefined, false, { qualifiedName: 'a.ts#f' }],
    [{ path: 'a.ts', line: 2, column: 8 }, 'a', undefined, true, undefined],
    [{ path: 'a.ts', line: 2, column: 8 }, 'a', 'col', false, { qualifiedName: 'a.ts#f' }],
    [{ path: 'b.ts', line: 1, column: 1 }, 'b', undefined, false, { qualifiedName: 'a.ts#f', usr: 'a.ts#f' }],
  ]);
});

test('dynamic 요약은 공백을 접고 제어 문자를 지우며 서러게이트 쌍을 가르지 않는다', () => {
  assert.equal(dynamicChannel('  SELECT\n\t*  FROM\u0007 x '), 'SELECT * FROM x');
  assert.equal(dynamicChannel('\u0001'), '<dynamic>');
  const long = `${'a'.repeat(MAX_DYNAMIC_CHANNEL_LENGTH - 1)}\u{1F600}tail`;
  assert.equal(dynamicChannel(long), 'a'.repeat(MAX_DYNAMIC_CHANNEL_LENGTH - 1));
  assert.equal(dynamicChannel('b'.repeat(500)).length, MAX_DYNAMIC_CHANNEL_LENGTH);
});

test('UTF-8 디코드는 BOM을 떼고 잘못된 바이트를 거부한다', () => {
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.equal(decodeUtf8(new Uint8Array([0xff])), undefined);
  const text = new SourceText('a\r\nb한c');
  assert.deepEqual(text.locate(3), { line: 2, column: 1 });
  assert.deepEqual(text.locate(5), { line: 2, column: 5 });
});

test('파일 읽기 도우미는 과대·UTF-8 아님·읽기 실패를 센다', () => {
  withProject({ 'ok.ts': 'x', 'bad.ts': '' }, (root) => {
    writeFileSync(join(root, 'bad.ts'), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(root, 'big.ts'), Buffer.alloc(MAX_SOURCE_BYTES + 1));
    const reader = new ProjectReader();
    assert.equal(reader.read(join(root, 'ok.ts'))?.text, 'x');
    assert.equal(reader.read(join(root, 'bad.ts')), undefined);
    assert.equal(reader.read(join(root, 'big.ts')), undefined);
    assert.equal(reader.read(join(root, 'missing.ts')), undefined);
    assert.deepEqual([reader.unreadable, reader.oversized], [2, 1]);
    assert.ok(reader.newestModifiedAt instanceof Date);
  });
});

test('트리 탐색은 링크를 따라가지 않고 생성물·점 디렉터리·제외 경로를 건너뛴다', () => {
  withProject({
    'src/a.ts': '', 'node_modules/p/i.ts': '', '.next/x.ts': '', 'dist/y.ts': '', 'gen/z.ts': '', 'src/locked/l.ts': '',
  }, (root) => {
    symlinkSync(join(root, 'src'), join(root, 'alias'));
    chmodSync(join(root, 'src', 'locked'), 0o000);
    try {
      const walk = collectProjectFiles(root, {
        includeFile: (name) => name.endsWith('.ts'),
        excludedDirectories: new Set([join(root, 'gen')]),
      });
      assert.deepEqual([...walk.files.keys()], ['src/a.ts']);
      assert.equal(walk.skippedSymlinks, 1);
      assert.equal(walk.truncated, false);
      assert.ok(walk.unreadableDirectories <= 1);
    } finally {
      chmodSync(join(root, 'src', 'locked'), 0o755);
    }
  });
});
