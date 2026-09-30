/**
 * 라우트 등록의 핸들러 인자를 tsograph 심볼 id(`symbol.usr`)로 옮긴다.
 *
 * usr는 핸들러 함수 **본문 코드가 속하는 그래프 노드**다(`src/graph/symbol-ids.ts`의 `scopeIdOf`). 그래서 이름 있는
 * 함수·메서드·`const h = () => …`는 그 선언 id가 되고, 등록 호출에 바로 넘긴 인라인 함수는 감싼 선언(모듈 최상위면
 * `<path>#<module>`)이 된다 — tsograph 그래프는 인라인 함수에 따로 노드를 만들지 않기 때문이다. 인라인 핸들러는
 * `inline`으로 표시해 호출자가 `framework-dispatch-unmodeled:` 한계로 알린다.
 *
 * `mayCallNext`는 핸들러가 요청을 다음 등록으로 넘길 수 있는지다. `next` 자리의 매개변수(Express 셋째, Hono·Koa 둘째)나
 * 나머지 매개변수가 있거나 함수를 찾지 못하면 true다. 이런 등록에는 `order`를 싣지 않는다(isthmus 계약).
 */

import ts from 'typescript';

import { scopeIdOf } from '../../graph/symbol-ids.ts';
import type { Frame, HandlerInfo } from './router-model.ts';
import { resolveAlias, symbolAt, unwrap } from './symbols.ts';
import { findBinding } from './value-resolver.ts';

/** 핸들러 추적 최대 깊이다. */
const MAX_HANDLER_DEPTH = 8;

/** 핸들러 해석에 필요한 환경이다. */
export interface HandlerEnvironment {
  readonly checker: ts.TypeChecker;
  /** 프로젝트 파일이면 기준 경로 */
  pathOf(sourceFile: ts.SourceFile): string | undefined;
}

/** 찾은 핸들러 함수다. */
interface FoundFunction {
  readonly node: ts.SignatureDeclaration & { readonly body?: ts.Node | undefined };
  /** 등록 호출 인자에 바로 쓴 함수면 true */
  readonly inline: boolean;
}

/**
 * 핸들러 식을 해석한다.
 *
 * @param environment 환경
 * @param expression 핸들러 식
 * @param frame 프레임
 * @param nextParameterIndex `next`가 오는 매개변수 위치(0부터)
 * @param call 등록 호출(인라인·외부 핸들러의 이름에 쓴다)
 * @returns 핸들러 정보
 */
export function resolveHandler(environment: HandlerEnvironment, expression: ts.Expression, frame: Frame, nextParameterIndex: number, call: ts.Node): HandlerInfo {
  const found = findFunction(environment, expression, frame, true, 0);
  const path = found === undefined ? undefined : environment.pathOf(found.node.getSourceFile());
  if (found === undefined || path === undefined || found.node.body === undefined) {
    const callPath = environment.pathOf(call.getSourceFile()) ?? call.getSourceFile().fileName;
    return { usr: undefined, qualifiedName: scopeIdOf(call, callPath), inline: false, mayCallNext: true };
  }
  const usr = scopeIdOf(found.node.body, path);
  return { usr, qualifiedName: usr, inline: found.inline, mayCallNext: mayCallNext(found.node, nextParameterIndex) };
}

/**
 * 핸들러 식이 가리키는 함수를 찾는다.
 *
 * @param environment 환경
 * @param expression 식
 * @param frame 프레임
 * @param direct 등록 호출 인자에 바로 쓴 식인지
 * @param depth 추적 깊이
 * @returns 함수 또는 undefined
 */
function findFunction(environment: HandlerEnvironment, expression: ts.Expression, frame: Frame | undefined, direct: boolean, depth: number): FoundFunction | undefined {
  if (depth > MAX_HANDLER_DEPTH) return undefined;
  const node = unwrap(expression);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { node, inline: direct };
  if (ts.isCallExpression(node)) return wrappedFunction(environment, node, frame, depth);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return referencedFunction(environment, node, frame, depth);
  return undefined;
}

/**
 * `wrap(fn)`·`fn.bind(x)` 같은 감싼 핸들러에서 안쪽 함수를 찾는다. 함수형 인자 중 마지막 것을 쓴다
 * (`asyncHandler(fn)`·`withAuth(opts, fn)`). 감싼 함수는 받은 핸들러를 그대로 부른다고 본다(문서화한 가정).
 *
 * @param environment 환경
 * @param call 호출 식
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 함수 또는 undefined
 */
function wrappedFunction(environment: HandlerEnvironment, call: ts.CallExpression, frame: Frame | undefined, depth: number): FoundFunction | undefined {
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'bind') {
    return findFunction(environment, call.expression.expression, frame, false, depth + 1);
  }
  for (const argument of [...call.arguments].reverse()) {
    const found = findFunction(environment, argument, frame, false, depth + 1);
    if (found !== undefined) return { node: found.node, inline: found.inline || isInlineFunction(argument) };
  }
  return undefined;
}

/**
 * 인자 식이 바로 쓴 함수 식인지 본다.
 *
 * @param argument 인자
 * @returns 함수 식이면 true
 */
function isInlineFunction(argument: ts.Expression): boolean {
  const node = unwrap(argument);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * 식별자·속성 접근이 가리키는 함수 선언을 찾는다.
 *
 * @param environment 환경
 * @param node 식별자 또는 속성 접근
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 함수 또는 undefined
 */
function referencedFunction(environment: HandlerEnvironment, node: ts.Identifier | ts.PropertyAccessExpression, frame: Frame | undefined, depth: number): FoundFunction | undefined {
  const symbol = symbolAt(environment.checker, ts.isIdentifier(node) ? node : node.name);
  if (symbol === undefined) return undefined;
  const binding = frame === undefined ? undefined : findBinding(frame, symbol);
  if (binding?.expression !== undefined) return findFunction(environment, binding.expression, binding.frame, false, depth + 1);
  const declaration = resolveAlias(environment.checker, symbol).valueDeclaration;
  if (declaration === undefined) return undefined;
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return { node: declaration, inline: false };
  const initializer = declarationInitializer(declaration);
  return initializer === undefined ? undefined : findFunction(environment, initializer, undefined, false, depth + 1);
}

/**
 * 변수·속성 선언의 초기값 식이다.
 *
 * @param declaration 선언
 * @returns 초기값 또는 undefined
 */
function declarationInitializer(declaration: ts.Declaration): ts.Expression | undefined {
  if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer !== undefined) {
    return declaration.initializer;
  }
  if (ts.isExportAssignment(declaration)) return declaration.expression;
  return undefined;
}

/**
 * 함수가 `next`를 받을 수 있는지 본다: `next` 자리까지 매개변수가 있거나 나머지 매개변수가 있으면 true다.
 *
 * @param node 함수
 * @param nextParameterIndex `next` 위치
 * @returns 받을 수 있으면 true
 */
function mayCallNext(node: ts.SignatureDeclaration, nextParameterIndex: number): boolean {
  const parameters = node.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  return parameters.length > nextParameterIndex || parameters.some((parameter) => parameter.dotDotDotToken !== undefined);
}
