/**
 * 인터페이스·구조 타입 수신자로 부른 메서드 호출(`this.deps.store.findX()`, `repo.save()`)과
 * 닫힌 호출 가능 값 호출(`invoke(cb)`, `make()()`)을 추측 없이 잇는다.
 *
 * direct 해석이 공백으로 남긴 호출마다(`edge-collector.ts`의 대기 항목):
 * 1. **bound**: 수신자 식에 흘러드는 값을 전체 프로그램 흐름(`value-flow.ts`)으로 모두 구하고, 모두 프로젝트
 *    클래스 인스턴스·객체 리터럴이며 각 값에서 메서드가 본문 있는 프로젝트 선언으로 해석되면, 호출을 감싼
 *    스코프에서 그 구현들로 `bound` 간선을 잇는다(구현마다 하나).
 * 2. 인터페이스 흐름 중 하나라도 모르면 bound를 내지 않고, 수신자 타입을 구현하거나 그 타입에 대입 가능한
 *    프로젝트 클래스·객체의 메서드 전부로 `candidate` 간선을 잇는다(`dispatch-candidates.ts`). 호출 가능 값
 *    흐름은 하나라도 모르면 원래 공백을 남기며 candidate를 만들지 않는다.
 * 3. 노드별 미해석 계수를 모드별로 센다(bound로 이었으면 direct 모드에서만, candidate면 direct·bound에서,
 *    끝내 못 이었으면 모든 모드에서).
 *
 * bound의 전제(README가 밝힌다): 스캔한 프로젝트가 프로그램 전체다. 그래서 스캔 밖 코드가 부를 수 있는
 * 함수·클래스는 흐름이 열린 자리로 본다: 진입점(과 그 export 별칭·기본 내보내기 대상), 진입점 파일의 내보내기,
 * 멤버를 추적할 수 없는 모듈(동적 import·값으로 쓰인 네임스페이스)의 내보내기, 그리고 공개 패키지
 * (`package.json`의 main·module·exports·bin·types·typings·browser)이거나 스캔이 불완전하면 모든 내보내기와
 * 비공개가 아닌 속성.
 *
 * 테스트 소스(`*.test.*`·`*.spec.*`, `__tests__`·`__mocks__` 아래 — routes와 같은 규칙)는 테스트 러너가 따로 실행하는
 * 별개 프로그램이다. 그래서 테스트 소스가 아닌 파일의 호출은 테스트 소스를 뺀 프로그램으로 흐름·후보를 구한다
 * (테스트가 주입한 목(mock)이 운영 호출의 bound를 막지 않게). 테스트 소스 안의 호출은 전체로 구한다. 테스트가 아닌
 * 파일이 테스트 소스를 import하면 둘을 나눌 수 없어 모든 호출을 전체로 구한다.
 */

import ts from 'typescript';

import { compareStrings } from '../exchange/sorted-json.ts';
import { CandidateFinder } from './dispatch-candidates.ts';
import type { EdgeGaps, PendingDispatch } from './edge-collector.ts';
import { climbWrappers, type FlowIndex, type ModuleResolver, stringLeaves } from './flow-index.ts';
import type { CallStatistics, GraphStore } from './graph-model.ts';
import { delegateCallbackExpression, isNextCacheWrapperExpression } from './next-cache-model.ts';
import { moduleScopeId, scopeIdOf } from './symbol-ids.ts';
import type { TargetResolver } from './target-resolver.ts';
import { type CallableValue, type FlowPolicy, ValueFlow } from './value-flow.ts';

