/**
 * 하위 명령 분배기다.
 *
 * argv를 명령별 구현으로 넘기고, 도움말·버전·모르는 명령을 처리한다. 파일
 * 시스템과 시계는 주입받아 프로세스 없이 테스트할 수 있게 한다.
 */

import {
  type CommandResult,
  success,
  usageFailure,
} from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { openApiUsage, runOpenApiCommand } from './openapi-command.ts';

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
const commandUsages: ReadonlyMap<string, string> = new Map([['openapi', openApiUsage]]);

/** 최상위 도움말이다. 명령이 늘면 여기에 한 줄씩 추가한다. */
export const rootHelp = `Usage: tsograph <command> [options]

Commands:
  openapi      Convert an OpenAPI 2.0/3.0/3.1 spec into isthmus route-contract facts
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
  return usageFailure(`tsograph: unknown command; run 'tsograph --help' for the list.\n${rootHelp}`);
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
