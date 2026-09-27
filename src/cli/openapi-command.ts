/**
 * `tsograph openapi` — OpenAPI 스펙을 isthmus http `route-contract` 문서로 바꾼다.
 *
 * 흐름: 인자 검증 → 스펙·프로젝트 경로 정규화 → 크기 상한 안에서 읽기 →
 * UTF-8 디코드 → 트리 파싱 → 문서 조립 → 키 정렬 JSON 출력.
 * 실패는 원인과 해결 방향을 담은 코드 2, 잘못된 호출은 사용법과 코드 64다.
 * 오류 문구에는 스펙 원문과 절대 경로를 넣지 않는다.
 */

import { dirname, isAbsolute, relative, sep } from 'node:path';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { encodeSortedJson } from '../exchange/sorted-json.ts';
import { createContractDocument, FactLimitError, MAX_FACTS } from '../openapi/contract-document.ts';
import { MAX_ALIAS_DEREFERENCES, parseSpecTree, SpecParseError } from '../openapi/spec-tree.ts';
import { SpecContentError } from '../openapi/spec-version.ts';
import { type CommandResult, inputFailure, success, usageFailure } from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { parseArguments } from './parse-arguments.ts';

/** 스펙 파일 크기 상한(바이트)이다. isthmus의 입력 파일 상한과 같은 규모다. */
export const MAX_SPEC_BYTES = 16 * 1024 * 1024;

/** `--service` 값의 최대 길이다. 서비스 신원은 짧은 이름이다. */
export const MAX_SERVICE_LENGTH = 256;

/** openapi 명령 사용법이다. */
export const openApiUsage = `Usage: tsograph openapi <spec-file> --service <name> [--project <root>] [--format json]

Convert an OpenAPI 2.0 (Swagger), 3.0, or 3.1 spec (JSON or YAML) into an isthmus
bridge-facts v1 document (platform "openapi", target "http", route-contract facts).

Options:
  --service <name>   Service identity recorded on the document and every fact (required)
  --project <root>   Join root; locations are relative to it (default: the spec's directory)
  --format json      Output format (json is the only format)

Exit codes: 0 success, 2 unreadable or invalid spec, 64 usage error.
`;

/** openapi 명령의 실행 환경이다. */
export interface OpenApiEnvironment {
  readonly fileSystem: CommandFileSystem;
  readonly toolVersion: string;
  readonly now: () => Date;
}

/** 검증을 통과한 인자다. */
interface OpenApiArguments {
  readonly specArgument: string;
  readonly service: string;
  readonly projectArgument: string | undefined;
}

/** 읽기까지 끝낸 입력이다. */
interface LoadedSpec {
  readonly project: string;
  readonly specPath: string;
  readonly text: string;
  readonly modifiedAt: Date;
}

/**
 * openapi 명령을 실행한다.
 *
 * @param arguments_ `openapi` 뒤의 인자
 * @param environment 파일 시스템·도구 버전·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runOpenApiCommand(
  arguments_: readonly string[],
  environment: OpenApiEnvironment,
): Promise<CommandResult> {
  const parsed = parseOpenApiArguments(arguments_);
  if (parsed === 'help') return success(openApiUsage);
  if (typeof parsed === 'string') return usageFailure(`tsograph: ${parsed}\n${openApiUsage}`);
  const loaded = await loadSpec(parsed, environment.fileSystem);
  if ('exitCode' in loaded) return loaded;
  return convertSpec(loaded, parsed.service, environment);
}

/**
 * 인자를 검증한다.
 *
 * @param arguments_ `openapi` 뒤의 인자
 * @returns 검증한 인자, 'help', 또는 사용법 오류 이유
 */
function parseOpenApiArguments(arguments_: readonly string[]): OpenApiArguments | 'help' | string {
  const parsed = parseArguments(arguments_, ['--service', '--project', '--format'], ['--help']);
  if (parsed === undefined) return 'unknown, repeated, or empty option.';
  if (parsed.booleanFlags.has('--help')) return 'help';
  const [specArgument, ...extra] = parsed.positionals;
  if (specArgument === undefined || extra.length > 0) return 'pass exactly one spec file.';
  const format = parsed.valueFlags.get('--format');
  if (format !== undefined && format !== 'json') return '--format supports only json.';
  const service = parsed.valueFlags.get('--service');
  if (service === undefined) return '--service <name> is required.';
  if (!isSafeIdentifier(service) || service.length > MAX_SERVICE_LENGTH) {
    return `--service must be 1-${MAX_SERVICE_LENGTH} characters without control characters.`;
  }
  return { specArgument, service, projectArgument: parsed.valueFlags.get('--project') };
}

