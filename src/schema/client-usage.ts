/**
 * 소스 파일 하나에서 Prisma Client 사용과 SQL 텍스트를 `relation-use` 사실로 읽는다.
 *
 * 읽는 표면:
 *
 * - `<client>.<delegate>` 접근: delegate의 모델 테이블(위치는 delegate 이름). 출처를 증명한
 *   수신자만 인정하고, 증명하지 못했지만 `<x>.<delegate>.<op>(` 모양인 호출은 개수로만 센다.
 * - delegate 호출 첫 인자의 `select`·`omit`·`where`·`data`·`cursor`·`create`·`update`·`orderBy`
 *   최상위 키와 `distinct`·`by` 문자열: 그 모델의 스칼라 필드일 때만 컬럼 사실.
 * - `$queryRaw`·`$executeRaw` 태그 템플릿과 `Prisma.sql` 조각: 보간은 바인드 파라미터라 `?`로 바꿔
 *   읽는다(관계 자리의 보간은 미해석 → dynamic). 중첩 `Prisma.sql`·`Prisma.raw('리터럴')`·
 *   `Prisma.empty`는 원문을 펼친다.
 * - `$queryRawUnsafe`·`$executeRawUnsafe`의 SQL 문자열: 리터럴·같은 파일 const는 읽고, 보간 템플릿과
 *   그 밖의 식은 dynamic(가족 규칙).
 * - 게이트 없는 문자열 리터럴: 대문자 SQL(strict)만 읽는다(가족 규칙).
 */

import ts from 'typescript';

import type { BindingEvaluator, BindingKind, ClassMembers, EvaluationContext } from './client-binding.ts';
import { Scope } from './client-binding.ts';
import { enclosingSymbol, isFunctionLike } from './enclosing-symbol.ts';
import type { CatalogModel, PrismaCatalog } from './prisma-catalog.ts';
import { dynamicChannel, type RelationFactSink } from './relation-facts.ts';
import { bindingElements, type ScopeBuilder } from './scope-builder.ts';
import type { SourceModule } from './source-module.ts';
import { looksLikeSql, sqlRelations } from './sql-relations.ts';

/** 파일 스캔 전체에서 누적하는 계수다. */
export interface UsageCounts {
  /** 조인할 수 없어 dynamic으로 낸 관계 자리 수다. */
  dynamicRelations: number;
  /** SQL 동사가 있지만 대문자가 아니어서 읽지 않은 게이트 없는 리터럴 수다. */
  skippedSqlLiterals: number;
  /** delegate 호출 모양이지만 수신자 출처를 증명하지 못해 내지 않은 호출 수다. */
  unresolvedReceivers: number;
  /** 클라이언트에서 알 수 없는 delegate를 접근한 수(dynamic으로 냄)다. */
  unknownDelegates: number;
}

/** Prisma 7 모델 delegate의 연산 이름이다. */
export const DELEGATE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'createMany',
  'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
  'count', 'aggregate', 'groupBy',
]);

/** 키가 필드 이름인 객체 인자다. */
const fieldObjectKeys: ReadonlySet<string> = new Set(['select', 'omit', 'where', 'data', 'cursor', 'create', 'update', 'orderBy']);

/** 값이 필드 이름 문자열(또는 그 배열)인 인자다. */
const fieldNameKeys: ReadonlySet<string> = new Set(['distinct', 'by']);

/** 태그 템플릿 SQL 게이트 메서드다. */
const taggedRawMethods: ReadonlySet<string> = new Set(['$queryRaw', '$executeRaw']);

/** 문자열 SQL 게이트 메서드다. */
const unsafeRawMethods: ReadonlySet<string> = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);

