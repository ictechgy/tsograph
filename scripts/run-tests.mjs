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
const testArguments = ['--test', ...coverageArguments, 'src/**/*.test.ts'];
const result = runChild(
  process.execPath,
  [...testArguments, ...process.argv.slice(2)],
  { stdio: 'inherit', timeout: 5 * 60_000 },
);

process.exit(result.status ?? 2);
