import { runChild } from './run-child.mjs';

// 제품 코드(src/**/*.ts)의 라인·함수·분기 커버리지를 각각 90% 이상으로 강제한다.
const coverageArguments = [
  '--experimental-test-coverage',
  '--test-coverage-lines=90',
  '--test-coverage-functions=90',
  '--test-coverage-branches=90',
  '--test-coverage-include=src/**/*.ts',
  '--test-coverage-exclude=src/**/*.test.ts',
];
// CI job의 10분 제한 안에서 전체 제품 테스트에 8분을 주고 build·CLI 검증 시간을 남긴다.
const suiteTimeout = 8 * 60_000;
const testArguments = ['--test', ...coverageArguments, 'src/**/*.test.ts'];
const result = runChild(
  process.execPath,
  [...testArguments, ...process.argv.slice(2)],
  { stdio: 'inherit', timeout: suiteTimeout },
);

if (result.error?.code === 'ETIMEDOUT') {
  process.stderr.write('Product test suite exceeded the 8-minute execution limit; verification is incomplete.\n');
  process.exit(2);
}
process.exit(result.status ?? 2);
