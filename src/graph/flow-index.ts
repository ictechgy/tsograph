/**
 * bound 디스패치의 값 흐름 분석(`value-flow.ts`)이 쓰는 전체 프로그램 색인이다.
 *
 * 노드 파일을 한 번 훑어 다음을 모은다.
 * - 함수·클래스·변수 심볼의 값 참조 위치(별칭을 푼 심볼 기준). 호출 위치를 찾고, 호출 대상이 아닌 자리에
 *   쓰인(값으로 새어 나간) 함수를 가려내는 데 쓴다. 값 자리의 식별자, 모든 속성 접근 이름(`ns.f`, 파일 안
 *   `namespace App`의 `App.Repo`, `globalThis.f`), 문자열 리터럴 원소 접근(`App["load"]`)을 checker로 풀어 모은다.
 * - 식별자 대입(`x = e`, `x ??= e` …)과 속성 대입(`a.b = e`, `a["b"] = e`)을 대상별로. 구조 분해 대입·
 *   증감·복합 대입·속성 삭제처럼 값을 모르는 쓰기는 값 없이 기록한다.
 * - `new this()`를 쓰는 클래스, `Object.assign`·`Object.defineProperty(ies)`·`Reflect.set`·
 *   `Reflect.defineProperty`·`Reflect.deleteProperty`·`Object/Reflect.setPrototypeOf`의 첫 인자(반사적 쓰기 대상),
 *   `export { x }`·`export default x`로 내보낸 심볼,
 *   동적 `import()`나 값으로 쓰인 네임스페이스 import 때문에 멤버를 추적할 수 없는 모듈, 파일 패턴 로더
 *   (`import.meta.glob`·`require.context`)나 문자열이 아닌 지정자처럼 어느 모듈이든 열 수 있는 호출.
 * - legacy accessor mutation(`__defineGetter__`·`__defineSetter__`)은 receiver/effect를 추측하지 않고 opaque 상태로 남긴다.
 *
 * 계산된 키 쓰기·삭제는 이름을 알 수 없으므로 수신자 전체를 반사적 쓰기 대상으로 연다. 구조화한 mutation
 * 기록은 이 legacy 색인과 함께 보존되며, 프로토타입 조작도 보수적으로 반사적 쓰기 대상으로 연다.
 */

import ts from 'typescript';

import { isTypeOnly, skipWrappers } from './node-collector.ts';
import { collectEffectPart, reconcileEffectInventory, type EffectBuildBudget, type EffectInventory, type EffectManifest, type EffectPart } from './effect-inventory.ts';

/** 값을 모르는 쓰기를 나타내는 표식이다. */
export const UNKNOWN_WRITE = undefined;

/** 속성 쓰기 하나다. */
export interface PropertyWrite {
  /** 대입 대상 속성 접근 식 */
  readonly target: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  /** 쓴 값, 모르면 undefined */
  readonly value: ts.Expression | undefined;
}

/** mutation이 나타내는 문법·반사 연산이다. `unknown`은 식의 의미를 좁히지 못한 경우다. */
export type MutationOperation =
  | 'assignment'
  | 'update'
  | 'delete'
  | 'object.assign'
  | 'object.defineProperty'
  | 'object.defineProperties'
  | 'reflect.set'
  | 'reflect.defineProperty'
  | 'reflect.deleteProperty'
  | 'object.setPrototypeOf'
  | 'reflect.setPrototypeOf'
  | 'proto'
  | 'unknown';

/** mutation이 바꾸는 효과의 범주다. */
export type MutationEffect = 'binding' | 'property' | 'prototype' | 'unknown';

/**
 * operation 표기의 확인 정도다. `known`은 AST 연산 형태를 알아본다는 뜻일 뿐 receiver provenance나 own-data effect를
 * 증명하지 않으며, reflective built-in은 intrinsic 여부를 확인할 수 없어 보수적으로 unknown이다.
 */
export type MutationConfidence = 'known' | 'unknown';

/** 한 mutation의 원래 AST와 정적으로 관찰한 인자를 함께 보존한 immutable 기록이다. */
export interface MutationRecord {
  /** 직접 대입·호출의 연산 종류 */
  readonly operation: MutationOperation;
  /** 대입·삭제·프로토타입 변경의 syntactic effect 범주. receiver의 own-data 의미를 증명하지 않는다. */
  readonly effect: MutationEffect;
  /** 직접 속성·반사 호출이 쓰는 receiver. 식별자 대입에서는 식별자 자체다. */
  readonly target: ts.Expression;
  /** 관찰한 key 식. key가 없는 연산·알 수 없는 연산이면 undefined다. */
  readonly key: ts.Expression | undefined;
  /** key를 정적으로 문자열로 읽을 수 있을 때의 값 */
  readonly staticKey: string | undefined;
  /** 직접 대입·Reflect.set의 값. 값을 알 수 없으면 undefined다. */
  readonly value: ts.Expression | undefined;
  /** Object.assign의 첫 source 인자 */
  readonly source: ts.Expression | undefined;
  /** Object.assign의 모든 source 인자 */
  readonly sources: readonly ts.Expression[];
  /** defineProperty/defineProperties의 descriptor 인자 */
  readonly descriptor: ts.Expression | undefined;
  /** setPrototypeOf 또는 __proto__ 쓰기의 새 prototype 식 */
  readonly prototype: ts.Expression | undefined;
  /** 반사 호출의 원래 인자들. 알 수 없는 연산도 인자 순서를 잃지 않는다. */
  readonly args: readonly ts.Expression[];
  /** mutation을 만든 원래 대입·단항·호출 AST */
  readonly site: ts.Node;
  /** operation 표기의 confidence. known이어도 receiver provenance나 own-data 의미를 보장하지 않는다. */
  readonly confidence: MutationConfidence;
}