/**
 * 스펙과 프로젝트 경로를 정규화하고 크기 상한 안에서 읽는다.
 *
 * @param parsed 검증한 인자
 * @param fileSystem 파일 시스템
 * @returns 읽은 입력 또는 실패 결과
 */
async function loadSpec(parsed: OpenApiArguments, fileSystem: CommandFileSystem): Promise<LoadedSpec | CommandResult> {
  const specReal = await realPathOf(fileSystem, parsed.specArgument);
  const specStatus = specReal === undefined ? undefined : await statusOf(fileSystem, specReal);
  if (specReal === undefined || specStatus?.kind !== 'file') {
    return inputFailure('unable to read the spec file; check that the path names an existing, readable file.');
  }
  if (specStatus.size > MAX_SPEC_BYTES) return specTooLarge();
  const project = await resolveProject(fileSystem, parsed.projectArgument, specReal);
  if (typeof project !== 'string') return project;
  const specPath = projectRelativePath(project, specReal);
  if (specPath === undefined) {
    return usageFailure(`tsograph: the spec file is outside --project; pass a project root that contains it.\n${openApiUsage}`);
  }
  if (!isSafeIdentifier(project) || !isSafeIdentifier(specPath)) {
    return inputFailure('the project or spec path contains characters the exchange format forbids; rename or move the files.');
  }
  const text = await readSpecText(fileSystem, specReal);
  if (typeof text !== 'string') return text;
  return { project, specPath, text, modifiedAt: specStatus.modifiedAt };
}

/**
 * 프로젝트 루트를 정한다. 명시 옵션이 없으면 스펙 파일의 디렉터리다.
 *
 * @param fileSystem 파일 시스템
 * @param projectArgument `--project` 값
 * @param specReal 스펙 파일 realpath
 * @returns 프로젝트 realpath 또는 실패 결과
 */
async function resolveProject(
  fileSystem: CommandFileSystem,
  projectArgument: string | undefined,
  specReal: string,
): Promise<string | CommandResult> {
  if (projectArgument === undefined) return dirname(specReal);
  const project = await realPathOf(fileSystem, projectArgument);
  const status = project === undefined ? undefined : await statusOf(fileSystem, project);
  if (project === undefined || status?.kind !== 'directory') {
    return inputFailure('--project does not name a readable directory; pass the join root that contains the spec.');
  }
  return project;
}

/**
 * 스펙을 바이트로 읽어 엄격한 UTF-8로 디코드한다.
 *
 * @param fileSystem 파일 시스템
 * @param specReal 스펙 파일 realpath
 * @returns 텍스트 또는 실패 결과
 */
async function readSpecText(fileSystem: CommandFileSystem, specReal: string): Promise<string | CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readBytes(specReal);
  } catch (error) {
    return inputFailure(`unable to read the spec file (${errorCode(error)}); check file permissions.`);
  }
  if (bytes.byteLength > MAX_SPEC_BYTES) return specTooLarge();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return inputFailure('the spec file is not valid UTF-8; re-encode it as UTF-8.');
    /* node:coverage ignore next */
    throw error;
  }
}

/**
 * 읽은 스펙을 문서로 바꾸고 JSON으로 출력한다.
 *
 * @param loaded 읽은 입력
 * @param service 서비스 신원
 * @param environment 실행 환경
 * @returns 성공 또는 실패 결과
 */
function convertSpec(loaded: LoadedSpec, service: string, environment: OpenApiEnvironment): CommandResult {
  try {
    const document = createContractDocument({
      tree: parseSpecTree(loaded.text),
      specPath: loaded.specPath,
      project: loaded.project,
      service,
      toolVersion: environment.toolVersion,
      generatedAt: environment.now(),
      sourceModifiedAt: loaded.modifiedAt,
    });
    return success(encodeSortedJson(document));
  } catch (error) {
    return conversionFailure(error);
  }
}

