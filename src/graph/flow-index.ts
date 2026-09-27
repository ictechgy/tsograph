/**
 * bound 디스패치의 값 흐름 분석(`value-flow.ts`)이 쓰는 전체 프로그램 색인이다.
 *
 * 노드 파일을 한 번 훑어 다음을 모은다.
 * - 함수·클래스·변수 심볼의 값 참조 위치(별칭을 푼 심볼 기준). 호출 위치를 찾고, 호출 대상이 아닌 자리에
 *   쓰인(값으로 새어 나간) 함수를 가려내는 데 쓴다. 값 자리의 식별자, 모든 속성 접근 이름(`ns.f`, 파일 안
 *   `namespace App`의 `App.Repo`, `globalThis.f`), 문자열 리터럴 원소 접근(`App["load"]`)을 checker로 풀어 모은다.
 * - 식별자 대입(`x = e`, `x ??= e` …)과 속성 대입(`a.b = e`, `a["b"] = e`)을 대상별로. 구조 분해 대입·
 *   증감·복합 대입처럼 값을 모르는 쓰기는 값 없이 기록한다.
 * - `new this()`를 쓰는 클래스, `Object.assign`·`Object.defineProperty(ies)`·`Reflect.set`·
 *   `Reflect.defineProperty`의 첫 인자(반사적 쓰기 대상), `export { x }`·`export default x`로 내보낸 심볼,
 *   동적 `import()`나 값으로 쓰인 네임스페이스 import 때문에 멤버를 추적할 수 없는 모듈, 파일 패턴 로더
 *   (`import.meta.glob`·`require.context`)나 문자열이 아닌 지정자처럼 어느 모듈이든 열 수 있는 호출.
 *
 * 계산된 키 쓰기(`obj[key] = v`)와 프로토타입 조작은 모으지 않는다 — README가 bound의 전제로 밝힌다.
 */

import ts from 'typescript';

import { isTypeOnly, skipWrappers } from './node-collector.ts';

/** 값을 모르는 쓰기를 나타내는 표식이다. */
export const UNKNOWN_WRITE = undefined;

/** 속성 쓰기 하나다. */
export interface PropertyWrite {
  /** 대입 대상 속성 접근 식 */
  readonly target: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  /** 쓴 값, 모르면 undefined */
  readonly value: ts.Expression | undefined;
}

/** 모은 색인이다. */
export interface FlowIndex {
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
  /** 색인한 파일 */
  readonly files: readonly ts.SourceFile[];
}

/** 조건식 지정자를 따라가는 최대 깊이다(넘으면 어느 모듈이든 열릴 수 있다고 본다). */
const MAX_SPECIFIER_DEPTH = 64;

/** 참조를 모으는 심볼 종류다. */
const TRACKED_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable;

/** 값을 그대로 옮기는 대입 연산자다. */
const VALUE_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** 반사적 쓰기 함수(`Object.*`·`Reflect.*`)의 멤버 이름이다. */
const REFLECTIVE_WRITERS: Readonly<Record<string, ReadonlySet<string>>> = {
  Object: new Set(['assign', 'defineProperty', 'defineProperties']),
  Reflect: new Set(['set', 'defineProperty']),
};

