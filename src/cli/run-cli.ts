/**
 * 하위 명령 분배기다.
 *
 * argv를 명령별 구현으로 넘기고, 도움말·버전·모르는 명령을 처리한다. 파일
 * 시스템과 시계는 주입받아 프로세스 없이 테스트할 수 있게 한다.
 */

import {
  type CommandResult,
  inputFailure,
  success,
  usageFailure,
} from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { graphUsage, impactUsage, reachUsage, runGraphCommand, runImpactCommand, runReachCommand } from './graph-command.ts';
import { openApiUsage, runOpenApiCommand } from './openapi-command.ts';
import { routesUsage, runRoutesCommand } from './routes-command.ts';
import { runSchemaCommand, schemaUsage } from './schema-command.ts';

/** 분배기가 명령 구현에 넘기는 실행 환경이다. */
export interface CliEnvironment {
  /** 출력 문서의 `tool.version`과 `--version`에 쓰는 도구 버전이다. */
  readonly toolVersion: string;
  /** 명령이 쓰는 파일 시스템이다. */
  readonly fileSystem: CommandFileSystem;
  /** 문서 추출 시각(`generatedAt`)을 정하는 시계다. */
  readonly now: () => Date;
}

/** 명령 이름 → 사용법이다. */
const commandUsages: ReadonlyMap<string, string> = new Map([
  ['openapi', openApiUsage],
  ['routes', routesUsage],
  ['schema', schemaUsage],
  ['graph', graphUsage],
  ['reach', reachUsage],
  ['impact', impactUsage],
]);

/** 최상위 도움말이다. 명령이 늘면 여기에 한 줄씩 추가한다. */
export const rootHelp = `Usage: tsograph <command> [options]

Commands:
  openapi      Convert an OpenAPI 2.0/3.0/3.1 spec into isthmus route-contract facts
  routes       Extract Next.js server route declarations as isthmus route-decl facts
  schema       Extract Prisma/SQL relation-use facts for the isthmus persistence join
  graph        Build the TypeScript/JavaScript call graph snapshot
  reach        Symbols reachable from ids (isthmus language-traversal, dependencies)
  impact       Symbols that reach ids (isthmus language-traversal, dependents)
  help         Show command help

Options:
  --help       Show this help
  --version    Print the tsograph version
`;

/**
 * argv(노드 실행 파일과 스크립트 경로를 뗀 인자)를 실행한다.
 *
 * @param arguments_ 사용자가 준 인자 목록
 * @param environment 도구 버전·파일 시스템·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runCli(
  arguments_: readonly string[],
  environment: CliEnvironment,
): Promise<CommandResult> {
  const [command, ...rest] = arguments_;
  if (command === undefined) return usageFailure(rootHelp);
  if (command === '--help' || command === '-h') return success(rootHelp);
  if (command === '--version') return success(`${environment.toolVersion}\n`);
  if (command === 'help') return runHelp(rest);
  if (command === 'openapi') return runOpenApiCommand(rest, environment);
  if (command === 'routes') return runRoutesCommand(rest, environment);
  if (command === 'schema') return runSchemaCommand(rest, environment);
  if (command === 'graph') return runGraphCommand(rest, environment);
  if (command === 'reach') return runReachCommand(rest, environment);
  if (command === 'impact') return runImpactCommand(rest, environment);
  return usageFailure(`tsograph: unknown command; run 'tsograph --help' for the list.\n${rootHelp}`);
}

/**
 * `runCli`를 실행하되, 예상하지 못한 내부 예외도 종료 코드 계약 안의 결과로 바꾼다.
 *
 * 명령 구현은 알려진 실패를 모두 코드 2·64로 돌려준다. 그래도 남은 예외(버그, 런타임 한계)가
 * 프로세스를 스택 트레이스와 계약 밖 종료 코드로 끝내지 않게 한다. 메시지에는 예외 내용을
 * 싣지 않는다 — 입력 원문이나 절대 경로가 섞일 수 있기 때문이다.
 *
 * @param arguments_ 사용자가 준 인자 목록
 * @param environment 도구 버전·파일 시스템·시계
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runCliSafely(
  arguments_: readonly string[],
  environment: CliEnvironment,
): Promise<CommandResult> {
  try {
    return await runCli(arguments_, environment);
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'unknown';
    return inputFailure(`internal error (${kind}); please report it with the command you ran.`);
  }
}

/**
 * `tsograph help [command]`을 처리한다.
 *
 * @param rest `help` 뒤의 인자
 * @returns 도움말(성공) 또는 모르는 명령에 대한 사용법 오류
 */
function runHelp(rest: readonly string[]): CommandResult {
  if (rest.length === 0) return success(rootHelp);
  const usage = rest.length === 1 ? commandUsages.get(rest[0]!) : undefined;
  if (usage !== undefined) return success(usage);
  return usageFailure(`tsograph: no help for that command.\n${rootHelp}`);
}
