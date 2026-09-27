import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 타입 제거로 직접 실행하는 진입점 경로다. */
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

/** 진입점을 실제 프로세스로 실행한다. */
function runMain(arguments_: readonly string[]) {
  return spawnSync(process.execPath, [mainPath, ...arguments_], { encoding: 'utf8' });
}

test('진입점은 결과를 스트림과 종료 코드로 옮긴다', () => {
  const version = runMain(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const usage = runMain([]);
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /^Usage: tsograph/);
});

test('진입점은 실제 파일 시스템과 시계로 openapi 문서를 낸다', () => {
  const fixture = fileURLToPath(new URL('../../fixtures/openapi/swagger-2.0.json', import.meta.url));
  const result = runMain(['openapi', fixture, '--service', 'demo']);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout) as { format: string; generatedAt: string };
  assert.equal(document.format, 'bridge-facts');
  assert.match(document.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