/**
 * 변환 실패를 원인·해결 방향 문구로 바꾼다. 모르는 예외는 다시 던진다.
 *
 * @param error 잡은 예외
 * @returns 코드 2 결과
 */
function conversionFailure(error: unknown): CommandResult {
  if (error instanceof SpecParseError) return inputFailure(parseFailureMessage(error));
  if (error instanceof SpecContentError) return inputFailure(contentFailureMessages[error.reason]);
  if (error instanceof FactLimitError) {
    return inputFailure(`the spec produces more than ${MAX_FACTS} route-contract facts; split the spec.`);
  }
  /* node:coverage ignore next */
  throw error;
}

/**
 * 파싱 실패 문구를 만든다.
 *
 * @param error 파싱 실패
 * @returns 원인과 해결 방향
 */
function parseFailureMessage(error: SpecParseError): string {
  const where = error.line === undefined ? '' : ` (line ${error.line})`;
  switch (error.reason) {
    case 'duplicate-key': return `the spec has a duplicate mapping key${where}; remove the duplicate so the operations are unambiguous.`;
    case 'multiple-documents': return 'the spec contains more than one YAML document; keep a single document per file.';
    case 'resource-exhaustion': return `the spec is nested too deeply to parse safely${where}; flatten the document.`;
    case 'alias-budget': return `the spec dereferences more than ${MAX_ALIAS_DEREFERENCES} YAML aliases; reduce alias use.`;
    default: return `the spec is not valid JSON or YAML${where}; fix the syntax and retry.`;
  }
}

/** 내용 실패 이유별 문구다. */
const contentFailureMessages: Readonly<Record<SpecContentError['reason'], string>> = {
  'not-an-object': 'the spec top level is not an object; pass an OpenAPI or Swagger document.',
  'missing-version': 'the spec has neither an "openapi" nor a "swagger" field; pass a Swagger 2.0 or OpenAPI 3.0/3.1 document.',
  'ambiguous-version': 'the spec has both "openapi" and "swagger" fields; keep the one that matches the document.',
  'unsupported-version': 'the spec version is not supported; tsograph reads Swagger 2.0 and OpenAPI 3.0.x/3.1.x (quote the version in YAML).',
  'missing-paths': 'the spec has no "paths" object, which Swagger 2.0 and OpenAPI 3.0 require; add "paths".',
  'invalid-paths': 'the spec "paths" field is not an object; fix the spec.',
};

/**
 * 크기 상한 초과 실패를 만든다.
 *
 * @returns 코드 2 결과
 */
function specTooLarge(): CommandResult {
  return inputFailure(`the spec file exceeds ${MAX_SPEC_BYTES} bytes; split or trim the spec.`);
}

/**
 * realpath를 구한다. 실패하면 undefined다(없는 경로·권한 없음).
 *
 * @param fileSystem 파일 시스템
 * @param path 입력 경로
 * @returns realpath 또는 undefined
 */
async function realPathOf(fileSystem: CommandFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fileSystem.realPath(path);
  } catch {
    // 없는 경로·권한 없음은 호출자가 원인·해결 문구로 보고한다(undefined가 신호다).
    return undefined;
  }
}

/**
 * 경로 상태를 구한다. 실패하면 undefined다.
 *
 * @param fileSystem 파일 시스템
 * @param path realpath
 * @returns 상태 또는 undefined
 */
async function statusOf(fileSystem: CommandFileSystem, path: string) {
  try {
    return await fileSystem.status(path);
  } catch {
    // stat 실패도 호출자가 "읽을 수 없음"으로 보고한다(undefined가 신호다).
    return undefined;
  }
}

/**
 * 프로젝트 루트 기준 POSIX 상대 경로를 만든다.
 *
 * @param project 프로젝트 realpath
 * @param target 대상 realpath
 * @returns 상대 경로. 루트 밖이면 undefined
 */
function projectRelativePath(project: string, target: string): string | undefined {
  const path = relative(project, target);
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return undefined;
  return path.split(sep).join('/');
}

/**
 * 예외에서 원문 경로 없는 오류 코드만 꺼낸다(예: EACCES).
 *
 * @param error 예외
 * @returns 오류 코드 또는 'unknown error'
 */
function errorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'unknown error';
}