/** 파일 하나의 사용 스캐너다. */
export class ClientUsageScanner {
  /** 소스 모듈이다. */
  private readonly module: SourceModule;
  /** 모듈 스코프다. */
  private readonly moduleScope: Scope;
  /** 평가기다. */
  private readonly evaluator: BindingEvaluator;
  /** 스코프 빌더다. */
  private readonly builder: ScopeBuilder;
  /** 스키마 이름 표(없으면 모든 delegate가 미해석)다. */
  private readonly catalog: PrismaCatalog | undefined;
  /** delegate 접근을 사실로 낼지 여부다. 비관계(MongoDB) 스키마면 끈다. */
  private readonly emitsDelegates: boolean;
  /** 사실 수집기다. */
  private readonly sink: RelationFactSink;
  /** 계수다. */
  private readonly counts: UsageCounts;
  /** 게이트가 이미 읽은 노드(그 아래 리터럴은 다시 읽지 않는다)다. */
  private readonly consumed = new Set<ts.Node>();
  /** 게이트가 소비한 같은 파일 const 문자열 리터럴 시작 위치다. */
  private readonly consumedLiteralStarts = new Set<number>();
  /** `$transaction` 콜백 함수 노드다. 첫 매개변수가 클라이언트다. */
  private readonly transactionCallbacks = new Set<ts.Node>();
  /**
   * 게이트 없는 리터럴 후보다. 게이트 소비 표시가 모두 끝난 뒤(두 번째 단계) 읽는다 — const
   * 선언이 게이트 호출보다 앞에 있어도 같은 SQL을 선언 위치에서 다시 읽지 않기 위해서다.
   */
  private readonly literalCandidates: (ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression)[] = [];

  /**
   * @param module 소스 모듈
   * @param analysis 모듈 스코프·평가기·빌더
   * @param catalog 스키마 이름 표. `'non-relational'`이면 delegate 접근을 사실로 내지 않는다
   * @param sink 사실 수집기
   * @param counts 계수
   */
  constructor(
    module: SourceModule,
    analysis: { readonly scope: Scope; readonly evaluator: BindingEvaluator; readonly builder: ScopeBuilder },
    catalog: PrismaCatalog | undefined | 'non-relational',
    sink: RelationFactSink,
    counts: UsageCounts,
  ) {
    this.module = module;
    this.moduleScope = analysis.scope;
    this.evaluator = analysis.evaluator;
    this.builder = analysis.builder;
    this.catalog = catalog === 'non-relational' ? undefined : catalog;
    this.emitsDelegates = catalog !== 'non-relational';
    this.sink = sink;
    this.counts = counts;
  }

  /** 파일 전체를 스캔한다. */
  scan(): void {
    const context: EvaluationContext = { scope: this.moduleScope, thisMembers: undefined };
    for (const statement of this.module.sourceFile.statements) this.visit(statement, context);
    for (const literal of this.literalCandidates) {
      if (ts.isTemplateExpression(literal)) this.inspectTemplateLiteral(literal);
      else this.inspectLiteral(literal);
    }
  }

