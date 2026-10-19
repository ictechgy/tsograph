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
// CI job의 15분 제한 안에서 전체 제품 테스트에 12분을 주고 build·CLI 검증 시간을 남긴다.
// GitHub ubuntu 러너는 같은 테스트를 1.7~1.8배 느리게 도는 경우가 잦아, 정상 러너에서 5분 남짓인 전체 테스트가
// 느린 러너에서는 8분을 넘긴다. 이 한도는 멈춘 실행을 끊으려는 것이므로 러너 편차를 흡수할 여유를 둔다.
const suiteTimeout = 12 * 60_000;
const testArguments = ['--test', '--test-concurrency=3', ...coverageArguments, 'src/**/*.test.ts'];
const result = runChild(
  process.execPath,
  [...testArguments, ...process.argv.slice(2)],
  { stdio: 'inherit', timeout: suiteTimeout },
);

if (result.error?.code === 'ETIMEDOUT') {
  process.stderr.write(`Product test suite exceeded the ${suiteTimeout / 60_000}-minute execution limit; verification is incomplete.\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