/** 디스패치 단계 입력이다. */
export interface DispatchContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly store: GraphStore;
  readonly resolver: TargetResolver;
  /** 운영 파일 direct 해석용 resolver(테스트를 분리할 수 없으면 resolver와 같다) */
  readonly productionResolver: TargetResolver;
  /** 모든 노드 파일의 합친 값 흐름 색인 */
  readonly flowIndex: FlowIndex;
  /** 테스트를 뺀 운영 범위 색인(분리할 수 없으면 flowIndex와 같다) */
  readonly productionFlowIndex: FlowIndex;
  readonly testPaths: ReadonlySet<string>;
  readonly separateTests: boolean;
  /** 노드 파일(프로젝트 기준 경로 → 파일) */
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  /** 기반 메서드 id → 재정의 메서드 id */
  readonly overrides: ReadonlyMap<string, readonly string[]>;
  readonly pending: readonly PendingDispatch[];
  readonly calls: CallStatistics;
  readonly gaps: EdgeGaps;
  /** 스캔 밖 코드가 내보낸 선언을 부를 수 있다고 볼지(공개 패키지·불완전 스캔) */
  readonly openProgram: boolean;
  /**
   * 프레임워크가 불러와 내보내기를 부르는 파일(`isFrameworkFile`). 진입점 표식이 없어도(`export * from`) 넣는다 — 그 파일의
   * 내보내기와 재내보내기로 닿는 선언 전부가 열린 자리다(진입점 표식이 달린 파일은 정책이 따로 더한다).
   */
  readonly frameworkFiles: ReadonlySet<string>;
}

/**
 * 대기 중인 메서드·호출 가능 값 공백 호출을 bound·candidate 간선으로 잇고 모드별 미해석 계수를 센다.
 *
 * @param files 노드 파일
 */
export function resolveDispatch(context: DispatchContext): void {
  if (context.pending.length === 0) return;
  const productionFiles = context.separateTests
    ? new Map([...context.files].filter(([path]) => !context.testPaths.has(path))) : context.files;
  const production = lazyView(context, productionFiles, context.productionFlowIndex, context.productionResolver);
  const whole = context.separateTests ? lazyView(context, context.files, context.flowIndex, context.resolver) : production;
  for (const site of context.pending) {
    const view = context.testPaths.has(site.path) ? whole() : production();
    const before = view.flow.budgetExceededQueries();
    const bound = site.kind === 'member' ? boundMemberTargets(view, site) : boundCallableTargets(context, view, site);
    if (view.flow.budgetExceededQueries() > before) context.calls.dispatch.overBudget++;
    if (bound !== undefined) {
      linkSite(context, site, bound, 'bound');
      continue;
    }
    if (site.kind === 'callable') {
      // 호출 가능 값 흐름은 전부 증명해야 한다. 원래 공백을 남기고 타입 후보를 열거하지 않는다.
      context.store.countUnresolved(site.from, undefined);
      continue;
    }
    const candidates = view.finder.targetsFor(site.receiver, site.method).filter((id) => !site.direct.includes(id));
    if (candidates.length > 0) linkSite(context, site, candidates, 'candidate');
    else context.store.countUnresolved(site.from, undefined);
  }
}

/** 한 프로그램 범위(파일 집합)의 흐름 분석기와 후보 탐색기다. */
interface DispatchView {
  readonly flow: ValueFlow;
  readonly finder: CandidateFinder;
  readonly resolver: TargetResolver;
  readonly index: FlowIndex;
  readonly pathByFile: ReadonlyMap<ts.SourceFile, string>;
  readonly allPathByFile: ReadonlyMap<ts.SourceFile, string>;
}

/**
 * 파일 집합의 분석 범위를 처음 쓸 때 만드는 함수를 돌려준다.
 *
 * @param context 디스패치 입력
 * @param files 범위의 노드 파일
 * @param merged 이 범위에 합친 색인
 * @param resolver 이 범위의 쓰기를 보는 대상 해석기
 * @returns 범위를 돌려주는 함수
 */
function lazyView(
  context: DispatchContext,
  files: ReadonlyMap<string, ts.SourceFile>,
  merged: FlowIndex,
  resolver: TargetResolver,
): () => DispatchView {
  let view: DispatchView | undefined;
  return () => {
    if (view === undefined) {
      const flow = new ValueFlow(context.checker, merged, new OpenCallablePolicy(context, merged, files));
      view = {
        flow,
        finder: new CandidateFinder(context.checker, resolver, [...files.values()]),
        resolver,
        index: merged,
        pathByFile: new Map([...files].map(([path, sourceFile]) => [sourceFile, path])),
        allPathByFile: new Map([...context.files].map(([path, sourceFile]) => [sourceFile, path])),
      };
    }
    return view;
  };
}

