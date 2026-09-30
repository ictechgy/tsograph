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
import { createGraphProgram } from '../../graph/program.ts';
import { collectProjectFiles } from '../../schema/project-files.ts';
import { isSourceFileName } from '../../schema/source-module.ts';

/** 분석하는 소스 파일 하나의 최대 크기(바이트)다. `graph`·`schema`와 같다. */
export const MAX_NODE_SOURCE_BYTES = 4 * 1024 * 1024;

/** 소스를 모으며 센 공백이다. */
export interface NodeProjectGaps {
  readonly symlinks: number;
  readonly unreadableDirectories: number;
  readonly truncated: boolean;
  readonly oversizedFiles: number;
}

/** 준비한 프로젝트다. */
export interface NodeProject {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** 분석 대상 파일(프로젝트 기준 POSIX 경로 → 소스), 경로 순 */
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  readonly gaps: NodeProjectGaps;
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
export function loadNodeProject(root: string): NodeProject {
  const walk = collectProjectFiles(root, { includeFile: isSourceFileName, excludedDirectories: new Set() });
  const candidates = [...walk.files].filter(([, absolute]) => !isOversized(absolute));
  const { program, checker } = createGraphProgram(root, candidates.map(([, absolute]) => absolute));
  const files = new Map<string, ts.SourceFile>();
  const pathBySourceFile = new Map<ts.SourceFile, string>();
  for (const [path, absolute] of candidates) {
    const sourceFile = program.getSourceFile(resolve(absolute));
    if (sourceFile === undefined) continue;
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
    },
    pathOf: (sourceFile) => pathBySourceFile.get(sourceFile),
    locationOf: (node) => locationOf(node, pathBySourceFile, columns),
  };
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
