import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createNodeFileSystem } from './file-system.ts';
import { rootHelp, runCli } from './run-cli.ts';

/** 테스트용 고정 실행 환경이다. */
const environment = {
  toolVersion: '9.9.9',
  fileSystem: createNodeFileSystem(),
  now: () => new Date('2026-09-27T00:00:00.000Z'),
};

test('인자가 없으면 사용법 오류 64와 도움말을 낸다', async () => {
  const result = await runCli([], environment);
  assert.equal(result.exitCode, 64);
  assert.equal(result.standardError, rootHelp);
});

test('--help와 help는 도움말을 성공으로 낸다', async () => {
  for (const argument of ['--help', '-h', 'help']) {
    const result = await runCli([argument], environment);
    assert.equal(result.exitCode, 0);
    assert.equal(result.standardOutput, rootHelp);
  }
});

test('--version은 주입된 도구 버전을 낸다', async () => {
  const result = await runCli(['--version'], environment);
  assert.deepEqual(result, { standardOutput: '9.9.9\n', standardError: '', exitCode: 0 });
});

test('모르는 명령과 모르는 help 대상은 사용법 오류다', async () => {
  const unknown = await runCli(['nope'], environment);
  assert.equal(unknown.exitCode, 64);
  assert.match(unknown.standardError, /unknown command/);
  const unknownHelp = await runCli(['help', 'nope'], environment);
  assert.equal(unknownHelp.exitCode, 64);
});

test('help openapi는 명령 사용법을 내고 openapi는 명령으로 분배된다', async () => {
  const help = await runCli(['help', 'openapi'], environment);
  assert.equal(help.exitCode, 0);
  assert.match(help.standardOutput, /^Usage: tsograph openapi/);
  const tooMany = await runCli(['help', 'openapi', 'extra'], environment);
  assert.equal(tooMany.exitCode, 64);
  const missingService = await runCli(['openapi', 'spec.yaml'], environment);
  assert.equal(missingService.exitCode, 64);
});
