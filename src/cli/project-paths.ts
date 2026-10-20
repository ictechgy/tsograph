/**
 * CLI 명령이 함께 쓰는 `--project` 루트와 프로젝트 안 입력 파일 검증이다.
 *
 * openapi·routes·schema·graph(reach·impact)·navigation이 같은 오류에 같은 종료 코드와 같은 문구 형식을 내도록 한곳에
 * 둔다. 명령마다 따로 구현하던 때에는 같은 실수(입력 파일이 `--project` 밖)를 openapi·routes client 모델은 사용 오류(64),
 * navigation은 입력 실패(2)로 알렸고, `--tsconfig` 포함 검사는 navigation에만 있어 graph·reach·impact·routes client는
 * 프로젝트 밖 설정을 조용히 썼다.
 *
 * 분류: realpath가 `--project` 밖인 입력 파일은 호출 설정의 실수라 사용 오류(64)다. 없음·권한·종류(일반 파일이 아님)·
 * 크기·형식은 입력 실패(2)다. realpath를 구하지 못한 경로(없는 파일)는 밖을 가리켜도 2다 — 실제 위치를 모르기
 * 때문이다. 문구에는 경로 원문을 넣지 않는다.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { MAX_GRAPH_CONFIG_BYTES } from '../graph/bounded-config-reader.ts';
import { type CommandResult, inputFailure, usageFailure } from './command-result.ts';
import type { CommandFileSystem, PathStatus } from './file-system.ts';

/**
 * `--project` 값을 realpath로 정규화하고 읽을 수 있는 디렉터리인지 확인한다.
 *
 * openapi는 교환 형식 문자 검사를 스펙 경로와 함께 하므로 이 단계만 쓴다. 나머지 명령은 {@link resolveProjectRoot}를 쓴다.
 *
 * @param fileSystem 파일 시스템
 * @param argument `--project` 값
 * @param remedy 명령별 해결 방향(예: `pass the project root.`)
 * @returns 프로젝트 realpath 또는 입력 실패(2)
 */
export async function resolveProjectDirectory(
  fileSystem: CommandFileSystem,
  argument: string,
  remedy: string,
): Promise<string | CommandResult> {
  let project: string;
  try {
    project = await fileSystem.realPath(argument);
    if ((await fileSystem.status(project)).kind !== 'directory') throw new Error('not a directory');
  } catch {
    // 없음·권한·파일은 해결 방향이 같아 한 문구로 알린다. 경로 원문은 싣지 않는다.
    return inputFailure(`--project does not name a readable directory; ${remedy}`);
  }
  return project;
}

/**
 * `--project` 값을 프로젝트 루트로 정규화한다. 디렉터리 확인에 더해, 문서 `project`가 될 경로에 교환 형식이 금지하는
 * 문자가 없는지 본다.
 *
 * @param fileSystem 파일 시스템
 * @param argument `--project` 값
 * @param remedy 명령별 해결 방향
 * @returns 프로젝트 realpath 또는 입력 실패(2)
 */
export async function resolveProjectRoot(
  fileSystem: CommandFileSystem,
  argument: string,
  remedy: string,
): Promise<string | CommandResult> {
  const project = await resolveProjectDirectory(fileSystem, argument, remedy);
  if (typeof project !== 'string') return project;
  if (!isSafeIdentifier(project)) {
    return inputFailure('the project path contains characters the exchange format forbids; rename or move the project.');
  }
  return project;
}

/**
 * 프로젝트 기준 POSIX 상대 경로를 만든다. 루트 자신·조상·이름 접두사만 같은 형제(`app-other`)는 밖이다.
 *
 * @param project 프로젝트 realpath
 * @param target 대상 realpath
 * @returns 상대 경로. 루트 밖이면 undefined
 */
export function projectRelativePath(project: string, target: string): string | undefined {
  const path = relative(project, target);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join('/');
}

/**
 * 입력 파일이 `--project` 밖일 때의 사용 오류(64)를 만든다. 명령마다 같은 형식
 * (`tsograph: <주어> is outside --project; <해결 방향>` + 사용법)이라 자동화가 문구로도 원인을 가를 수 있다.
 *
 * @param subject 문구의 주어(예: `the spec file`)
 * @param remedy 해결 방향
 * @param usage 명령 사용법(끝 개행 포함)
 * @returns 종료 코드 64 결과
 */
