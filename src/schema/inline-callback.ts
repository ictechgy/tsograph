/**
 * 호출 인자로 바로 넘긴 인라인 함수(화살표·함수 식)의 이름 조각을 만든다.
 *
 * `app.get('/x', async (c) => …)`·`items.map((item) => …)`·`it('works', () => …)`처럼 인자 자리에 쓴 함수는
 * 이름이 없어서, 예전에는 감싸는 선언에 투명하게 귀속했다. 그러면 모듈 최상위 라우트 핸들러의 코드가 모듈 스코프
 * 하나에 섞이고(`framework-dispatch-unmodeled:`), 그 안의 relation-use는 usr가 없었다. 이제 이런 함수는
 * 감싸는 스코프 아래의 이름 조각 하나를 갖는다(`enclosing-symbol.ts`가 잇는다).
 *
 * 조각 = `<호출 대상>(<앞쪽 문자열 리터럴 인자>)`:
 *
 * - **기준 호출**은 함수를 인자로 받은 호출이다. 그 호출이 다시 다른 호출의 인자면(`app.get('/x',
 *   asyncHandler(async () => …))`) 인자 사슬의 가장 바깥 호출까지 올라간다 — 감싼 핸들러도 등록 호출로 이름을
 *   얻게 하려는 것이다(`app.get("/x")`).
 * - **호출 대상**은 식별자·`this`·`super`·속성 접근·문자열 키 원소 접근의 사슬 그대로다(`app.get`,
 *   `this.router.post`, `db["run"]`). 사슬 안에 호출·`new`·그 밖의 식이 끼면 그 앞을 `…`로 줄인다
 *   (`new Hono().get('/a', …)` → `….get("/a")`). 앞 등록의 경로가 뒤 핸들러 id에 스며들지 않게 하려는 것이다
 *   (체인 길이만큼 id가 길어지거나, 무관한 경로 수정이 뒤 핸들러 id를 바꾸지 않는다). `new` 기준 호출은
 *   `new <대상>`으로 쓴다(`new Promise()`).
 * - **키 인자**는 기준 호출의 앞쪽 인자 중 연속한 정적 키 최대 2개를 쉼표로 잇는다(없으면 `useEffect()`).
 *   정적 키는 문자열 리터럴(JSON 문자열, `router.on("GET","/x")`), 템플릿 리터럴(치환은 이름 사슬이면
 *   `${이름}`, 아니면 `${…}`: `books.get("${BOOKS}/featured")`), 이름 사슬(`books.post(BOOKS)`,
 *   `authors.get(PATHS.authors)`), 그런 키만 담은 배열(`books.on(["PUT","PATCH"],…)`)이다. 함수·호출·객체 등
 *   다른 인자에서 멈춘다. 문자열은 64 UTF-16 단위를 넘으면 서러게이트 쌍을 가르지 않고 자른 뒤 `…`를 붙이고,
 *   JSON이 이스케이프하지 않는 C1 제어 문자·U+2028/U+2029도 `\uXXXX`로 바꾼다 — 계약이 심볼 이름에 제어
 *   문자를 금지하기 때문이다.
 *
 * 같은 스코프에서 조각이 겹치면(같은 경로를 두 번 등록, 한 호출에 인라인 함수 여럿, `useEffect` 여러 번)
 * 소스 순서로 두 번째부터 `~2`, `~3`…을 붙인다(`enclosing-symbol.ts`의 파일별 표).
 */

import ts from 'typescript';

/** 리터럴 인자 하나를 id에 싣는 최대 길이(UTF-16 단위)다. 긴 SQL·테스트 이름이 id를 부풀리지 않게 한다. */
const MAX_LITERAL_LENGTH = 64;

/** 조각에 싣는 앞쪽 정적 키 인자의 최대 개수다(`on('GET', '/x', h)`). */
const MAX_KEY_ARGUMENTS = 2;

/** 호출 대상 사슬에서 이름으로 옮길 수 없는 부분을 줄인 표시다. */
const ELIDED = '…';

/** JSON 문자열화가 남기는 계약 금지 문자(C1 제어 문자·U+2028/U+2029)다. */
const RESIDUAL_FORBIDDEN = /[\u007F-\u009F\u2028\u2029]/gu;

/** 인라인 함수 노드다. */
export type InlineFunction = ts.ArrowFunction | ts.FunctionExpression;

/**
 * 노드가 호출·`new`의 인자로 바로 쓴 화살표·함수 식인지 본다(괄호·`as`·`satisfies`·non-null·타입 단언은 벗긴다).
 *
 * @param node 노드
 * @returns 인라인 콜백이면 true
 */
export function isInlineCallback(node: ts.Node): node is InlineFunction {
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && argumentOwner(node) !== undefined;
}

/**
 * 인라인 콜백의 기본 조각(순번 없이)을 만든다.
 *
 * @param callback 인라인 콜백(`isInlineCallback`이 참인 노드)
 * @returns `<호출 대상>(<리터럴>)`
 */
