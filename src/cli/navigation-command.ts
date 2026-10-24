/**
 * `tsograph navigation` — 명시적 router model로 screen-route navigation 사실을 만든다.
 *
 * 모델과 compiler config는 realpath가 project 안인 일반 파일만 받는다(검증은 다른 명령과 같은 `project-paths.ts`).
 * 밖이면 사용 오류(64)다. 모델은 bounded byte read와 fatal UTF-8 decode 뒤 검증하며, 분석 대상 코드는 실행하지 않는다.
 * 출력은 키 정렬 JSON이고 읽기·설정·분석·크기 실패는 원문 경로나 내용을 노출하지 않는 코드 2 결과로 닫는다.
 */
import { encodeSortedJsonWithinLimit } from '../exchange/sorted-json.ts';
import { MAX_GRAPH_CONFIG_BYTES } from '../graph/bounded-config-reader.ts';
import { GraphProjectInputError } from '../graph/program.ts';
import {
  extractNavigationRoutes,
  MAX_NAVIGATION_FACTS,
  MAX_ROUTER_MODEL_BYTES,
  NavigationBindingLimitError,
  NavigationFactLimitError,
  parseRouterModels,
  RouterModelError,
  type RouterModels,
} from '../routes/navigation-routes.ts';
import {
  type CommandResult,
  inputFailure,
  isStackExhaustion,
  stackExhaustionFailure,
  success,
  usageFailure,
} from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH } from './openapi-command.ts';
import { parseArguments } from './parse-arguments.ts';
import { checkCompilerConfig, resolveProjectFile, resolveProjectRoot } from './project-paths.ts';

/** navigation 명령 사용법이다. */
export const navigationUsage = `Usage: tsograph navigation --project <root> --router-model <file> [options]

Read an explicit router-models v1 JSON file and statically extract navigation-facts v1
screen-route records. Factory and screen identities must resolve to exact project declarations;
unresolved routes remain dynamic facts with measured limitations.

Options:
  --respect-gitignore         Select entries with project-local .gitignore rules (default off)
  --project <root>            Project root; locations and graph ids are relative to it (required)
  --router-model <file>       Bounded router-models v1 JSON file inside --project (required)
  --tsconfig <file>           Compiler config file inside --project (relative to it, or absolute)
  --generated-at <timestamp>  Fixed generatedAt (YYYY-MM-DDTHH:mm:ss.sssZ) for byte-identical output
  --format json               Output format (json is the only format)
  --help                      Show this help

Exit codes: 0 success, 2 unreadable/invalid input or oversized output, 64 usage error
(including an input file outside --project).
`;

/** navigation 명령의 실행 환경이다. */
export interface NavigationEnvironment {
  readonly fileSystem: CommandFileSystem;
  readonly toolVersion: string;
  readonly now: () => Date;
}

interface NavigationArguments {
  readonly project: string;
  readonly routerModel: string;
  readonly tsconfig: string | undefined;
  readonly generatedAt: Date | undefined;
}