/**
 * 테스트 소스가 아닌 파일이 테스트 소스를 불러오는지 본다(Program과 같은 옵션으로 지정자를 푼다).
 *
 * @param context 디스패치 입력
 * @param testPaths 테스트 소스 경로
 * @param resolve 모듈 지정자 해석기
 * @returns 불러오면 true
 */
export function importsTestSources(
  files: ReadonlyMap<string, ts.SourceFile>,
  testPaths: ReadonlySet<string>,
  resolve: ModuleResolver,
): boolean {
  const pathByFile = new Map([...files].map(([path, sourceFile]) => [sourceFile, path]));
  for (const [path, sourceFile] of files) {
    if (testPaths.has(path)) continue;
    const loadsTest = moduleSpecifiers(sourceFile).some((specifier) => {
      const declaration = resolve(specifier.text, sourceFile)?.valueDeclaration;
      const target = declaration !== undefined && ts.isSourceFile(declaration) ? pathByFile.get(declaration) : undefined;
      return target !== undefined && testPaths.has(target);
    });
    if (loadsTest) return true;
  }
  return false;
}

/**
 * 파일이 불러오는 문자열 모듈 지정자다(정적 import·재내보내기·`import x = require("…")`, 그리고 `import(…)`·
 * `require(…)`의 문자열 또는 문자열만 고르는 조건식).
 *
 * @param sourceFile 파일
 * @returns 문자열 지정자 식
 */
function moduleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const result: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    const declared = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
    if (declared !== undefined && ts.isStringLiteralLike(declared)) result.push(declared);
    const isLoad = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'));
    if (isLoad && node.arguments[0] !== undefined) result.push(...(stringLeaves(node.arguments[0]) ?? []));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return result;
}

/**
 * 문자열 지정자를 Program과 같은 컴파일러 옵션으로 풀어 모듈 심볼을 돌려주는 함수를 만든다(해석 캐시와 결과 메모를 둔다).
 *
 * @param program Program
 * @param checker TypeChecker
 * @returns 지정자 → 모듈 심볼(풀리지 않거나 Program 밖 파일이면 undefined)
 */
export function createModuleResolver(program: ts.Program, checker: ts.TypeChecker): ModuleResolver {
  const cache = ts.createModuleResolutionCache(program.getCurrentDirectory(), (name) => name, program.getCompilerOptions());
  const memo = new Map<string, ts.Symbol | undefined>();
  return (specifier, from) => {
    const key = `${from.fileName}\u0000${specifier}`;
    if (memo.has(key)) return memo.get(key);
    const resolved = ts.resolveModuleName(specifier, from.fileName, program.getCompilerOptions(), ts.sys, cache).resolvedModule;
    const sourceFile = resolved === undefined ? undefined : program.getSourceFile(resolved.resolvedFileName);
    const module = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
    memo.set(key, module);
    return module;
  };
}

/**
 * bound 대상을 구한다. 수신자 값이 비었거나 하나라도 모르거나, 어느 값에서든 메서드를 프로젝트 본문으로
 * 해석하지 못하면 undefined다.
 *
 * @param view 값 흐름·resolver 범위
 * @param site 대기 호출
 * @returns 대상 id(정렬, direct로 이미 이은 것 포함 가능) 또는 undefined
 */
function boundMemberTargets(view: DispatchView, site: Extract<PendingDispatch, { kind: 'member' }>): string[] | undefined {
  const values = view.flow.valuesOf(site.receiver);
  if (values === null || values.size === 0) return undefined;
  const ids = new Set<string>();
  for (const value of values) {
    const resolution = view.resolver.resolveSymbol(view.flow.memberSymbol(value, site.method), 0);
    if (resolution.kind !== 'nodes' || resolution.partial !== undefined) return undefined;
    resolution.ids.forEach((id) => ids.add(id));
  }
  // 대상이 하나도 없으면 이은 것이 아니다(빈 bound로 호출을 해석됨으로 세지 않는다).
  return ids.size === 0 ? undefined : [...ids].sort(compareStrings);
}