/** 모은 색인이다. */
export interface FlowIndex {
  /** 파일별 실행 관찰이다. 이것만으로 완전성이나 안전을 주장하지 않는다. */
  readonly effectParts: readonly EffectPart[];
  /** 독립 기대 매니페스트와 대조한 결과다. 매니페스트 없는 legacy 병합은 인증되지 않는다. */
  readonly effectInventory: EffectInventory | undefined;
  /** 별칭을 푼 함수·클래스·변수 심볼 → 값 참조 토큰(식별자, 원소 접근의 문자열 리터럴). `referenceSite`로 식을 얻는다. */
  readonly references: ReadonlyMap<ts.Symbol, readonly ts.Node[]>;
  /** 별칭을 푼 변수·매개변수 심볼 → 대입한 값(모르면 undefined) */
  readonly identifierWrites: ReadonlyMap<ts.Symbol, readonly (ts.Expression | undefined)[]>;
  /** 속성 이름 → 쓰기 */
  readonly propertyWrites: ReadonlyMap<string, readonly PropertyWrite[]>;
  /** `new this(...)`·`new this.constructor(...)`를 담은 클래스 */
  readonly newThisClasses: ReadonlySet<ts.ClassLikeDeclaration>;
  /** 반사적 쓰기 대상 식 */
  readonly reflectiveTargets: readonly ts.Expression[];
  /** 직접·반사·프로토타입 mutation의 구조화한 근거 */
  readonly mutations: readonly MutationRecord[];
  /** bounded alias 추적이나 call/apply/bind escape로 mutation 관찰이 불완전해진 경우다. */
  readonly hasOpaqueMutation: boolean;
  /** `export { x }`·`export default x`로 내보낸(별칭을 푼) 심볼 */
  readonly exportedSymbols: ReadonlySet<ts.Symbol>;
  /** 멤버 참조를 다 볼 수 없는 모듈·네임스페이스 심볼(동적 import 대상, 값으로 쓰이거나 계산된 키로 읽힌 네임스페이스) */
  readonly openModules: ReadonlySet<ts.Symbol>;
  /** 지정자가 문자열이 아닌 동적 import·require가 있으면 true(어느 모듈이든 열릴 수 있다) */
  readonly hasOpaqueImport: boolean;
  /** 클래스 선언 → 프로젝트 안 직접 하위 클래스 */
  readonly subclasses: ReadonlyMap<ts.ClassLikeDeclaration, readonly ts.ClassLikeDeclaration[]>;
  /**
   * 멤버 이름 → 호출 대상이 아닌 자리에서 그 이름을 읽는 위치(`h.run.bind(x)`, `const f = h.run`,
   * `const { run } = h`, `({ run } = h)`). 메서드를 떼어 내 다른 `this`로 부를 수 있는지 판정하는 데 쓴다.
   */
  readonly memberReads: ReadonlyMap<string, readonly ts.Node[]>;
  /** 별칭을 푼 심볼 → 그것을 다른 이름으로 들여온 import·export 별칭의 지역 이름(완전성 검사용) */
  readonly aliasNames: ReadonlyMap<ts.Symbol, readonly string[]>;
  /** 토큰 텍스트 → 모든 식별자·private 식별자·문자열 리터럴(참조 0개 완전성 검사용) */
  readonly tokenOccurrences: ReadonlyMap<string, readonly ts.Node[]>;
  /** 색인한 파일 */
  readonly files: readonly ts.SourceFile[];
}

/** 조건식 지정자를 따라가는 최대 깊이다(넘으면 어느 모듈이든 열릴 수 있다고 본다). */
const MAX_SPECIFIER_DEPTH = 64;

/** 반사 mutation alias를 직접 확정하는 최대 깊이다. */
const MAX_REFLECTIVE_ALIAS_DEPTH = 4;

/** 깊이 예산을 넘은 alias에 mutation seed가 있는지 확인하는 bounded lookahead다. */
const MAX_REFLECTIVE_SEED_DEPTH = 64;

/** 참조를 모으는 심볼 종류다. */
const TRACKED_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable;

/** 값을 그대로 옮기는 대입 연산자다. */
const VALUE_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** 반사 호출에서 owner의 역할을 아는지 나타내는 내부 종류다. */
type ReflectiveOwner = 'Object' | 'Reflect';

/** 반사 호출의 syntax 분류 결과다. */
interface ReflectiveCall {
  readonly owner: ReflectiveOwner | undefined;
  readonly method: string | undefined;
  readonly operation: MutationOperation;
  readonly effect: MutationEffect;
  readonly confidence: MutationConfidence;
}

/** bounded alias 추적 결과다. seed를 넘은 미완료 추적은 부재로 취급하지 않는다. */
interface ReflectiveAliasResult {
  readonly call: ReflectiveCall | undefined;
  readonly opaque: boolean;
}

/** 색인을 채우는 가변 저장소다. */
interface MutableIndex {
  effectParts: EffectPart[];
  effectInventory: EffectInventory | undefined;
  references: Map<ts.Symbol, ts.Node[]>;
  identifierWrites: Map<ts.Symbol, (ts.Expression | undefined)[]>;
  propertyWrites: Map<string, PropertyWrite[]>;
  newThisClasses: Set<ts.ClassLikeDeclaration>;
  reflectiveTargets: ts.Expression[];
  mutations: MutationRecord[];
  hasOpaqueMutation: boolean;
  exportedSymbols: Set<ts.Symbol>;
  openModules: Set<ts.Symbol>;
  hasOpaqueImport: boolean;
  subclasses: Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration[]>;
  memberReads: Map<string, ts.Node[]>;
  aliasNames: Map<ts.Symbol, string[]>;
  tokenOccurrences: Map<string, ts.Node[]>;
  files: ts.SourceFile[];
}

/** 모듈 지정자를 모듈 심볼로 푸는 함수다(인자 자리가 아닌 문자열 지정자용). */
export type ModuleResolver = (specifier: string, from: ts.SourceFile) => ts.Symbol | undefined;

/**
 * 빈 색인을 만든다.
 *
 * @returns 빈 가변 색인
 */
function emptyIndex(): MutableIndex {
  return {
    effectParts: [], effectInventory: undefined,
    references: new Map(), identifierWrites: new Map(), propertyWrites: new Map(), newThisClasses: new Set(),
    reflectiveTargets: [], mutations: [], hasOpaqueMutation: false, exportedSymbols: new Set(), openModules: new Set(), hasOpaqueImport: false, subclasses: new Map(),
    memberReads: new Map(), aliasNames: new Map(), tokenOccurrences: new Map(), files: [],
  };
}

/**
 * 파일 하나의 색인을 만든다. 분석 범위(테스트 소스 포함·제외)마다 다시 훑지 않도록 파일별로 만들어 합친다.
 *
 * @param checker TypeChecker
 * @param sourceFile 노드 파일
 * @param resolveModule 조건식 안 문자열 지정자(`import(a ? "./x" : "./y")`)를 모듈 심볼로 푸는 함수
 * @returns 파일 색인
 */
export function buildFileIndex(checker: ts.TypeChecker, sourceFile: ts.SourceFile, resolveModule: ModuleResolver, effectBudget?: EffectBuildBudget): FlowIndex {
  const index = emptyIndex();
  new IndexCollector(checker, index, resolveModule).visitFile(sourceFile);
  index.files.push(sourceFile);
  index.effectParts.push(collectEffectPart(sourceFile, resolveModule, undefined, effectBudget, checker));
  return index;
}

/**
 * 파일 색인들을 주어진 순서로 합친다(목록은 이어 붙이고 집합은 합친다).
 *
 * @param parts 파일 색인
 * @returns 합친 색인
 */
