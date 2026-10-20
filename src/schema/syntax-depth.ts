/**
 * 소스 구문 트리의 중첩 깊이 상한과, 파싱이 호출 스택을 넘긴 파일을 그 파일만의 실패로 가두는 격리 파싱이다.
 *
 * TypeScript 파서·바인더·검사기와 tsograph 방문기는 구문 중첩 깊이만큼 재귀한다. 생성·압축 코드나 조작한 파일 하나가
 * 깊게 중첩되면(긴 `||` 사슬·메서드 사슬, 괄호 수백 겹 등) 엔진 호출 스택을 넘겨 명령 전체가 실패하고, 같은 프로젝트의
 * 정상 파일 사실까지 사라진다. 그래서 파일마다 파싱 직후 명시 스택으로 깊이를 재고, 상한을 넘거나 파싱 자체가 스택을
 * 넘긴 파일은 분석에서 뺀다. 뺀 파일은 호출자가 그 문서의 parse-errors 계열 limitation으로 알린다.
 *
 * 이 검사는 파일 하나의 깊이만 묶는다. 분석이 파일 사이를 따라가며 쌓는 재귀(라우터 해석기의 호출 따라가기 등)가 그래도
 * 스택을 넘기면 CLI의 공용 실패(`stackExhaustionFailure`, 코드 2)가 안전망으로 남는다.
 */

import ts from 'typescript';

/**
 * 분석에 넣는 소스 파일 구문 트리의 최대 중첩 깊이다. SourceFile이 1이고 `ts.forEachChild`로 내려갈 때마다 1씩 는다.
 *
 * 근거(2026-10, macOS arm64·Node 22.20·TypeScript 5.9.3; 정상 파일 하나와 깊은 파일 하나를 둔 프로젝트에 다섯 명령을
 * 프로세스로 돌려 모양 50가지를 이분 탐색): 파싱에 성공한 파일에서 가장 얕게 넘친 것은 TypeScript 바인더가 재귀로 읽는
 * `||`·`&&`·`??` 사슬로 깊이 639~640이었다. 그다음은 JSX 중첩 779, 객체 전개 중첩 815, 블록 중첩 882이고, `+`·쉼표·
 * 메서드 사슬은 1,007~1,041이었다. 괄호·배열·타입 인자·호출 인자·콜백은 그보다 얕은 곳(403~)에서 파서가 먼저 넘치므로
 * {@link parseWithinSyntaxDepth}가 잡는다. 상한은 최저 붕괴 깊이의 약 1.6분의 1로 두어 플랫폼마다 다른 프레임 크기와
 * JIT 상태, 호출자가 이미 쌓은 스택을 흡수한다. 공개 npm 패키지 소스 6,869개 파일의 최대 깊이는 220(문자 폭 표의 214항
 * `||` 사슬)이라 정상 코드는 이 상한에 걸리지 않는다.
 */
export const MAX_SYNTAX_DEPTH = 400;

/**
 * 뺀 파일을 알리는 limitation 문장에 쓰는 원인 구절이다. 문서마다 같은 말로 알려야 사용자가 한 가지 원인(깊이 중첩된
 * 생성·압축 소스)을 찾는다. 주어는 호출자가 붙인다(`N source file(s) …`).
 */
export const SYNTAX_DEPTH_CAUSE = `nest syntax more than ${MAX_SYNTAX_DEPTH} levels deep or overflow the parser's call stack`;

/** 파싱이 호출 스택을 넘겼거나 트리가 상한보다 깊어 분석에서 뺀 파일을 나타내는 값이다. */
export const TOO_DEEP = 'too-deep';

/** V8이 호출 스택을 다 썼을 때 던지는 RangeError의 메시지다. */
const STACK_EXHAUSTION_MESSAGE = /Maximum call stack size exceeded/u;

/**
 * 잡은 예외가 호출 스택 초과인지 판정한다.
 *
 * 생성·압축 코드의 긴 메서드 사슬이나 수천 항의 쉼표 연결처럼 깊이 중첩된 식은 TypeScript 파서·바인더·검사기와
 * tsograph 방문기의 재귀를 중첩 깊이만큼 쌓아 엔진 스택을 넘긴다. 같은 RangeError라도 Map 크기·문자열 길이·
 * 잘못된 시각은 다른 원인(내부 한계·버그·출력 크기)이라 메시지까지 확인해 이 분류에 넣지 않는다 — 그런
 * 예외는 각 명령의 기존 처리(내부 오류로 전파 등)를 따른다.
 *
 * @param error 잡은 예외
 * @returns 호출 스택 초과면 true
 */
export function isStackExhaustion(error: unknown): boolean {
  return error instanceof RangeError && STACK_EXHAUSTION_MESSAGE.test(error.message);
}

/**
 * 구문 트리가 상한보다 깊은지 명시 스택으로 본다. 상한을 넘는 노드를 꺼내면 바로 멈춘다.
 *
 * 재귀하지 않으므로 이 검사 자체는 트리 깊이와 무관하게 호출 스택을 쓰지 않는다. 노드마다 한 번 방문하는 선형 시간이다.
 *
 * @param root 트리 뿌리(보통 SourceFile)
 * @param limit 허용하는 최대 깊이(뿌리가 1)
 * @returns 상한보다 깊은 노드가 있으면 true
 */
export function exceedsSyntaxDepth(root: ts.Node, limit: number = MAX_SYNTAX_DEPTH): boolean {
  const nodes: ts.Node[] = [root];
  const depths: number[] = [1];
  let depth = 0;
  const push = (child: ts.Node): undefined => {
    nodes.push(child);
    depths.push(depth + 1);
    return undefined;
  };
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    depth = depths.pop()!;
    if (depth > limit) return true;
    ts.forEachChild(node, push);
  }
  return false;
}

/**
 * 파일 하나의 파싱을 격리해 실행하고 깊이를 잰다.
 *
 * 파서는 괄호·배열·타입 인자 같은 중첩을 재귀로 읽어 수백 겹에서 스스로 스택을 넘긴다. 그 RangeError만 잡아 그 파일의
 * 실패로 바꾸고, 다른 예외(입력이 아니라 도구 쪽 문제)는 그대로 던진다. 파싱 함수가 트리 없음(undefined, 읽지 못함)을
 * 돌려주면 그대로 돌려준다 — 읽지 못한 파일과 깊어서 뺀 파일은 호출자가 다른 원인으로 센다.
 *
 * @param parse 파일 하나를 파싱하는 함수
 * @returns 상한 안의 트리(또는 파싱 함수가 준 undefined), 파싱이 스택을 넘겼거나 상한보다 깊으면 {@link TOO_DEEP}
 */
export function parseWithinSyntaxDepth<T extends ts.SourceFile | undefined>(parse: () => T): T | typeof TOO_DEEP {
  let sourceFile: T;
  try {
    sourceFile = parse();
  } catch (error) {
    // 파서의 스택 초과만 이 파일의 실패로 가둔다. 다른 예외는 입력 탓이 아니므로 그대로 전파한다.
    if (!isStackExhaustion(error)) throw error;
    return TOO_DEEP;
  }
  return sourceFile !== undefined && exceedsSyntaxDepth(sourceFile) ? TOO_DEEP : sourceFile;
}
