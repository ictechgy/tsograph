/**
 * `tsograph routes --role server` — Next.js·Node 백엔드 서버 라우트 선언을 isthmus http `route-decl` 문서로 낸다.
 *
 * 흐름: 인자 검증 → 프로젝트 경로 정규화 → package.json·next.config 읽기 → Next.js route 파일 스캔과 Node 백엔드
 * 라우터 해석 → 문서 조립 → 키 정렬 JSON 출력. 파일 하나를 읽지 못하는 것은 limitation이고, 프로젝트 자체를 읽지
 * 못하거나 출력이 상한을 넘으면 코드 2, 잘못된 호출은 사용법과 코드 64다. 분석이 호출 스택을 넘기면(깊이 중첩된
 * 생성 코드 등) 다른 명령과 같은 원인 문구의 코드 2다. 분석 대상 코드는 실행하지 않는다.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { encodeSortedJsonWithinLimit } from '../exchange/sorted-json.ts';
import { GraphProjectInputError } from '../graph/program.ts';
import { extractProjectRoutes, type ProjectRoutes } from '../routes/project-routes.ts';
import { extractClientRoutes } from '../routes/client/client-routes.ts';
import {
  MAX_TYPED_CLIENT_MODEL_BYTES,
  parseTypedClientModels,
  TypedClientModelError,
  type TypedClientModels,
} from '../routes/client/typed-client-model.ts';
import {
  createRouteDocument,
  MAX_FLATTENED_ROUTES,
  MAX_ROUTE_FACTS,
  type RouteFactLimitCause,
  RouteFactLimitError,
} from '../routes/route-document.ts';
import { type CommandResult, inputFailure, isStackExhaustion, stackExhaustionFailure, success, usageFailure } from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH, MAX_SERVICE_LENGTH } from './openapi-command.ts';
import { parseArguments } from './parse-arguments.ts';

/** routes 명령 사용법이다. */
export const routesUsage = `Usage: tsograph routes --role server|client --project <root> [--service <name>] [--client-model <file>] [--include-tests] [--format json]

Scan a Next.js project (App Router route handlers and Pages Router API routes) or a Node
backend (Hono, Express, Fastify, Koa with @koa/router, NestJS) and write an isthmus
bridge-facts v1 document (platform "js", target "http", route-decl facts).
Client role extracts web/React Native fetch, axios and ky route-call facts.

Options:
  --role <role>      server declarations or client HTTP calls
  --project <root>   Project root (the directory with package.json, next.config.*, app/ or pages/)
  --service <name>   Service identity recorded on the document and every fact
  --client-model <file>
                     Bounded JSON typed HTTP client model for opaque transports (client role only)
  --tsconfig <file>   Compiler config relative to --project (client role only)
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
  readonly clientModel: string | undefined;
  readonly tsconfig: string | undefined;
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
  const parsed = parseArguments(arguments_, ['--role', '--project', '--service', '--client-model', '--tsconfig', '--format'], ['--help', '--include-tests']);
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
  const clientModel = parsed.valueFlags.get('--client-model');
  if (clientModel !== undefined && role !== 'client') return '--client-model is available only with --role client.';
  const tsconfig = parsed.valueFlags.get('--tsconfig');
  if (tsconfig !== undefined && role !== 'client') return '--tsconfig is available only with --role client.';
  return { role, projectArgument, service, includeTests: parsed.booleanFlags.has('--include-tests'), clientModel, tsconfig };
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
  if (parsed.role === 'client') return extractClientDocument(project, parsed, environment);
  let routes: ProjectRoutes;
  try {
    routes = await extractProjectRoutes(environment.fileSystem, project, parsed.includeTests);
  } catch (error) {
    if (isStackExhaustion(error)) return stackExhaustionFailure();
    throw error;
  }
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
 * client 역할 문서를 만든다. client 추출은 Program 생성·분석·문서 조립을 한 함수(renderDocument의 build)에서 하므로,
 * 그 단계에서 난 호출 스택 초과를 분석 실패의 공용 문구로 바꾼다. 직렬화 단계의 RangeError는 renderDocument가
 * 출력 초과로 처리하므로 여기까지 오지 않는다.
 *
 * @param project 프로젝트 realpath
 * @param parsed 검증한 인자
 * @param environment 실행 환경
 * @returns 성공 또는 실패 결과
 */
async function extractClientDocument(project: string, parsed: RoutesArguments, environment: RoutesEnvironment): Promise<CommandResult> {
  const typedModels = parsed.clientModel === undefined ? undefined : await loadClientModel(environment.fileSystem, project, parsed.clientModel);
  if (typedModels !== undefined && 'exitCode' in typedModels) return typedModels;
  if (typedModels !== undefined && parsed.service !== undefined
    && typedModels.models.some((model) => model.methods.some((method) => method.service !== undefined && method.service !== parsed.service))) {
    return inputFailure('the client model declares a service that conflicts with --service; use one service identity.');
  }
  try {
    return renderDocument(() => extractClientRoutes(project, parsed.service, parsed.includeTests, environment.toolVersion, environment.now(), typedModels, parsed.tsconfig));
  } catch (error) {
    if (isStackExhaustion(error)) return stackExhaustionFailure();
    throw error;
  }
}

/** 명시 모델 파일을 프로젝트 안에서 bounded하게 읽고 JSON parser에 넘긴다. */
async function loadClientModel(fileSystem: CommandFileSystem, project: string, argument: string): Promise<TypedClientModels | CommandResult> {
  const requested = isAbsolute(argument) ? argument : resolve(project, argument);
  let modelPath: string;
  try { modelPath = await fileSystem.realPath(requested); }
  catch { return inputFailure('unable to read the client model file; pass an existing readable JSON file.'); }
  let status;
  try { status = await fileSystem.status(modelPath); }
  catch { return inputFailure('unable to read the client model file; pass an existing readable JSON file.'); }
  if (status.kind !== 'file') return inputFailure('unable to read the client model file; pass an existing readable JSON file.');
  const rel = relative(project, modelPath);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return usageFailure('tsograph: the client model file must be inside --project.');
  }
  if (!isSafeIdentifier(rel)) return inputFailure('the client model path contains characters the exchange format forbids; rename or move the file.');
  if (status.size > MAX_TYPED_CLIENT_MODEL_BYTES) return inputFailure(`the client model exceeds ${MAX_TYPED_CLIENT_MODEL_BYTES} bytes; split the model file.`);
  let bytes: Uint8Array;
  try { bytes = await fileSystem.readBytes(modelPath, MAX_TYPED_CLIENT_MODEL_BYTES); }
  catch { return inputFailure('unable to read the client model file; check file permissions.'); }
  if (bytes.byteLength > MAX_TYPED_CLIENT_MODEL_BYTES) return inputFailure(`the client model exceeds ${MAX_TYPED_CLIENT_MODEL_BYTES} bytes; split the model file.`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return inputFailure('the client model is not valid UTF-8; re-encode it as UTF-8.'); }
  try { return parseTypedClientModels(text); }
  catch (error) {
    if (error instanceof TypedClientModelError) return inputFailure(error.message);
    throw error;
  }
}

/**
 * 문서를 만들어 JSON으로 직렬화한다. 사실·출력 상한을 넘으면 부분 문서 대신 코드 2다.
 *
 * 조립(build)과 직렬화를 다른 단계로 다룬다. 조립 단계는 알려진 입력 실패(설정·사실 상한)만 바꾸고 그 밖의 예외는
 * 호출자에게 그대로 던진다 — client 역할은 분석 전체가 build 안에 있어, 분석 중 RangeError(스택 초과 등)를 출력
 * 크기 초과로 보고하면 원인과 해결 방향이 모두 틀리기 때문이다. RangeError를 출력 초과로 보는 것은 직렬화 단계뿐이다.
 *
 * @param build 문서 조립 함수
 * @param maxLength 출력 최대 길이(테스트 주입용). 기본은 isthmus 입력 상한
 * @returns 성공 또는 실패 결과
 * @throws build가 던진 그 밖의 예외(GraphProjectInputError·RouteFactLimitError가 아닌 것)
 */
export function renderDocument(build: () => unknown, maxLength: number = MAX_OUTPUT_LENGTH): CommandResult {
  let document: unknown;
  try {
    document = build();
  } catch (error) {
    if (error instanceof GraphProjectInputError) return inputFailure(error.message);
    if (error instanceof RouteFactLimitError) return inputFailure(routeFactLimitMessage(error.limitCause));
    throw error;
  }
  return encodeDocument(document, maxLength);
}

/**
 * 사실 상한 실패의 원인별 문구다. 펼치기 상한은 사실을 내지 않는 조건부 등록과 같은 사실로 합쳐질 등록도 세므로, 그때는
 * 사실 수가 아니라 펼친 등록 수를 원인으로 든다(사실 수로 적으면 사실이 거의 없는 프로젝트에 거짓 원인이 된다).
 *
 * @param cause 실패 원인
 * @returns 실패 문구
 */
function routeFactLimitMessage(cause: RouteFactLimitCause): string {
  if (cause === 'flattened-routes') {
    return `the project's routers expand to more than ${MAX_FLATTENED_ROUTES} route registrations when routers mounted at `
      + 'several paths are flattened, which exceeds the flattening limit; scan a smaller project root.';
  }
  return `the project produces more than ${MAX_ROUTE_FACTS} route-decl facts, which isthmus rejects; scan a smaller project root.`;
}

/**
 * 조립한 문서를 출력 상한 안에서 키 정렬 JSON으로 직렬화한다. 직렬화 중 엔진 문자열 길이 한계(RangeError)도 출력 초과다.
 *
 * @param document 조립한 문서
 * @param maxLength 출력 최대 길이
 * @returns 성공 또는 출력 초과 결과
 */
function encodeDocument(document: unknown, maxLength: number): CommandResult {
  let text: string | undefined;
  try {
    text = encodeSortedJsonWithinLimit(document, maxLength);
  } catch (error) {
    if (error instanceof RangeError) return outputTooLarge(maxLength);
    throw error;
  }
  return text === undefined ? outputTooLarge(maxLength) : success(text);
}

/**
 * 출력 길이 초과 실패를 만든다.
 *
 * @returns 코드 2 결과
 */
function outputTooLarge(maxLength: number): CommandResult {
  return inputFailure(`the output document would exceed ${maxLength} characters, which isthmus rejects; scan a smaller project root.`);
}