export function mergeFlowIndexes(parts: Iterable<FlowIndex>, manifest?: EffectManifest): FlowIndex {
  const index = emptyIndex();
  let validParts = true;
  for (const part of parts) {
    validParts &&= part.files.length === 1 && part.effectParts.length === 1 && part.effectParts[0]?.source === part.files[0];
    index.effectParts.push(...part.effectParts);
    mergeLists(index.references, part.references);
    mergeLists(index.identifierWrites, part.identifierWrites);
    mergeLists(index.propertyWrites, part.propertyWrites);
    mergeLists(index.subclasses, part.subclasses);
    mergeLists(index.memberReads, part.memberReads);
    mergeLists(index.aliasNames, part.aliasNames);
    mergeLists(index.tokenOccurrences, part.tokenOccurrences);
    index.files.push(...part.files);
    part.newThisClasses.forEach((value) => index.newThisClasses.add(value));
    part.exportedSymbols.forEach((value) => index.exportedSymbols.add(value));
    part.openModules.forEach((value) => index.openModules.add(value));
    index.reflectiveTargets.push(...part.reflectiveTargets);
    index.mutations.push(...part.mutations);
    index.hasOpaqueMutation ||= part.hasOpaqueMutation;
    index.hasOpaqueImport ||= part.hasOpaqueImport;
  }
  if (manifest) {
    const inventory = reconcileEffectInventory(manifest, index.effectParts, manifest.view, {
      references: index.references,
      aliasNames: index.aliasNames,
      tokenOccurrences: index.tokenOccurrences,
    });
    const aliasesSafe = !index.hasOpaqueImport && !index.hasOpaqueMutation && index.openModules.size === 0;
    index.effectInventory = validParts ? inventory : {
      ...inventory, enumeration: 'incomplete', referenceAliases: 'incomplete', initialization: 'incomplete', ambientSafety: 'unknown',
      reasons: [...inventory.reasons, 'index-part-mismatch'],
    };
    if (index.effectInventory !== undefined && !aliasesSafe) index.effectInventory = {
      ...index.effectInventory,
      referenceAliases: 'incomplete', initialization: 'incomplete', ambientSafety: 'unknown',
      reasons: [...new Set([...index.effectInventory.reasons, 'reference-alias-open'])].sort(),
    };
  }
  return index;
}

/**
 * 목록 맵을 다른 목록 맵에 이어 붙인다.
 *
 * @param target 모으는 맵(갱신)
 * @param source 더할 맵
 */
function mergeLists<K, V>(target: Map<K, V[]>, source: ReadonlyMap<K, readonly V[]>): void {
  for (const [key, values] of source) {
    const list = target.get(key);
    if (list === undefined) target.set(key, [...values]);
    else list.push(...values);
  }
}

/** 색인 수집기다. */
class IndexCollector {
  private readonly checker: ts.TypeChecker;
  private readonly index: MutableIndex;
  private readonly resolveModule: ModuleResolver;

  /**
   * @param checker TypeChecker
   * @param index 채울 색인
   * @param resolveModule 문자열 지정자 → 모듈 심볼
   */
  constructor(checker: ts.TypeChecker, index: MutableIndex, resolveModule: ModuleResolver) {
    this.checker = checker;
    this.index = index;
    this.resolveModule = resolveModule;
  }

