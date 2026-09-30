/**
 * Node 라우터 등록을 실행 순서대로 모으는 정적 해석기다. 분석 대상 코드는 실행하지 않는다.
 *
 * 걷기 규칙:
 * - 모든 프로젝트 모듈의 최상위 문장을 모듈 프레임에서 순서대로 걷는다.
 * - 호출 식은 평가 순서(수신자 체인·인자 → 호출)로 본다. 인자로 넘긴 함수 식(핸들러·콜백)은 지금 실행되지 않으므로 걷지
 *   않는다.
 * - 프레임워크 어댑터의 멤버 이름(`get`·`use`·`route`…)을 부르는 호출은 수신자를 라우터 대상으로 풀어 어댑터가 사건으로
 *   기록한다.
 * - 라우터를 인자로 받거나 라우터를 만드는 프로젝트 함수 호출(`registerRoutes(app)`, `createApp()`)은 새 프레임에서 그
 *   본문을 걷는다(매개변수 → 호출 인자 바인딩, 깊이 상한). 같은 호출·프레임은 한 번만 걷는다.
 * - if·switch·반복문·catch·`?:`·`&&`·`||`·`??` 아래의 사건은 조건부로 표시한다.
 * - 어느 프레임에서도 걷지 않은 함수 중 라우터 문법이 있는 것은 마지막에 독립 프레임으로 걷는다(프로젝트 밖에서 부르는
 *   `export default function (app: Hono)` 등). 이 사건들은 타임라인 뿌리가 달라 순서를 증명하지 않는다.
 */

import ts from 'typescript';

import { resolveHandler } from './handler-ref.ts';
import type { NodeProject } from './node-project.ts';
import {
  type Binding,
  type EventSite,
  type Frame,
  type HandlerInfo,
  type PathArgument,
  type PathValue,
  type RouterEvent,
  type RouterInstance,
  type RouterTarget,
} from './router-model.ts';
import { enclosingFunction, packageBindingOf, requireBinding, resolveAlias, symbolAt, unwrap } from './symbols.ts';
import {
  booleanOption,
  declarationValue,
  findBinding,
  frameForDeclaration,
  lookupProperty,
  type PropertyLookup,
  referencedExpression,
  resolveBooleanValue,
  resolveStringValue,
  type ValueEnvironment,
} from './value-resolver.ts';

/** 함수 호출을 따라 들어가는 최대 깊이다. */
export const MAX_CALL_DEPTH = 8;

/** 한 번의 해석에서 걷는 최대 호출 프레임 수다(거대한 프로젝트에서 끝없이 돌지 않게 한다). */
export const MAX_FRAMES = 20_000;

/** 어댑터가 만드는 인스턴스 명세다. */
export interface InstanceSpec {
  readonly kind: RouterInstance['kind'];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly parent?: RouterTarget;
}

/** 어댑터가 쓰는 해석기 기능이다. */
export interface InterpreterContext extends ValueEnvironment {
  readonly project: NodeProject;
  resolveTargets(expression: ts.Expression, frame: Frame): readonly RouterTarget[];
  resolvePath(expression: ts.Expression, frame: Frame): PathValue;
  /** 문자열 하나 또는 문자열 배열 리터럴을 경로 인자 목록으로 푼다 */
  resolvePaths(expression: ts.Expression, frame: Frame): PathArgument[];
  resolveBoolean(expression: ts.Expression, frame: Frame): boolean | undefined;
  booleanOption(options: ts.Expression | undefined, name: string, frame: Frame, fallback: boolean): boolean | undefined;
  lookupProperty(expression: ts.Expression, name: string, frame: Frame): PropertyLookup;
  resolveHandler(expression: ts.Expression, frame: Frame, nextParameterIndex: number, call: ts.Node): HandlerInfo;
  /** 식별자·속성 접근이 가리키는 값 식과 평가 프레임(변수 초기값·바인딩·객체 속성) */
  resolveReference(expression: ts.Expression, frame: Frame): { readonly expression: ts.Expression; readonly frame: Frame } | undefined;
  /**
   * 등록 호출의 첫 인자가 경로(문자열)인지 본다: 리터럴·확정한 문자열이면 경로, 함수·라우터·패키지 미들웨어로 풀리면 아니다.
   * 둘 다 아니면 타입이 문자열 계열이거나, 뒤에 인자가 더 있을 때(`use(prefix, router)`처럼 경로 자리) 경로로 본다 — 모르는
   * 경로는 dynamic·base가 되어 안전하지만, 경로를 미들웨어로 잘못 보면 붙인 라우터가 루트에 있다고 거짓으로 내게 된다.
   */
  isPathArgument(expression: ts.Expression, frame: Frame, hasMoreArguments?: boolean): boolean;
  /** 식이 가리키는 프로젝트 함수(플러그인·팩토리)와 그 정의 프레임 */
  resolveFunction(expression: ts.Expression, frame: Frame): { readonly node: ts.SignatureDeclaration; readonly frame: Frame } | undefined;
  /** 함수 본문을 새 프레임에서 걷는다(첫 매개변수에 대상을 묶을 수 있다) */
  interpretFunction(fn: ts.SignatureDeclaration, definitionFrame: Frame, site: EventSite, firstParameter?: readonly RouterTarget[]): void;
  instance(spec: InstanceSpec, framework: RouterInstance['framework'], node: ts.Node, frame: Frame): RouterInstance;
  emit(event: RouterEvent): void;
}