/** 호출 가능 값 흐름을 프로젝트 그래프 노드 id로 바꾼다. */
function boundCallableTargets(
  context: DispatchContext,
  view: DispatchView,
  site: Extract<PendingDispatch, { kind: 'callable' }>,
): string[] | undefined {
  const modelContext = {
    program: context.program,
    checker: context.checker,
    pathByFile: view.pathByFile,
    allPathByFile: view.allPathByFile,
    index: view.index,
    openProgram: context.openProgram,
  };
  const modeled = isNextCacheWrapperExpression(site.call.expression, modelContext);
  const callback = modeled ? delegateCallbackExpression(site.call.expression, modelContext, site.call) : undefined;
  const values = !modeled ? view.flow.callablesOf(site.call.expression)
    : callback === undefined ? null : view.flow.callablesOf(callback);
  if (values === null || values.size === 0) return undefined;
  const ids = new Set<string>();
  for (const value of values) {
    const id = callableNodeId(context.store, view.pathByFile, value);
    if (id === undefined) return undefined;
    ids.add(id);
  }
  return ids.size === 0 ? undefined : [...ids].sort(compareStrings);
}

/** 호출 가능 선언의 본문을 기존 안정 심볼 id로 매핑한다. */
function callableNodeId(store: GraphStore, pathByFile: ReadonlyMap<ts.SourceFile, string>, value: CallableValue): string | undefined {
  const path = pathByFile.get(value.getSourceFile());
  if (path === undefined || value.body === undefined) return undefined;
  const id = scopeIdOf(value.body, path);
  // 대입 오른쪽의 이름 없는 함수처럼 자체 안정 id가 없는 값은 모듈 노드로 꾸미지 않는다.
  if (id === moduleScopeId(path)) return undefined;
  return store.hasNode(id) ? id : undefined;
}

/**
 * 호출 하나를 bound·candidate로 이은 결과를 간선·통계·노드 계수에 옮긴다.
 *
 * @param context 디스패치 입력
 * @param site 대기 호출
 * @param targets 대상 id
 * @param evidence 근거
 */
function linkSite(context: DispatchContext, site: PendingDispatch, targets: readonly string[], evidence: 'bound' | 'candidate'): void {
  for (const id of targets) if (!site.direct.includes(id)) context.store.addEdge(site.from, id, 'call', evidence);
  const statistics = context.calls.dispatch;
  const isPartial = site.direct.length > 0;
  if (evidence === 'bound') {
    if (isPartial) statistics.boundPartial++;
    else statistics.bound++;
  } else if (isPartial) {
    statistics.candidatePartial++;
  } else {
    statistics.candidate++;
  }
  const counts = evidence === 'bound' ? context.gaps.bound : context.gaps.candidate;
  const partialCounts = evidence === 'bound' ? context.gaps.boundPartial : context.gaps.candidatePartial;
  const target = site.direct.length > 0 ? partialCounts : counts;
  target[site.reason] = (target[site.reason] ?? 0) + 1;
  context.store.countUnresolved(site.from, evidence === 'bound' ? 'bound' : 'candidates');
}

/** 스캔 밖 코드가 부를 수 있는 자리를 정하는 정책이다. */
class OpenCallablePolicy implements FlowPolicy {
  readonly openProperties: boolean;
  private readonly context: DispatchContext;
  private readonly index: FlowIndex;
  private readonly pathByFile: ReadonlyMap<ts.SourceFile, string>;
  /** 진입점과, 진입점에서 alias·reference 간선으로 닿는 노드 id */
  private readonly entryTargets: ReadonlySet<string>;
  /** 진입점 노드가 있는 파일과 route 파일 경로 */
  private readonly entryPaths: ReadonlySet<string>;
  /** 열린 모듈(동적 import·값으로 쓰인 네임스페이스)이 내보내는 선언 심볼(재내보내기·배럴을 따라간다) */
  private readonly openExports: ReadonlySet<ts.Symbol>;

