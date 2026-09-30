/**
 * ORM·드라이버 표면이 사실을 내는 공통 통로다.
 *
 * - 사용 사실: 위치 노드를 감싼 선언 이름이 `symbol.qualifiedName`이자 `symbol.usr`다(그래프 id).
 * - 선언 사실: Prisma 스키마와 같은 선언 이름공간 `<선언 파일>#model:<심볼>`을 usr로 쓴다(그래프 노드가 아님).
 * - SQL 텍스트: 가족 공유 추출기로 관계를 읽고, 미해석 피연산자가 있으면 dynamic 사실 하나를 더한다.
 *
 * 게이트가 읽은 리터럴 노드는 `consumed`에 넣는다. 뒤이어 도는 게이트 없는 리터럴 스캔이 같은 SQL을
 * 다시 읽거나 dynamic으로 세지 않게 하기 위해서다(소스 트리는 두 스캔이 공유한다).
 */

import ts from 'typescript';

import { enclosingSymbol } from '../enclosing-symbol.ts';
import { dynamicChannel, type RelationFactSink } from '../relation-facts.ts';
import type { SourceModule } from '../source-module.ts';
import { sqlRelations } from '../sql-relations.ts';
import type { DeclarationSite, TableName } from './orm-model.ts';

/** ORM 표면이 누적하는 계수다. */
export interface OrmCounts {
  /** 조인할 수 없어 dynamic으로 낸 관계 자리 수다(기존 `dynamic-relation-names:`와 합산). */
  dynamicRelations: number;
  /** 쿼리 모양이지만 수신자를 증명하지 못해 내지 않은 호출 수(표면별)다. */
  readonly unresolvedReceivers: Map<string, number>;
  /** 이름 규칙을 확정하지 못한 이유(표면별 문장)다. */
  readonly namingUnverified: Set<string>;
  /** 정적으로 읽지 못한 선언 조각(스프레드·계산된 키·비리터럴 이름) 수(표면별)다. */
  readonly unreadableDeclarations: Map<string, number>;
}

/**
 * 빈 계수를 만든다.
 *
 * @returns 계수
 */
export function emptyOrmCounts(): OrmCounts {
  return { dynamicRelations: 0, unresolvedReceivers: new Map(), namingUnverified: new Set(), unreadableDeclarations: new Map() };
}

/**
 * 표면별 계수를 하나 올린다.
 *
 * @param counts 표면 → 수
 * @param surface 표면 이름
 */
export function bump(counts: Map<string, number>, surface: string): void {
  counts.set(surface, (counts.get(surface) ?? 0) + 1);
}

/** 사실 발행기다. 프로젝트 하나에 하나를 둔다. */
export class OrmFactEmitter {
  /** 사실 수집기다. */
  private readonly sink: RelationFactSink;
  /** 계수다. */
  readonly counts: OrmCounts;
  /** 게이트가 소비한 노드(게이트 없는 스캔이 건너뛴다)다. */
  readonly consumed: Set<ts.Node>;
  /** 소스 파일 → 모듈이다. */
  private readonly modules: ReadonlyMap<ts.SourceFile, SourceModule>;

  /**
   * @param sink 사실 수집기
   * @param counts 계수
   * @param consumed 소비 노드 집합(공유)
   * @param modules 스캔한 모듈
   */
  constructor(sink: RelationFactSink, counts: OrmCounts, consumed: Set<ts.Node>, modules: readonly SourceModule[]) {
    this.sink = sink;
    this.counts = counts;
    this.consumed = consumed;
    this.modules = new Map(modules.map((module) => [module.sourceFile, module]));
  }

  /**
   * 코드의 사용 사실 하나를 낸다.
   *
   * @param channel 관계 이름
   * @param method 컬럼 이름
   * @param dynamic dynamic 여부
   * @param at 위치 노드
   */
  use(channel: string, method: string | undefined, dynamic: boolean, at: ts.Node): void {
    const module = this.moduleOf(at);
    if (module === undefined) return;
    const symbol = enclosingSymbol(at, module.path);
    this.sink.add({
      channel, method, dynamic, path: module.path, text: module.text,
      offset: at.getStart(module.sourceFile), symbol, usr: symbol,
    });
  }