  /**
   * 노드 하나를 방문한다. 스코프를 여는 노드는 새 스코프로 내려간다.
   *
   * @param node 노드
   * @param context 평가 문맥
   */
  private visit(node: ts.Node, context: EvaluationContext): void {
    if (isFunctionLike(node)) {
      this.visitFunction(node, context);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      this.visitClass(node, context);
    } else if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
      this.visitBlock(node, context);
    } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      this.visitLoop(node, context);
    } else if (ts.isCatchClause(node)) {
      this.visitCatch(node, context);
    } else {
      this.inspect(node, context);
      ts.forEachChild(node, (child) => this.visit(child, context));
    }
  }

  /**
   * 함수 본문을 새 스코프로 방문한다. 일반 함수는 `this`를 끊고, 화살표·메서드는 이어받는다.
   *
   * @param node 함수 노드
   * @param context 바깥 문맥
   */
  private visitFunction(node: ts.FunctionLikeDeclaration, context: EvaluationContext): void {
    const breaksThis = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
    const inner: EvaluationContext = {
      scope: new Scope(context.scope),
      thisMembers: breaksThis ? undefined : context.thisMembers,
    };
    if (ts.isFunctionExpression(node) && node.name !== undefined) {
      const self = node;
      inner.scope.declareValue(node.name.text, () => this.evaluator.expression(self, context));
    }
    this.builder.declareParameters(node, inner, context, this.transactionCallbacks.has(node));
    for (const parameter of node.parameters) {
      if (parameter.initializer !== undefined) this.visit(parameter.initializer, inner);
    }
    const body = node.body;
    if (body === undefined) return;
    if (ts.isBlock(body)) {
      this.builder.hoistStatements(body.statements, inner);
      for (const statement of body.statements) this.visit(statement, inner);
    } else {
      this.visit(body, inner);
    }
  }

  /**
   * 클래스 멤버를 `this` 멤버 표와 함께 방문한다.
   *
   * @param node 클래스 노드
   * @param context 바깥 문맥
   */
  private visitClass(node: ts.ClassLikeDeclaration, context: EvaluationContext): void {
    for (const clause of node.heritageClauses ?? []) this.visit(clause, context);
    const members: ClassMembers = this.builder.classMembers(node, context);
    const memberContext: EvaluationContext = { scope: context.scope, thisMembers: members };
    for (const member of node.members) {
      if (ts.isClassStaticBlockDeclaration(member)) this.visit(member.body, { scope: context.scope, thisMembers: undefined });
      else if (isFunctionLike(member)) this.visitFunction(member, memberContext);
      else ts.forEachChild(member, (child) => this.visit(child, memberContext));
    }
  }

  /**
   * 블록을 새 스코프로 방문한다.
   *
   * @param node 블록
   * @param context 바깥 문맥
   */
  private visitBlock(node: ts.Block | ts.ModuleBlock | ts.CaseBlock, context: EvaluationContext): void {
    const inner: EvaluationContext = { scope: new Scope(context.scope), thisMembers: context.thisMembers };
    if (ts.isCaseBlock(node)) {
      this.builder.hoistStatements(node.clauses.flatMap((clause) => [...clause.statements]), inner);
    } else {
      this.builder.hoistStatements(node.statements, inner);
    }
    ts.forEachChild(node, (child) => this.visit(child, inner));
  }

  /**
   * 반복문을 초기화 선언의 스코프로 방문한다.
   *
   * @param node 반복문
   * @param context 바깥 문맥
   */
  private visitLoop(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement, context: EvaluationContext): void {
    const inner: EvaluationContext = { scope: new Scope(context.scope), thisMembers: context.thisMembers };
    const initializer = node.initializer;
    if (initializer !== undefined && ts.isVariableDeclarationList(initializer)) {
      this.builder.declareVariables(initializer, inner);
    }
    ts.forEachChild(node, (child) => this.visit(child, inner));
  }

  /**
   * catch 절을 오류 변수가 가리는 스코프로 방문한다.
   *
   * @param node catch 절
   * @param context 바깥 문맥
   */
  private visitCatch(node: ts.CatchClause, context: EvaluationContext): void {
    const inner: EvaluationContext = { scope: new Scope(context.scope), thisMembers: context.thisMembers };
    const declaration = node.variableDeclaration;
    if (declaration !== undefined) {
      for (const { local } of bindingElements(declaration.name)) inner.scope.declareValue(local, () => ({ kind: 'other' }));
    }
    this.visit(node.block, inner);
  }

  /**
   * 사실을 낼 수 있는 노드를 검사한다.
   *
   * @param node 노드
   * @param context 평가 문맥
   */
  private inspect(node: ts.Node, context: EvaluationContext): void {
    if (ts.isCallExpression(node)) this.inspectCall(node, context);
    else if (ts.isTaggedTemplateExpression(node)) this.inspectTaggedTemplate(node, context);
    else if (ts.isPropertyAccessExpression(node)) this.inspectMember(node, node.name.text, node.name, context);
    else if (ts.isElementAccessExpression(node)) this.inspectElementAccess(node, context);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      this.literalCandidates.push(node);
    }
  }

  /**
   * 식의 의미를 평가한다.
   *
   * @param expression 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private kindOf(expression: ts.Expression, context: EvaluationContext): BindingKind {
    return this.evaluator.expression(expression, context);
  }

  /**
   * `<receiver>.<name>` 접근을 검사한다.
   *
   * @param access 접근 식
   * @param name 멤버 이름
   * @param nameNode 위치로 쓸 이름 노드
   * @param context 평가 문맥
   */
  private inspectMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    name: string,
    nameNode: ts.Node,
    context: EvaluationContext,
  ): void {
    if (name.startsWith('$') || !this.emitsDelegates) return;
    if (this.kindOf(access.expression, context).kind === 'client') {
      this.emitDelegate(access, name, nameNode);
      return;
    }
    if (this.catalog?.delegates.get(name) !== undefined && isOperationCall(access)) this.counts.unresolvedReceivers++;
  }

  /**
   * 클라이언트의 delegate 접근을 사실로 낸다. 모르는 이름은 dynamic이다.
   *
   * @param access 접근 식
   * @param name delegate 이름
   * @param nameNode 위치 노드
   */
  private emitDelegate(access: ts.Expression, name: string, nameNode: ts.Node): void {
    const model = this.catalog?.delegates.get(name);
    if (model === undefined) {
      this.counts.unknownDelegates++;
      this.emitDynamic(access, nameNode);
      return;
    }
    if (model.table.dynamic) this.counts.dynamicRelations++;
    this.emit(model.table.channel, undefined, model.table.dynamic, nameNode);
  }

  /**
   * `client['job']`·`client[name]` 접근을 검사한다.
   *
   * @param access 원소 접근 식
   * @param context 평가 문맥
   */
  private inspectElementAccess(access: ts.ElementAccessExpression, context: EvaluationContext): void {
    const argument = access.argumentExpression;
    if (ts.isStringLiteralLike(argument)) {
      this.inspectMember(access, argument.text, argument, context);
      return;
    }
    if (!this.emitsDelegates || this.kindOf(access.expression, context).kind !== 'client') return;
    this.counts.unknownDelegates++;
    this.emitDynamic(access, argument);
  }

  /**
   * 호출 식을 검사한다: 트랜잭션 콜백 표시, 문자열 SQL 게이트, delegate 인자 컬럼, `Prisma.raw`.
   *
   * @param call 호출 식
   * @param context 평가 문맥
   */
  private inspectCall(call: ts.CallExpression, context: EvaluationContext): void {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    if (this.evaluator.isPrismaHelper(callee, 'raw', context)) {
      this.readRawHelper(call, context);
      return;
    }
    if (DELEGATE_OPERATIONS.has(method)) this.readOperationArguments(callee.expression, call, context);
    if (!method.startsWith('$') || this.kindOf(callee.expression, context).kind !== 'client') return;
    if (method === '$transaction') {
      for (const argument of call.arguments) if (isFunctionLike(argument)) this.transactionCallbacks.add(argument);
    } else if (unsafeRawMethods.has(method)) {
      this.readSqlArgument(call.arguments[0], context, false);
    } else if (taggedRawMethods.has(method)) {
      this.readSqlArgument(call.arguments[0], context, true);
    }
  }

  /**
   * `Prisma.raw('…')`의 리터럴(또는 같은 파일 const)을 SQL 조각으로 읽는다.
   *
   * @param call 호출 식
   * @param context 평가 문맥
   */
  private readRawHelper(call: ts.CallExpression, context: EvaluationContext): void {
    const [argument] = call.arguments;
    if (argument === undefined || this.isConsumed(call)) return;
    const kind = this.kindOf(argument, context);
    if (kind.kind !== 'string') return;
    this.consumed.add(argument);
    this.consumedLiteralStarts.add(kind.literalStart);
    this.emitSql(kind.value, argument, false);
  }

  /**
   * 게이트가 확정한 SQL 인자를 읽는다.
   *
   * @param argument 첫 인자
   * @param context 평가 문맥
   * @param acceptsFragment `Prisma.sql` 조각을 받는 게이트(`$queryRaw(…)` 호출형)인지 여부
   */
  private readSqlArgument(argument: ts.Expression | undefined, context: EvaluationContext, acceptsFragment: boolean): void {
    if (argument === undefined) return;
    const inner = skipOuterExpressions(argument);
    if (acceptsFragment && ts.isTaggedTemplateExpression(inner) && this.evaluator.isPrismaSqlTag(inner.tag, context)) return;
    this.consumed.add(argument);
    const kind = this.kindOf(argument, context);
    if (kind.kind === 'string') {
      this.consumedLiteralStarts.add(kind.literalStart);
      this.emitSql(kind.value, argument, false);
    } else if (!(acceptsFragment && kind.kind === 'sql-fragment')) {
      this.counts.dynamicRelations++;
      this.emitDynamic(argument, argument);
    }
  }

  /**
   * 태그 템플릿이 SQL 게이트(`client.$queryRaw`·`client.$executeRaw`·`Prisma.sql`)면 읽는다.
   *
   * @param node 태그 템플릿 식
   * @param context 평가 문맥
   */
  private inspectTaggedTemplate(node: ts.TaggedTemplateExpression, context: EvaluationContext): void {
    if (this.isConsumed(node)) return;
    const tag = node.tag;
    const isRawGate = ts.isPropertyAccessExpression(tag) && taggedRawMethods.has(tag.name.text)
      && this.kindOf(tag.expression, context).kind === 'client';
    if (!isRawGate && !this.evaluator.isPrismaSqlTag(tag, context)) return;
    this.consumed.add(node.template);
    this.emitSql(this.templateSql(node.template, context), node.template, false);
  }

  /**
   * 태그 템플릿의 SQL 텍스트를 만든다. 보간은 바인드 파라미터 `?`로 바꾸고 SQL 조각은 펼친다.
   *
   * @param template 템플릿
   * @param context 평가 문맥
   * @returns SQL 텍스트
   */
  private templateSql(template: ts.TemplateLiteral, context: EvaluationContext): string {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
    let text = template.head.text;
    for (const span of template.templateSpans) text += this.interpolationSql(span.expression, context) + span.literal.text;
    return text;
  }

  /**
   * 보간 하나의 SQL 텍스트다.
   *
   * @param expression 보간 식
   * @param context 평가 문맥
   * @returns 펼친 조각 또는 `?`
   */
  private interpolationSql(expression: ts.Expression, context: EvaluationContext): string {
    const inner = skipOuterExpressions(expression);
    if (ts.isTaggedTemplateExpression(inner) && this.evaluator.isPrismaSqlTag(inner.tag, context)) {
      this.consumed.add(inner);
      return this.templateSql(inner.template, context);
    }
    if (ts.isCallExpression(inner) && this.evaluator.isPrismaHelper(inner.expression, 'raw', context)) {
      const [argument] = inner.arguments;
      const kind = argument === undefined ? undefined : this.kindOf(argument, context);
      if (kind?.kind === 'string') {
        this.consumed.add(inner);
        this.consumedLiteralStarts.add(kind.literalStart);
        return kind.value;
      }
    }
    if (this.evaluator.isPrismaHelper(inner, 'empty', context)) return '';
    return ' ? ';
  }

  /**
   * delegate 연산 호출의 첫 인자에서 컬럼 사실을 읽는다.
   *
   * @param delegateAccess `client.delegate` 식(호출의 수신자)
   * @param call 연산 호출
   * @param context 평가 문맥
   */
  private readOperationArguments(delegateAccess: ts.Expression, call: ts.CallExpression, context: EvaluationContext): void {
    const model = this.delegateModel(delegateAccess, context);
    const [argument] = call.arguments;
    if (model === undefined || argument === undefined || model.table.dynamic) return;
    const options = skipOuterExpressions(argument);
    if (!ts.isObjectLiteralExpression(options)) return;
    for (const property of options.properties) {
      const key = propertyKey(property);
      if (key === undefined || !ts.isPropertyAssignment(property)) continue;
      if (fieldObjectKeys.has(key)) this.readFieldObject(property.initializer, model);
      else if (fieldNameKeys.has(key)) this.readFieldNames(property.initializer, model);
    }
  }

  /**
   * 식이 클라이언트의 알려진 delegate 접근이면 모델을 돌려준다.
   *
   * @param expression 식
   * @param context 평가 문맥
   * @returns 모델 또는 undefined
   */
  private delegateModel(expression: ts.Expression, context: EvaluationContext): CatalogModel | undefined {
    const inner = skipOuterExpressions(expression);
    if (!ts.isPropertyAccessExpression(inner) && !ts.isElementAccessExpression(inner)) return undefined;
    const name = ts.isPropertyAccessExpression(inner) ? inner.name.text : staticElementName(inner);
    if (name === undefined || this.kindOf(inner.expression, context).kind !== 'client') return undefined;
    return this.catalog?.delegates.get(name);
  }

  /**
   * 객체(또는 객체 배열) 인자의 최상위 키 중 스칼라 필드를 컬럼 사실로 낸다.
   *
   * @param value 인자 값
   * @param model 모델
   */
  private readFieldObject(value: ts.Expression, model: CatalogModel): void {
    const inner = skipOuterExpressions(value);
    const objects = ts.isArrayLiteralExpression(inner) ? inner.elements.map(skipOuterExpressions) : [inner];
    for (const object of objects) {
      if (!ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        const key = propertyKey(property);
        if (key !== undefined && property.name !== undefined) this.emitColumn(model, key, property.name);
      }
    }
  }

  /**
   * 필드 이름 문자열(또는 배열) 인자를 컬럼 사실로 낸다.
   *
   * @param value 인자 값
   * @param model 모델
   */
  private readFieldNames(value: ts.Expression, model: CatalogModel): void {
    const inner = skipOuterExpressions(value);
    const items = ts.isArrayLiteralExpression(inner) ? inner.elements.map(skipOuterExpressions) : [inner];
    for (const item of items) {
      if (ts.isStringLiteralLike(item)) {
        this.consumed.add(item);
        this.emitColumn(model, item.text, item);
      }
    }
  }

  /**
   * 필드가 모델의 스칼라 필드면 컬럼 사실을 낸다.
   *
   * @param model 모델
   * @param field 필드 이름
   * @param at 위치 노드
   */
  private emitColumn(model: CatalogModel, field: string, at: ts.Node): void {
    const column = model.columns.find((candidate) => candidate.field === field);
    if (column !== undefined) this.emit(model.table.channel, column.column, false, at);
  }

  /**
   * 게이트 없는 문자열 리터럴을 strict 모드로 읽는다.
   *
   * @param node 문자열 리터럴
   */
  private inspectLiteral(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void {
    if (this.isConsumed(node) || this.consumedLiteralStarts.has(node.getStart()) || isModuleSpecifier(node)) return;
    if (looksLikeSql(node.text, true)) this.emitSql(node.text, node, true);
    else if (looksLikeSql(node.text)) this.counts.skippedSqlLiterals++;
  }

  /**
   * 게이트 없는 보간 템플릿은 앞 조각이 대문자 SQL이면 dynamic으로 남긴다.
   *
   * @param node 템플릿 식
   */
  private inspectTemplateLiteral(node: ts.TemplateExpression): void {
    if (this.isConsumed(node)) return;
    const prefix = node.head.text;
    if (looksLikeSql(prefix, true)) {
      this.consumed.add(node);
      this.counts.dynamicRelations++;
      this.emitDynamic(node, node);
    } else if (looksLikeSql(prefix)) {
      this.counts.skippedSqlLiterals++;
    }
  }

  /**
   * 노드나 그 조상이 게이트에 소비됐는지 본다.
   *
   * @param node 노드
   * @returns 소비됐으면 true
   */
  private isConsumed(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (this.consumed.has(current)) return true;
    }
    return false;
  }

  /**
   * SQL 텍스트의 관계를 사실로 낸다. 한 텍스트의 사실은 모두 같은 위치이고, 미해석 피연산자가
   * 있으면 dynamic 사실 하나를 더한다(가족 규칙).
   *
   * @param sql SQL 텍스트
   * @param at 위치 노드
   * @param strict 대문자 게이트 여부
   */
  private emitSql(sql: string, at: ts.Node, strict: boolean): void {
    const result = sqlRelations(sql, strict);
    for (const name of new Set(result.relations.map((relation) => relation.name))) this.emit(name, undefined, false, at);
    if (result.unresolved > 0) {
      this.counts.dynamicRelations += result.unresolved;
      this.emit(dynamicChannel(sql), undefined, true, at);
    }
  }

  /**
   * 식의 원문 요약을 channel로 실은 dynamic 사실을 낸다.
   *
   * @param source 원문 식
   * @param at 위치 노드
   */
  private emitDynamic(source: ts.Node, at: ts.Node): void {
    this.emit(dynamicChannel(source.getText(this.module.sourceFile)), undefined, true, at);
  }

  /**
   * 사실 하나를 낸다.
   *
   * @param channel 관계 이름
   * @param method 컬럼 이름
   * @param dynamic dynamic 여부
   * @param at 위치 노드
   */
  private emit(channel: string, method: string | undefined, dynamic: boolean, at: ts.Node): void {
    this.sink.add({
      channel,
      method,
      dynamic,
      path: this.module.path,
      text: this.module.text,
      offset: at.getStart(this.module.sourceFile),
      ...symbolFields(enclosingSymbol(at, this.module.path)),
    });
  }
}

