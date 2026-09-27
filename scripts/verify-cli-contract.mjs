import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runChild } from './run-child.mjs';

// 빌드된 CLI(dist)가 종료 코드 계약(0/2/64, 1은 예약)을 지키는지 실제 프로세스로 확인한다.
const binaryPath = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const packageDocument = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

verifyHelp();
verifyVersion();
verifyUsageErrors();
process.stdout.write('CLI contract verified: 0/2/64 (1 reserved)\n');

/** 도움말이 성공으로 나오는지 확인한다. */
function verifyHelp() {
  const result = run(['--help']);
  verify(result.status === 0 && result.stdout.startsWith('Usage: tsograph'), 'help');
}

/** 버전이 package.json과 같은지 확인한다. */
function verifyVersion() {
  const result = run(['--version']);
  verify(result.status === 0 && result.stdout === `${packageDocument.version}\n`, 'version');
}

/** 잘못된 호출이 64로 끝나는지 확인한다. */
function verifyUsageErrors() {
  verify(run([]).status === 64, 'missing command');
  verify(run(['no-such-command']).status === 64, 'unknown command');
}

/** 빌드된 CLI를 실행한다. */
function run(arguments_) {
  return runChild(process.execPath, [binaryPath, ...arguments_], { timeout: 60_000 });
}

/** 계약 위반을 검사 이름으로 보고한다. */
function verify(condition, name) {
  if (!condition) throw new Error(`CLI contract failed: ${name}`);
}