/** 프레임워크 어댑터다. */
export interface FrameworkAdapter {
  readonly framework: RouterInstance['framework'];
  /** 수신자를 풀어 볼 멤버 이름 */
  readonly memberNames: ReadonlySet<string>;
  /** 라우터 생성 식이면 명세를 돌려준다 */
  creation(node: ts.CallExpression | ts.NewExpression, context: InterpreterContext): InstanceSpec | undefined;
  /** 대상의 멤버 호출이 돌려주는 대상(체이닝·파생) */
  chain(target: RouterTarget, member: string, call: ts.CallExpression, frame: Frame, context: InterpreterContext): readonly RouterTarget[];
  /** 대상의 멤버 호출을 사건으로 기록한다 */
  record(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void;
  /** 타입 주석으로만 라우터임을 아는 매개변수의 명세 */
  opaque?(parameter: ts.ParameterDeclaration, context: InterpreterContext): InstanceSpec | undefined;
}

/** 해석 결과다. */
export interface InterpretationResult {
  readonly instances: readonly RouterInstance[];
  readonly events: readonly RouterEvent[];
  /** 깊이·프레임 상한으로 따라가지 못한 호출 수 */
  readonly truncatedCalls: number;
}

/**
 * 프로젝트를 해석한다.
 *
 * @param project 프로젝트
 * @param adapters 감지한 프레임워크 어댑터
 * @param includeFile 해석할 파일인지(테스트 소스 제외 등)
 * @returns 인스턴스·사건
 */
export function interpretProject(project: NodeProject, adapters: readonly FrameworkAdapter[], includeFile: (path: string) => boolean): InterpretationResult {
  const interpreter = new RouterInterpreter(project, adapters);
  for (const [path, sourceFile] of project.files) {
    if (includeFile(path)) interpreter.walkModule(sourceFile);
  }
  for (const [path, sourceFile] of project.files) {
    if (includeFile(path)) interpreter.walkStandaloneFunctions(sourceFile);
  }
  return interpreter.result();
}

/** 정적 해석기 본체다. */
class RouterInterpreter implements InterpreterContext {
  readonly project: NodeProject;
  readonly checker: ts.TypeChecker;
  private readonly adapters: readonly FrameworkAdapter[];
  private readonly memberNames: ReadonlySet<string>;
  private readonly moduleFrames = new Map<ts.SourceFile, Frame>();
  private readonly instances = new Map<string, RouterInstance>();
  private readonly events: RouterEvent[] = [];
  private readonly targetCache = new Map<ts.Node, Map<string, readonly RouterTarget[]>>();
  private readonly resolving = new Set<string>();
  private readonly callFrames = new Map<string, Frame>();
  private readonly interpretedFunctions = new Set<ts.Node>();
  private readonly activeFunctions = new Set<ts.Node>();
  private readonly routerSyntaxCache = new Map<ts.Node, boolean>();
  private frameCount = 0;
  private truncatedCalls = 0;

  /**
   * @param project 프로젝트
   * @param adapters 어댑터
   */
  constructor(project: NodeProject, adapters: readonly FrameworkAdapter[]) {
    this.project = project;
    this.checker = project.checker;
    this.adapters = adapters;
    this.memberNames = new Set(adapters.flatMap((adapter) => [...adapter.memberNames]));
  }

  /**
   * 해석 결과를 돌려준다.
   *
   * @returns 결과
   */
  result(): InterpretationResult {
    return { instances: [...this.instances.values()], events: this.events, truncatedCalls: this.truncatedCalls };
  }

  /**
   * 모듈 최상위를 걷는다.
   *
   * @param sourceFile 소스
   */
  walkModule(sourceFile: ts.SourceFile): void {
    this.walkStatements(sourceFile.statements, this.moduleFrame(sourceFile), false);
  }