  /**
   * 파일 하나를 훑는다. 타입 전용 노드는 건너뛴다.
   *
   * @param sourceFile 파일
   */
  visitFile(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node, skipAnalysis = false): void => {
      this.visitToken(node);
      const skipChildrenAnalysis = skipAnalysis || (isTypeOnly(node) && !ts.isImportDeclaration(node));
      if (!skipChildrenAnalysis) this.visitNode(node);
      ts.forEachChild(node, (child) => visit(child, skipChildrenAnalysis));
    };
    ts.forEachChild(sourceFile, visit);
  }

  /** 완전성 검사가 쓸 이름 토큰을 타입 자리까지 포함해 한 번 모은다. */
  private visitToken(node: ts.Node): void {
    const text = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (text !== undefined) appendTo(this.index.tokenOccurrences, text, node);
  }

  /**
   * 노드 하나를 분류한다.
   *
   * @param node 노드
   */
  private visitNode(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) this.visitMemberRead(node);
    else if (ts.isBindingElement(node)) this.visitBindingRead(node);
    if (ts.isElementAccessExpression(node)) this.visitElementAccess(node);
    if (ts.isIdentifier(node)) this.visitIdentifier(node);
    else if (ts.isShorthandPropertyAssignment(node)) this.addReference(node.name, this.checker.getShorthandAssignmentValueSymbol(node));
    else if (ts.isBinaryExpression(node)) this.visitBinary(node);
    else if (ts.isDeleteExpression(node)) this.recordWrite(skipWrappers(node.expression), UNKNOWN_WRITE, 'delete', node);
    else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) this.visitUpdate(node);
    else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) this.visitLoopTarget(node.initializer);
    else if (ts.isNewExpression(node)) this.visitNew(node);
    else if (ts.isCallExpression(node)) this.visitCall(node);
    else if (ts.isExportSpecifier(node)) this.visitExportSpecifier(node);
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isExportSpecifier(node)
      || ts.isImportEqualsDeclaration(node)) {
      this.visitAliasName(node);
    }
    else if (ts.isExportAssignment(node)) this.addExported(this.expressionSymbol(node.expression));
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) this.visitClass(node);
  }

  /**
   * 호출 대상·대입 대상이 아닌 속성 읽기를 멤버 이름별로 기록한다.
   *
   * @param access 속성·원소 접근
   */
  private visitMemberRead(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    const name = ts.isPropertyAccessExpression(access) ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
    const outer = climbWrappers(access);
    const parent = outer.parent;
    if (this.isReflectiveMutationValueRead(access, parent)) this.index.hasOpaqueMutation = true;
    if (name === undefined) return;
    // `h.run(...)`·`h.run\`…\``은 `this`가 h인 호출이다. `new h.run()`·데코레이터·그 밖의 읽기는 떼어 낸다.
    if (ts.isCallExpression(parent) && parent.expression === outer) return;
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === outer) return;
    if (ts.isBinaryExpression(parent) && parent.left === outer && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;
    appendTo(this.index.memberReads, name, access);
  }

  /** mutation built-in member를 값으로 읽으면 alias 사용 범위를 완전 증명할 수 없으므로 opaque로 닫는다. */
  private isReflectiveMutationValueRead(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    parent: ts.Node,
  ): boolean {
    if (ts.isCallExpression(parent) && parent.expression === access) return false;
    const elementKey = ts.isElementAccessExpression(access) ? skipWrappers(access.argumentExpression) : undefined;
    const key = ts.isPropertyAccessExpression(access) ? access.name.text
      : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
    if (isLegacyAccessorMutationName(key)) return true;
    const owner = access.expression;
    const ownerInfo = reflectiveOwner(owner) ?? reflectiveAliasOwner(this.checker, owner);
    if (ownerInfo === undefined) return false;
    return key === undefined || reflectiveOperation(ownerInfo.owner, key) !== undefined;
  }

  /**
   * 객체 구조 분해(`const { run } = h`)는 멤버를 떼어 내 읽는다.
   *
   * @param element 바인딩 요소
   */
  private visitBindingRead(element: ts.BindingElement): void {
    if (!ts.isObjectBindingPattern(element.parent)) return;
    const name = element.propertyName ?? element.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) appendTo(this.index.memberReads, name.text, element);
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (isLegacyAccessorMutationName(key)) this.index.hasOpaqueMutation = true;
    const declaration = ts.isVariableDeclaration(element.parent.parent) ? element.parent.parent : undefined;
    const initializer = declaration?.initializer;
    if (initializer === undefined) return;
    const owner = reflectiveOwner(skipWrappers(initializer)) ?? reflectiveAliasOwner(this.checker, skipWrappers(initializer));
    if (owner === undefined) return;
    if (key === undefined || reflectiveOperation(owner.owner, key) !== undefined) this.index.hasOpaqueMutation = true;
  }

  /**
   * 값 참조 식별자를 기록한다. 속성 접근 이름은 왼쪽이 무엇이든 checker로 풀어 기록한다(파일 안 `namespace`,
   * `globalThis`, 중첩 네임스페이스를 빠뜨리지 않기 위해서다 — 추적하지 않는 심볼 종류는 `addReference`가 거른다).
   * 모듈·네임스페이스가 `ns.x`·`ns["x"]` 밖에서 값으로 쓰이면 그 멤버 참조를 다 볼 수 없어 연다.
   *
   * @param identifier 식별자
   */
  private visitIdentifier(identifier: ts.Identifier): void {
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
      const member = this.checker.getSymbolAtLocation(identifier);
      this.addReference(identifier, member);
      // `App.Repo`·`helpers.sub`처럼 속성 사슬 끝이 모듈·네임스페이스여도 값으로 쓰이면 연다.
      this.noteNamespaceUse(parent, member);
      return;
    }
    if (!isReferencePosition(identifier)) return;
    const symbol = this.checker.getSymbolAtLocation(identifier);
    this.noteNamespaceUse(identifier, symbol);
    this.addReference(identifier, symbol);
  }

  /**
   * 원소 접근: 문자열 리터럴 키(`App["load"]`)는 그 멤버의 참조로 기록한다. 계산된 키가 모듈·네임스페이스를
   * 읽으면(`App[key]`) 멤버를 다 볼 수 없어 연다(왼쪽 식별자는 `noteNamespaceUse`가 연다).
   *
   * @param access 원소 접근
   */
  private visitElementAccess(access: ts.ElementAccessExpression): void {
    const key = skipWrappers(access.argumentExpression);
    if (!ts.isStringLiteralLike(key)) return;
    const member = this.checker.getSymbolAtLocation(key);
    this.addReference(key, member);
    this.noteNamespaceUse(access, member);
  }

  /**
   * 모듈·값 네임스페이스로 풀리는 식(식별자, 속성 사슬 `App.Repo`, 문자열 키 원소 접근)이 `ns.x`·`ns["리터럴"]`의 왼쪽
   * 밖(인자·대입·구조 분해 초기값·전개·계산된 키 등)에서 쓰이면 그 모듈·네임스페이스를 연다.
   *
   * @param expression 네임스페이스를 가리킬 수 있는 식
   * @param symbol 그 식의 심볼
   */
  private noteNamespaceUse(expression: ts.Expression, symbol: ts.Symbol | undefined): void {
    const target = this.dealias(symbol);
    if (target === undefined || (target.flags & ts.SymbolFlags.ValueModule) === 0) return;
    const outer = climbWrappers(expression);
    const parent = outer.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) return;
    if (ts.isElementAccessExpression(parent) && parent.expression === outer && ts.isStringLiteralLike(skipWrappers(parent.argumentExpression))) return;
    this.index.openModules.add(target);
  }

  /**
   * 참조를 기록한다(별칭을 풀고, 추적하는 종류만).
   *
   * @param token 참조 토큰(식별자, 원소 접근의 문자열 리터럴)
   * @param symbol 심볼
   */
  private addReference(token: ts.Node, symbol: ts.Symbol | undefined): void {
    const target = this.dealias(symbol);
    if (target === undefined || (target.flags & TRACKED_FLAGS) === 0) return;
    appendTo(this.index.references, target, token);
  }

  /**
   * 대입식의 쓰기를 기록한다.
   *
   * @param binary 이항식
   */
  private visitBinary(binary: ts.BinaryExpression): void {
    const operator = binary.operatorToken.kind;
    if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) return;
    const value = VALUE_ASSIGNMENTS.has(operator) ? binary.right : UNKNOWN_WRITE;
    const left = skipWrappers(binary.left);
    if (operator === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))) {
      this.visitDestructuringTargets(left, binary);
    } else {
      this.recordWrite(left, value, 'assignment', binary);
    }
  }

  /**
   * 증감(`x++`, `--o.n`)은 값을 모르는 쓰기다.
   *
   * @param update 전위·후위 단항식
   */
  private visitUpdate(update: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): void {
    if (update.operator === ts.SyntaxKind.PlusPlusToken || update.operator === ts.SyntaxKind.MinusMinusToken) {
      this.recordWrite(skipWrappers(update.operand), UNKNOWN_WRITE, 'update', update);
    }
  }

  /**
   * 선언이 아닌 for-in/of 대상(`for (x of xs)`)은 값을 모르는 쓰기다.
   *
   * @param initializer 반복문의 대상
   */
  private visitLoopTarget(initializer: ts.ForInitializer): void {
    if (ts.isVariableDeclarationList(initializer)) return;
    const target = skipWrappers(initializer);
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) this.visitDestructuringTargets(target, initializer);
    else this.recordWrite(target, UNKNOWN_WRITE, 'assignment', initializer);
  }

  /**
   * 구조 분해 대입의 대상(식별자·속성 접근)을 값 모르는 쓰기로 기록한다.
   *
   * @param pattern 객체·배열 리터럴 패턴
   */
  private visitDestructuringTargets(pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, site: ts.Node = pattern): void {
    const elements: ts.Node[] = ts.isArrayLiteralExpression(pattern) ? [...pattern.elements] : [...pattern.properties];
    for (const element of elements) {
      if ((ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) && !ts.isComputedPropertyName(element.name)) {
        // `({ run } = h)`는 멤버를 떼어 내 읽는다.
        const name = ts.isIdentifier(element.name) || ts.isStringLiteral(element.name) ? element.name.text : undefined;
        if (name !== undefined) appendTo(this.index.memberReads, name, element);
      }
      let target: ts.Node | undefined = element;
      if (ts.isSpreadElement(element) || ts.isSpreadAssignment(element)) target = element.expression;
      else if (ts.isPropertyAssignment(element)) target = element.initializer;
      else if (ts.isShorthandPropertyAssignment(element)) target = element.name;
      if (target !== undefined && ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) target = target.left;
      if (target === undefined || !ts.isExpression(target)) continue;
      const inner = skipWrappers(target);
      if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) this.visitDestructuringTargets(inner, site);
      else this.recordWrite(inner, UNKNOWN_WRITE, 'assignment', site);
    }
  }

  /**
   * 쓰기 대상 하나를 기록한다: 식별자면 심볼별, 속성 접근이면 이름별.
   *
   * @param target 대상 식(래퍼를 벗긴)
   * @param value 쓴 값, 모르면 undefined
   */
  private recordWrite(target: ts.Expression, value: ts.Expression | undefined, operation: MutationOperation, site: ts.Node): void {
    this.recordDirectMutation(target, value, operation, site);
    if (ts.isIdentifier(target)) {
      const symbol = this.dealias(this.checker.getSymbolAtLocation(target));
      if (symbol !== undefined) appendTo(this.index.identifierWrites, symbol, value);
      return;
    }
    const key = ts.isElementAccessExpression(target) ? skipWrappers(target.argumentExpression) : undefined;
    const name = ts.isPropertyAccessExpression(target) ? target.name.text
      : key !== undefined && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
    if (name === undefined) {
      if (ts.isElementAccessExpression(target)) this.index.reflectiveTargets.push(target.expression);
      return;
    }
    appendTo(this.index.propertyWrites, name, { target: target as PropertyWrite['target'], value });
    // TS `namespace N { export let x }`의 `N.x = e`는 변수 쓰기다.
    const member = ts.isPropertyAccessExpression(target) ? target.name : (target as ts.ElementAccessExpression).argumentExpression;
    const symbol = this.dealias(this.checker.getSymbolAtLocation(member));
    if (symbol !== undefined && (symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function)) !== 0) {
      appendTo(this.index.identifierWrites, symbol, value);
    }
  }

  /** 직접 대입·갱신·삭제를 구조화한 mutation으로 기록한다. */
  private recordDirectMutation(target: ts.Expression, value: ts.Expression | undefined, operation: MutationOperation, site: ts.Node): void {
    const shape = directMutationShape(target);
    const isPrototypeWrite = shape.staticKey === '__proto__' && operation !== 'delete';
    const normalizedOperation: MutationOperation = isPrototypeWrite ? 'proto' : operation;
    const effect: MutationEffect = isPrototypeWrite ? 'prototype'
      : ts.isIdentifier(target) ? 'binding' : shape.key === undefined ? 'unknown' : 'property';
    const record: MutationRecord = {
      operation: normalizedOperation,
      effect,
      target: shape.target,
      key: shape.key,
      staticKey: shape.staticKey,
      value,
      source: undefined,
      sources: [],
      descriptor: undefined,
      prototype: isPrototypeWrite ? value : undefined,
      args: [],
      site,
      confidence: 'known',
    };
    this.index.mutations.push(record);
    if (isPrototypeWrite) this.index.reflectiveTargets.push(shape.target);
  }

  /**
   * `new this(...)`·`new this.constructor(...)`를 담은 클래스를 기록한다.
   *
   * @param expression new 식
   */
  private visitNew(expression: ts.NewExpression): void {
    const callee = skipWrappers(expression.expression);
    const isThis = callee.kind === ts.SyntaxKind.ThisKeyword
      || (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && callee.name.text === 'constructor');
    const owner = isThis ? ts.findAncestor(expression, ts.isClassLike) : undefined;
    if (owner !== undefined) this.index.newThisClasses.add(owner);
  }

  /**
   * 반사적 쓰기 호출과 동적 import·require를 기록한다.
   *
   * @param call 호출식
   */
  private visitCall(call: ts.CallExpression): void {
    const callee = skipWrappers(call.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
      this.visitModuleLoad(call);
      return;
    }
    if (isPatternModuleLoader(callee)) {
      this.index.hasOpaqueImport = true;
      return;
    }
    if (this.legacyAccessorCall(callee)) this.index.hasOpaqueMutation = true;
    if (this.reflectiveEscape(callee)) this.index.hasOpaqueMutation = true;
    const reflective = this.reflectiveCall(callee);
    if (reflective !== undefined) this.recordReflectiveMutation(call, reflective);
  }

  /** legacy accessor member의 direct call과 alias call/apply/bind escape를 opaque로 표시한다. */
  private legacyAccessorCall(callee: ts.Expression): boolean {
    const elementKey = ts.isElementAccessExpression(callee) ? skipWrappers(callee.argumentExpression) : undefined;
    const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
    if (isLegacyAccessorMutationName(member)) return true;
    if (member !== 'call' && member !== 'apply' && member !== 'bind') return false;
    const base = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
    return base !== undefined && hasLegacyAccessorValue(this.checker, base);
  }

  /** mutation method의 `.call`·`.apply`·`.bind` escape는 인자 위치와 receiver를 더 이상 증명하지 않는다. */
  private reflectiveEscape(callee: ts.Expression): boolean {
    const elementKey = ts.isElementAccessExpression(callee) ? skipWrappers(callee.argumentExpression) : undefined;
    const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
    if (member !== undefined && member !== 'call' && member !== 'apply' && member !== 'bind') return false;
    const base = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
    if (base === undefined) return false;
    if (ts.isIdentifier(base)) {
      const alias = reflectiveAliasMethod(this.checker, base);
      return alias.call?.operation !== undefined || alias.opaque;
    }
    if (ts.isPropertyAccessExpression(base)) {
      const owner = reflectiveOwner(base.expression);
      return owner !== undefined && reflectiveOperation(owner.owner, base.name.text) !== undefined;
    }
    if (ts.isElementAccessExpression(base)) {
      const owner = reflectiveOwner(base.expression);
      if (owner === undefined) return false;
      const key = skipWrappers(base.argumentExpression);
      return !ts.isStringLiteralLike(key) || reflectiveOperation(owner.owner, key.text) !== undefined;
    }
    return false;
  }

  /** 지원하는 반사 built-in 표기와 AST로 확인한 mutation alias만 구조화할 분류로 바꾼다. */
  private reflectiveCall(callee: ts.Expression): ReflectiveCall | undefined {
    let owner: ReflectiveOwner | undefined;
    let ownerConfidence: MutationConfidence = 'unknown';
    let method: string | undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      method = callee.name.text;
      const ownerInfo = reflectiveOwner(callee.expression);
      owner = ownerInfo?.owner;
      ownerConfidence = ownerInfo?.confidence ?? 'unknown';
      if (owner === undefined) {
        const aliasInfo = reflectiveAliasOwner(this.checker, callee.expression);
        if (aliasInfo === undefined) return undefined;
        owner = aliasInfo.owner;
        ownerConfidence = 'unknown';
      }
    } else if (ts.isElementAccessExpression(callee)) {
      const ownerInfo = reflectiveOwner(callee.expression);
      owner = ownerInfo?.owner;
      ownerConfidence = ownerInfo?.confidence ?? 'unknown';
      const key = skipWrappers(callee.argumentExpression);
      method = ts.isStringLiteralLike(key) ? key.text : undefined;
      if (owner === undefined) {
        const aliasInfo = reflectiveAliasOwner(this.checker, callee.expression);
        if (aliasInfo === undefined) return undefined;
        owner = aliasInfo.owner;
        ownerConfidence = 'unknown';
      }
    } else if (ts.isIdentifier(callee)) {
      const alias = reflectiveAliasMethod(this.checker, callee);
      if (alias.opaque) this.index.hasOpaqueMutation = true;
      return alias.call;
    } else {
      return undefined;
    }

    if (owner === undefined) return undefined;
    const operation = reflectiveOperation(owner, method);
    if (operation === undefined) {
      // 정적인 미지원 method(Object.keys, Reflect.get 등)는 reader/allocator일 수 있다.
      // 계산된 method만 보수적으로 unknown mutation으로 남긴다.
      return ts.isElementAccessExpression(callee) && method === undefined
        ? { owner, method, operation: 'unknown', effect: 'unknown', confidence: 'unknown' }
        : undefined;
    }
    return {
      owner,
      method,
      operation,
      effect: mutationEffect(operation),
      confidence: ownerConfidence,
    };
  }

  /** 반사 호출 인자를 구조화하고 legacy reflectiveTargets에도 receiver를 남긴다. */
  private recordReflectiveMutation(call: ts.CallExpression, reflective: ReflectiveCall): void {
    const args = [...call.arguments];
    const target = args[0];
    if (target === undefined) return;
    const key = reflectiveKey(reflective.operation, args);
    const staticKey = staticKeyOf(key);
    const value = reflectiveValue(reflective.operation, args);
    const sourceArgs = reflective.operation === 'object.assign' ? args.slice(1) : [];
    const source = sourceArgs[0];
    const descriptor = reflectiveDescriptor(reflective.operation, args);
    const prototype = reflective.operation === 'object.setPrototypeOf' || reflective.operation === 'reflect.setPrototypeOf'
      ? args[1] : undefined;
    const record: MutationRecord = {
      operation: reflective.operation,
      effect: reflective.effect,
      target,
      key,
      staticKey,
      value,
      source,
      sources: sourceArgs,
      descriptor,
      prototype,
      args,
      site: call,
      confidence: reflective.confidence,
    };
    this.index.mutations.push(record);
    // 기존 flow 모델은 shadow/alias 이름과 프로토타입 변경을 포함한 반사 표기를 모두 보수적으로 연다.
    this.index.reflectiveTargets.push(target);
  }

  /**
   * 동적 import·require가 불러올 수 있는 모듈을 연다: 받은 모듈 객체(`const { f } = await import('./m')`)를
   * 거친 호출은 함수 심볼의 참조로 잡히지 않기 때문이다. 지정자는 문자열이거나 문자열만 고르는 조건식
   * (`a ? "./x" : "./y"`, `??`·`||`)이어야 하고, 그 밖이면 어느 모듈이든 열릴 수 있다고 기록한다. 풀리지 않는
   * 지정자(패키지·없는 파일)는 프로젝트 모듈이 아니므로 무시한다.
   *
   * @param call import(...)·require(...) 호출
   */
  private visitModuleLoad(call: ts.CallExpression): void {
    const specifier = call.arguments[0];
    const leaves = specifier === undefined ? undefined : stringLeaves(specifier);
    if (leaves === undefined) {
      this.index.hasOpaqueImport = true;
      return;
    }
    for (const leaf of leaves) {
      const module = leaf === specifier ? this.checker.getSymbolAtLocation(leaf) : this.resolveModule(leaf.text, call.getSourceFile());
      if (module !== undefined) this.index.openModules.add(module);
    }
  }

  /**
   * 별칭 선언의 지역 이름을 대상 심볼별로 기록한다(`import { f as g }`의 g, `import g from`의 g).
   *
   * @param node import·export 별칭 선언
   */
  private visitAliasName(node: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport | ts.ExportSpecifier | ts.ImportEqualsDeclaration): void {
    if (node.name === undefined) return;
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName ?? node.name;
      const importedName = ts.isIdentifier(imported) || ts.isStringLiteral(imported) ? imported.text : undefined;
      if (importedName !== undefined
        && (isReflectiveMutationMethodName(importedName) || isLegacyAccessorMutationName(importedName))) this.index.hasOpaqueMutation = true;
    }
    const target = this.dealias(this.checker.getSymbolAtLocation(node.name));
    if (target !== undefined && (target.flags & TRACKED_FLAGS) !== 0) appendTo(this.index.aliasNames, target, node.name.text);
  }

  /**
   * 지역 `export { x }`·`export { x as y }`의 대상을 내보낸 심볼로 기록한다.
   *
   * @param specifier export 지정자
   */
  private visitExportSpecifier(specifier: ts.ExportSpecifier): void {
    if (specifier.parent.parent.moduleSpecifier !== undefined) return;
    this.addExported(this.checker.getExportSpecifierLocalTargetSymbol(specifier));
  }

  /**
   * 클래스의 `extends` 기반이 프로젝트 클래스면 하위 클래스 색인에 넣는다.
   *
   * @param declaration 클래스 선언·식
   */
  private visitClass(declaration: ts.ClassLikeDeclaration): void {
    const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (base === undefined) return;
    const symbol = this.dealias(this.expressionSymbol(base));
    const baseDeclaration = symbol?.declarations?.find(ts.isClassLike);
    if (baseDeclaration !== undefined) appendTo(this.index.subclasses, baseDeclaration, declaration);
  }

  /**
   * 식(식별자·속성 접근)의 심볼이다.
   *
   * @param expression 식
   * @returns 심볼 또는 undefined
   */
  private expressionSymbol(expression: ts.Expression): ts.Symbol | undefined {
    const inner = skipWrappers(expression);
    if (ts.isIdentifier(inner)) return this.checker.getSymbolAtLocation(inner);
    if (ts.isPropertyAccessExpression(inner)) return this.checker.getSymbolAtLocation(inner.name);
    return undefined;
  }

  /**
   * 내보낸 심볼을 기록한다.
   *
   * @param symbol 심볼
   */
  private addExported(symbol: ts.Symbol | undefined): void {
    const target = this.dealias(symbol);
    if (target !== undefined) this.index.exportedSymbols.add(target);
  }

  /**
   * 별칭 심볼을 실제 심볼로 푼다.
   *
   * @param symbol 심볼
   * @returns 실제 심볼, 풀리지 않으면 undefined
   */
  private dealias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const target = this.checker.getAliasedSymbol(symbol);
    return (target.declarations ?? []).length === 0 ? undefined : target;
  }
}

