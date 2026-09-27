/**
 * `candidate` 간선의 대상을 찾는다: 인터페이스·구조 타입 수신자로 부른 메서드를 구현할 **수 있는** 프로젝트
 * 클래스·객체 리터럴 전부다(과대 근사). bound로 증명하지 못한 호출에만 쓴다.
 *
 * 후보 판정(둘 중 하나):
 * - 명목: 클래스(또는 그 기반 클래스)가 `implements`로 수신자 타입의 인터페이스(또는 그 인터페이스를
 *   확장한 인터페이스)를 선언했다.
 * - 구조: 클래스 인스턴스 타입이나 객체 리터럴 타입이 수신자 타입에 대입 가능하다
 *   (`TypeChecker.isTypeAssignableTo`, TypeScript 5.9 공개 API). 타입 매개변수 수신자는 제약 타입으로 본다.
 *
 * 그리고 그 값에서 메서드 이름이 본문 있는 프로젝트 선언으로 해석돼야 한다. 결과는 (수신자 타입, 이름)별로
 * 메모한다.
 */

import ts from 'typescript';

import { compareStrings } from '../exchange/sorted-json.ts';
import { memberName } from '../schema/scope-builder.ts';
import { isTypeOnly } from './node-collector.ts';
import type { TargetResolver } from './target-resolver.ts';
import { instanceTypeOf } from './value-flow.ts';

/** 후보 색인이다. */
interface CandidateIndex {
  readonly classes: readonly ts.ClassLikeDeclaration[];
  /** 멤버 이름 → 그 이름의 멤버를 가진 객체 리터럴 */
  readonly literals: ReadonlyMap<string, readonly ts.ObjectLiteralExpression[]>;
}

/** 후보 탐색기다. */
export class CandidateFinder {
  private readonly checker: ts.TypeChecker;
  private readonly resolver: TargetResolver;
  private readonly files: readonly ts.SourceFile[];
  private index: CandidateIndex | undefined;
  private readonly memo = new Map<ts.Type, Map<string, readonly string[]>>();

  /**
   * @param checker TypeChecker
   * @param resolver 대상 해석기
   * @param files 노드 파일
   */
  constructor(checker: ts.TypeChecker, resolver: TargetResolver, files: readonly ts.SourceFile[]) {
    this.checker = checker;
    this.resolver = resolver;
    this.files = files;
  }

  /**
   * 수신자 식과 메서드 이름의 후보 대상 노드 id다.
   *
   * @param receiver 수신자 식
   * @param method 메서드 이름
   * @returns 노드 id(정렬)
   */
  targetsFor(receiver: ts.Expression, method: string): readonly string[] {
    const type = this.receiverType(receiver);
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return [];
    let byName = this.memo.get(type);
    if (byName === undefined) {
      byName = new Map();
      this.memo.set(type, byName);
    }
    let targets = byName.get(method);
    if (targets === undefined) {
      targets = this.findTargets(type, method);
      byName.set(method, targets);
    }
    return targets;
  }

  /**
   * 수신자의 타입이다. 타입 매개변수면 제약 타입이다.
   *
   * @param receiver 수신자 식
   * @returns 타입
   */
  private receiverType(receiver: ts.Expression): ts.Type {
    const type = this.checker.getTypeAtLocation(receiver);
    return (type.flags & ts.TypeFlags.TypeParameter) !== 0 ? this.checker.getBaseConstraintOfType(type) ?? type : type;
  }

  /**
   * 후보 대상을 찾는다.
   *
   * @param type 수신자 타입
   * @param method 메서드 이름
   * @returns 노드 id(정렬)
   */
  private findTargets(type: ts.Type, method: string): readonly string[] {
    const index = this.candidateIndex();
    const nominal = nominalSymbols(type);
    const ids = new Set<string>();
    for (const declaration of index.classes) {
      const instance = instanceTypeOf(this.checker, declaration);
      if (!this.implementsNominally(declaration, nominal) && !this.checker.isTypeAssignableTo(instance, type)) continue;
      this.addMember(ids, instance, method);
    }
    for (const literal of index.literals.get(method) ?? []) {
      const literalType = this.checker.getTypeAtLocation(literal);
      if (this.checker.isTypeAssignableTo(literalType, type)) this.addMember(ids, literalType, method);
    }
    return [...ids].sort(compareStrings);
  }

