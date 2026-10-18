/**
 * 특수 파일 입력(FIFO·장치 링크) 회귀 테스트가 함께 쓰는 도우미다.
 *
 * 그런 입력을 막지 못한 코드는 FIFO에서 영원히 멈추거나 `/dev/zero`를 끝없이 읽어 1초에 GB 단위 메모리를 쓴다.
 * 그래서 검사할 명령은 자식 프로세스에서 돌리고, 부모가 시간이나 RSS 상한을 넘긴 자식을 바로 끝낸다. 회귀가
 * 생겨도 테스트 프로세스와 기계를 멈추지 않고 실패로 끝나게 하려는 것이다.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 타입 제거로 직접 실행하는 CLI 진입점이다. */
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

/** 자식 실행 시간 상한(ms)이다. 정상 실행은 1초 남짓이지만 부하가 큰 CI에서도 흔들리지 않게 넉넉히 잡는다. */
const CHILD_TIMEOUT_MS = 60_000;

/** 자식 RSS 상한(바이트)이다. 정상 실행은 수백 MiB이고, 장치를 끝없이 읽는 회귀는 1초 안에 이 값을 넘는다. */
const CHILD_RSS_LIMIT_BYTES = 1024 * 1024 * 1024;

/** 시간과 RSS를 확인하는 간격(ms)이다. */
const POLL_INTERVAL_MS = 50;

/** 감시한 자식 실행 결과다. */
export interface GuardedRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 시간·메모리 상한 때문에 자식을 끝냈으면 그 이유, 스스로 끝났으면 undefined다. */
  readonly stopped: 'timeout' | 'memory' | undefined;
}

/**
 * Node 자식 프로세스를 시간·RSS 상한 아래에서 실행한다.
 *
 * @param arguments_ `node` 실행 파일 뒤의 인자
 * @returns 종료 코드·출력·감시 중단 이유
 */
export function runNodeGuarded(arguments_: readonly string[]): Promise<GuardedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stopped: GuardedRun['stopped'];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > CHILD_TIMEOUT_MS) stopped = 'timeout';
      else if (residentBytes(child.pid) > CHILD_RSS_LIMIT_BYTES) stopped = 'memory';
      if (stopped !== undefined) child.kill('SIGKILL');
    }, POLL_INTERVAL_MS);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearInterval(timer);
      resolve({ status, stdout, stderr, stopped });
    });
  });
}

/**
 * CLI 진입점을 시간·RSS 상한 아래의 자식 프로세스로 실행한다.
 *
 * @param arguments_ `tsograph` 뒤의 인자
 * @returns 종료 코드·출력·감시 중단 이유
 */
export function runMainGuarded(arguments_: readonly string[]): Promise<GuardedRun> {
  return runNodeGuarded([mainPath, ...arguments_]);
}

/**
 * `ps`로 본 프로세스 RSS(바이트)다. 이미 끝났거나 `ps`가 값을 주지 않으면 0이다(시간 상한은 그대로 남는다).
 *
 * @param pid 프로세스 id
 * @returns RSS 바이트 수
 */
function residentBytes(pid: number | undefined): number {
  if (pid === undefined) return 0;
  const probe = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const kibibytes = Number.parseInt(probe.stdout ?? '', 10);
  return Number.isNaN(kibibytes) ? 0 : kibibytes * 1024;
}

/**
 * 이름 있는 파이프를 만든다. 쓰는 쪽이 없으므로 블로킹 open은 영원히 기다린다.
 *
 * @param path 만들 경로
 */
export function makeFifo(path: string): void {
  const created = spawnSync('mkfifo', [path], { timeout: 1000 });
  assert.equal(created.status, 0);
}

/**
 * EOF 없이 끝없이 읽히는 장치(`/dev/zero`)로 가는 symlink를 만든다. `stat` 크기가 0이라 크기 검사만으로는 막지 못한다.
 *
 * @param path 만들 링크 경로
 */
export function linkToDevZero(path: string): void {
  symlinkSync('/dev/zero', path);
}