/** 직접 mutation에서 receiver와 key를 분리한 형태다. */
interface DirectMutationShape {
  readonly target: ts.Expression;
  readonly key: ts.Expression | undefined;
  readonly staticKey: string | undefined;
}

/** 직접 대입·삭제 식에서 receiver, key, 정적 key를 추출한다. */
function directMutationShape(expression: ts.Expression): DirectMutationShape {
  if (ts.isPropertyAccessExpression(expression)) {
    return { target: expression.expression, key: expression.name, staticKey: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)) {
    const key = expression.argumentExpression;
    return { target: expression.expression, key, staticKey: staticKeyOf(key) };
  }
  return { target: expression, key: undefined, staticKey: undefined };
}

/** key 식이 문자열·숫자 리터럴 또는 일반 속성 이름일 때만 정적 문자열을 돌려준다. */
function staticKeyOf(key: ts.Expression | undefined): string | undefined {
  if (key === undefined) return undefined;
  const inner = skipWrappers(key);
  if (ts.isStringLiteralLike(inner) || ts.isNumericLiteral(inner)) return inner.text;
  return undefined;
}

/** legacy accessor member를 제한된 AST alias·destructure 경로로 확인한다. */
function hasLegacyAccessorValue(checker: ts.TypeChecker, expression: ts.Expression, depth = 0, visited = new Set<ts.Symbol>()): boolean {
  if (depth >= MAX_REFLECTIVE_ALIAS_DEPTH) return false;
  const inner = skipWrappers(expression);
  const elementKey = ts.isElementAccessExpression(inner) ? skipWrappers(inner.argumentExpression) : undefined;
  const member = ts.isPropertyAccessExpression(inner) ? inner.name.text
    : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
  if (isLegacyAccessorMutationName(member)) return true;
  if (!ts.isIdentifier(inner)) return false;
  const symbol = checker.getSymbolAtLocation(inner);
  if (symbol === undefined || visited.has(symbol)) return false;
  visited.add(symbol);
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (variable?.initializer !== undefined && hasLegacyAccessorValue(checker, variable.initializer, depth + 1, visited)) return true;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding !== undefined) {
    const key = binding.propertyName ?? binding.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return isLegacyAccessorMutationName(key.text);
  }
  const imported = symbol.declarations?.find(ts.isImportSpecifier);
  if (imported !== undefined) {
    const key = imported.propertyName ?? imported.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return isLegacyAccessorMutationName(key.text);
  }
  return false;
}