/**
 * 소스 사실의 symbol·usr 입력이다. 감싸는 선언 이름이 곧 그래프 id라 usr도 같은 값이다.
 *
 * @param symbol 감싸는 선언 이름
 * @returns 사실 입력의 symbol·usr
 */
function symbolFields(symbol: string | undefined): { symbol: string | undefined; usr: string | undefined } {
  return { symbol, usr: symbol };
}

/**
 * 괄호·`as`·`satisfies`·non-null 래퍼를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
function skipOuterExpressions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (isWrapperExpression(current)) current = current.expression;
  return current;
}

/** 값을 바꾸지 않는 래퍼 식이다. */
type WrapperExpression = ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression
  | ts.NonNullExpression | ts.TypeAssertion;

/**
 * 값을 바꾸지 않는 래퍼 식인지 본다.
 *
 * @param expression 식
 * @returns 래퍼면 true
 */
function isWrapperExpression(expression: ts.Expression): expression is WrapperExpression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression);
}

/**
 * 원소 접근의 정적 문자열 키다.
 *
 * @param access 원소 접근 식
 * @returns 키 또는 undefined
 */
function staticElementName(access: ts.ElementAccessExpression): string | undefined {
  return ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
}

/**
 * `<x>.<delegate>.<op>(` 모양인지 본다(접근이 연산 호출의 수신자).
 *
 * @param access delegate 접근 식
 * @returns 연산 호출 모양이면 true
 */
function isOperationCall(access: ts.Expression): boolean {
  const parent = access.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== access || !DELEGATE_OPERATIONS.has(parent.name.text)) {
    return false;
  }
  return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

/**
 * 객체 리터럴 멤버의 정적 키다.
 *
 * @param property 멤버
 * @returns 키 또는 undefined
 */
function propertyKey(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isSpreadAssignment(property)) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * 리터럴이 모듈 지정자(import·export·require·동적 import)인지 본다.
 *
 * @param node 리터럴
 * @returns 모듈 지정자면 true
 */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  return ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'));
}
