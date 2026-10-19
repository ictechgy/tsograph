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
 *
 * 비용: 대입 검사를 (수신자 타입, 메서드)마다 모든 클래스에 하면 타입 × 메서드 × 클래스로 커지고, TypeScript가
 * 질의마다 남기는 관계 캐시(Map)가 2^24 항목에서 넘쳐 그래프 생성이 실패한다. 메모만으로는 검사 쌍 수가 줄지 않으므로
 * 검사할 클래스 자체를 줄인다. 클래스마다 인스턴스 타입·속성 이름(상속·mixin·프로젝트 밖 기반 클래스 멤버 포함)·명목
 * 구현 인터페이스를 색인할 때 한 번만 구한다. 메서드 이름을 인스턴스 속성으로 갖지 않는 클래스는 대상 id를 낼 수
 * 없으므로 검사하지 않는다. 수신자가 일반 객체 타입이면 대입에 필요한 필수 속성 이름을 모두 가진 클래스만 구조 대입
 * 검사로 보낸다. 대입 결과는 메서드와 무관하므로 (수신자 타입, 클래스)마다 한 번만 묻는다.
 */

import ts from 'typescript';

import { compareStrings } from '../exchange/sorted-json.ts';
import { memberName } from '../schema/scope-builder.ts';
import { appendTo } from './flow-index.ts';
import { isTypeOnly } from './node-collector.ts';
import type { TargetResolver } from './target-resolver.ts';
import { instanceTypeOf } from './value-flow.ts';

/**
 * TypeScript가 대입 판정에서 원본에 없는 속성을 찾아보는 전역 인터페이스다(`getPropertyOfType`의 Object·Function 보강).
 * 이 인터페이스의 속성 이름은 어떤 클래스든 가진 것으로 보고 필수 이름 사전 필터에서 뺀다.
 */
const AUGMENTING_GLOBALS = ['Object', 'Function', 'CallableFunction', 'NewableFunction'] as const;

/** 후보 색인의 클래스 항목이다. 수신자 타입·메서드와 무관한 값을 색인할 때 한 번만 계산한다. */
interface ClassEntry {
  /** 인스턴스 타입(클래스 식이면 생성 시그니처의 반환 타입) */
  readonly instance: ts.Type;
  /** 인스턴스 타입의 속성 escaped 이름(`getPropertiesOfType`: 상속·mixin·프로젝트 밖 기반 클래스 멤버 포함) */
  readonly names: ReadonlySet<ts.__String>;
}