/** `Object`·`Reflect` receiver 표기를 식별한다. declaration file 경로만으로 intrinsic 여부를 확정하지 않는다. */
function reflectiveOwner(expression: ts.Expression): { owner: ReflectiveOwner; confidence: MutationConfidence } | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner) && (inner.text === 'Object' || inner.text === 'Reflect')) {
    return { owner: inner.text, confidence: 'unknown' };
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'globalThis'
    && (inner.name.text === 'Object' || inner.name.text === 'Reflect')) {
    return { owner: inner.name.text, confidence: 'unknown' };
  }
  if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'globalThis') {
    const key = skipWrappers(inner.argumentExpression);
    if (ts.isStringLiteralLike(key) && (key.text === 'Object' || key.text === 'Reflect')) {
      return { owner: key.text, confidence: 'unknown' };
    }
  }
  return undefined;
}

/** `const R = Reflect` 같은 별칭 receiver를 제한된 깊이로 확인한다. */
function reflectiveAliasOwner(checker: ts.TypeChecker, expression: ts.Expression, depth = 0): { owner: ReflectiveOwner } | undefined {
  if (depth >= MAX_REFLECTIVE_ALIAS_DEPTH) return undefined;
  const inner = skipWrappers(expression);
  if (!ts.isIdentifier(inner)) return undefined;
  const symbol = checker.getSymbolAtLocation(inner);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  const initializer = declaration?.initializer;
  if (initializer === undefined) return undefined;
  const direct = reflectiveOwner(initializer);
  if (direct !== undefined) return { owner: direct.owner };
  return reflectiveAliasOwner(checker, initializer, depth + 1);
}