  /**
   * 어느 프레임에서도 걷지 않은 라우터 문법 함수를 독립 프레임으로 걷는다.
   *
   * @param sourceFile 소스
   */
  walkStandaloneFunctions(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (isWalkableFunction(node) && !this.interpretedFunctions.has(node) && this.hasRouterSyntax(node)) {
        const path = this.project.pathOf(sourceFile) ?? sourceFile.fileName;
        const root = `standalone:${path}:${node.getStart(sourceFile)}`;
        const frame = this.newFrame({ id: root, root, timeline: [], parent: this.moduleFrame(sourceFile), functionNode: node, bindings: new Map(), conditional: false, depth: 1 });
        this.interpretedFunctions.add(node);
        this.walkFunctionBody(node, frame);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  /**
   * 파일의 모듈 프레임을 얻는다(없으면 만든다).
   *
   * @param sourceFile 소스
   * @returns 모듈 프레임
   */
  moduleFrame(sourceFile: ts.SourceFile): Frame {
    let frame = this.moduleFrames.get(sourceFile);
    if (frame === undefined) {
      const path = this.project.pathOf(sourceFile) ?? sourceFile.fileName;
      frame = { id: `module:${path}`, root: `module:${path}`, timeline: [], parent: undefined, functionNode: undefined, bindings: new Map(), conditional: false, depth: 0 };
      this.moduleFrames.set(sourceFile, frame);
    }
    return frame;
  }

  // --- 값 해석 ---

  /** @inheritdoc */
  resolvePath(expression: ts.Expression, frame: Frame): PathValue {
    return resolveStringValue(this, expression, frame);
  }

  /** @inheritdoc */
  resolvePaths(expression: ts.Expression, frame: Frame): PathArgument[] {
    const node = unwrap(expression);
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map((element) => ({ value: ts.isSpreadElement(element) ? { kind: 'unknown' } : this.resolvePath(element, frame), node: element }));
    }
    return [{ value: this.resolvePath(expression, frame), node: expression }];
  }

  /** @inheritdoc */
  resolveBoolean(expression: ts.Expression, frame: Frame): boolean | undefined {
    return resolveBooleanValue(this, expression, frame);
  }

  /** @inheritdoc */
  booleanOption(options: ts.Expression | undefined, name: string, frame: Frame, fallback: boolean): boolean | undefined {
    return booleanOption(this, options, name, frame, fallback);
  }

  /** @inheritdoc */
  lookupProperty(expression: ts.Expression, name: string, frame: Frame): PropertyLookup {
    return lookupProperty(this, expression, name, frame);
  }

  /** @inheritdoc */
  resolveHandler(expression: ts.Expression, frame: Frame, nextParameterIndex: number, call: ts.Node): HandlerInfo {
    return resolveHandler(this.project, expression, frame, nextParameterIndex, call);
  }

  /** @inheritdoc */
  isPathArgument(expression: ts.Expression, frame: Frame, hasMoreArguments = false): boolean {
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) return true;
    if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0 && !ts.isSpreadElement(node.elements[0]!) && this.isPathArgument(node.elements[0]!, frame, hasMoreArguments);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)) return false;
    if (this.resolvePath(node, frame).kind !== 'unknown') return true;
    if (this.resolveTargets(node, frame).length > 0 || this.resolveFunction(node, frame) !== undefined) return false;
    if (isStringTyped(this.checker, node)) return true;
    const callee = ts.isCallExpression(node) ? node.expression : node;
    return hasMoreArguments && packageBindingOf(this.checker, callee) === undefined && !ts.isCallExpression(node);
  }

  /** @inheritdoc */
  resolveReference(expression: ts.Expression, frame: Frame): { readonly expression: ts.Expression; readonly frame: Frame } | undefined {
    return referencedExpression(this, unwrap(expression), frame);
  }

  /** @inheritdoc */
  resolveFunction(expression: ts.Expression, frame: Frame): { readonly node: ts.SignatureDeclaration; readonly frame: Frame } | undefined {
    return this.functionOf(unwrap(expression), frame, 0);
  }

  /**
   * 식이 가리키는 프로젝트 함수를 찾는다(바인딩·변수·import·CommonJS `require`를 따라간다).
   *
   * @param node 식
   * @param frame 프레임
   * @param depth 추적 깊이
   * @returns 함수와 정의 프레임
   */
  private functionOf(node: ts.Expression, frame: Frame, depth: number): { readonly node: ts.SignatureDeclaration; readonly frame: Frame } | undefined {
    if (depth > MAX_CALL_DEPTH) return undefined;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return this.isProjectNode(node) ? { node, frame } : undefined;
    if (ts.isCallExpression(node)) {
      const module = this.requiredModule(node);
      const exported = module === undefined ? undefined : this.moduleExportExpression(module, 'default');
      return exported === undefined ? undefined : this.functionOf(unwrap(exported.expression), exported.frame, depth + 1);
    }
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;
    const symbol = symbolAt(this.checker, ts.isIdentifier(node) ? node : node.name);
    if (symbol === undefined) return undefined;
    const binding = findBinding(frame, symbol);
    if (binding?.expression !== undefined) return this.functionOf(unwrap(binding.expression), binding.frame, depth + 1);
    const declaration = resolveAlias(this.checker, symbol).valueDeclaration;
    if (declaration === undefined || !this.isProjectNode(declaration)) return undefined;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
      const definition = frameForDeclaration(this, declaration, frame) ?? this.moduleFrame(declaration.getSourceFile());
      return { node: declaration, frame: definition };
    }
    const value = declarationValue(this, declaration, frame);
    return value === undefined ? undefined : this.functionOf(unwrap(value.expression), value.frame, depth + 1);
  }

  /**
   * 노드가 분석 대상 프로젝트 파일에 있는지 본다.
   *
   * @param node 노드
   * @returns 프로젝트 파일이면 true
   */
  private isProjectNode(node: ts.Node): boolean {
    return this.project.pathOf(node.getSourceFile()) !== undefined;
  }

  // --- 라우터 대상 해석 ---

  /** @inheritdoc */
  resolveTargets(expression: ts.Expression, frame: Frame): readonly RouterTarget[] {
    const node = unwrap(expression);
    let byFrame = this.targetCache.get(node);
    const cached = byFrame?.get(frame.id);
    if (cached !== undefined) return cached;
    const key = `${frame.id}\u0000${node.pos}:${node.end}:${node.getSourceFile().fileName}`;
    if (this.resolving.has(key)) return [];
    this.resolving.add(key);
    const targets = this.computeTargets(node, frame);
    this.resolving.delete(key);
    if (byFrame === undefined) {
      byFrame = new Map();
      this.targetCache.set(node, byFrame);
    }
    byFrame.set(frame.id, targets);
    return targets;
  }

  /**
   * 식의 라우터 대상을 계산한다.
   *
   * @param node 벗긴 식
   * @param frame 프레임
   * @returns 대상 목록
   */
  private computeTargets(node: ts.Expression, frame: Frame): readonly RouterTarget[] {
    if (ts.isIdentifier(node)) return this.identifierTargets(node, frame);
    if (ts.isNewExpression(node)) return this.creationTargets(node, frame);
    if (ts.isCallExpression(node)) return this.callTargets(node, frame);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return this.memberTargets(node, frame);
    if (ts.isConditionalExpression(node)) return [...this.resolveTargets(node.whenTrue, frame), ...this.resolveTargets(node.whenFalse, frame)];
    return [];
  }

  /**
   * 식별자의 대상: 바인딩, 선언 초기값, 타입 주석으로만 아는 매개변수.
   *
   * @param node 식별자
   * @param frame 프레임
   * @returns 대상 목록
   */
  private identifierTargets(node: ts.Identifier, frame: Frame): readonly RouterTarget[] {
    const symbol = symbolAt(this.checker, node);
    if (symbol === undefined) return [];
    const binding = findBinding(frame, symbol);
    if (binding !== undefined) return this.bindingTargets(binding);
    const resolved = resolveAlias(this.checker, symbol);
    const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
    if (declaration === undefined) return [];
    if (ts.isSourceFile(declaration)) return this.moduleDefaultTargets(declaration);
    if (ts.isParameter(declaration)) return this.opaqueTargets(declaration);
    const value = declarationValue(this, declaration, frame);
    return value === undefined ? [] : this.resolveTargets(value.expression, value.frame);
  }

  /**
   * 바인딩의 대상을 얻는다.
   *
   * @param binding 바인딩
   * @returns 대상 목록
   */
  private bindingTargets(binding: Binding): readonly RouterTarget[] {
    if (binding.targets !== undefined) return binding.targets;
    return binding.expression === undefined ? [] : this.resolveTargets(binding.expression, binding.frame);
  }

  /**
   * 타입 주석(`app: Hono`)으로만 라우터임을 아는 매개변수의 대상이다. 붙는 위치를 모르므로 opaque 인스턴스다.
   *
   * @param parameter 매개변수
   * @returns 대상 목록
   */
  private opaqueTargets(parameter: ts.ParameterDeclaration): readonly RouterTarget[] {
    for (const adapter of this.adapters) {
      const spec = adapter.opaque?.(parameter, this);
      if (spec !== undefined) {
        const frame = this.moduleFrame(parameter.getSourceFile());
        return [{ instance: this.instance(spec, adapter.framework, parameter, frame), basePaths: [] }];
      }
    }
    return [];
  }

  /**
   * 생성 식의 대상이다.
   *
   * @param node 생성 식
   * @param frame 프레임
   * @returns 대상 목록
   */
  private creationTargets(node: ts.NewExpression | ts.CallExpression, frame: Frame): readonly RouterTarget[] {
    for (const adapter of this.adapters) {
      const spec = adapter.creation(node, this);
      if (spec !== undefined) return [{ instance: this.instance(spec, adapter.framework, node, frame), basePaths: [] }];
    }
    return [];
  }

  /**
   * 호출 식의 대상: 생성, `require`한 프로젝트 모듈, 대상의 체이닝 멤버, 라우터를 돌려주는 프로젝트 함수.
   *
   * @param node 호출 식
   * @param frame 프레임
   * @returns 대상 목록
   */
  private callTargets(node: ts.CallExpression, frame: Frame): readonly RouterTarget[] {
    const created = this.creationTargets(node, frame);
    if (created.length > 0) return created;
    const module = this.requiredModule(node);
    if (module !== undefined) return this.moduleDefaultTargets(module);
    const member = memberNameOf(node.expression);
    if (member !== undefined) {
      const receivers = this.resolveTargets(receiverOf(node.expression)!, frame);
      if (receivers.length > 0) return receivers.flatMap((receiver) => this.adapterOf(receiver).chain(receiver, member, node, frame, this));
    }
    const fn = this.functionOf(unwrap(node.expression), frame, 0);
    if (fn === undefined || !this.hasRouterSyntax(fn.node)) return [];
    const callFrame = this.interpretCall(fn.node, fn.frame, node, frame, false);
    return callFrame === undefined ? [] : this.returnTargets(fn.node, callFrame);
  }

  /**
   * 속성 접근의 대상: `require('./x').router`, 네임스페이스 import 멤버, `this.app`, 객체 속성.
   *
   * @param node 속성 접근
   * @param frame 프레임
   * @returns 대상 목록
   */
  private memberTargets(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, frame: Frame): readonly RouterTarget[] {
    const name = memberNameOf(node);
    if (name === undefined) return [];
    const base = unwrap(node.expression);
    if (ts.isCallExpression(base)) {
      const module = this.requiredModule(base);
      const exported = module === undefined ? undefined : this.moduleExportExpression(module, name);
      if (exported !== undefined) return this.resolveTargets(exported.expression, exported.frame);
    }
    const lookup = lookupProperty(this, node.expression, name, frame);
    if (lookup.kind === 'found') return this.resolveTargets(lookup.expression, lookup.frame);
    const symbol = symbolAt(this.checker, ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
    const declaration = symbol === undefined ? undefined : resolveAlias(this.checker, symbol).valueDeclaration;
    const value = declaration === undefined ? undefined : declarationValue(this, declaration, frame);
    return value === undefined ? [] : this.resolveTargets(value.expression, value.frame);
  }

  /**
   * 함수 본문의 return 식(화살표 식 본문 포함)이 가리키는 대상이다.
   *
   * @param fn 함수
   * @param frame 호출 프레임
   * @returns 대상 목록
   */
  private returnTargets(fn: ts.SignatureDeclaration, frame: Frame): readonly RouterTarget[] {
    const body = (fn as { body?: ts.Node }).body;
    if (body === undefined) return [];
    if (!ts.isBlock(body)) return this.resolveTargets(body as ts.Expression, frame);
    const targets: RouterTarget[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) targets.push(...this.resolveTargets(node.expression, frame));
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return targets;
  }

  /**
   * 대상의 프레임워크 어댑터를 얻는다.
   *
   * @param target 대상
   * @returns 어댑터
   */
  private adapterOf(target: RouterTarget): FrameworkAdapter {
    return this.adapters.find((adapter) => adapter.framework === target.instance.framework)!;
  }

  // --- 모듈 ---

  /**
   * `require('<프로젝트 상대 경로>')`가 가리키는 프로젝트 소스를 찾는다.
   *
   * @param call 호출 식
   * @returns 소스 또는 undefined
   */
  private requiredModule(call: ts.CallExpression): ts.SourceFile | undefined {
    const binding = requireBinding(call);
    if (binding === undefined || !binding.module.startsWith('.')) return undefined;
    const resolved = ts.resolveModuleName(binding.module, call.getSourceFile().fileName, this.project.program.getCompilerOptions(), ts.sys).resolvedModule;
    const sourceFile = resolved === undefined ? undefined : this.project.program.getSourceFile(resolved.resolvedFileName);
    return sourceFile !== undefined && this.isProjectNode(sourceFile) ? sourceFile : undefined;
  }

  /**
   * 모듈의 기본 내보내기(ESM `export default`, CommonJS `module.exports =`) 대상이다.
   *
   * @param sourceFile 소스
   * @returns 대상 목록
   */
  private moduleDefaultTargets(sourceFile: ts.SourceFile): readonly RouterTarget[] {
    const exported = this.moduleExportExpression(sourceFile, 'default');
    return exported === undefined ? [] : this.resolveTargets(exported.expression, exported.frame);
  }

  /**
   * 모듈이 내보낸 이름의 값 식을 찾는다. CommonJS `module.exports = x`는 `default`이고, 그 객체 리터럴의 속성과
   * `exports.name = x`는 이름 내보내기다.
   *
   * @param sourceFile 소스
   * @param name 내보낸 이름
   * @returns 값 식과 모듈 프레임
   */
  private moduleExportExpression(sourceFile: ts.SourceFile, name: string): { expression: ts.Expression; frame: Frame } | undefined {
    const frame = this.moduleFrame(sourceFile);
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && name === 'default') return { expression: statement.expression, frame };
      const assignment = commonJsAssignment(statement);
      if (assignment === undefined) continue;
      if (assignment.name === name) return { expression: assignment.value, frame };
      if (assignment.name === 'default' && name !== 'default') {
        const lookup = lookupProperty(this, assignment.value, name, frame);
        if (lookup.kind === 'found') return { expression: lookup.expression, frame: lookup.frame };
      }
    }
    const moduleSymbol = symbolAt(this.checker, sourceFile);
    const exported = moduleSymbol === undefined ? undefined : this.checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
    const declaration = exported === undefined ? undefined : resolveAlias(this.checker, exported).valueDeclaration;
    if (declaration === undefined) return undefined;
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return undefined;
    return declarationValue(this, declaration, frame);
  }

  // --- 인스턴스·사건 ---

  /** @inheritdoc */
  instance(spec: InstanceSpec, framework: RouterInstance['framework'], node: ts.Node, frame: Frame): RouterInstance {
    const key = `${framework}\u0000${frame.id}\u0000${node.pos}:${node.end}:${node.getSourceFile().fileName}`;
    let instance = this.instances.get(key);
    if (instance === undefined) {
      instance = { id: this.instances.size, framework, kind: spec.kind, node, frame, options: spec.options ?? {}, ...(spec.parent === undefined ? {} : { parent: spec.parent }) };
      this.instances.set(key, instance);
    }
    return instance;
  }

  /** @inheritdoc */
  emit(event: RouterEvent): void {
    this.events.push(event);
  }

  /** @inheritdoc */
  interpretFunction(fn: ts.SignatureDeclaration, definitionFrame: Frame, site: EventSite, firstParameter?: readonly RouterTarget[]): void {
    const bindings = new Map<ts.Symbol, Binding>();
    const first = fn.parameters[0];
    if (firstParameter !== undefined && first !== undefined && ts.isIdentifier(first.name)) {
      const symbol = symbolAt(this.checker, first.name);
      if (symbol !== undefined) bindings.set(symbol, { expression: undefined, frame: site.frame, targets: firstParameter });
    }
    this.enterFunction(fn, definitionFrame, site.node, site.frame, site.conditional, bindings);
  }

  /**
   * 함수 호출을 새 프레임에서 걷는다. 같은 (호출, 프레임)은 한 번만 걷는다.
   *
   * @param fn 함수
   * @param definitionFrame 함수를 정의한 프레임
   * @param call 호출 식
   * @param frame 호출한 프레임
   * @param conditional 호출이 조건부인지
   * @returns 호출 프레임(상한 초과·재귀면 undefined)
   */
  private interpretCall(fn: ts.SignatureDeclaration, definitionFrame: Frame, call: ts.CallExpression, frame: Frame, conditional: boolean): Frame | undefined {
    const bindings = new Map<ts.Symbol, Binding>();
    fn.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const symbol = symbolAt(this.checker, parameter.name);
      if (symbol !== undefined) bindings.set(symbol, { expression: call.arguments[index], frame });
    });
    return this.enterFunction(fn, definitionFrame, call, frame, conditional, bindings);
  }

  /**
   * 함수 본문을 새 프레임에서 걷는다.
   *
   * @param fn 함수
   * @param definitionFrame 정의 프레임(어휘적 부모)
   * @param call 호출 노드(위치·키)
   * @param frame 호출한 프레임
   * @param conditional 호출이 조건부인지
   * @param bindings 매개변수 바인딩
   * @returns 호출 프레임(상한 초과·재귀면 undefined)
   */
  private enterFunction(fn: ts.SignatureDeclaration, definitionFrame: Frame, call: ts.Node, frame: Frame, conditional: boolean, bindings: Map<ts.Symbol, Binding>): Frame | undefined {
    // 프레임 id는 group 이름의 해시에 들어가므로 절대 경로가 아니라 프로젝트 기준 경로로 만든다(기계마다 같게).
    const key = `${frame.id}>${call.pos}:${call.end}:${this.project.pathOf(call.getSourceFile()) ?? call.getSourceFile().fileName}`;
    const existing = this.callFrames.get(key);
    if (existing !== undefined) return existing;
    if (frame.depth >= MAX_CALL_DEPTH || this.frameCount >= MAX_FRAMES || this.activeFunctions.has(fn)) {
      this.truncatedCalls += 1;
      return undefined;
    }
    const callFrame = this.newFrame({
      id: key,
      root: frame.root,
      timeline: [...frame.timeline, call.getStart()],
      parent: definitionFrame,
      functionNode: fn,
      bindings,
      conditional: frame.conditional || conditional,
      depth: frame.depth + 1,
    });
    this.callFrames.set(key, callFrame);
    this.interpretedFunctions.add(fn);
    this.activeFunctions.add(fn);
    this.walkFunctionBody(fn, callFrame);
    this.activeFunctions.delete(fn);
    return callFrame;
  }

  /**
   * 프레임을 만들고 수를 센다.
   *
   * @param frame 프레임
   * @returns 같은 프레임
   */
  private newFrame(frame: Frame): Frame {
    this.frameCount += 1;
    return frame;
  }

  /**
   * 함수 본문을 걷는다.
   *
   * @param fn 함수
   * @param frame 프레임
   */
  private walkFunctionBody(fn: ts.SignatureDeclaration, frame: Frame): void {
    const body = (fn as { body?: ts.Node }).body;
    if (body === undefined) return;
    if (ts.isBlock(body)) this.walkStatements(body.statements, frame, false);
    else this.walkExpression(body as ts.Expression, frame, false);
  }

  /**
   * 함수에 라우터 문법(어댑터 멤버 호출·생성 식)이 있는지 본다(결과 캐시).
   *
   * @param fn 함수
   * @returns 있으면 true
   */
  private hasRouterSyntax(fn: ts.Node): boolean {
    const cached = this.routerSyntaxCache.get(fn);
    if (cached !== undefined) return cached;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && this.looksLikeRouterSyntax(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    this.routerSyntaxCache.set(fn, found);
    return found;
  }

  /**
   * 호출이 라우터 문법처럼 보이는지 본다(멤버 이름 또는 생성 식).
   *
   * @param node 호출·new 식
   * @returns 그렇다면 true
   */
  private looksLikeRouterSyntax(node: ts.CallExpression | ts.NewExpression): boolean {
    const member = memberNameOf(node.expression);
    if (member !== undefined && this.memberNames.has(member)) return true;
    return this.adapters.some((adapter) => adapter.creation(node, this) !== undefined);
  }

  // --- 문장·식 걷기 ---

  /**
   * 문장 목록을 순서대로 걷는다.
   *
   * @param statements 문장 목록
   * @param frame 프레임
   * @param conditional 조건부인지
   */
  private walkStatements(statements: readonly ts.Statement[], frame: Frame, conditional: boolean): void {
    for (const statement of statements) this.walkStatement(statement, frame, conditional);
  }

  /**
   * 문장 하나를 걷는다.
   *
   * @param statement 문장
   * @param frame 프레임
   * @param conditional 조건부인지
   */
  private walkStatement(statement: ts.Statement, frame: Frame, conditional: boolean): void {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return;
    if (ts.isBlock(statement)) return this.walkStatements(statement.statements, frame, conditional);
    if (ts.isIfStatement(statement)) {
      this.walkExpression(statement.expression, frame, conditional);
      this.walkStatement(statement.thenStatement, frame, true);
      if (statement.elseStatement !== undefined) this.walkStatement(statement.elseStatement, frame, true);
      return;
    }
    if (ts.isTryStatement(statement)) {
      this.walkStatements(statement.tryBlock.statements, frame, conditional);
      if (statement.catchClause !== undefined) this.walkStatements(statement.catchClause.block.statements, frame, true);
      if (statement.finallyBlock !== undefined) this.walkStatements(statement.finallyBlock.statements, frame, conditional);
      return;
    }
    if (ts.isIterationStatement(statement, false) || ts.isSwitchStatement(statement)) {
      ts.forEachChild(statement, (child) => this.walkNode(child, frame, true));
      return;
    }
    if (ts.isLabeledStatement(statement)) return this.walkStatement(statement.statement, frame, conditional);
    ts.forEachChild(statement, (child) => this.walkNode(child, frame, conditional));
  }

  /**
   * 문장·식 노드를 걷는다.
   *
   * @param node 노드
   * @param frame 프레임
   * @param conditional 조건부인지
   */
  private walkNode(node: ts.Node, frame: Frame, conditional: boolean): void {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (isStatementNode(node)) return this.walkStatement(node, frame, conditional);
    if (ts.isExpression(node)) return this.walkExpression(node, frame, conditional);
    ts.forEachChild(node, (child) => this.walkNode(child, frame, conditional));
  }

  /**
   * 식을 평가 순서로 걷는다.
   *
   * @param node 식
   * @param frame 프레임
   * @param conditional 조건부인지
   */
  private walkExpression(node: ts.Expression, frame: Frame, conditional: boolean): void {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isConditionalExpression(node)) {
      this.walkExpression(node.condition, frame, conditional);
      this.walkExpression(node.whenTrue, frame, true);
      this.walkExpression(node.whenFalse, frame, true);
      return;
    }
    if (ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind)) {
      this.walkExpression(node.left, frame, conditional);
      this.walkExpression(node.right, frame, true);
      return;
    }
    if (ts.isCallExpression(node)) {
      this.walkExpression(node.expression, frame, conditional);
      for (const argument of node.arguments) this.walkExpression(argument, frame, conditional);
      this.visitCall(node, frame, conditional);
      return;
    }
    ts.forEachChild(node, (child) => this.walkNode(child, frame, conditional));
  }

  /**
   * 호출 하나를 처리한다: 라우터 멤버 호출이면 어댑터가 기록하고, 아니면 라우터 문법이 있는 프로젝트 함수를 따라 들어간다.
   *
   * @param call 호출 식
   * @param frame 프레임
   * @param conditional 조건부인지
   */
  private visitCall(call: ts.CallExpression, frame: Frame, conditional: boolean): void {
    const member = memberNameOf(call.expression);
    if (member !== undefined && this.memberNames.has(member)) {
      const receivers = this.resolveTargets(receiverOf(call.expression)!, frame);
      if (receivers.length > 0) {
        const site = this.site(call, frame, conditional);
        for (const receiver of receivers) this.adapterOf(receiver).record(receiver, member, call, site, this);
        return;
      }
    }
    const fn = this.functionOf(unwrap(call.expression), frame, 0);
    if (fn !== undefined && this.hasRouterSyntax(fn.node)) this.interpretCall(fn.node, fn.frame, call, frame, conditional);
  }

  /**
   * 호출의 사건 위치를 만든다. 호출은 수신자 체인과 인자를 모두 평가한 **뒤** 실행되므로 호출 식의 끝 위치를 쓴다
   * (`app.get().post()`의 안쪽 호출이 먼저 끝나고, `app.route('/x', createSub())`의 팩토리 안 등록이 mount보다 앞선다).
   *
   * @param call 호출 식
   * @param frame 프레임
   * @param conditional 조건부인지
   * @returns 사건 위치
   */
  private site(call: ts.CallExpression, frame: Frame, conditional: boolean): EventSite {
    return { frame, position: [...frame.timeline, call.getEnd()], conditional: conditional || frame.conditional, node: call };
  }
}