export function outsideProjectFailure(subject: string, remedy: string, usage: string): CommandResult {
  return usageFailure(`tsograph: ${subject} is outside --project; ${remedy}\n${usage}`);
}

/** 프로젝트 안 입력 파일 하나의 문구 규칙이다. */
export interface ProjectFileRule {
  /** 밖 오류 문구의 주어(예: `the router model file`) */
  readonly subject: string;
  /** 없음·권한·종류 실패의 원인과 해결 방향 */
  readonly unreadable: string;
  /** 밖일 때의 해결 방향 */
  readonly outsideRemedy: string;
  /** 사용 오류 끝에 붙일 명령 사용법 */
  readonly usage: string;
}

/** 검증을 통과한 프로젝트 안 입력 파일이다. */
export interface ProjectFile {
  /** realpath */
  readonly path: string;
  /** 프로젝트 기준 POSIX 상대 경로 */
  readonly projectPath: string;
  /** realpath의 종류·크기(호출자는 크기 상한을 이 값으로 판정한다) */
  readonly status: PathStatus;
}

/**
 * 입력 파일 인자가 realpath 기준으로 `--project` 안의 일반 파일인지 확인한다.
 *
 * 상대 경로는 `--project` 기준이고, 절대 경로도 realpath가 안이면 받는다. 판정 순서는 realpath → 상태 → 종류 →
 * 포함 관계다(openapi 스펙·routes client 모델이 쓰던 순서). 그래서 밖의 디렉터리·없는 파일은 입력 실패(2)이고,
 * 밖에 실제로 있는 일반 파일만 사용 오류(64)다. 프로젝트 안 링크가 밖을 가리키면 대상 기준으로 밖이다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param argument 입력 파일 인자
 * @param rule 문구 규칙
 * @returns 검증한 파일, 입력 실패(2) 또는 사용 오류(64)
 */
export async function resolveProjectFile(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
  rule: ProjectFileRule,
): Promise<ProjectFile | CommandResult> {
  let path: string;
  let status: PathStatus;
  try {
    // 절대 경로도 `path.resolve`로 같은 정규화를 거친다. TypeScript가 `--tsconfig`를 여는 경로(`resolve(root, 설정)`)와 같다.
    path = await fileSystem.realPath(resolve(project, argument));
    status = await fileSystem.status(path);
  } catch {
    // 없음·권한은 해결 방향이 같아 한 문구로 알린다. realpath를 모르면 밖인지도 모르므로 입력 실패다.
    return inputFailure(rule.unreadable);
  }
  if (status.kind !== 'file') return inputFailure(rule.unreadable);
  const projectPath = projectRelativePath(project, path);
  if (projectPath === undefined) return outsideProjectFailure(rule.subject, rule.outsideRemedy, rule.usage);
  return { path, projectPath, status };
}

/**
 * `--tsconfig` 인자를 확인한다. graph·reach·impact·routes client·navigation이 같은 규칙을 쓴다: realpath가 `--project`
 * 안인 1 MiB 이하 일반 파일.
 *
 * 값은 바꾸지 않는다. 호출자는 받은 인자를 그대로 Program에 넘기고, TypeScript(`tsc -p`)처럼 그 경로의 디렉터리가 상대
 * 옵션의 기준이 된다(링크를 풀어 기준 디렉터리를 바꾸지 않는다). 밖 설정은 받지 않지만 안의 설정이 `extends`로 밖의
 * 공용 설정을 가리키는 것은 Program 단계의 bounded reader가 다룬다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param argument `--tsconfig` 값
 * @param usage 명령 사용법(사용 오류에 붙인다)
 * @returns 실패 결과, 통과하면 undefined
 */
export async function checkCompilerConfig(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
  usage: string,
): Promise<CommandResult | undefined> {
  const config = await resolveProjectFile(fileSystem, project, argument, {
    subject: 'the --tsconfig file',
    unreadable: '--tsconfig must name a readable compiler config file inside --project; check the path and permissions.',
    outsideRemedy: 'pass a compiler config inside the project root (it may extend a shared config outside it).',
    usage,
  });
  if ('exitCode' in config) return config;
  if (config.status.size > MAX_GRAPH_CONFIG_BYTES) {
    return inputFailure(`the compiler config exceeds ${MAX_GRAPH_CONFIG_BYTES} bytes; split or reduce the config.`);
  }
  return undefined;
}
