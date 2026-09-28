/**
 * CLI 명령이 프로세스 경계에 넘기는 결과 형태와 공통 실패 생성기다.
 *
 * 명령 구현은 프로세스·스트림을 직접 만지지 않고 이 값을 돌려준다. 그래서
 * 종료 코드 계약(0/1/2/64)을 단위 테스트에서 프로세스 없이 검증할 수 있다.
 */

/**
 * 종료 코드 계약이다.
 *
 * - 0: 성공(사실이 0건이어도 성공이다 — 완전성의 증거가 아니다)
 * - 1: 예약(발견 사항으로 실패시키는 명령이 생길 때 쓴다. 현재 명령은 내지 않는다)
 * - 2: 입력·도구 실패(읽을 수 없거나 잘못된 입력)
 * - 64: 사용법 오류(잘못된 호출). reach·impact의 root-not-found는 문서를 표준 출력에 낸 뒤 64다
 */
export type ExitCode = 0 | 1 | 2 | 64;

/** 명령 하나의 표준 출력·표준 오류와 종료 코드다. */
export interface CommandResult {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: ExitCode;
}

/**
 * 성공 결과를 만든다.
 *
 * @param standardOutput 표준 출력에 쓸 전체 텍스트
 * @returns 종료 코드 0 결과
 */
export function success(standardOutput: string): CommandResult {
  return { standardOutput, standardError: '', exitCode: 0 };
}

/**
 * 사용법 오류(종료 코드 64)를 만든다.
 *
 * @param usage 사용자에게 보여 줄 사용법 문구. 끝 개행을 포함한다.
 * @returns 종료 코드 64 결과
 */
export function usageFailure(usage: string): CommandResult {
  return { standardOutput: '', standardError: usage, exitCode: 64 };
}

/**
 * 문서를 내면서도 사용법 오류(종료 코드 64)로 끝나는 결과를 만든다.
 *
 * reach·impact가 그래프 노드가 아닌 root id를 받았을 때 쓴다. 계약(isthmus `language-traversal` v1)은 그런 root를
 * 문서 안 `root-not-found`로 기록하게 하고, 형제 생산자(cartograph·kartograph)는 문서를 낸 뒤 64로 끝난다. 호출자는
 * 표준 출력이 비었는지로 순수 사용법 오류와 구별한다.
 *
 * @param standardOutput 표준 출력에 쓸 문서
 * @param message 표준 오류에 쓸 안내. 끝 개행을 포함한다.
 * @returns 종료 코드 64 결과
 */
export function usageFailureWithOutput(standardOutput: string, message: string): CommandResult {
  return { standardOutput, standardError: message, exitCode: 64 };
}

/**
 * 입력·도구 실패(종료 코드 2)를 만든다.
 *
 * 메시지에는 원인과 해결 방향을 담되, 입력 본문이나 절대 경로를 넣지 않는다 —
 * CI 로그로 스펙 원문이나 로컬 경로가 새지 않게 하기 위해서다.
 *
 * @param message 원인과 해결 방향. 끝 개행이 없으면 붙인다.
 * @returns 종료 코드 2 결과
 */
export function inputFailure(message: string): CommandResult {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return { standardOutput: '', standardError: `tsograph: ${text}`, exitCode: 2 };
}