/**
 * 식의 타입이 문자열 계열(문자열, 문자열 리터럴·템플릿 리터럴 타입, 그 합집합과 undefined)인지 본다.
 *
 * @param checker TypeChecker
 * @param node 식
 * @returns 문자열 계열이면 true
 */
function isStringTyped(checker: ts.TypeChecker, node: ts.Expression): boolean {
  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(node);
  } catch {
    // 타입을 계산하지 못하면 경로로 보지 않는다(미들웨어로 세면 요청을 넘긴다고 볼 뿐이다).
    return false;
  }
  const parts = type.isUnion() ? type.types : [type];
  const meaningful = parts.filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
  return meaningful.length > 0 && meaningful.every((part) => (part.flags & ts.TypeFlags.StringLike) !== 0);
}

/**
 * CommonJS 내보내기 대입(`module.exports = x`, `module.exports.name = x`, `exports.name = x`)을 읽는다.
 *
 * @param statement 문장
 * @returns 내보낸 이름(`default`는 `module.exports` 전체)과 값, 아니면 undefined
 */
function commonJsAssignment(statement: ts.Statement): { name: string; value: ts.Expression } | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined;
  const { left, operatorToken, right } = statement.expression;
  if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left)) return undefined;
  if (isModuleExports(left)) return { name: 'default', value: right };
  if (isModuleExports(left.expression) || (ts.isIdentifier(left.expression) && left.expression.text === 'exports')) return { name: left.name.text, value: right };
  return undefined;
}

