/**
 * 사실을 담은 선언의 이름(`symbol.qualifiedName`)을 만든다.
 *
 * 형식: `<프로젝트 기준 POSIX 경로>#<이름>(.<이름>)*`. 이름은 바깥 선언부터 안쪽 선언 순서다.
 *
 * - 함수 선언·클래스 선언/식(이름 있는 것)·클래스 메서드·접근자·필드: 선언 이름. 생성자는
 *   `constructor`, 이름 없는 default export 함수·클래스는 `default`다.
 * - 변수 선언: 모듈 최상위 변수이거나, 사실이 그 초기값 안의 함수 안에 있을 때만 이름이 된다
 *   (함수 안 지역 결과 변수 `const rows = await …`는 이름이 아니다).
 * - 객체 리터럴의 메서드·함수 값 속성: 속성 이름(`handlers.GET`).
 * - `export default <식>`(CommonJS `export =`는 제외)의 식 안은 `default`다 — 모듈이 내보낸 값이고
 *   `routes`의 Pages Router 핸들러 id(`#default`)와 같아야 하기 때문이다.
 * - 호출·`new` 인자로 바로 넘긴 화살표·함수 식(인라인 콜백)은 자기 조각을 갖는다
 *   (`inline-callback.ts`의 `<호출 대상>(<리터럴>)`, 겹치면 `~2`…). 그 앞 이름은 **콜백 식 자신이 속한
 *   스코프**다 — 콜백 안에서 올라온 것처럼 지역 변수를 이름으로 삼지 않는다(`const rows = ids.map(cb)`의
 *   콜백은 `f.rows.…`가 아니라 `f.ids.map()`). 그래서 콜백 id의 앞부분은 언제나 콜백을 담은 노드의 id이고,
 *   그래프가 그 노드에서 콜백으로 `contains` 간선을 잇는다. 모듈 최상위 콜백은 `<module>` 아래다
 *   (`src/app.ts#<module>.app.get("/x")`).
 * - 그 밖의 이름 없는 함수(JSX 속성 값, 즉시 실행 함수, 조건식 값 등)는 투명하다 — 감싸는 선언에 귀속한다.
 * - 계산된 이름이 끼면 이름을 만들지 않는다(추측하지 않는다). 이름이 하나도 없으면(모듈 최상위 문장)
 *   심볼을 생략하고 호출자가 `missing-relation-usrs:`로 센다(isthmus 체인 전용 접두사).
 *
 * 이 이름은 그대로 tsograph 그래프 id(`symbol.usr`)다(`src/graph/symbol-ids.ts`).
 */

import ts from 'typescript';

import { inlineCallbackKey, type InlineFunction, isInlineCallback } from './inline-callback.ts';
import { memberName } from './scope-builder.ts';

/** 모듈 스코프 이름 조각이다. JS 식별자가 될 수 없는 이름이라 실제 선언과 겹치지 않는다. */
export const MODULE_SCOPE_NAME = '<module>';

/**
 * 파일 → 인라인 콜백 → 한정 이름 조각 목록(계산된 이름이 끼면 null)이다. 이름 조각은 경로와 무관하므로 파일마다
 * 한 번 만든다. 순번(`~n`)이 어느 노드에서 물어도 같도록 파일 전체를 한꺼번에 정한다.
 */
const callbackNameTables = new WeakMap<ts.SourceFile, Map<ts.Node, readonly string[] | null>>();

/**
 * 노드를 담은 선언의 한정 이름을 만든다.
 *
 * @param node 사실 노드
 * @param path 프로젝트 기준 경로
 * @returns `path#A.B` 또는 undefined
 */
export function enclosingSymbol(node: ts.Node, path: string): string | undefined {
  const names = namesAbove(node, callbackNames);
  return names === null || names.length === 0 ? undefined : `${path}#${names.join('.')}`;
}

/** 이미 정한 인라인 콜백의 한정 이름을 읽는 함수다(계산된 이름이 끼면 null). */
type CallbackNameReader = (callback: InlineFunction) => readonly string[] | null;

/**
 * 노드에서 위로 올라가며 이름 조각을 모은다. 인라인 콜백을 만나면 그 콜백의 한정 이름에 잇고 멈춘다.
 *
 * @param node 시작 노드(자신은 조각이 되지 않는다)
 * @param readCallback 인라인 콜백의 한정 이름을 읽는다
 * @returns 이름 조각(없으면 빈 목록), 계산된 이름이 끼면 null
 */
function namesAbove(node: ts.Node, readCallback: CallbackNameReader): readonly string[] | null {
  const names: string[] = [];
  let insideFunction = false;
  for (let current: ts.Node = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent;
    if (isInlineCallback(parent)) {
      const outer = readCallback(parent);
      return outer === null ? null : [...outer, ...names.reverse()];
    }
    const name = declarationSegment(parent, current, insideFunction);
    if (name === null) return null;
    if (name !== undefined) names.push(name);
    if (isFunctionLike(parent)) insideFunction = true;
  }
  return names.reverse();
}