/** `const patch = Reflect.setPrototypeOf` 같은 임의 이름의 반사 메서드 별칭을 제한된 깊이로 확인한다. */
function reflectiveAliasMethod(
  checker: ts.TypeChecker,
  expression: ts.Identifier,
  depth = 0,
  visited = new Set<ts.Symbol>(),
): ReflectiveAliasResult {
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || visited.has(symbol)) return { call: undefined, opaque: false };
  if (depth >= MAX_REFLECTIVE_ALIAS_DEPTH) {
    return { call: undefined, opaque: hasReflectiveMutationSeed(checker, expression) };
  }
  visited.add(symbol);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  const initializer = declaration?.initializer;
  if (initializer === undefined) return { call: undefined, opaque: false };
  const inner = skipWrappers(initializer);
  const elementKey = ts.isElementAccessExpression(inner) ? skipWrappers(inner.argumentExpression) : undefined;
  const member = ts.isPropertyAccessExpression(inner) ? inner.name.text
    : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
  const ownerExpression = ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) ? inner.expression : undefined;
  if (ownerExpression !== undefined) {
    const ownerInfo = reflectiveOwner(ownerExpression) ?? reflectiveAliasOwner(checker, ownerExpression);
    if (ownerInfo !== undefined) {
      const operation = reflectiveOperation(ownerInfo.owner, member);
      if (operation === undefined && member !== undefined) return { call: undefined, opaque: false };
      return {
        call: {
        owner: ownerInfo.owner,
        method: member,
        operation: operation ?? 'unknown',
        effect: mutationEffect(operation ?? 'unknown'),
        confidence: 'unknown',
        },
        opaque: false,
      };
    }
  }
  if (ts.isIdentifier(inner)) return reflectiveAliasMethod(checker, inner, depth + 1, visited);
  return { call: undefined, opaque: false };
}

/** depth cap 뒤에도 실제 mutation built-in seed가 있는지 bounded하게 확인한다. */
function hasReflectiveMutationSeed(
  checker: ts.TypeChecker,
  expression: ts.Identifier,
  depth = 0,
  visited = new Set<ts.Symbol>(),
): boolean {
  if (depth >= MAX_REFLECTIVE_SEED_DEPTH) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || visited.has(symbol)) return false;
  visited.add(symbol);
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  const initializer = declaration?.initializer;
  if (initializer === undefined) return false;
  const inner = skipWrappers(initializer);
  const elementKey = ts.isElementAccessExpression(inner) ? skipWrappers(inner.argumentExpression) : undefined;
  const member = ts.isPropertyAccessExpression(inner) ? inner.name.text
    : elementKey !== undefined && ts.isStringLiteralLike(elementKey) ? elementKey.text : undefined;
  const ownerExpression = ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) ? inner.expression : undefined;
  if (ownerExpression !== undefined) {
    const ownerInfo = reflectiveOwner(ownerExpression) ?? reflectiveAliasOwner(checker, ownerExpression);
    if (ownerInfo !== undefined) return member === undefined || reflectiveOperation(ownerInfo.owner, member) !== undefined;
  }
  return ts.isIdentifier(inner) ? hasReflectiveMutationSeed(checker, inner, depth + 1, visited) : false;
}

