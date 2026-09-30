/**
 * 게이트가 확정한 SQL 인자·태그 템플릿을 SQL 텍스트로 읽는다.
 *
 * 문자열 리터럴과 정적으로 풀리는 const는 읽고, 그 밖의 식은 dynamic이다. 보간이 있는 일반 템플릿 문자열은
 * 부분 관찰이다: 문자열 보간은 바인드 파라미터가 아니라 텍스트 연결이라 관계·조인 조각이 들어갈 수 있으므로
 * 늘 dynamic 사실을 내고, 템플릿 원문에 이름으로 쓰인 관계만 정적 사실로 더한다(`IN (${placeholders})` 관용구).
 * 태그 템플릿(`sql\`…\``)의 보간은 라이브러리가 파라미터로 바꾸므로 `?`로 읽고, 식별자로 렌더링되는
 * 보간(테이블 객체, `sql.identifier('t')`)만 인용 이름으로 펼친다.
 */

import ts from 'typescript';

import { objectMember, type OrmEvaluator } from './orm-values.ts';
import { type OrmFactEmitter, unwrap } from './orm-facts.ts';

/** ORM 표면이 공유하는 분석 문맥이다. */
export interface OrmContext {
  readonly evaluator: OrmEvaluator;
  readonly emitter: OrmFactEmitter;
}

/** 객체 인자에서 SQL을 담는 키다(`pg` `{ text }`, `mysql2`·libSQL `{ sql }`). */
const sqlObjectKeys = ['text', 'sql', 'query'] as const;

/** 보간 하나를 SQL 조각으로 바꾸는 함수다. undefined면 바인드 파라미터 `?`다. */
export type Interpolator = (expression: ts.Expression) => string | undefined;

/**
 * SQL 인자 하나를 읽어 사실을 낸다.
 *
 * @param context 분석 문맥
 * @param argument 인자 식
 * @param depth 객체 속성을 따라간 깊이
 */
export function readSqlArgument(context: OrmContext, argument: ts.Expression | undefined, depth = 0): void {
  if (argument === undefined || depth > 4) return;
  const { emitter, evaluator } = context;
  const inner = unwrap(argument);
  if (ts.isStringLiteralLike(inner)) {
    emitter.consume(inner);
    emitter.sql(inner.text, inner);
    return;
  }
  if (ts.isObjectLiteralExpression(inner)) {
    readSqlObject(context, inner, inner, depth);
    return;
  }
  emitter.consume(inner);
  const template = templateOf(inner, evaluator);
  if (template !== undefined) {
    emitter.consume(template);
    emitter.partialSql(template, inner);
    return;
  }
  const value = evaluator.valueOf(inner);
  if (value.kind === 'string') {
    emitter.consume(value.node);
    emitter.sql(value.value, inner);
  } else if (value.kind === 'object') {
    readSqlObject(context, value.node, inner, depth);
  } else {
    emitter.dynamic(inner, inner);
  }
}

/**
 * 인자가 보간 있는 템플릿 문자열이거나 그것을 담은 const면 템플릿을 돌려준다.
 *
 * @param expression 인자 식(래퍼를 벗김)
 * @param evaluator 평가기
 * @returns 템플릿 또는 undefined
 */
function templateOf(expression: ts.Expression, evaluator: OrmEvaluator): ts.TemplateExpression | undefined {
  if (ts.isTemplateExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const origin = evaluator.binder.originOf(expression);
  if (origin.kind !== 'declaration' || !ts.isVariableDeclaration(origin.declaration)) return undefined;
  const list = origin.declaration.parent;
  const initializer = origin.declaration.initializer === undefined ? undefined : unwrap(origin.declaration.initializer);
  const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
  return isConst && initializer !== undefined && ts.isTemplateExpression(initializer) ? initializer : undefined;
}

/**
 * `{ text: '…' }`·`{ sql: '…' }` 인자의 SQL을 읽는다. SQL 키가 없으면 dynamic이다.
 *
 * @param context 분석 문맥
 * @param object 객체 리터럴
 * @param at 키가 없을 때의 위치
 * @param depth 깊이
 */
function readSqlObject(context: OrmContext, object: ts.ObjectLiteralExpression, at: ts.Expression, depth: number): void {
  for (const key of sqlObjectKeys) {
    const member = objectMember(object, key);
    if (member !== undefined) {
      readSqlArgument(context, member, depth + 1);
      return;
    }
  }
  context.emitter.dynamic(at, at);
}

/**
 * 태그 템플릿의 SQL 텍스트를 만든다. 보간은 `interpolate`가 조각으로 바꾸고, 못 바꾸면 `?`다.
 *
 * @param template 템플릿
 * @param interpolate 보간 변환 함수
 * @returns SQL 텍스트
 */
export function templateSql(template: ts.TemplateLiteral, interpolate: Interpolator): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let text = template.head.text;
  for (const span of template.templateSpans) text += (interpolate(span.expression) ?? ' ? ') + span.literal.text;
  return text;
}

/**
 * 이름을 SQL 인용 식별자로 만든다. 공유 추출기는 인용을 벗기고 `.`가 든 이름을 한 세그먼트로 escape한다.
 *
 * @param name 식별자
 * @returns `"name"`
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
