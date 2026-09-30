/**
 * `tsograph routes --role server` — Next.js·Node 백엔드 서버 라우트 선언을 isthmus http `route-decl` 문서로 낸다.
 *
 * 흐름: 인자 검증 → 프로젝트 경로 정규화 → package.json·next.config 읽기 → Next.js route 파일 스캔과 Node 백엔드
 * 라우터 해석 → 문서 조립 → 키 정렬 JSON 출력. 파일 하나를 읽지 못하는 것은 limitation이고, 프로젝트 자체를 읽지
 * 못하거나 출력이 상한을 넘으면 코드 2, 잘못된 호출은 사용법과 코드 64다. 분석 대상 코드는
 * 실행하지 않는다.
 */

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { encodeSortedJson } from '../exchange/sorted-json.ts';
import { extractProjectRoutes } from '../routes/project-routes.ts';
import { extractClientRoutes } from '../routes/client/client-routes.ts';
import { createRouteDocument, MAX_ROUTE_FACTS, RouteFactLimitError } from '../routes/route-document.ts';
import { type CommandResult, inputFailure, success, usageFailure } from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH, MAX_SERVICE_LENGTH } from './openapi-command.ts';
import { parseArguments } from './parse-arguments.ts';

/** routes 명령 사용법이다. */
export const routesUsage = `Usage: tsograph routes --role server|client --project <root> [--service <name>] [--include-tests] [--format json]

Scan a Next.js project (App Router route handlers and Pages Router API routes) or a Node
backend (Hono, Express, Fastify, Koa with @koa/router, NestJS) and write an isthmus
bridge-facts v1 document (platform "js", target "http", route-decl facts).
Client role extracts web/React Native fetch, axios and ky route-call facts.

Options:
  --role <role>      server declarations or client HTTP calls
  --project <root>   Project root (the directory with package.json, next.config.*, app/ or pages/)
  --service <name>   Service identity recorded on the document and every fact
  --include-tests    Also emit routes declared in test sources (*.test.*, *.spec.*, __tests__/;
                     for Node backends also test/, tests/, e2e/) with testSource: true
  --format json      Output format (json is the only format)

Exit codes: 0 success, 2 unreadable project or oversized output, 64 usage error.
`;

/** routes 명령의 실행 환경이다. */
export interface RoutesEnvironment {
  readonly fileSystem: CommandFileSystem;
  readonly toolVersion: string;
  readonly now: () => Date;
}

/** 검증을 통과한 인자다. */
interface RoutesArguments {
  readonly role: 'server' | 'client';
  readonly projectArgument: string;
  readonly service: string | undefined;
  readonly includeTests: boolean;
}

/**
 * routes 명령을 실행한다.
 *
 * @param arguments_ `routes` 뒤의 인자
 * @param environment 파일 시스템·도구 버전·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runRoutesCommand(arguments_: readonly string[], environment: RoutesEnvironment): Promise<CommandResult> {
  const parsed = parseRoutesArguments(arguments_);
  if (parsed === 'help') return success(routesUsage);
  if (typeof parsed === 'string') return usageFailure(`tsograph: ${parsed}\n${routesUsage}`);
  const project = await resolveProject(environment.fileSystem, parsed.projectArgument);
  if (typeof project !== 'string') return project;
  return extractDocument(project, parsed, environment);
}

/**
 * 인자를 검증한다.
 *
 * @param arguments_ `routes` 뒤의 인자
 * @returns 검증한 인자, 'help', 또는 사용법 오류 이유
 */