  /**
   * @param context 디스패치 입력(진입점 표식이 끝난 저장소)
   * @param index 흐름 색인
   * @param files 분석 범위의 노드 파일
   */
  constructor(context: DispatchContext, index: FlowIndex, files: ReadonlyMap<string, ts.SourceFile>) {
    this.context = context;
    this.index = index;
    this.openProperties = context.openProgram;
    this.pathByFile = new Map([...files].map(([path, sourceFile]) => [sourceFile, path]));
    const entries = context.store.entryRecords();
    this.entryPaths = new Set([...entries.map((entry) => entry.path), ...context.frameworkFiles]);
    this.entryTargets = entryClosure(context.store, entries.map((entry) => entry.id));
    const frameworkModules = [...this.entryPaths].flatMap((path) => {
      const sourceFile = context.files.get(path);
      const module = sourceFile === undefined ? undefined : context.checker.getSymbolAtLocation(sourceFile);
      return module === undefined ? [] : [module];
    });
    this.openExports = moduleExportClosure(context.checker, new Set([...index.openModules, ...frameworkModules]));
  }

  /**
   * 분석 범위의 노드 파일인지 본다.
   *
   * @param sourceFile 파일
   * @returns 범위의 노드 파일이면 true
   */
  isProjectFile(sourceFile: ts.SourceFile): boolean {
    return this.pathByFile.has(sourceFile);
  }

  /** SDK 선언 파일과 구분해 Program이 실제 default library로 읽은 파일만 인정한다. */
  isDefaultLibraryFile(sourceFile: ts.SourceFile): boolean {
    return this.context.program.isSourceFileDefaultLibrary(sourceFile);
  }

  /**
   * 스캔 밖 코드가 부를 수 있는 함수·클래스인지 본다.
   *
   * @param declaration 함수 계열·클래스
   * @returns 열린 자리면 true
   */
  isOpenCallable(declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): boolean {
    const sourceFile = declaration.getSourceFile();
    const path = this.pathByFile.get(sourceFile);
    // 모듈이 아닌 스크립트 파일의 최상위 선언은 전역이라 HTML·다른 스크립트·`globalThis[key]`가 부를 수 있다.
    if (path === undefined || !ts.isExternalModule(sourceFile)) return true;
    if (declarationIds(declaration, path).some((id) => this.entryTargets.has(id))) return true;
    if (!this.isExported(declaration)) return false;
    const symbol = declarationSymbol(this.context.checker, declaration);
    return this.context.openProgram || this.index.hasOpaqueImport || this.entryPaths.has(path)
      || (symbol !== undefined && this.openExports.has(symbol));
  }

  /**
   * 하위 클래스가 재정의한 메서드인지 본다.
   *
   * @param method 메서드
   * @returns 재정의됐으면 true
   */
  isOverridden(method: ts.MethodDeclaration): boolean {
    const path = this.pathByFile.get(method.getSourceFile());
    return path !== undefined && method.body !== undefined && this.context.overrides.has(scopeIdOf(method.body, path));
  }

  /**
   * 선언이 모듈 밖으로 내보내졌는지 본다: `export` 수식어(변수에 담긴 함수·클래스 식은 그 문장),
   * `export { x }`·`export default x`. 생성자는 클래스를 본다.
   *
   * @param declaration 함수 계열·클래스
   * @returns 내보냈으면 true
   */
  private isExported(declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): boolean {
    if (ts.isConstructorDeclaration(declaration)) return this.isExported(declaration.parent);
    const holder = ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration)
      ? climbWrappers(declaration).parent : declaration;
    if (ts.isVariableDeclaration(holder)) {
      const statement = holder.parent.parent;
      if (ts.isVariableStatement(statement) && hasExportModifier(statement)) return true;
      return ts.isIdentifier(holder.name) && this.isExportedSymbol(this.context.checker.getSymbolAtLocation(holder.name));
    }
    if (!ts.isFunctionDeclaration(holder) && !ts.isClassDeclaration(holder)) return false;
    if (hasExportModifier(holder)) return true;
    return holder.name !== undefined && this.isExportedSymbol(this.context.checker.getSymbolAtLocation(holder.name));
  }

  /**
   * 심볼이 `export { x }`·`export default x`로 내보내졌는지 본다.
   *
   * @param symbol 심볼
   * @returns 내보냈으면 true
   */
  private isExportedSymbol(symbol: ts.Symbol | undefined): boolean {
    return symbol !== undefined && this.index.exportedSymbols.has(symbol);
  }
}

