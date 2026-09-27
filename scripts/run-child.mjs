import { spawnSync } from 'node:child_process';

const defaultTimeout = 60_000;
const defaultMaxBuffer = 16 * 1024 * 1024;

/** 검증 자식 프로세스를 제한시간과 충분한 출력 버퍼 안에서 실행한다. */
export function runChild(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    timeout: options.timeout ?? defaultTimeout,
    maxBuffer: options.maxBuffer ?? defaultMaxBuffer,
    stdio: options.stdio,
  });
}