export function inlineCallbackKey(callback: InlineFunction): string {
  const anchor = anchorCall(callback);
  const callee = calleeText(anchor.expression);
  const prefix = ts.isNewExpression(anchor) ? `new ${callee}` : callee;
  return `${prefix}(${leadingKeys(anchor.arguments ?? []).join(',')})`;
}

/**
 * 식을 인자로 받은 호출·`new`를 찾는다.
 *
 * @param expression 식
 * @returns 인자로 받은 호출, 인자가 아니면 undefined
 */
function argumentOwner(expression: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  const outer = climbValueWrappers(expression);
  const parent = outer.parent;
  if (parent === undefined || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return undefined;
  const argumentsList: readonly ts.Node[] = parent.arguments ?? [];
  return argumentsList.includes(outer) ? parent : undefined;
}

/**
 * 인자 사슬의 가장 바깥 호출(기준 호출)을 찾는다.
 *
 * @param callback 인라인 콜백
 * @returns 기준 호출
 */
function anchorCall(callback: InlineFunction): ts.CallExpression | ts.NewExpression {
  let anchor = argumentOwner(callback)!;
  for (let outer = argumentOwner(anchor); outer !== undefined; outer = argumentOwner(outer)) anchor = outer;
  return anchor;
}

/**
 * 값을 바꾸지 않는 부모 래퍼를 위로 벗긴다.
 *
 * @param node 식
 * @returns 가장 바깥 래퍼(없으면 식 자신)
 */
function climbValueWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isTypeAssertionExpression(current.parent))) {
    current = current.parent;
  }
  return current;
}

/**
 * 호출 대상 식을 이름 사슬로 옮긴다. 옮길 수 없는 부분은 `…`다.
 *
 * @param expression 호출 대상 식
 * @returns 이름 사슬
 */
function calleeText(expression: ts.Expression): string {
  const node = skipValueWrappers(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (ts.isPropertyAccessExpression(node)) return `${calleeText(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return `${calleeText(node.expression)}[${quoteLiteral(node.argumentExpression.text)}]`;
  }
  return ELIDED;
}

/**
 * 값을 바꾸지 않는 래퍼를 아래로 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
function skipValueWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * 앞쪽의 연속한 정적 키 인자를 옮긴다.
 *
 * @param argumentsList 호출 인자
 * @returns 키 표기(최대 `MAX_KEY_ARGUMENTS`개)
 */
function leadingKeys(argumentsList: readonly ts.Expression[]): string[] {
  const result: string[] = [];
  for (const argument of argumentsList.slice(0, MAX_KEY_ARGUMENTS)) {
    const key = argumentKey(argument, true);
    if (key === undefined) break;
    result.push(key);
  }
  return result;
}

/**
 * 인자 하나를 정적 키 표기로 옮긴다.
 *
 * @param argument 인자
 * @param allowArray 키만 담은 배열을 받을지(한 단계만)
 * @returns 키 표기, 정적 키가 아니면 undefined
 */
function argumentKey(argument: ts.Expression, allowArray: boolean): string | undefined {
  const node = skipValueWrappers(argument);
  if (ts.isStringLiteralLike(node)) return quoteLiteral(node.text);
  if (ts.isTemplateExpression(node)) return quoteLiteral(templateText(node));
  if (allowArray && ts.isArrayLiteralExpression(node)) {
    const keys = node.elements.map((element) => argumentKey(element, false));
    return keys.every((key) => key !== undefined) ? `[${keys.join(',')}]` : undefined;
  }
  return nameChain(node);
}

/**
 * 템플릿 리터럴을 글자로 옮긴다. 치환은 이름 사슬이면 `${이름}`, 아니면 `${…}`다.
 *
 * @param template 템플릿 식
 * @returns 글자
 */
function templateText(template: ts.TemplateExpression): string {
  return template.head.text + template.templateSpans
    .map((span) => `\${${nameChain(skipValueWrappers(span.expression)) ?? ELIDED}}${span.literal.text}`).join('');
}

/**
 * 식이 식별자·`this`와 그 속성 접근만으로 된 이름 사슬이면 그 글자다.
 *
 * @param node 식
 * @returns 이름 사슬 또는 undefined
 */
function nameChain(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const base = nameChain(skipValueWrappers(node.expression));
  return base === undefined ? undefined : `${base}.${node.name.text}`;
}

/**
 * 리터럴을 자르고 JSON 문자열로 인용한다. 남은 계약 금지 문자는 `\uXXXX`로 바꾼다.
 *
 * @param text 리터럴 값
 * @returns 인용한 문자열
 */
export function quoteLiteral(text: string): string {
  let end = Math.min(text.length, MAX_LITERAL_LENGTH);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  const clipped = end < text.length ? `${text.slice(0, end)}${ELIDED}` : text;
  return JSON.stringify(clipped).replace(RESIDUAL_FORBIDDEN, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
