/**
 * 하위 명령 공통 인자 파서다.
 *
 * 플래그는 위치 인자 앞뒤 어디에 와도 된다. 값 플래그의 값은 비어 있지 않고
 * `-`로 시작하지 않아야 한다. `--` 뒤는 모두 위치 인자다. 모르는 플래그·중복
 * 값 플래그·빈 값은 사용법 오류(undefined)다 — 조용히 무시하면 사용자가 준
 * 옵션이 적용됐다고 오해한다.
 */

/** 플래그와 위치 인자로 나눈 결과다. */
export interface ParsedArguments {
  readonly valueFlags: ReadonlyMap<string, string>;
  readonly booleanFlags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

/**
 * 인자를 나눈다.
 *
 * @param arguments_ 하위 명령 이름 뒤의 인자
 * @param valueFlagNames 값을 받는 플래그 이름
 * @param booleanFlagNames 값 없는 플래그 이름
 * @returns 나눈 결과. 사용법 위반이면 undefined
 */
export function parseArguments(
  arguments_: readonly string[],
  valueFlagNames: readonly string[],
  booleanFlagNames: readonly string[],
): ParsedArguments | undefined {
  const valueFlags = new Map<string, string>();
  const booleanFlags = new Set<string>();
  const positionals: string[] = [];
  let onlyPositionals = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (onlyPositionals || !argument.startsWith('-')) {
      positionals.push(argument);
    } else if (argument === '--') {
      onlyPositionals = true;
    } else if (valueFlagNames.includes(argument)) {
      const value = arguments_[index + 1];
      if (valueFlags.has(argument) || !isFlagValue(value)) return undefined;
      valueFlags.set(argument, value);
      index++;
    } else if (booleanFlagNames.includes(argument)) {
      booleanFlags.add(argument);
    } else {
      return undefined;
    }
  }
  return { valueFlags, booleanFlags, positionals };
}

/**
 * 값 플래그 뒤의 인자가 값으로 쓸 수 있는지 확인한다.
 *
 * @param value 다음 인자
 * @returns 비어 있지 않고 `-`로 시작하지 않으면 true
 */
function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith('-');
}