/**
 * navigation 명령을 실행한다.
 *
 * @param arguments_ `navigation` 뒤의 인자
 * @param environment 파일 시스템·도구 버전·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runNavigationCommand(
  arguments_: readonly string[],
  environment: NavigationEnvironment,
): Promise<CommandResult> {
  const parsed = parseNavigationArguments(arguments_);
  if (parsed === 'help') return success(navigationUsage);
  if (typeof parsed === 'string') return usageFailure(`tsograph: ${parsed}\n${navigationUsage}`);
  const project = await resolveProjectRoot(environment.fileSystem, parsed.project, 'pass the project root.');
  if (typeof project !== 'string') return project;
  const models = await loadRouterModels(
    environment.fileSystem,
    project,
    parsed.routerModel,
  );
  if ('exitCode' in models) return models;
  const configFailure = parsed.tsconfig === undefined
    ? undefined
    : await checkCompilerConfig(environment.fileSystem, project, parsed.tsconfig, navigationUsage);
  if (configFailure !== undefined) return configFailure;
  return extractAndRender(
    project,
    models,
    parsed.tsconfig,
    parsed.generatedAt ?? environment.now(),
    environment.toolVersion,
  );
}

function parseNavigationArguments(
  arguments_: readonly string[],
): NavigationArguments | 'help' | string {
  const parsed = parseArguments(
    arguments_,
    ['--project', '--router-model', '--tsconfig', '--generated-at', '--format'],
    ['--help'],
  );
  if (parsed === undefined) return 'unknown, repeated, or empty option.';
  if (parsed.booleanFlags.has('--help')) return 'help';
  if (parsed.positionals.length > 0) {
    return 'navigation takes no positional arguments; pass paths with named options.';
  }
  const format = parsed.valueFlags.get('--format');
  if (format !== undefined && format !== 'json') return '--format supports only json.';
  const project = parsed.valueFlags.get('--project');
  if (project === undefined) return '--project <root> is required.';
  const routerModel = parsed.valueFlags.get('--router-model');
  if (routerModel === undefined) return '--router-model <file> is required.';
  const generatedAt = parseTimestamp(parsed.valueFlags.get('--generated-at'));
  if (generatedAt === null) {
    return '--generated-at takes a UTC timestamp such as 2026-09-27T00:00:00.000Z.';
  }
  return {
    project,
    routerModel,
    tsconfig: parsed.valueFlags.get('--tsconfig'),
    generatedAt,
  };
}

/** router model을 project 안에서 bounded하게 읽고 검증한다. 크기는 포함 검사가 본 상태로 판정한다. */
async function loadRouterModels(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
): Promise<RouterModels | CommandResult> {
  const file = await resolveProjectFile(fileSystem, project, argument, {
    subject: 'the router model file',
    unreadable: 'the router model must be a readable file inside --project; move it under the project root.',
    outsideRemedy: 'move it under the project root.',
    usage: navigationUsage,
  });
  if ('exitCode' in file) return file;
  if (file.status.size > MAX_ROUTER_MODEL_BYTES) return routerModelTooLarge();
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readBytes(file.path, MAX_ROUTER_MODEL_BYTES);
  } catch {
    return inputFailure('unable to read the router model file; check file permissions and retry.');
  }
  if (bytes.byteLength > MAX_ROUTER_MODEL_BYTES) return routerModelTooLarge();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return inputFailure('the router model is not valid UTF-8; re-encode it as UTF-8 JSON.');
  }
  try {
    return parseRouterModels(text);
  } catch (error) {
    if (error instanceof RouterModelError) {
      return inputFailure(`${error.message}; fix the router model to match router-models v1 and retry.`);
    }
    return inputFailure('the router model could not be validated; fix it to match router-models v1.');
  }
}

/** 추출 오류를 CLI 계약으로 바꾸고 sorted JSON 상한 안에서 직렬화한다. */
function extractAndRender(
  project: string,
  models: RouterModels,
  tsconfig: string | undefined,
  generatedAt: Date,
  toolVersion: string,
): CommandResult {
  let document: unknown;
  try {
    document = extractNavigationRoutes(
      project,
      models,
      toolVersion,
      generatedAt,
      tsconfig,
    );
  } catch (error) {
    if (error instanceof NavigationBindingLimitError) {
      return inputFailure(
        `${error.message}; use a narrower project so mutation and alias coverage can be completed.`,
      );
    }
    if (error instanceof NavigationFactLimitError) {
      return inputFailure(
        `the project produces more than ${MAX_NAVIGATION_FACTS} screen-route facts; `
          + 'use a narrower project or router model.',
      );
    }
    if (error instanceof GraphProjectInputError) {
      return inputFailure(
        'the compiler config is invalid or unreadable; fix the selected config and its extends, '
          + `keeping each file within ${MAX_GRAPH_CONFIG_BYTES} bytes.`,
      );
    }
    // 깊이 중첩된 소스로 분석이 호출 스택을 넘긴 경우는 다른 명령과 같은 원인 문구로 알린다.
    if (isStackExhaustion(error)) return stackExhaustionFailure();
    return inputFailure(
      'navigation analysis failed; check project sources and compiler configuration, then retry.',
    );
  }
  let text: string | undefined;
  try {
    text = encodeSortedJsonWithinLimit(document, MAX_OUTPUT_LENGTH);
  } catch {
    return outputTooLarge();
  }
  return text === undefined ? outputTooLarge() : success(text);
}

function routerModelTooLarge(): CommandResult {
  return inputFailure(
    `the router model exceeds ${MAX_ROUTER_MODEL_BYTES} bytes; split or reduce the model file.`,
  );
}

function outputTooLarge(): CommandResult {
  return inputFailure(
    `the output document would exceed ${MAX_OUTPUT_LENGTH} characters; `
      + 'use a narrower project or router model.',
  );
}

/** graph 명령과 같은 UTC timestamp 문법을 읽는다. */
function parseTimestamp(value: string | undefined): Date | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime())
    || instant.toISOString().slice(0, 19) !== value.slice(0, 19)
    ? null
    : instant;
}