/** 후보 색인이다. */
interface CandidateIndex {
  /** 속성 escaped 이름 → 그 이름을 인스턴스 속성으로 가진 클래스(색인 순서) */
  readonly classesByName: ReadonlyMap<ts.__String, readonly ClassEntry[]>;
  /** 인터페이스 심볼 → 그 인터페이스를 명목으로 구현한 클래스 */
  readonly classesByInterface: ReadonlyMap<ts.Symbol, readonly ClassEntry[]>;
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
  /** 수신자 타입 → 클래스 → 대입 가능 여부(메서드와 무관하다) */
  private readonly assignable = new Map<ts.Type, Map<ClassEntry, boolean>>();
  /** 어떤 클래스든 전역 보강으로 가진 것으로 보는 속성 이름(처음 쓸 때 만든다) */
  private augmented: ReadonlySet<ts.__String> | undefined;

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
    const ids = new Set<string>();
    for (const entry of this.classCandidates(type, ts.escapeLeadingUnderscores(method))) this.addMember(ids, entry.instance, method);
    for (const literal of index.literals.get(method) ?? []) {
      const literalType = this.checker.getTypeAtLocation(literal);
      if (this.checker.isTypeAssignableTo(literalType, type)) this.addMember(ids, literalType, method);
    }
    return [...ids].sort(compareStrings);
  }

  /**
   * 메서드를 인스턴스 속성으로 갖고 수신자 타입을 명목으로 구현하거나 그 타입에 구조로 대입되는 클래스다.
   * 명목 구현은 멤버가 모자라도 후보이므로 필수 이름 사전 필터를 거치지 않는다.
   *
   * @param type 수신자 타입
   * @param method 메서드 escaped 이름
   * @returns 후보 클래스
   */
  private classCandidates(type: ts.Type, method: ts.__String): ReadonlySet<ClassEntry> {
    const index = this.candidateIndex();
    const result = new Set<ClassEntry>();
    for (const symbol of nominalSymbols(type)) {
      for (const entry of index.classesByInterface.get(symbol) ?? []) if (entry.names.has(method)) result.add(entry);
    }
    for (const entry of this.structuralCandidates(type, method)) {
      if (!result.has(entry) && this.isAssignable(entry, type)) result.add(entry);
    }
    return result;
  }

  /**
   * 구조 대입을 검사할 클래스다: 메서드 이름과(일반 객체 수신자면) 필수 속성 이름을 모두 인스턴스 속성으로 가진
   * 클래스. 그 이름들 중 가진 클래스가 가장 적은 이름의 목록만 훑는다.
   *
   * @param type 수신자 타입
   * @param method 메서드 escaped 이름
   * @returns 검사할 클래스(색인 순서)
   */
  private structuralCandidates(type: ts.Type, method: ts.__String): readonly ClassEntry[] {
    const index = this.candidateIndex();
    const names = [method, ...this.requiredNames(type)];
    let shortest = index.classesByName.get(method) ?? [];
    for (const name of names) {
      const classes = index.classesByName.get(name) ?? [];
      if (classes.length < shortest.length) shortest = classes;
    }
    return shortest.filter((entry) => names.every((name) => entry.names.has(name)));
  }

  /**
   * 클래스 인스턴스가 대입되려면 반드시 가져야 하는 수신자 타입의 속성 이름이다. TypeScript는 대입할 때 선택이 아닌
   * 대상 속성마다 같은 이름의 원본 속성(없으면 전역 Object·Function 멤버)을 요구하므로, 이 이름이 하나라도 없는
   * 클래스는 대입되지 않는다. 일반 객체 타입이 아니면(union·intersection·타입 매개변수·mapped·시그니처·인덱스)
   * 관계 규칙이 속성 검사만으로 정해지지 않으므로 좁히지 않는다(빈 목록).
   *
   * @param type 수신자 타입
   * @returns 필수 속성 escaped 이름
   */
  private requiredNames(type: ts.Type): readonly ts.__String[] {
    if (!isPlainObjectType(this.checker, type)) return [];
    this.augmented ??= globalMemberNames(this.checker);
    const augmented = this.augmented;
    return this.checker.getPropertiesOfType(type)
      .filter((property) => (property.flags & ts.SymbolFlags.Optional) === 0 && !augmented.has(property.escapedName))
      .map((property) => property.escapedName);
  }

  /**
   * 클래스 인스턴스가 수신자 타입에 대입되는지 본다. 메서드와 무관하므로 (수신자 타입, 클래스)마다 한 번만 묻는다.
   *
   * @param entry 클래스 항목
   * @param type 수신자 타입
   * @returns 대입되면 true
   */
  private isAssignable(entry: ClassEntry, type: ts.Type): boolean {
    let byClass = this.assignable.get(type);
    if (byClass === undefined) {
      byClass = new Map();
      this.assignable.set(type, byClass);
    }
    let result = byClass.get(entry);
    if (result === undefined) {
      result = this.checker.isTypeAssignableTo(entry.instance, type);
      byClass.set(entry, result);
    }
    return result;
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
   * 클래스와 그 기반 클래스들이 `implements`로 명목 구현한 인터페이스(와 그것이 확장한 인터페이스)의 심볼이다.
   * 기반 클래스가 순환해도(타입 오류) 끝나도록 지나온 클래스를 기억한다.
   *
   * @param declaration 클래스
   * @returns 인터페이스 심볼 집합
   */
  private implementedInterfaces(declaration: ts.ClassLikeDeclaration): Set<ts.Symbol> {
    const result = new Set<ts.Symbol>();
    const seen = new Set<ts.ClassLikeDeclaration>();
    for (let current: ts.ClassLikeDeclaration | undefined = declaration; current !== undefined && !seen.has(current); current = this.baseClass(current)) {
      seen.add(current);
      const implemented = current.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? [];
      for (const expression of implemented) {
        interfaceClosure(this.checker, this.checker.getTypeAtLocation(expression)).forEach((symbol) => result.add(symbol));
      }
    }
    return result;
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
   * 노드 파일의 클래스를 (속성 이름별·명목 구현 인터페이스별로) 색인하고 객체 리터럴을 멤버 이름별로 한 번 모은다.
   *
   * @returns 색인
   */
  private candidateIndex(): CandidateIndex {
    if (this.index !== undefined) return this.index;
    const classesByName = new Map<ts.__String, ClassEntry[]>();
    const classesByInterface = new Map<ts.Symbol, ClassEntry[]>();
    const literals = new Map<string, ts.ObjectLiteralExpression[]>();
    const addClass = (declaration: ts.ClassLikeDeclaration): void => {
      const instance = instanceTypeOf(this.checker, declaration);
      const entry: ClassEntry = { instance, names: new Set(this.checker.getPropertiesOfType(instance).map((property) => property.escapedName)) };
      entry.names.forEach((name) => appendTo(classesByName, name, entry));
      this.implementedInterfaces(declaration).forEach((symbol) => appendTo(classesByInterface, symbol, entry));
    };
    const visit = (node: ts.Node): void => {
      if (isTypeOnly(node)) return;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) addClass(node);
      else if (ts.isObjectLiteralExpression(node)) indexLiteral(literals, node);
      ts.forEachChild(node, visit);
    };
    this.files.forEach((sourceFile) => ts.forEachChild(sourceFile, visit));
    this.index = { classesByName, classesByInterface, literals };
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

/**
 * 필수 속성 이름으로 후보를 좁혀도 되는 일반 객체 타입인지 본다: union·intersection·타입 매개변수가 아니고 mapped
 * 타입도 아니며 호출·생성·인덱스 시그니처가 없는 객체 타입. 이때 TypeScript의 대입은 같은 타입, 같은 제네릭 선언의
 * 인스턴스(속성 이름이 같다), 또는 속성별 검사로만 성립한다.
 *
 * @param checker TypeChecker
 * @param type 수신자 타입
 * @returns 일반 객체 타입이면 true
 */
function isPlainObjectType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0
    && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) === 0
    && checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0
    && checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length === 0
    && checker.getIndexInfosOfType(type).length === 0;
}

/**
 * 대입 판정이 원본 속성을 보강하는 전역 인터페이스(`AUGMENTING_GLOBALS`)의 속성 이름이다. 프로그램에 그 전역이
 * 없으면(`noLib` 등) 보강도 없으므로 건너뛴다. 실제 보강보다 넓게 잡아도 사전 필터가 약해질 뿐 결과는 같다.
 *
 * @param checker TypeChecker
 * @returns 속성 escaped 이름 집합
 */
function globalMemberNames(checker: ts.TypeChecker): Set<ts.__String> {
  const names = new Set<ts.__String>();
  for (const name of AUGMENTING_GLOBALS) {
    const symbol = checker.resolveName(name, undefined, ts.SymbolFlags.Type, false);
    if (symbol === undefined) continue;
    for (const property of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) names.add(property.escapedName);
  }
  return names;
}
