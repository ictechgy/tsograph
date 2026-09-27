/**
 * TypeScript/JavaScript 소스를 구문 트리로 읽고 위치를 계약 형식으로 바꾼다.
 *
 * 분석 대상 코드는 실행하지 않는다. TypeScript 컴파일러의 파서만 쓰고 타입 검사·모듈
 * 해석·lib 로딩은 하지 않는다 — 네트워크·파일 시스템을 더 건드리지 않고, 입력이 무엇이든
 * 파일 하나 안에서 끝나게 하기 위해서다.
 */

import ts from 'typescript';

import { ByteColumnIndex } from '../openapi/byte-columns.ts';

/** 파서가 읽을 수 있는 확장자(마지막 `.` 뒤)와 스크립트 종류다. */
const scriptKinds: ReadonlyMap<string, ts.ScriptKind> = new Map([
  ['ts', ts.ScriptKind.TS],
  ['mts', ts.ScriptKind.TS],
  ['cts', ts.ScriptKind.TS],
  ['tsx', ts.ScriptKind.TSX],
  ['js', ts.ScriptKind.JS],
  ['mjs', ts.ScriptKind.JS],
  ['cjs', ts.ScriptKind.JS],
  ['jsx', ts.ScriptKind.JSX],
]);

/** 1부터 시작하는 줄과 UTF-8 바이트 열이다. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** 파싱한 소스 하나와 위치 변환기다. */
export interface ParsedSource {
  readonly sourceFile: ts.SourceFile;
  /** 파서가 보고한 구문 오류가 있으면 true다. 이때 추출 결과는 부분일 수 있다. */
  readonly hasSyntaxErrors: boolean;
  /** 노드 시작(앞 공백·주석 제외)의 줄·UTF-8 바이트 열을 돌려준다. */
  readonly positionOf: (node: ts.Node) => SourcePosition;
}

/**
 * 파일 이름의 마지막 확장자로 스크립트 종류를 고른다.
 *
 * @param fileName 파일 이름 또는 경로
 * @returns 스크립트 종류. JS/TS 계열이 아니면 undefined
 */
export function scriptKindOf(fileName: string): ts.ScriptKind | undefined {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? undefined : scriptKinds.get(fileName.slice(dot + 1));
}

/**
 * 소스 텍스트를 파싱한다.
 *
 * 텍스트의 BOM은 호출자가 남겨 둔다(TypeScript 스캐너는 BOM을 공백으로 본다). 그래야
 * 첫 줄의 열이 파일 원문 바이트와 맞는다.
 *
 * @param fileName 진단용 파일 이름(확장자로 JSX 허용 여부가 갈린다)
 * @param text 파일 전체 텍스트
 * @param scriptKind 스크립트 종류
 * @returns 파싱 결과
 */
export function parseSource(fileName: string, text: string, scriptKind: ts.ScriptKind): ParsedSource {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const columns = new ByteColumnIndex(text);
  const lineStarts = sourceFile.getLineStarts();
  return {
    sourceFile,
    hasSyntaxErrors: countSyntaxErrors(sourceFile) > 0,
    positionOf: (node) => {
      const start = node.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      return { line: line + 1, column: columns.column(lineStarts[line]!, start) };
    },
  };
}

/**
 * 파일 하나의 구문 오류 수를 센다.
 *
 * 공개 API로 구문 진단을 얻는 방법은 Program뿐이라, 이미 파싱한 파일 하나만 돌려주는
 * 가상 호스트로 Program을 만든다. lib·모듈 해석을 끄므로 다른 파일을 읽지 않는다.
 *
 * @param sourceFile 파싱한 파일
 * @returns 구문 오류 수
 */
function countSyntaxErrors(sourceFile: ts.SourceFile): number {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [] };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === sourceFile.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [sourceFile.fileName], options, host });
  return program.getSyntacticDiagnostics(sourceFile).length;
}