/** owner와 method 조합을 지원되는 반사 연산으로 분류한다. */
function reflectiveOperation(owner: ReflectiveOwner, method: string | undefined): MutationOperation | undefined {
  if (method === undefined) return undefined;
  if (owner === 'Object') {
    if (method === 'assign') return 'object.assign';
    if (method === 'defineProperty') return 'object.defineProperty';
    if (method === 'defineProperties') return 'object.defineProperties';
    if (method === 'setPrototypeOf') return 'object.setPrototypeOf';
  } else {
    if (method === 'set') return 'reflect.set';
    if (method === 'defineProperty') return 'reflect.defineProperty';
    if (method === 'deleteProperty') return 'reflect.deleteProperty';
    if (method === 'setPrototypeOf') return 'reflect.setPrototypeOf';
  }
  return undefined;
}

/** import/destructure alias에서 mutation built-in으로 오인될 수 있는 method 이름이다. */
function isReflectiveMutationMethodName(method: string): boolean {
  return reflectiveOperation('Object', method) !== undefined || reflectiveOperation('Reflect', method) !== undefined;
}

/** legacy accessor mutation member는 receiver provenance를 증명하지 않고 이름만으로 opaque 처리한다. */
function isLegacyAccessorMutationName(method: string | undefined): boolean {
  return method === '__defineGetter__' || method === '__defineSetter__';
}

/** 연산의 property/prototype 효과를 분류한다. */
function mutationEffect(operation: MutationOperation): MutationEffect {
  if (operation === 'object.setPrototypeOf' || operation === 'reflect.setPrototypeOf' || operation === 'proto') return 'prototype';
  if (operation === 'unknown') return 'unknown';
  return 'property';
}

/** 반사 연산에서 key 인자를 가져온다. */
function reflectiveKey(operation: MutationOperation, args: readonly ts.Expression[]): ts.Expression | undefined {
  if (operation === 'object.defineProperty' || operation === 'reflect.set'
    || operation === 'reflect.defineProperty' || operation === 'reflect.deleteProperty') return args[1];
  return undefined;
}

/** 반사 연산에서 정확히 관찰한 value 인자를 가져온다. */
function reflectiveValue(operation: MutationOperation, args: readonly ts.Expression[]): ts.Expression | undefined {
  return operation === 'reflect.set' ? args[2] : undefined;
}

/** 반사 연산에서 descriptor 인자를 가져온다. */
function reflectiveDescriptor(operation: MutationOperation, args: readonly ts.Expression[]): ts.Expression | undefined {
  if (operation === 'object.defineProperty' || operation === 'reflect.defineProperty') return args[2];
  if (operation === 'object.defineProperties') return args[1];
  return undefined;
}

/**
 * 식별자가 값 참조 자리인지 본다. 선언 이름·import/export 이름·레이블·대입 왼쪽·`export default x`는
 * 아니다(`export default x`는 내보내기로 따로 기록한다 — 가져온 쪽의 사용이 참조로 잡힌다).
 *
 * @param identifier 식별자(속성 접근 이름이 아님)
 * @returns 참조 자리면 true
 */
function isReferencePosition(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isNamespaceExport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent) || ts.isMetaProperty(parent) || ts.isQualifiedName(parent)
    || ts.isExportAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  if ((parent as { name?: ts.Node }).name === identifier) return false;
  const outer = climbWrappers(identifier);
  return !(ts.isBinaryExpression(outer.parent) && outer.parent.left === outer
    && outer.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && outer.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
}

/**
 * 파일 패턴으로 모듈을 불러오는 번들러 API(`import.meta.glob`·`import.meta.globEager`·`require.context`)인지 본다.
 * 불러온 모듈의 내보내기가 어디로 가는지 알 수 없으므로 동적 import처럼 연다.
 *
 * @param callee 호출 대상 식(래퍼를 벗긴)
 * @returns 패턴 로더면 true
 */
function isPatternModuleLoader(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = callee.expression;
  if (ts.isMetaProperty(owner)) return owner.keywordToken === ts.SyntaxKind.ImportKeyword && (callee.name.text === 'glob' || callee.name.text === 'globEager');
  return ts.isIdentifier(owner) && owner.text === 'require' && callee.name.text === 'context';
}

/**
 * 식이 고를 수 있는 문자열 리터럴들이다(괄호·조건식·`??`·`||`를 따라간다).
 *
 * @param expression 식
 * @returns 문자열 리터럴 목록, 문자열이 아닌 값이 섞이면 undefined
 */
export function stringLeaves(expression: ts.Expression, depth = 0): ts.StringLiteralLike[] | undefined {
  const inner = skipWrappers(expression);
  if (ts.isStringLiteralLike(inner)) return [inner];
  if (depth > MAX_SPECIFIER_DEPTH) return undefined;
  const branches = ts.isConditionalExpression(inner) ? [inner.whenTrue, inner.whenFalse]
    : ts.isBinaryExpression(inner) && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ? [inner.left, inner.right] : undefined;
  if (branches === undefined) return undefined;
  const leaves = branches.map((branch) => stringLeaves(branch, depth + 1));
  return leaves.includes(undefined) ? undefined : leaves.flat() as ts.StringLiteralLike[];
}

/**
 * 참조 토큰이 가리키는 값 식이다: 속성 접근 이름이면 그 속성 접근, 원소 접근의 문자열 키면 그 원소 접근, 그 밖은
 * 토큰 자신. 부모 래퍼까지 벗겨 올라간다.
 *
 * @param token 참조 토큰
 * @returns 값 식(래퍼 포함 가장 바깥)
 */
export function referenceSite(token: ts.Node): ts.Node {
  const parent = token.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === token) return climbWrappers(parent);
  if (ts.isElementAccessExpression(parent) && skipWrappers(parent.argumentExpression) === token) return climbWrappers(parent);
  return climbWrappers(token);
}

/**
 * 값을 바꾸지 않는 부모 래퍼(괄호·`as`·`satisfies`·non-null·타입 단언)를 위로 벗긴다.
 *
 * @param node 식
 * @returns 가장 바깥 래퍼(없으면 식 자신)
 */
export function climbWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/**
 * 목록 맵에 값을 더한다.
 *
 * @param map 키 → 목록
 * @param key 키
 * @param value 값
 */
function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