function parseRoutesArguments(arguments_: readonly string[]): RoutesArguments | 'help' | string {
  const parsed = parseArguments(arguments_, ['--role', '--project', '--service', '--format'], ['--help', '--include-tests']);
  if (parsed === undefined) return 'unknown, repeated, or empty option.';
  if (parsed.booleanFlags.has('--help')) return 'help';
  if (parsed.positionals.length > 0) return 'routes takes no positional arguments; pass the project with --project.';
  const role = parsed.valueFlags.get('--role');
  if (role === undefined) return '--role server|client is required.';
  if (role !== 'server' && role !== 'client') return '--role supports only server or client.';
  const format = parsed.valueFlags.get('--format');
  if (format !== undefined && format !== 'json') return '--format supports only json.';
  const projectArgument = parsed.valueFlags.get('--project');
  if (projectArgument === undefined) return '--project <root> is required.';
  const service = parsed.valueFlags.get('--service');
  if (service !== undefined && (!isSafeIdentifier(service) || service.length > MAX_SERVICE_LENGTH)) {
    return `--service must be 1-${MAX_SERVICE_LENGTH} characters without control characters.`;
  }
  return { role, projectArgument, service, includeTests: parsed.booleanFlags.has('--include-tests') };
}

/**
 * 프로젝트 경로를 realpath로 정규화하고 디렉터리인지 확인한다.
 *
 * @param fileSystem 파일 시스템
 * @param projectArgument `--project` 값
 * @returns 프로젝트 realpath 또는 실패 결과
 */
async function resolveProject(fileSystem: CommandFileSystem, projectArgument: string): Promise<string | CommandResult> {
  let project: string;
  try {
    project = await fileSystem.realPath(projectArgument);
    if ((await fileSystem.status(project)).kind !== 'directory') throw new Error('not a directory');
  } catch {
    // 원인(없음·권한·파일)은 같은 해결 방향이라 한 문구로 보고한다. 경로 원문은 싣지 않는다.
    return inputFailure('--project does not name a readable directory; pass the project root.');
  }
  if (!isSafeIdentifier(project)) {
    return inputFailure('the project path contains characters the exchange format forbids; rename or move the project.');
  }
  return project;
}

/**
 * 프로젝트를 스캔해 문서를 만들고 JSON으로 출력한다.
 *
 * @param project 프로젝트 realpath
 * @param parsed 검증한 인자
 * @param environment 실행 환경
 * @returns 성공 또는 실패 결과
 */
async function extractDocument(project: string, parsed: RoutesArguments, environment: RoutesEnvironment): Promise<CommandResult> {
  if (parsed.role === 'client') return renderDocument(() => extractClientRoutes(project, parsed.service, parsed.includeTests, environment.toolVersion, environment.now()));
  const routes = await extractProjectRoutes(environment.fileSystem, project, parsed.includeTests);
  return renderDocument(() => createRouteDocument({
    next: routes.next,
    node: routes.node,
    project,
    service: parsed.service,
    includeTests: parsed.includeTests,
    toolVersion: environment.toolVersion,
    generatedAt: environment.now(),
  }));
}

/**
 * 문서를 만들어 JSON으로 직렬화한다. 사실·출력 상한을 넘으면 부분 문서 대신 코드 2다.
 *
 * @param build 문서 조립 함수
 * @param maxLength 출력 최대 길이(테스트 주입용). 기본은 isthmus 입력 상한
 * @returns 성공 또는 실패 결과
 */
export function renderDocument(build: () => unknown, maxLength: number = MAX_OUTPUT_LENGTH): CommandResult {
  let text: string;
  try {
    text = encodeSortedJson(build());
  } catch (error) {
    if (error instanceof RouteFactLimitError) {
      return inputFailure(`the project produces more than ${MAX_ROUTE_FACTS} route-decl facts, which isthmus rejects; scan a smaller project root.`);
    }
    if (error instanceof RangeError) return outputTooLarge();
    /* node:coverage ignore next */
    throw error;
  }
  return text.length > maxLength ? outputTooLarge() : success(text);
}

/**
 * 출력 길이 초과 실패를 만든다.
 *
 * @returns 코드 2 결과
 */
function outputTooLarge(): CommandResult {
  return inputFailure(`the output document would exceed ${MAX_OUTPUT_LENGTH} characters, which isthmus rejects; scan a smaller project root.`);
}