/**
 * 식이 `module.exports`인지 본다.
 *
 * @param node 식
 * @returns 그렇다면 true
 */
function isModuleExports(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports';
}

/**
 * 호출 대상 식의 멤버 이름이다(`a.get` → `get`, `a['get']` → `get`).
 *
 * @param callee 호출 대상 식
 * @returns 이름 또는 undefined
 */
export function memberNameOf(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return callee.argumentExpression.text;
  return undefined;
}

/**
 * 멤버 호출 대상 식의 수신자 식이다.
 *
 * @param callee 호출 대상 식
 * @returns 수신자 또는 undefined
 */
export function receiverOf(callee: ts.Expression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
}

/**
 * 단락 평가 연산자(`&&`·`||`·`??`와 그 대입형)인지 본다.
 *
 * @param kind 연산자
 * @returns 그렇다면 true
 */
function isShortCircuit(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

/**
 * 노드가 문장인지 본다.
 *
 * @param node 노드
 * @returns 문장이면 true
 */
function isStatementNode(node: ts.Node): node is ts.Statement {
  return ts.isBlock(node) || ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isIfStatement(node)
    || ts.isIterationStatement(node, false) || ts.isReturnStatement(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)
    || ts.isLabeledStatement(node) || ts.isThrowStatement(node);
}

/**
 * 독립 프레임으로 걸을 수 있는 함수 선언인지 본다(본문 있는 함수·메서드·화살표·함수 식).
 *
 * @param node 노드
 * @returns 그렇다면 true
 */
function isWalkableFunction(node: ts.Node): node is ts.SignatureDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node))
    && node.body !== undefined;
}

/**
 * 노드를 감싼 함수가 없으면(모듈 최상위) true다.
 *
 * @param node 노드
 * @returns 모듈 최상위면 true
 */
export function isModuleLevel(node: ts.Node): boolean {
  return enclosingFunction(node) === undefined;
}