  /**
   * 값 타입의 메서드가 본문 있는 프로젝트 선언이면 그 id를 더한다.
   *
   * @param ids 모으는 집합(갱신)
   * @param valueType 값 타입
   * @param method 메서드 이름
   */
  private addMember(ids: Set<string>, valueType: ts.Type, method: string): void {
    const resolution = this.resolver.resolveSymbol(this.checker.getPropertyOfType(valueType, method), 0);
    if (resolution.kind === 'nodes') resolution.ids.forEach((id) => ids.add(id));
  }

  /**
   * 클래스(기반 클래스 포함)가 명목으로 구현한 인터페이스가 수신자 타입의 심볼인지 본다.
   *
   * @param declaration 클래스
   * @param nominal 수신자 타입의 인터페이스 심볼
   * @returns 명목 구현이면 true
   */
  private implementsNominally(declaration: ts.ClassLikeDeclaration, nominal: ReadonlySet<ts.Symbol>): boolean {
    if (nominal.size === 0) return false;
    for (let current: ts.ClassLikeDeclaration | undefined = declaration; current !== undefined; current = this.baseClass(current)) {
      const implemented = current.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? [];
      for (const expression of implemented) {
        if (interfaceClosure(this.checker, this.checker.getTypeAtLocation(expression)).some((symbol) => nominal.has(symbol))) return true;
      }
    }
    return false;
  }

  /**
   * 클래스의 프로젝트 기반 클래스 선언이다.
   *
   * @param declaration 클래스
   * @returns 기반 클래스 또는 undefined
   */
  private baseClass(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
    const expression = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (expression === undefined) return undefined;
    const symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(symbol) : symbol;
    return target?.declarations?.find(ts.isClassLike);
  }

  /**
   * 노드 파일의 클래스와(멤버 이름별) 객체 리터럴을 한 번 모은다.
   *
   * @returns 색인
   */
  private candidateIndex(): CandidateIndex {
    if (this.index !== undefined) return this.index;
    const classes: ts.ClassLikeDeclaration[] = [];
    const literals = new Map<string, ts.ObjectLiteralExpression[]>();
    const visit = (node: ts.Node): void => {
      if (isTypeOnly(node)) return;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes.push(node);
      else if (ts.isObjectLiteralExpression(node)) indexLiteral(literals, node);
      ts.forEachChild(node, visit);
    };
    this.files.forEach((sourceFile) => ts.forEachChild(sourceFile, visit));
    this.index = { classes, literals };
    return this.index;
  }
}

/**
 * 객체 리터럴을 멤버 이름별 색인에 넣는다.
 *
 * @param literals 이름 → 리터럴(갱신)
 * @param literal 객체 리터럴
 */
function indexLiteral(literals: Map<string, ts.ObjectLiteralExpression[]>, literal: ts.ObjectLiteralExpression): void {
  for (const property of literal.properties) {
    const name = property.name === undefined ? undefined : memberName(property.name);
    if (name === undefined) continue;
    const list = literals.get(name);
    if (list === undefined) literals.set(name, [literal]);
    else if (list.at(-1) !== literal) list.push(literal);
  }
}

/**
 * 수신자 타입(union이면 각 구성원)의 인터페이스 심볼이다.
 *
 * @param type 수신자 타입
 * @returns 인터페이스 심볼 집합
 */
function nominalSymbols(type: ts.Type): Set<ts.Symbol> {
  const members = type.isUnion() || type.isIntersection() ? type.types : [type];
  const result = new Set<ts.Symbol>();
  for (const member of members) {
    const symbol = member.getSymbol() ?? member.aliasSymbol;
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Interface) !== 0) result.add(symbol);
  }
  return result;
}

/**
 * 인터페이스 타입과 그것이 확장한 인터페이스들의 심볼이다.
 *
 * @param checker TypeChecker
 * @param type 구현한 인터페이스 타입
 * @returns 심볼 목록
 */
function interfaceClosure(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  const result: ts.Symbol[] = [];
  const queue: ts.Type[] = [type];
  for (let index = 0; index < queue.length && index < 64; index++) {
    const current = queue[index]!;
    const symbol = current.getSymbol();
    if (symbol === undefined || result.includes(symbol)) continue;
    result.push(symbol);
    const target = (current as ts.TypeReference).target ?? current;
    if (target.isClassOrInterface()) queue.push(...checker.getBaseTypes(target));
  }
  return result;
}