  /**
   * 테이블 이름의 사용 사실을 낸다. dynamic이면 계수를 올린다.
   *
   * @param table 테이블 이름
   * @param method 컬럼 이름(테이블이 dynamic이면 버린다)
   * @param at 위치 노드
   */
  useTable(table: TableName, method: string | undefined, at: ts.Node): void {
    if (table.dynamic) {
      if (method !== undefined) return;
      this.counts.dynamicRelations++;
    }
    this.use(table.channel, method, table.dynamic, at);
  }

  /**
   * 선언 사실 하나를 낸다. usr는 `<위치 파일>#model:<심볼>`이다(선언은 그 파일에 있다).
   *
   * @param site 선언 정보
   * @param table 테이블 이름
   * @param member 컬럼 사실이면 `[코드 이름, DB 컬럼]`
   * @param at 위치 노드
   */
  declaration(site: DeclarationSite, table: TableName, member: readonly [string, string] | undefined, at: ts.Node): void {
    const module = this.moduleOf(at);
    if (module === undefined) return;
    if (table.dynamic && member !== undefined) return;
    if (table.dynamic) this.counts.dynamicRelations++;
    const symbol = member === undefined ? site.symbol : `${site.symbol}.${member[0]}`;
    this.sink.add({
      channel: table.channel, method: member?.[1], dynamic: table.dynamic, path: module.path, text: module.text,
      offset: at.getStart(module.sourceFile), symbol, usr: `${module.path}#model:${symbol}`,
    });
  }

  /**
   * SQL 텍스트의 관계를 사용 사실로 낸다. 한 텍스트의 사실은 모두 같은 위치다.
   *
   * @param sql SQL 텍스트
   * @param at 위치 노드
   */
  sql(sql: string, at: ts.Node): void {
    const result = sqlRelations(sql, false);
    for (const name of new Set(result.relations.map((relation) => relation.name))) this.use(name, undefined, false, at);
    if (result.unresolved > 0) {
      this.counts.dynamicRelations += result.unresolved;
      this.use(dynamicChannel(sql), undefined, true, at);
    }
  }

  /**
   * 보간이 있는 일반 템플릿 문자열의 SQL을 부분 관찰로 낸다: 보간을 `?`로 둔 텍스트에서 이름으로 쓰인 관계는
   * 정적 사실로 내고, 보간이 무엇이든 텍스트 전체는 알 수 없으므로 원문 요약 dynamic 사실 하나를 늘 더한다
   * (보간이 관계·조인 조각일 수 있어 정적 사실만으로는 완전하지 않다).
   *
   * @param template 템플릿 식
   * @param at 위치 노드
   */
  partialSql(template: ts.TemplateExpression, at: ts.Node): void {
    const text = template.head.text + template.templateSpans.map((span) => ` ? ${span.literal.text}`).join('');
    const result = sqlRelations(text, false);
    for (const name of new Set(result.relations.map((relation) => relation.name))) this.use(name, undefined, false, at);
    this.dynamic(template, at);
  }

  /**
   * 식의 원문 요약을 channel로 실은 dynamic 사실을 낸다.
   *
   * @param source 원문 식
   * @param at 위치 노드
   */
  dynamic(source: ts.Node, at: ts.Node): void {
    const module = this.moduleOf(at);
    if (module === undefined) return;
    this.counts.dynamicRelations++;
    this.use(dynamicChannel(source.getText(module.sourceFile)), undefined, true, at);
  }

  /**
   * 노드를 게이트가 소비한 것으로 표시한다.
   *
   * @param node 노드
   */
  consume(node: ts.Node): void {
    this.consumed.add(node);
  }

  /**
   * 노드의 프로젝트 기준 경로다.
   *
   * @param node 노드
   * @returns 경로 또는 undefined
   */
  pathOf(node: ts.Node): string | undefined {
    return this.moduleOf(node)?.path;
  }

  /**
   * 노드가 속한 모듈이다.
   *
   * @param node 노드
   * @returns 모듈 또는 undefined
   */
  private moduleOf(node: ts.Node): SourceModule | undefined {
    return this.modules.get(node.getSourceFile());
  }
}

/**
 * 괄호·`as`·`satisfies`·non-null 래퍼를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * 파일의 모든 노드를 전위로 방문한다.
 *
 * @param sourceFile 파일
 * @param visit 방문 함수
 */
export function walk(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  ts.forEachChild(sourceFile, step);
}
