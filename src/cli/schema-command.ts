/**
 * `tsograph schema` — 프로젝트의 Prisma 스키마·클라이언트 사용·SQL 텍스트를 isthmus persistence
 * `relation-use` 문서로 바꾼다.
 *
 * 흐름: 인자 검증 → 프로젝트 realpath → 추출 → 문서 조립 → 키 정렬 JSON 출력.
 * 실패는 원인과 해결 방향을 담은 코드 2, 잘못된 호출은 사용법과 코드 64다. 오류 문구에는
 * 절대 경로와 소스 원문을 넣지 않는다.
 */

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { encodeSortedJsonWithinLimit } from '../exchange/sorted-json.ts';
import { extractPersistenceFacts, type ExtractionResult } from '../schema/extract.ts';
import { createPersistenceDocument, MAX_SCHEMA_FACTS, SchemaFactLimitError } from '../schema/schema-document.ts';
import { type CommandResult, inputFailure, success, usageFailure } from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { parseArguments } from './parse-arguments.ts';

/** 출력 문서의 최대 길이(UTF-16 코드 단위)다. isthmus의 파일당 입력 상한과 같다. */
export const MAX_SCHEMA_OUTPUT_LENGTH = 16 * 1024 * 1024;

/** schema 명령 사용법이다. */
export const schemaUsage = `Usage: tsograph schema --project <root> [--format json]

Read the project's Prisma schema, Prisma Client usage, and SQL text, and write an isthmus
bridge-facts v1 document (platform "js", target "persistence", relation-use facts).

Options:
  --project <root>   Join root to scan; locations are relative to it (required)
  --format json      Output format (json is the only format)

Exit codes: 0 success, 2 unreadable project or oversized output, 64 usage error.
`;

/** schema 명령의 실행 환경이다. */
export interface SchemaEnvironment {
  readonly fileSystem: CommandFileSystem;
  readonly toolVersion: string;
  readonly now: () => Date;
  /** 추출기(테스트 주입용). 기본은 실제 추출기다. */
  readonly extract?: (root: string) => ExtractionResult;
}

/**
 * schema 명령을 실행한다.
 *
 * @param arguments_ `schema` 뒤의 인자
 * @param environment 파일 시스템·도구 버전·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runSchemaCommand(arguments_: readonly string[], environment: SchemaEnvironment): Promise<CommandResult> {
  const parsed = parseSchemaArguments(arguments_);
  if (parsed === 'help') return success(schemaUsage);
  if (parsed.error !== undefined) return usageFailure(`tsograph: ${parsed.error}\n${schemaUsage}`);
  const project = await resolveProject(environment.fileSystem, parsed.project);
  if (typeof project !== 'string') return project;
  const extraction = (environment.extract ?? extractPersistenceFacts)(project);
  return encodeDocument(project, extraction, environment);
}

/** 인자 검증 결과다. */
type SchemaArguments = { readonly project: string; readonly error?: undefined } | { readonly error: string };

/**
 * 인자를 검증한다.
 *
 * @param arguments_ `schema` 뒤의 인자
 * @returns 검증한 인자, 'help', 또는 사용법 오류 이유
 */
function parseSchemaArguments(arguments_: readonly string[]): SchemaArguments | 'help' {
  const parsed = parseArguments(arguments_, ['--project', '--format'], ['--help']);
  if (parsed === undefined) return { error: 'unknown, repeated, or empty option.' };
  if (parsed.booleanFlags.has('--help')) return 'help';
  if (parsed.positionals.length > 0) return { error: 'schema takes no positional arguments; pass the root with --project.' };
  const format = parsed.valueFlags.get('--format');
  if (format !== undefined && format !== 'json') return { error: '--format supports only json.' };
  const project = parsed.valueFlags.get('--project');
  if (project === undefined) return { error: '--project <root> is required.' };
  return { project };
}

/**
 * 프로젝트 루트를 realpath로 정규화하고 디렉터리인지 확인한다.
 *
 * @param fileSystem 파일 시스템
 * @param argument `--project` 값
 * @returns 프로젝트 realpath 또는 실패 결과
 */
async function resolveProject(fileSystem: CommandFileSystem, argument: string): Promise<string | CommandResult> {
  let project: string;
  try {
    project = await fileSystem.realPath(argument);
    if ((await fileSystem.status(project)).kind !== 'directory') throw new Error('not a directory');
  } catch {
    // 없는 경로·권한 없음·파일은 모두 같은 원인 문구로 알린다(경로 원문은 싣지 않는다).
    return inputFailure('--project does not name a readable directory; pass the join root to scan.');
  }
  if (!isSafeIdentifier(project)) {
    return inputFailure('the project path contains characters the exchange format forbids; rename or move the project.');
  }
  return project;
}

/**
 * 추출 결과를 문서로 조립해 JSON으로 출력한다.
 *
 * @param project 프로젝트 realpath
 * @param extraction 추출 결과
 * @param environment 실행 환경
 * @returns 성공 또는 실패 결과
 */
function encodeDocument(project: string, extraction: ExtractionResult, environment: SchemaEnvironment): CommandResult {
  let text: string | undefined;
  try {
    text = encodeSortedJsonWithinLimit(createPersistenceDocument({
      project,
      toolVersion: environment.toolVersion,
      generatedAt: environment.now(),
      sourceModifiedAt: extraction.sourceModifiedAt,
      facts: extraction.facts,
      limitations: extraction.limitations,
    }), MAX_SCHEMA_OUTPUT_LENGTH);
  } catch (error) {
    if (error instanceof SchemaFactLimitError) {
      return inputFailure(`the project produces more than ${MAX_SCHEMA_FACTS} relation-use facts; pass a narrower --project.`);
    }
    if (error instanceof RangeError) return outputTooLarge();
    /* node:coverage ignore next */
    throw error;
  }
  return text === undefined ? outputTooLarge() : success(text);
}

/**
 * 출력 길이 초과 실패를 만든다.
 *
 * @returns 코드 2 결과
 */
function outputTooLarge(): CommandResult {
  return inputFailure(`the output document would exceed ${MAX_SCHEMA_OUTPUT_LENGTH} characters, which isthmus rejects; pass a narrower --project.`);
}