/** 색인을 채우는 가변 저장소다. */
interface MutableIndex {
  references: Map<ts.Symbol, ts.Node[]>;
  identifierWrites: Map<ts.Symbol, (ts.Expression | undefined)[]>;
  propertyWrites: Map<string, PropertyWrite[]>;
  newThisClasses: Set<ts.ClassLikeDeclaration>;
  reflectiveTargets: ts.Expression[];
  exportedSymbols: Set<ts.Symbol>;
  openModules: Set<ts.Symbol>;
  hasOpaqueImport: boolean;
  subclasses: Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration[]>;
  memberReads: Map<string, ts.Node[]>;
  aliasNames: Map<ts.Symbol, string[]>;
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
    references: new Map(), identifierWrites: new Map(), propertyWrites: new Map(), newThisClasses: new Set(),
    reflectiveTargets: [], exportedSymbols: new Set(), openModules: new Set(), hasOpaqueImport: false, subclasses: new Map(),
    memberReads: new Map(), aliasNames: new Map(), files: [],
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
export function buildFileIndex(checker: ts.TypeChecker, sourceFile: ts.SourceFile, resolveModule: ModuleResolver): FlowIndex {
  const index = emptyIndex();
  new IndexCollector(checker, index, resolveModule).visitFile(sourceFile);
  index.files.push(sourceFile);
  return index;
}

/**
 * 파일 색인들을 주어진 순서로 합친다(목록은 이어 붙이고 집합은 합친다).
 *
 * @param parts 파일 색인
 * @returns 합친 색인
 */
export function mergeFlowIndexes(parts: Iterable<FlowIndex>): FlowIndex {
  const index = emptyIndex();
  for (const part of parts) {
    mergeLists(index.references, part.references);
    mergeLists(index.identifierWrites, part.identifierWrites);
    mergeLists(index.propertyWrites, part.propertyWrites);
    mergeLists(index.subclasses, part.subclasses);
    mergeLists(index.memberReads, part.memberReads);
    mergeLists(index.aliasNames, part.aliasNames);
    index.files.push(...part.files);
    part.newThisClasses.forEach((value) => index.newThisClasses.add(value));
    part.exportedSymbols.forEach((value) => index.exportedSymbols.add(value));
    part.openModules.forEach((value) => index.openModules.add(value));
    index.reflectiveTargets.push(...part.reflectiveTargets);
    index.hasOpaqueImport ||= part.hasOpaqueImport;
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
    const visit = (node: ts.Node): void => {
      if (isTypeOnly(node) && !ts.isImportDeclaration(node)) return;
      this.visitNode(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
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
    if (name === undefined) return;
    const outer = climbWrappers(access);
    const parent = outer.parent;
    // `h.run(...)`·`h.run\`…\``은 `this`가 h인 호출이다. `new h.run()`·데코레이터·그 밖의 읽기는 떼어 낸다.
    if (ts.isCallExpression(parent) && parent.expression === outer) return;
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === outer) return;
    if (ts.isBinaryExpression(parent) && parent.left === outer && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;
    appendTo(this.index.memberReads, name, access);
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
      this.visitDestructuringTargets(left);
    } else {
      this.recordWrite(left, value);
    }
  }

  /**
   * 증감(`x++`, `--o.n`)은 값을 모르는 쓰기다.
   *
   * @param update 전위·후위 단항식
   */
  private visitUpdate(update: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): void {
    if (update.operator === ts.SyntaxKind.PlusPlusToken || update.operator === ts.SyntaxKind.MinusMinusToken) {
      this.recordWrite(skipWrappers(update.operand), UNKNOWN_WRITE);
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
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) this.visitDestructuringTargets(target);
    else this.recordWrite(target, UNKNOWN_WRITE);
  }

  /**
   * 구조 분해 대입의 대상(식별자·속성 접근)을 값 모르는 쓰기로 기록한다.
   *
   * @param pattern 객체·배열 리터럴 패턴
   */
  private visitDestructuringTargets(pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): void {
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
      if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) this.visitDestructuringTargets(inner);
      else this.recordWrite(inner, UNKNOWN_WRITE);
    }
  }

  /**
   * 쓰기 대상 하나를 기록한다: 식별자면 심볼별, 속성 접근이면 이름별.
   *
   * @param target 대상 식(래퍼를 벗긴)
   * @param value 쓴 값, 모르면 undefined
   */
  private recordWrite(target: ts.Expression, value: ts.Expression | undefined): void {
    if (ts.isIdentifier(target)) {
      const symbol = this.dealias(this.checker.getSymbolAtLocation(target));
      if (symbol !== undefined) appendTo(this.index.identifierWrites, symbol, value);
      return;
    }
    const name = ts.isPropertyAccessExpression(target) ? target.name.text
      : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined;
    if (name === undefined) return;
    appendTo(this.index.propertyWrites, name, { target: target as PropertyWrite['target'], value });
    // TS `namespace N { export let x }`의 `N.x = e`는 변수 쓰기다.
    const member = ts.isPropertyAccessExpression(target) ? target.name : (target as ts.ElementAccessExpression).argumentExpression;
    const symbol = this.dealias(this.checker.getSymbolAtLocation(member));
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Variable) !== 0) appendTo(this.index.identifierWrites, symbol, value);
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
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
    const writers = REFLECTIVE_WRITERS[callee.expression.text];
    const target = call.arguments[0];
    if (writers?.has(callee.name.text) === true && target !== undefined) this.index.reflectiveTargets.push(target);
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
