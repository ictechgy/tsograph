/**
 * Node 백엔드 라우트 분석에 쓰는 프로젝트 소스와 TypeScript Program을 준비한다.
 *
 * 라우터는 여러 파일에 걸쳐 만들고 붙이는 경우가 흔하다(`import users from './routes/users'`, `app.route('/users', users)`).
 * 그래서 `tsograph graph`와 같은 방식(`src/graph/program.ts`)으로 Program과 TypeChecker를 만들어 import·재수출·
 * 기본 내보내기를 따라간다. emit·타입 진단은 하지 않고 분석 대상 코드는 실행하지 않는다.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

import type { BridgeLocation } from '../../exchange/bridge-facts.ts';
import { ByteColumnIndex } from '../../openapi/byte-columns.ts';
import { configRootGaps, createGraphProgram, type ProgramConfigStatus } from '../../graph/program.ts';
import { collectProjectFiles } from '../../schema/project-files.ts';
import { isSourceFileName } from '../../schema/source-module.ts';
import { SYNTAX_DEPTH_CAUSE } from '../../schema/syntax-depth.ts';

/** 분석하는 소스 파일 하나의 최대 크기(바이트)다. `graph`·`schema`와 같다. */
export const MAX_NODE_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * 소스를 모으며 센 공백이다. 값이 하나라도 0·false가 아니면 스캔이 불완전하다(client 문서는 그 판정에 모든 값을 쓴다).
 */
export interface NodeProjectGaps {
  readonly symlinks: number;
  readonly unreadableDirectories: number;
  readonly truncated: boolean;
  readonly oversizedFiles: number;
  /** 교환 형식이 금지하는 문자가 든 이름이라 걷기가 건너뛴 파일·디렉터리 수다. */
  readonly unsafeNames: number;
  /**
   * 걷기가 골랐지만 compiler host가 읽지 못해 Program에 없는 소스 수다(권한·걷기 뒤 삭제·TypeScript가 다른 경로로
   * 읽는 백슬래시 이름). host의 읽기 실패 전체는 TypeScript의 존재 탐침(ENOENT)까지 섞이므로 기대 소스와 대조해 센다.
   */
  readonly unreadableFiles: number;
}

/** 준비한 프로젝트다. */
export interface NodeProject {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** 분석 대상 파일(프로젝트 기준 POSIX 경로 → 소스), 경로 순 */
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  readonly gaps: NodeProjectGaps;
  /**
   * Program을 만들며 센 설정 공백(설정 해석 실패·compiler 입력 상한 초과)이다. `gaps`에 넣지 않는다 — client 문서는
   * `gaps`의 값을 모두 참·거짓으로 보는데 객체는 늘 참이기 때문이다. 문구는 {@link compilerConfigGaps}가 만든다.
   */
  readonly configStatus: ProgramConfigStatus;
  /**
   * 걷기가 고른 소스 중 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 Program에서 뺀 파일의 기준 경로다(경로 순).
   * `gaps`에 넣지 않는다 — 명령마다 분석하는 파일(테스트 포함 여부)이 달라 각자 세어 parse-errors 계열 문장으로 낸다.
   */
  readonly deeplyNestedFiles: readonly string[];
  /** 프로젝트 파일이면 기준 경로, 아니면(의존성·lib) undefined */
  readonly pathOf: (sourceFile: ts.SourceFile) => string | undefined;
  /** 노드 시작(앞 공백·주석 제외)의 계약 위치 */
  readonly locationOf: (node: ts.Node) => BridgeLocation;
}

/**
 * 프로젝트 소스를 모아 Program을 만든다.
 *
 * @param root 프로젝트 realpath
 * @returns 준비한 프로젝트
 */
export function loadNodeProject(root: string, tsconfig?: string): NodeProject {
  const walk = collectProjectFiles(root, { includeFile: isSourceFileName, excludedDirectories: new Set() });
  const candidates = [...walk.files].filter(([, absolute]) => !isOversized(absolute));
  const { program, checker, status, deeplyNestedSources, excludedSources } = createGraphProgram(root, candidates.map(([, absolute]) => absolute), ts.createProgram, tsconfig);
  const files = new Map<string, ts.SourceFile>();
  const pathBySourceFile = new Map<ts.SourceFile, string>();
  const deeplyNestedFiles: string[] = [];
  for (const [path, absolute] of candidates) {
    const sourceFile = program.getSourceFile(resolve(absolute));
    if (sourceFile === undefined) {
      if (deeplyNestedSources.has(resolve(absolute))) deeplyNestedFiles.push(path);
      continue;
    }
    files.set(path, sourceFile);
    pathBySourceFile.set(sourceFile, path);
  }
  const columns = new Map<ts.SourceFile, ByteColumnIndex>();
  return {
    root,
    program,
    checker,
    files,
    gaps: {
      symlinks: walk.skippedSymlinks,
      unreadableDirectories: walk.unreadableDirectories,
      truncated: walk.truncated,
      oversizedFiles: walk.files.size - candidates.length,
      unsafeNames: walk.unsafeNames,
      unreadableFiles: candidates.length - files.size - deeplyNestedFiles.length - excludedSources.size,
    },
    configStatus: { ...status, ...((walk.skippedLoaders ?? 0) > 0 ? { skippedLoaderEntries: walk.skippedLoaders } : {}) },
    deeplyNestedFiles,
    pathOf: (sourceFile) => pathBySourceFile.get(sourceFile),
    locationOf: (node) => locationOf(node, pathBySourceFile, columns),
  };
}