/**
 * 인라인 콜백의 한정 이름 조각을 파일별 표에서 읽는다. 표는 파일마다 처음 한 번 만든다.
 *
 * @param callback 인라인 콜백
 * @returns 이름 조각, 계산된 이름이 끼면 null
 */
function callbackNames(callback: InlineFunction): readonly string[] | null {
  const sourceFile = callback.getSourceFile();
  let table = callbackNameTables.get(sourceFile);
  if (table === undefined) {
    table = buildCallbackTable(sourceFile);
    callbackNameTables.set(sourceFile, table);
  }
  return table.get(callback) ?? null;
}

/**
 * 파일의 인라인 콜백마다 한정 이름을 정한다. 전위 순회라 바깥 콜백이 먼저 정해지고, 안쪽 콜백은 만드는 중인 표에서
 * 바깥 콜백 이름을 읽는다. 같은 스코프·같은 조각이 겹치면 소스 순서로 두 번째부터 `~n`을 붙인다.
 *
 * @param sourceFile 파일
 * @returns 콜백 → 이름 조각(계산된 이름이 끼면 null)
 */
function buildCallbackTable(sourceFile: ts.SourceFile): Map<ts.Node, readonly string[] | null> {
  const table = new Map<ts.Node, readonly string[] | null>();
  const occurrences = new Map<string, number>();
  const readOuter: CallbackNameReader = (callback) => table.get(callback) ?? null;
  const visit = (node: ts.Node): void => {
    if (isInlineCallback(node)) table.set(node, callbackEntry(node, readOuter, occurrences));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return table;
}

/**
 * 콜백 하나의 한정 이름을 만든다: 콜백 식이 속한 스코프 이름(없으면 `<module>`) + 조각(겹치면 `~n`).
 *
 * @param callback 인라인 콜백
 * @param readOuter 이미 정한 바깥 콜백 이름을 읽는다
 * @param occurrences 스코프·조각별 등장 수(갱신)
 * @returns 이름 조각, 계산된 이름이 끼면 null
 */
function callbackEntry(callback: InlineFunction, readOuter: CallbackNameReader, occurrences: Map<string, number>): readonly string[] | null {
  const owner = ownerNames(callback, readOuter);
  if (owner === null) return null;
  const key = inlineCallbackKey(callback);
  const slot = `${owner.join('\u0000')}\u0000${key}`;
  const count = (occurrences.get(slot) ?? 0) + 1;
  occurrences.set(slot, count);
  return [...owner, count === 1 ? key : `${key}~${count}`];
}

/**
 * 콜백 식 자신이 속한 스코프의 이름 조각이다(모듈 최상위면 `<module>`).
 *
 * @param callback 인라인 콜백
 * @param readOuter 바깥 콜백 이름을 읽는다
 * @returns 이름 조각, 계산된 이름이 끼면 null
 */
function ownerNames(callback: InlineFunction, readOuter: CallbackNameReader): readonly string[] | null {
  const names = namesAbove(callback, readOuter);
  return names === null || names.length > 0 ? names : [MODULE_SCOPE_NAME];
}

/**
 * 조상 노드 하나가 이름 조각이 되는지 본다.
 *
 * @param node 조상 노드
 * @param child 그 조상으로 올라온 자식
 * @param insideFunction 사실이 이미 어떤 함수 안에 있는지
 * @returns 이름, 조각 아님(undefined), 계산된 이름이라 포기(null)
 */
function declarationSegment(node: ts.Node, child: ts.Node, insideFunction: boolean): string | undefined | null {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? 'default';
  if (ts.isClassExpression(node)) return node.name?.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isPropertyDeclaration(node)) {
    return memberName(node.name) ?? null;
  }
  if (ts.isPropertyAssignment(node)) {
    if (child !== node.initializer || !insideFunction || !isFunctionValued(node.initializer)) return undefined;
    return memberName(node.name) ?? null;
  }
  if (ts.isVariableDeclaration(node)) return variableSegment(node, child, insideFunction);
  if (ts.isExportAssignment(node) && node.isExportEquals !== true) return 'default';
  return undefined;
}

/**
 * 변수 선언이 이름 조각이 되는지 본다.
 *
 * @param node 변수 선언
 * @param child 올라온 자식
 * @param insideFunction 사실이 이미 함수 안에 있는지
 * @returns 이름 또는 undefined
 */
function variableSegment(node: ts.VariableDeclaration, child: ts.Node, insideFunction: boolean): string | undefined {
  if (!ts.isIdentifier(node.name) || child !== node.initializer) return undefined;
  return insideFunction || isModuleLevel(node) ? node.name.text : undefined;
}

/**
 * 변수 선언이 모듈 최상위 문장에 속하는지 본다.
 *
 * @param node 변수 선언
 * @returns 최상위면 true
 */
function isModuleLevel(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

/**
 * 식이 (괄호를 벗겨) 함수 값인지 본다.
 *
 * @param expression 식
 * @returns 함수 값이면 true
 */
function isFunctionValued(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current);
}

/**
 * 함수처럼 본문을 가진 노드인지 본다.
 *
 * @param node 노드
 * @returns 함수 계열이면 true
 */
export function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}
