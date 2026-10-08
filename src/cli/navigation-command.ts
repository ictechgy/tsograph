/**
 * `tsograph navigation` — 명시적 router model로 screen-route navigation 사실을 만든다.
 *
 * 모델과 compiler config는 project 안의 일반 파일만 받는다. 모델은 bounded byte read와
 * fatal UTF-8 decode 뒤 검증하며, 분석 대상 코드는 실행하지 않는다. 출력은 키 정렬 JSON이고
 * 읽기·설정·분석·크기 실패는 원문 경로나 내용을 노출하지 않는 코드 2 결과로 닫는다.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
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
  success,
  usageFailure,
} from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH } from './openapi-command.ts';
import { parseArguments } from './parse-arguments.ts';

/** navigation 명령 사용법이다. */
export const navigationUsage = `Usage: tsograph navigation --project <root> --router-model <file> [options]

Read an explicit router-models v1 JSON file and statically extract navigation-facts v1
screen-route records. Factory and screen identities must resolve to exact project declarations;
unresolved routes remain dynamic facts with measured limitations.

Options:
  --project <root>            Project root; locations and graph ids are relative to it (required)
  --router-model <file>       Bounded router-models v1 JSON file inside --project (required)
  --tsconfig <file>           Compiler config relative to --project
  --generated-at <timestamp>  Fixed generatedAt (YYYY-MM-DDTHH:mm:ss.sssZ) for byte-identical output
  --format json               Output format (json is the only format)
  --help                      Show this help

Exit codes: 0 success, 2 unreadable/invalid input or oversized output, 64 usage error.
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
  const project = await resolveProject(environment.fileSystem, parsed.project);
  if (typeof project !== 'string') return project;
  const models = await loadRouterModels(
    environment.fileSystem,
    project,
    parsed.routerModel,
  );
  if ('exitCode' in models) return models;
  const tsconfig = parsed.tsconfig === undefined
    ? undefined
    : await resolveCompilerConfig(environment.fileSystem, project, parsed.tsconfig);
  if (tsconfig !== undefined && typeof tsconfig !== 'string') return tsconfig;
  return extractAndRender(
    project,
    models,
    tsconfig,
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

/** 프로젝트 realpath가 읽을 수 있는 디렉터리인지 확인한다. */
async function resolveProject(
  fileSystem: CommandFileSystem,
  argument: string,
): Promise<string | CommandResult> {
  let project: string;
  try {
    project = await fileSystem.realPath(argument);
    if ((await fileSystem.status(project)).kind !== 'directory') throw new Error('not-directory');
  } catch {
    return inputFailure('--project does not name a readable directory; pass the project root.');
  }
  if (!isSafeIdentifier(project)) {
    return inputFailure(
      'the project path contains characters the exchange format forbids; rename or move the project.',
    );
  }
  return project;
}

/** router model을 project 안에서 bounded하게 읽고 검증한다. */
async function loadRouterModels(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
): Promise<RouterModels | CommandResult> {
  const file = await resolveProjectFile(
    fileSystem,
    project,
    argument,
    true,
    'the router model must be a readable file inside --project; move it under the project root.',
  );
  if (typeof file !== 'string') return file;
  let size: number;
  try {
    size = (await fileSystem.status(file)).size;
  } catch {
    return inputFailure(
      'unable to read the router model file; pass an existing readable JSON file inside --project.',
    );
  }
  if (size > MAX_ROUTER_MODEL_BYTES) return routerModelTooLarge();
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readBytes(file, MAX_ROUTER_MODEL_BYTES);
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

/** 선택한 compiler config가 project 안의 상대 일반 파일인지 확인한다. */
async function resolveCompilerConfig(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
): Promise<string | CommandResult> {
  if (isAbsolute(argument)) {
    return inputFailure('--tsconfig must be relative to --project; pass a project-relative config file.');
  }
  const file = await resolveProjectFile(
    fileSystem,
    project,
    argument,
    false,
    '--tsconfig must name a readable compiler config inside --project.',
  );
  if (typeof file !== 'string') return file;
  let status;
  try {
    status = await fileSystem.status(file);
  } catch {
    return inputFailure(
      '--tsconfig must name a readable compiler config; check the relative path and permissions.',
    );
  }
  if (status.size > MAX_GRAPH_CONFIG_BYTES) {
    return inputFailure(
      `the compiler config exceeds ${MAX_GRAPH_CONFIG_BYTES} bytes; split or reduce the config.`,
    );
  }
  return relative(project, file);
}

/** realpath containment와 일반 파일 종류를 함께 확인한다. */
async function resolveProjectFile(
  fileSystem: CommandFileSystem,
  project: string,
  argument: string,
  allowAbsolute: boolean,
  failure: string,
): Promise<string | CommandResult> {
  if (!allowAbsolute && isAbsolute(argument)) return inputFailure(failure);
  const requested = isAbsolute(argument) ? argument : resolve(project, argument);
  let file: string;
  try {
    file = await fileSystem.realPath(requested);
    if ((await fileSystem.status(file)).kind !== 'file') throw new Error('not-file');
  } catch {
    return inputFailure(failure);
  }
  const path = relative(project, file);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return inputFailure(failure);
  }
  return file;
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