/**
 * Program 설정 공백을 원인 문장으로 만든다. 접두사는 문서마다 다르므로 호출자가 붙인다.
 *
 * 원인 문구는 graph의 `graph-config:`·`oversized-compiler-inputs:`·`parse-errors:`(깊이로 뺀 입력)와 같다 — 같은
 * Program에서 같은 공백을 본 문서들이 같은 말로 알려야 사용자가 한 가지 고칠 방향(설정·extends 대상 설치, 큰 입력·
 * 깊이 중첩된 생성 파일 정리, 설정 루트를 담는 루트로 분석, 건너뛰는 디렉터리 안 설정 루트는 소스에서 참조)을 찾는다.
 * 설정 루트 경계의 문장은 {@link configRootGaps}다.
 *
 * @param status Program 설정 상태
 * @param affected 불완전할 수 있는 결과(예: `route registrations`)
 * @returns 원인 문장(공백이 없으면 빈 목록)
 */
export function compilerConfigGaps(status: ProgramConfigStatus, affected: string): string[] {
  const gaps: string[] = [];
  if (status.configUnreadable) {
    gaps.push(`${status.configName} could not be parsed; default compiler options were used, so path aliases may not resolve`);
  }
  const oversized = status.oversizedCompilerInputs ?? 0;
  if (oversized > 0) gaps.push(`${oversized} source, declaration, or package input(s) exceeded 4 MiB; type resolution and ${affected} may be incomplete`);
  const deeplyNested = status.deeplyNestedCompilerInputs ?? 0;
  if (deeplyNested > 0) {
    gaps.push(`${deeplyNested} declaration, package, or config-selected input(s) ${SYNTAX_DEPTH_CAUSE} and were not loaded; `
      + `type resolution and ${affected} may be incomplete`);
  }
  gaps.push(...configRootGaps(status, affected));
  return gaps;
}

/**
 * 노드의 계약 위치(1부터 시작하는 줄, UTF-8 바이트 열)를 만든다.
 *
 * @param node 노드
 * @param paths 소스 → 기준 경로
 * @param columns 소스별 바이트 열 색인 캐시
 * @returns 위치
 */
function locationOf(node: ts.Node, paths: ReadonlyMap<ts.SourceFile, string>, columns: Map<ts.SourceFile, ByteColumnIndex>): BridgeLocation {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  let index = columns.get(sourceFile);
  if (index === undefined) {
    index = new ByteColumnIndex(sourceFile.text);
    columns.set(sourceFile, index);
  }
  return { path: paths.get(sourceFile) ?? sourceFile.fileName, line: line + 1, column: index.column(sourceFile.getLineStarts()[line]!, start) };
}

/**
 * 파일이 크기 상한을 넘는지 본다. 읽지 못하면 넘는 것으로 본다.
 *
 * @param absolute 절대 경로
 * @returns 넘으면 true
 */
function isOversized(absolute: string): boolean {
  try {
    return statSync(absolute).size > MAX_NODE_SOURCE_BYTES;
  } catch {
    // 걷기와 stat 사이에 사라진 파일은 분석하지 않고 크기 초과와 같은 계수로 알린다.
    return true;
  }
}

/**
 * 파서가 구문 오류를 남겼는지 본다(`parseDiagnostics`는 공개 API가 아니라 Program의 구문 진단을 쓴다).
 *
 * @param sourceFile 소스
 * @returns 오류가 있으면 true
 */
export function hasParseErrors(sourceFile: ts.SourceFile): boolean {
  return ((sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0;
}

/**
 * Node 백엔드 테스트 소스 경로인지 판정한다: `__tests__`·`__mocks__`·`test`·`tests`·`e2e` 디렉터리, `*.test.*`·`*.spec.*`·
 * `*.e2e-spec.*`·`*.e2e.*` 파일. Next.js와 달리 이 프레임워크들은 폴더 이름이 URL이 아니므로 `test/`도 테스트로 본다.
 * graph는 Next 라우터 디렉터리를 이 규칙에서 빼는 `isProjectTestPath`(project-routes.ts)로 같은 규칙을 쓴다.
 *
 * @param path 프로젝트 기준 경로
 * @returns 테스트 소스면 true
 */
export function isNodeTestPath(path: string): boolean {
  const segments = path.split('/');
  const directories = new Set(['__tests__', '__mocks__', 'test', 'tests', 'e2e']);
  if (segments.slice(0, -1).some((segment) => directories.has(segment))) return true;
  return /\.(?:test|spec|e2e-spec|e2e)\.[^.]+$/u.test(segments.at(-1)!);
}
