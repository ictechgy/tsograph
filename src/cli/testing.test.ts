/**
 * 특수 파일 입력(FIFO·장치 링크)과 펼치기·해석 상한 회귀 테스트가 함께 쓰는 도우미다.
 *
 * 그런 입력을 막지 못한 코드는 FIFO에서 영원히 멈추거나 `/dev/zero`를 끝없이 읽어 1초에 GB 단위 메모리를 쓴다.
 * 그래서 검사할 명령은 자식 프로세스에서 돌리고, 부모가 시간이나 RSS 상한을 넘긴 자식을 바로 끝낸다. 회귀가
 * 생겨도 테스트 프로세스와 기계를 멈추지 않고 실패로 끝나게 하려는 것이다.
 *
 * 같은 프로세스에서 Program을 만드는 합성 fixture가 저장소의 ambient 선언을 읽지 않게 하는 tsconfig 내용도 둔다.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { CommandResult } from './command-result.ts';

/** 타입 제거로 직접 실행하는 CLI 진입점이다. */
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

/** 여러 명령을 자식 하나에서 차례로 돌리는 실행기가 불러올 분배기·파일 시스템 모듈이다. */
const runCliModule = new URL('./run-cli.ts', import.meta.url).href;
const fileSystemModule = new URL('./file-system.ts', import.meta.url).href;

/** 명령 하나의 자식 실행 시간 상한(ms)이다. 정상 실행은 1초 남짓이지만 부하가 큰 CI에서도 흔들리지 않게 넉넉히 잡는다. */
const CHILD_TIMEOUT_MS = 60_000;

/** 자식 RSS 상한(바이트)이다. 정상 실행은 수백 MiB이고, 장치를 끝없이 읽는 회귀는 1초 안에 이 값을 넘는다. */
const CHILD_RSS_LIMIT_BYTES = 1024 * 1024 * 1024;

/** 시간과 RSS를 확인하는 간격(ms)이다. */
const POLL_INTERVAL_MS = 50;

/**
 * 분석 기본 옵션(graph program.ts의 defaultOptions)에 `types: []`만 더한 tsconfig.json 내용이다.
 *
 * TypeScript 자동 타입 포함(typeRoots 기본값)은 프로젝트 루트(설정이 있으면 설정 디렉터리)와 그 조상의
 * `node_modules/@types`를 읽는다. 예전에는 설정이 없으면 실행 위치(npm test·CI에서는 저장소 루트) 기준이라 Program마다
 * 저장소 자신의 @types/node(선언 67개)를 다시 파싱했다. 지금은 임시 디렉터리의 조상만 보지만, 그 조상에 `@types`가
 * 있는 기계에서도 선언과 무관한 검사가 같은 Program을 만들도록 fixture에 이 설정을 둔다(628bc19가 graph 합성 Program에
 * 쓴 방식과 같다). 다른 compiler 옵션은 기본값과 같다.
 *
 * `include: []`라 설정이 루트 파일을 더하지 않는다(TypeScript의 '입력 없음' 18003은 분석기가 무시한다). 그래서 Program의
 * 루트는 tsconfig가 없을 때처럼 걷기가 고른 소스뿐이고, 걷기가 뺀 금지 문자 이름·읽지 못한 파일을 설정이 다시 넣지 않는다.
 */
export const ambientTypesFreeConfig = JSON.stringify({ include: [], compilerOptions: {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', esModuleInterop: true, resolveJsonModule: true, types: [],
} });

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
 * 자식의 현재 디렉터리는 임시 디렉터리다. 인자는 모두 절대 경로라 결과는 실행 위치와 무관하다. 예전에는 tsconfig가 없는
 * 프로젝트의 자동 타입 루트가 실행 위치 기준이라, 저장소 루트를 물려받은 자식이 저장소의 `@types/node`(선언 파일
 * 67개)를 자식마다 다시 파싱했다(지금은 프로젝트 루트 기준이다). 임시 디렉터리 실행은 그런 실행 위치 의존을 다시
 * 들이지 않으려고 그대로 둔다.
 *
 * @param arguments_ `node` 실행 파일 뒤의 인자
 * @param timeoutMs 자식 실행 시간 상한(ms). 기본은 명령 하나의 상한이다
 * @returns 종료 코드·출력·감시 중단 이유
 */
export function runNodeGuarded(arguments_: readonly string[], timeoutMs = CHILD_TIMEOUT_MS): Promise<GuardedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stopped: GuardedRun['stopped'];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) stopped = 'timeout';
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
 * @param nodeArguments 진입점 앞에 둘 `node` 인자(예: V8 힙 상한). 기본은 없다
 * @returns 종료 코드·출력·감시 중단 이유
 */
export function runMainGuarded(arguments_: readonly string[], nodeArguments: readonly string[] = []): Promise<GuardedRun> {
  return runNodeGuarded([...nodeArguments, mainPath, ...arguments_]);
}

/** 감시한 자식 하나에서 차례로 실행한 CLI 명령들의 결과다. */
export interface GuardedCliRuns {
  /** 자식 프로세스 자체의 종료 코드·출력·감시 중단 이유. stderr에는 시작한 명령 순번(`run <n>`)이 남는다 */
  readonly child: GuardedRun;
  /** 명령마다의 결과(인자 순서). 자식이 모든 명령을 끝내지 못했으면 빈 배열이다 */
  readonly results: readonly CommandResult[];
}

/**
 * 여러 CLI 명령을 시간·RSS 상한 아래의 자식 프로세스 하나에서 차례로 실행한다.
 *
 * 자식마다 내는 시작 비용(타입 제거·TypeScript 적재, 커버리지 실행에서 0.5초 남짓)을 명령마다 되풀이하지 않으려는
 * 것이다. 명령은 `main.ts`처럼 `runCliSafely`로 실행하고 도구 버전·시계만 고정한다. 시간 상한은 명령 수만큼 늘려
 * 명령 하나의 몫을 따로 실행할 때와 같게 둔다. 한 명령이 멈추거나 메모리를 다 쓰면 자식 전체가 끝나므로, 같은 회귀를
 * 지키는 한 테스트의 명령끼리만 묶는다. 그때 stderr의 마지막 `run <n>`이 멈춘 명령이다.
 *
 * @param runs 명령마다 `tsograph` 뒤의 인자
 * @param nodeArguments 실행기 앞에 둘 `node` 인자(예: V8 힙 상한). 기본은 없다
 * @returns 자식 실행 결과와 명령별 결과
 */
export async function runCliGuarded(
  runs: readonly (readonly string[])[],
  nodeArguments: readonly string[] = [],
): Promise<GuardedCliRuns> {
  const script = [
    `import { runCliSafely } from ${JSON.stringify(runCliModule)};`,
    `import { createNodeFileSystem } from ${JSON.stringify(fileSystemModule)};`,
    "const environment = { toolVersion: '0.0.0-test', fileSystem: createNodeFileSystem(), now: () => new Date(0) };",
    'const results = [];',
    'for (const [index, arguments_] of JSON.parse(process.argv[1]).entries()) {',
    '  process.stderr.write(`run ${index}\\n`);',
    '  results.push(await runCliSafely(arguments_, environment));',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const child = await runNodeGuarded([...nodeArguments, '--input-type=module', '--eval', script, JSON.stringify(runs)], CHILD_TIMEOUT_MS * runs.length);
  const finished = child.stopped === undefined && child.status === 0;
  return { child, results: finished ? JSON.parse(child.stdout) as CommandResult[] : [] };
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