/**
 * 진입점과, 진입점에서 `alias`·`reference` 간선으로 닿는 노드(`export { h as GET }`, `export default h`의 h)다.
 * 프레임워크가 그 함수를 직접 부르기 때문이다.
 *
 * @param store 그래프 저장소(direct 간선만 있는 상태)
 * @param entryIds 진입점 id
 * @returns 노드 id 집합
 */
function entryClosure(store: GraphStore, entryIds: readonly string[]): Set<string> {
  const result = new Set(entryIds);
  const queue = [...entryIds];
  while (queue.length > 0) {
    for (const [to, kinds] of store.targetsOf(queue.pop()!)) {
      if ((kinds.has('alias') || kinds.has('reference')) && !result.has(to)) {
        result.add(to);
        queue.push(to);
      }
    }
  }
  return result;
}

/**
 * 열린 모듈들이 내보내는 선언 심볼 전부다. `export *`·`export { x } from`·`export * as ns` 배럴을 거친 내보내기도
 * 별칭을 풀어 넣고, 모듈 값 내보내기는 그 모듈까지 따라간다 — 받은 모듈 객체로 부르는 호출(`m.handle(...)`)은
 * 참조로 잡히지 않기 때문이다.
 *
 * @param checker TypeChecker
 * @param modules 열린 모듈 심볼
 * @returns 선언 심볼 집합
 */
function moduleExportClosure(checker: ts.TypeChecker, modules: ReadonlySet<ts.Symbol>): Set<ts.Symbol> {
  const result = new Set<ts.Symbol>();
  const visited = new Set<ts.Symbol>();
  const queue = [...modules];
  while (queue.length > 0) {
    const module = queue.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    for (const exported of checker.getExportsOfModule(module)) {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      if ((target.flags & ts.SymbolFlags.ValueModule) !== 0) queue.push(target);
      else result.add(target);
    }
  }
  return result;
}

/**
 * 함수·클래스 선언의 값 심볼이다(`const f = () => …`·`const C = class …`는 변수 심볼, 생성자는 클래스 심볼).
 *
 * @param checker TypeChecker
 * @param declaration 함수 계열·클래스
 * @returns 심볼 또는 undefined
 */
function declarationSymbol(checker: ts.TypeChecker, declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): ts.Symbol | undefined {
  if (ts.isConstructorDeclaration(declaration)) return declarationSymbol(checker, declaration.parent);
  const holder = ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration)
    ? climbWrappers(declaration).parent : declaration;
  const name = (holder as { name?: ts.Node }).name;
  return name !== undefined && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
}

/**
 * 선언이 만드는 그래프 노드 id다(함수는 본문 스코프, 클래스는 클래스·생성자 노드).
 *
 * @param declaration 함수 계열·클래스
 * @param path 프로젝트 기준 경로
 * @returns 노드 id 목록
 */
function declarationIds(declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration, path: string): string[] {
  if (!ts.isClassLike(declaration)) return declaration.body === undefined ? [] : [scopeIdOf(declaration.body, path)];
  const constructor = declaration.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined);
  const probe = declaration.name ?? declaration.members[0];
  return [...(probe === undefined ? [] : [scopeIdOf(probe, path)]), ...(constructor === undefined ? [] : [scopeIdOf(constructor.body!, path)])];
}

/**
 * `export` 수식어가 있는지 본다.
 *
 * @param node 선언·문장
 * @returns 있으면 true
 */
function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
