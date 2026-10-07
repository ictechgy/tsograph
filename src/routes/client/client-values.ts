/** 실행 없이 불변 상수와 요청 설정을 읽는다. 심볼로 스코프·import를 구분한다. */
import ts from 'typescript';
import { declarationOf, resolveAlias, symbolAt, unwrap } from '../node/symbols.ts';
import { isNodeTestPath, type NodeProject } from '../node/node-project.ts';
import type { UrlPart } from './url-compose.ts';

const MAX_MUTATION_WORK = 20_000;
const MAX_PROJECTION_DEPTH = 16;
type ProjectionKey = string | number;
type ClosedNonClassProof = number | false | undefined;
type NamespaceRuntimeValue = ts.Expression | ts.ClassLikeDeclaration | ts.FunctionDeclaration;
type MutationWork = { readonly kind: 'value'; readonly expression: ts.Expression;
  readonly contentsMayEscape: boolean; readonly projection: readonly ProjectionKey[];
  readonly unresolvedIsIncomplete: boolean; readonly wholeContentsEscape: boolean }
  | { readonly kind: 'capture'; readonly node: ts.Node; readonly projection: readonly ProjectionKey[];
    readonly unresolvedIsIncomplete: boolean; readonly wholeContentsEscape: boolean }
  | { readonly kind: 'callable'; readonly expression: ts.Expression; readonly projection: readonly ProjectionKey[];
    readonly unresolvedIsIncomplete: boolean; readonly wholeContentsEscape: boolean };
interface MutationSource {
  readonly expression: ts.Expression;
  /** null은 rest/computed source라 후속 projection을 보존할 수 없다는 뜻이다. */
  readonly sourceProjection: readonly ProjectionKey[] | null;
  /** null은 dynamic store key라 어느 target projection과도 겹칠 수 있다는 뜻이다. */
  readonly targetProjection: readonly ProjectionKey[] | null;
}
interface ClassSource extends MutationSource {
  readonly mode: 'inherit' | 'value' | 'callable';
  readonly isStatic: boolean;
}
interface ClassReturnRoot {
  readonly targetProjection: readonly ProjectionKey[] | null;
  readonly body: ts.Block;
  readonly mode: 'value' | 'callable';
  readonly isStatic: boolean;
}
interface PendingClassStore {
  readonly target: ts.Expression;
  readonly expression: ts.Expression;
  readonly sourceProjection: readonly ProjectionKey[] | null;
  staticDestinationFound: boolean;
}

/** null은 전개·변경으로 전체 설정을 알 수 없다는 뜻이다. */
export type ClientConfig = ReadonlyMap<string, ts.Expression> | null;
/** 속성 없음(undefined)과 값 미상(null)을 구분한다. */
export type ConfigValue = ts.Expression | undefined | null;

/** 분석 중인 프로젝트의 변경 가능 심볼과 상수 해석기를 소유한다. */
export class ClientValues {
  readonly project: NodeProject;
  readonly mutated = new Set<ts.Symbol>();
  mutationAnalysisIncomplete = false;
  readonly #assignmentSources = new Map<ts.Symbol, MutationSource[]>();
  readonly #assignmentSourceIndex = new Map<ts.Symbol, Map<string, MutationSource[]>>();
  readonly #classSources = new Map<ts.ClassLikeDeclaration, ClassSource[]>();
  readonly #classSourceIndex = new Map<ts.ClassLikeDeclaration, Map<ts.Expression, Set<string>>>();
  readonly #classReturnRoots = new Map<ts.ClassLikeDeclaration, ClassReturnRoot[]>();
  readonly #materializedClassReturns = new Set<ClassReturnRoot>();
  readonly #unknownMemberStoreSources = new Set<ts.Expression>();
  readonly #subclasses = new Map<ts.ClassLikeDeclaration, Set<ts.ClassLikeDeclaration>>();
  readonly #ownedReceiverCache = new Map<ts.Symbol, Map<string,
    readonly { owner: ts.ClassLikeDeclaration; projection: readonly ProjectionKey[] | null }[]>>();
  readonly #rootClassReferenceCache = new Map<ts.Symbol, readonly ts.ClassLikeDeclaration[]>();
  readonly #ownedRootCacheEligible = new Map<ts.Symbol, boolean>();
  readonly #closedNonClassRoots = new Map<ts.Symbol, number | false>();
  readonly #mutationVisited = new Map<ts.Node, Set<string>>();
  readonly #assignmentExpansionVisited = new Map<ts.Symbol, Set<string>>();
  #buildWork = 0;
  #mutationWork = 0;
  #classSourceVersion = 0;
  #building = true;
  #bindingGraphComplete = false;

  /** 직접 대입·증감·Object.assign·interceptor 등록의 루트 심볼을 모은다. */
  constructor(project: NodeProject, includeTests = false) {
    this.project = project;
    const constructions: ts.NewExpression[] = [];
    const classStores: PendingClassStore[] = [];
    const projectClasses = new Set<ts.ClassLikeDeclaration>();
    for (const [path, source] of project.files) {
      if (!includeTests && isNodeTestPath(path)) continue;
      const indexAliases = (node: ts.Node): void => {
        if (ts.isClassLike(node)) projectClasses.add(node);
        if (ts.isPropertyDeclaration(node) && ts.isClassLike(node.parent) && node.initializer !== undefined) {
          const key = staticName(node.name);
          this.#addClassSource(node.parent, key === undefined ? null : [key], node.initializer, [],
            'inherit', staticMember(node));
        }
        if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && ts.isClassLike(node.parent)
          && node.body !== undefined) {
          const key = staticName(node.name);
          this.#addClassReturnRoot(node.parent, key === undefined ? null : [key], node.body,
            ts.isMethodDeclaration(node) ? 'value' : 'callable', staticMember(node));
        }
        if (ts.isConstructorDeclaration(node) && ts.isClassLike(node.parent)) {
          for (const parameter of node.parameters) {
            if (!ts.isIdentifier(parameter.name)) continue;
            const symbol = this.rootSymbol(parameter.name);
            if (symbol !== undefined && parameter.initializer !== undefined) {
              this.#addAssignmentSource(symbol, [], parameter.initializer, []);
            }
            if (ts.isParameterPropertyDeclaration(parameter, node)) {
              this.#addClassSource(node.parent, [parameter.name.text], parameter.name, []);
            }
          }
          if (node.body !== undefined) this.#addClassReturnRoot(node.parent, [], node.body, 'value', false);
        }
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind)) {
          this.#indexAssignmentSources(node.left, node.right);
        }
        if (ts.isForOfStatement(node)) {
          const initializer = node.initializer;
          if (ts.isVariableDeclarationList(initializer)) {
            for (const declaration of initializer.declarations) {
              this.#indexIterationBinding(declaration.name, node.expression);
            }
          } else this.#indexAssignmentSources(initializer, node.expression, null);
        }
        if (ts.isNewExpression(node)) constructions.push(node);
        ts.forEachChild(node, indexAliases);
      };
      indexAliases(source);
    }
    this.#bindingGraphComplete = true;
    for (const construction of constructions) this.#indexConstructionSources(construction);
    for (const [path, source] of project.files) {
      if (!includeTests && isNodeTestPath(path)) continue;
      const indexStores = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind)
          && memberAssignmentTarget(node.left)) {
          this.#collectClassStores(node.left, node.right, [], classStores);
        }
        if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)
          && memberAssignmentTarget(node.initializer)) {
          this.#collectClassStores(node.initializer, node.expression, null, classStores);
        }
        ts.forEachChild(node, indexStores);
      };
      indexStores(source);
    }
    let previousClassSourceVersion: number;
    do {
      previousClassSourceVersion = this.#classSourceVersion;
      for (const store of classStores) {
        if (!this.#chargeMutation()) break;
        this.#indexClassStore(store, 'static');
      }
    } while (!this.mutationAnalysisIncomplete && previousClassSourceVersion !== this.#classSourceVersion);
    if (!this.mutationAnalysisIncomplete) for (const store of classStores) {
      if (!this.#chargeMutation()) break;
      this.#indexClassStore(store, 'instance');
    }
    if (!this.mutationAnalysisIncomplete) for (const child of projectClasses) {
      const clauses = child.heritageClauses?.filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? [];
      if (clauses.length !== 1 || clauses[0]!.types.length !== 1) continue;
      for (const base of this.#projectClassReferences(clauses[0]!.types[0]!.expression)) {
        const children = this.#subclasses.get(base) ?? new Set();
        children.add(child); this.#subclasses.set(base, children);
      }
    }
    this.#building = false;
    if (!this.mutationAnalysisIncomplete) {
      for (const value of this.#unknownMemberStoreSources) this.markMutated(value, true);
    }
    for (const [path, source] of project.files) {
      if (!includeTests && isNodeTestPath(path)) continue;
      const visit = (node: ts.Node): void => {
        let target: ts.Expression | undefined;
        if (ts.isDeleteExpression(node)) target = node.expression;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) this.#markMutationTarget(node.left);
        if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
          this.#markMutationTarget(node.initializer);
        }
        if (ts.isForInStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
          this.#markMutationTarget(node.initializer);
        }
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === 'assign' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object') target = node.arguments[0];
          if (hasInterceptorAccess(node.expression)) target = node.expression.expression;
        }
        if (target !== undefined) {
          const value = unwrap(target);
          const access = ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
          this.markMutated(access ? value.expression : target, access, true, false);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  #addAssignmentSource(symbol: ts.Symbol, targetProjection: readonly ProjectionKey[] | null,
    expression: ts.Expression, sourceProjection: readonly ProjectionKey[] | null): void {
    const source = { expression, sourceProjection, targetProjection };
    const sources = this.#assignmentSources.get(symbol) ?? [];
    sources.push(source);
    this.#assignmentSources.set(symbol, sources);
    let index = this.#assignmentSourceIndex.get(symbol);
    if (index === undefined) { index = new Map(); this.#assignmentSourceIndex.set(symbol, index); }
    const key = targetProjection === null ? '*' : projectionPath(targetProjection);
    const bucket = index.get(key) ?? [];
    bucket.push(source); index.set(key, bucket);
  }

  #assignmentSourcesFor(symbol: ts.Symbol, projection: readonly ProjectionKey[] | null,
    whole: boolean): readonly MutationSource[] {
    if (whole || projection === null) return this.#assignmentSources.get(symbol) ?? [];
    const index = this.#assignmentSourceIndex.get(symbol);
    if (index === undefined) return [];
    const sources: MutationSource[] = projection.length === 0 ? [] : [...(index.get('*') ?? [])];
    for (let length = 0; length <= projection.length; length++) {
      sources.push(...(index.get(projectionPath(projection.slice(0, length))) ?? []));
    }
    return sources;
  }

  #canCacheOwnedRoot(symbol: ts.Symbol): boolean {
    const cached = this.#ownedRootCacheEligible.get(symbol);
    if (cached !== undefined) return cached;
    let eligible = true;
    for (const source of this.#assignmentSources.get(symbol) ?? []) {
      if (!this.#chargeMutation()) return false;
      if (source.targetProjection?.length !== 0 && !this.#definitelyPrimitive(source.expression)) {
        eligible = false; break;
      }
    }
    if (!this.mutationAnalysisIncomplete) this.#ownedRootCacheEligible.set(symbol, eligible);
    return eligible;
  }

  /** 완성된 binding graph에서 class/instance를 포함하지 않는 닫힌 root만 증명한다. */
  #closedNonClassRoot(symbol: ts.Symbol): boolean {
    if (!this.#bindingGraphComplete || this.mutationAnalysisIncomplete) return false;
    return typeof this.#closedNonClassSymbol(symbol, new Set(), 0) === 'number';
  }

  #closedNonClassSymbol(symbol: ts.Symbol, visiting: Set<ts.Symbol>, depth: number): ClosedNonClassProof {
    if (!this.#chargeMutation() || depth > MAX_PROJECTION_DEPTH) return undefined;
    const cached = this.#closedNonClassRoots.get(symbol);
    if (cached !== undefined) {
      return cached === false || depth + cached <= MAX_PROJECTION_DEPTH ? cached : undefined;
    }
    if (visiting.has(symbol)) {
      this.#closedNonClassRoots.set(symbol, false);
      return false;
    }
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || this.project.pathOf(declaration.getSourceFile()) === undefined) {
      this.#closedNonClassRoots.set(symbol, false);
      return false;
    }
    visiting.add(symbol);
    const initializer = this.#closedNonClassExpression(declaration.initializer, visiting, depth + 1);
    if (typeof initializer !== 'number') {
      visiting.delete(symbol);
      if (initializer === false) this.#closedNonClassRoots.set(symbol, false);
      return initializer;
    }
    let span = 1 + initializer;
    for (const source of this.#assignmentSources.get(symbol) ?? []) {
      if (!this.#chargeMutation()) { visiting.delete(symbol); return undefined; }
      const proof = this.#closedNonClassExpression(source.expression, visiting, depth + 1);
      if (typeof proof !== 'number') {
        visiting.delete(symbol);
        if (proof === false) this.#closedNonClassRoots.set(symbol, false);
        return proof;
      }
      span = Math.max(span, 1 + proof);
    }
    visiting.delete(symbol);
    if (!this.mutationAnalysisIncomplete) this.#closedNonClassRoots.set(symbol, span);
    return span;
  }

  #closedNonClassExpression(expression: ts.Expression, visiting: Set<ts.Symbol>, depth: number): ClosedNonClassProof {
    if (!this.#chargeMutation() || depth > MAX_PROJECTION_DEPTH) return undefined;
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
      || node.kind === ts.SyntaxKind.NullKeyword) return 0;
    if (ts.isIdentifier(node)) {
      const symbol = this.rootSymbol(node);
      if (symbol === undefined) return node.text === 'undefined' ? 0 : false;
      const proof = this.#closedNonClassSymbol(symbol, visiting, depth + 1);
      return typeof proof === 'number' ? 1 + proof : proof;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 0;
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.#closedNonClassExpression(node.whenTrue, visiting, depth + 1);
      if (typeof whenTrue !== 'number') return whenTrue;
      const whenFalse = this.#closedNonClassExpression(node.whenFalse, visiting, depth + 1);
      return typeof whenFalse === 'number' ? 1 + Math.max(whenTrue, whenFalse) : whenFalse;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const left = this.#closedNonClassExpression(node.left, visiting, depth + 1);
      if (typeof left !== 'number') return left;
      const right = this.#closedNonClassExpression(node.right, visiting, depth + 1);
      return typeof right === 'number' ? 1 + Math.max(left, right) : right;
    }
    if (ts.isObjectLiteralExpression(node)) {
      let span = 0;
      for (const property of node.properties) {
        if (!this.#chargeMutation()) return undefined;
        let proof: ClosedNonClassProof;
        if (ts.isPropertyAssignment(property)) {
          proof = this.#closedNonClassExpression(property.initializer, visiting, depth + 1);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          proof = this.#closedNonClassExpression(property.name, visiting, depth + 1);
        } else if (ts.isSpreadAssignment(property)) {
          proof = this.#closedNonClassExpression(property.expression, visiting, depth + 1);
        } else if (ts.isMethodDeclaration(property)) {
          span = Math.max(span, 1); continue;
        } else return false;
        if (typeof proof !== 'number') return proof;
        span = Math.max(span, 1 + proof);
      }
      return span;
    }
    if (ts.isArrayLiteralExpression(node)) {
      let span = 0;
      for (const element of node.elements) {
        if (!this.#chargeMutation()) return undefined;
        if (ts.isOmittedExpression(element)) { span = Math.max(span, 1); continue; }
        const proof = this.#closedNonClassExpression(ts.isSpreadElement(element) ? element.expression : element,
          visiting, depth + 1);
        if (typeof proof !== 'number') return proof;
        span = Math.max(span, 1 + proof);
      }
      return span;
    }
    return false;
  }

  /** immutable assignment edge만 symbol/state별로 한 번 확장한다. */
  #claimAssignmentExpansion(symbol: ts.Symbol, state: string): boolean {
    let states = this.#assignmentExpansionVisited.get(symbol);
    if (states?.has(state) === true) return false;
    if (states === undefined) { states = new Set(); this.#assignmentExpansionVisited.set(symbol, states); }
    states.add(state);
    return true;
  }

  #addClassSource(owner: ts.ClassLikeDeclaration, targetProjection: readonly ProjectionKey[] | null,
    expression: ts.Expression, sourceProjection: readonly ProjectionKey[] | null,
    mode: ClassSource['mode'] = 'inherit', isStatic = false): void {
    let byExpression = this.#classSourceIndex.get(owner);
    if (byExpression === undefined) { byExpression = new Map(); this.#classSourceIndex.set(owner, byExpression); }
    let states = byExpression.get(expression);
    if (states === undefined) { states = new Set(); byExpression.set(expression, states); }
    const state = `${mode}:${isStatic ? 'static' : 'instance'}:${classSourceProjection(targetProjection)}:${classSourceProjection(sourceProjection)}`;
    if (states.has(state)) return;
    states.add(state);
    const sources = this.#classSources.get(owner) ?? [];
    sources.push({ expression, sourceProjection, targetProjection, mode, isStatic });
    this.#classSources.set(owner, sources);
    this.#classSourceVersion++;
  }

  #addClassReturnRoot(owner: ts.ClassLikeDeclaration, targetProjection: readonly ProjectionKey[] | null,
    body: ts.Block, mode: ClassReturnRoot['mode'], isStatic: boolean): void {
    const roots = this.#classReturnRoots.get(owner) ?? [];
    roots.push({ targetProjection, body, mode, isStatic });
    this.#classReturnRoots.set(owner, roots);
  }

  /** nested callable을 실행했다고 가정하지 않고 member 자체의 direct return만 class source로 수집한다. */
  #indexClassReturns(owner: ts.ClassLikeDeclaration, root: ClassReturnRoot): void {
    const { targetProjection, body, mode, isStatic } = root;
    const pending: ts.Node[] = [body];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const current = pending.pop()!;
      if (ts.isReturnStatement(current) && current.expression !== undefined) {
        this.#addClassSource(owner, targetProjection, current.expression, [], mode, isStatic);
        continue;
      }
      if (current !== body && (ts.isFunctionLike(current) || ts.isClassLike(current))) continue;
      ts.forEachChild(current, child => {
        if (ts.isStatement(child) || ts.isBlock(child) || ts.isCaseBlock(child)
          || ts.isCaseClause(child) || ts.isDefaultClause(child) || ts.isCatchClause(child)) pending.push(child);
      });
    }
  }

  /** destructuring store를 static/instance closure에서 공유할 leaf로 한 번만 펼친다. */
  #collectClassStores(target: ts.Expression, source: ts.Expression,
    initialProjection: readonly ProjectionKey[] | null, stores: PendingClassStore[]): void {
    const pending: { readonly target: ts.Expression; readonly expression: ts.Expression;
      readonly sourceProjection: readonly ProjectionKey[] | null }[] = [
      { target, expression: source, sourceProjection: initialProjection },
    ];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const item = pending.pop()!;
      const current = unwrap(item.target);
      if (ts.isObjectLiteralExpression(current)) {
        for (const property of current.properties) {
          if (!this.#chargeMutation()) return;
          if (ts.isSpreadAssignment(property)) {
            pending.push({ target: property.expression, expression: item.expression, sourceProjection: null });
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const key = property.name === undefined ? undefined : staticName(property.name);
          pending.push({ target: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            expression: item.expression, sourceProjection: item.sourceProjection === null || key === undefined
              ? null : [...item.sourceProjection, key] });
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current)) {
        for (let index = 0; index < current.elements.length; index++) {
          if (!this.#chargeMutation()) return;
          const element = current.elements[index]!;
          if (ts.isOmittedExpression(element)) continue;
          const rest = ts.isSpreadElement(element);
          pending.push({ target: rest ? element.expression : element, expression: item.expression,
            sourceProjection: rest || item.sourceProjection === null ? null : [...item.sourceProjection, index] });
        }
        continue;
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        pending.push({ target: current.left, expression: item.expression, sourceProjection: item.sourceProjection });
        pending.push({ target: current.left, expression: current.right, sourceProjection: [] });
        continue;
      }
      stores.push({ target: current, expression: item.expression, sourceProjection: item.sourceProjection,
        staticDestinationFound: false });
    }
  }

  /** static source closure 뒤에만 instance destination과 unknown fallback을 확정한다. */
  #indexClassStore(store: PendingClassStore, phase: 'static' | 'instance'): void {
    const destinations = this.#classDestinations(store.target, phase);
    if (phase === 'static' && destinations.length > 0) store.staticDestinationFound = true;
    for (const destination of destinations) {
      this.#addClassSource(destination.owner, destination.projection, store.expression, store.sourceProjection,
        'inherit', destination.isStatic);
    }
    if (phase === 'instance' && destinations.length === 0 && !store.staticDestinationFound
      && (ts.isPropertyAccessExpression(store.target) || ts.isElementAccessExpression(store.target))
      && !this.#closedLocalMemberReceiver(store.target.expression)) {
      this.#unknownMemberStoreSources.add(store.expression);
    }
  }

  #classDestinations(expression: ts.Expression, phase: 'static' | 'instance'): readonly {
    readonly owner: ts.ClassLikeDeclaration; readonly projection: readonly ProjectionKey[] | null;
    readonly isStatic: boolean;
  }[] {
    const destinations: { owner: ts.ClassLikeDeclaration; projection: readonly ProjectionKey[] | null;
      isStatic: boolean }[] = [];
    if (phase === 'static') {
      let staticCandidate = unwrap(expression);
      const staticProjection: ProjectionKey[] = [];
      while (ts.isPropertyAccessExpression(staticCandidate) || ts.isElementAccessExpression(staticCandidate)) {
        const key = accessKey(staticCandidate);
        if (key === undefined) break;
        staticProjection.unshift(key);
        const receiver = unwrap(staticCandidate.expression);
        const owners = this.#projectClassReferences(receiver);
        if (owners.length > 0) {
          for (const owner of owners) destinations.push({ owner, projection: [...staticProjection], isStatic: true });
          break;
        }
        staticCandidate = receiver;
      }
      return destinations;
    }
    let current = unwrap(expression);
    const projection: ProjectionKey[] = [];
    let dynamic = false;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const key = accessKey(current);
      if (key === undefined) dynamic = true;
      else {
        projection.unshift(key);
        if (projection.length > MAX_PROJECTION_DEPTH) {
          this.mutationAnalysisIncomplete = true; return [];
        }
      }
      current = unwrap(current.expression);
    }
    for (const destination of this.#ownedClassReceivers(current, dynamic ? null : projection)) {
      destinations.push({ ...destination, isStatic: false });
    }
    return destinations;
  }

  #closedLocalMemberReceiver(expression: ts.Expression): boolean {
    const receiver = unwrap(expression);
    if (ts.isObjectLiteralExpression(receiver) || ts.isArrayLiteralExpression(receiver)) return true;
    if (!ts.isIdentifier(receiver)) return false;
    const symbol = this.rootSymbol(receiver);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
    const initializer = unwrap(declaration.initializer);
    return ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer);
  }

  /** 완성된 assignment graph에서 this/new/container alias의 class receiver와 남은 member path를 찾는다. */
  #ownedClassReceivers(expression: ts.Expression, initialProjection: readonly ProjectionKey[] | null): readonly {
    readonly owner: ts.ClassLikeDeclaration; readonly projection: readonly ProjectionKey[] | null;
  }[] {
    const root = unwrap(expression);
    const cacheSymbol = ts.isIdentifier(root) ? this.rootSymbol(root) : undefined;
    const cacheKey = initialProjection === null ? '*' : projectionPath(initialProjection);
    const cached = cacheSymbol === undefined ? undefined : this.#ownedReceiverCache.get(cacheSymbol)?.get(cacheKey);
    if (cached !== undefined) return cached;
    if (cacheSymbol !== undefined && this.#canCacheOwnedRoot(cacheSymbol)) {
      const closed = this.#closedNonClassRoot(cacheSymbol);
      if (this.mutationAnalysisIncomplete) return [];
      if (closed) {
        let byPath = this.#ownedReceiverCache.get(cacheSymbol);
        if (byPath === undefined) { byPath = new Map(); this.#ownedReceiverCache.set(cacheSymbol, byPath); }
        byPath.set(cacheKey, []);
        return [];
      }
    }
    const pending = [{ expression, projection: initialProjection, depth: 0 }];
    const visited = new Map<ts.Node, Set<string>>();
    const results: { owner: ts.ClassLikeDeclaration; projection: readonly ProjectionKey[] | null }[] = [];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return results;
      const item = pending.pop()!;
      if (item.depth > MAX_PROJECTION_DEPTH) {
        this.mutationAnalysisIncomplete = true; return results;
      }
      const current = unwrap(item.expression);
      const state = item.projection === null ? '*'
        : item.projection.map(projectionState).join('/');
      let states = visited.get(current);
      if (states?.has(state) === true) continue;
      if (states === undefined) { states = new Set(); visited.set(current, states); }
      states.add(state);
      if (current.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = lexicalThisClass(current);
        if (owner !== undefined) results.push({ owner, projection: item.projection });
        continue;
      }
      if (ts.isNewExpression(current)) {
        for (const owner of this.#constructedClasses(current)) results.push({ owner, projection: item.projection });
        continue;
      }
      if (ts.isConditionalExpression(current)) {
        pending.push({ expression: current.whenTrue, projection: item.projection, depth: item.depth + 1 },
          { expression: current.whenFalse, projection: item.projection, depth: item.depth + 1 });
        continue;
      }
      if (ts.isBinaryExpression(current) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) {
        if (current.operatorToken.kind !== ts.SyntaxKind.CommaToken) pending.push({
          expression: current.left, projection: item.projection, depth: item.depth + 1,
        });
        pending.push({ expression: current.right, projection: item.projection, depth: item.depth + 1 });
        continue;
      }
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        const key = accessKey(current);
        pending.push({ expression: current.expression,
          projection: key === undefined || item.projection === null ? null : [key, ...item.projection],
          depth: item.depth + 1 });
        continue;
      }
      if (ts.isObjectLiteralExpression(current)) {
        const key = item.projection?.[0];
        const rest = item.projection === null ? null : item.projection.slice(1);
        for (const property of current.properties) {
          if (!this.#chargeMutation()) return results;
          if (ts.isSpreadAssignment(property)) {
            pending.push({ expression: property.expression, projection: item.projection, depth: item.depth + 1 });
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const name = property.name === undefined ? undefined : staticName(property.name);
          if (item.projection !== null && property.name !== undefined && !ts.isComputedPropertyName(property.name)
            && name !== String(key)) continue;
          pending.push({ expression: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            projection: rest, depth: item.depth + 1 });
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current)) {
        if (item.projection === null) {
          for (const element of current.elements) {
            if (!this.#chargeMutation()) return results;
            if (!ts.isOmittedExpression(element)) pending.push({
              expression: ts.isSpreadElement(element) ? element.expression : element,
              projection: null, depth: item.depth + 1,
            });
          }
          continue;
        }
        const key = item.projection[0];
        const index = typeof key === 'number' ? key : key === undefined ? undefined : arrayIndexKey(key);
        if (index === undefined) continue;
        let uncertainIndex = false;
        for (let position = 0; position < current.elements.length && position <= index; position++) {
          if (!this.#chargeMutation()) return results;
          if (ts.isSpreadElement(current.elements[position]!)) { uncertainIndex = true; break; }
        }
        if (uncertainIndex) {
          pending.push({ expression: current, projection: null, depth: item.depth + 1 });
          continue;
        }
        const element = current.elements[index];
        if (element !== undefined && !ts.isOmittedExpression(element)) pending.push({
          expression: ts.isSpreadElement(element) ? element.expression : element,
          projection: item.projection.slice(1), depth: item.depth + 1,
        });
        continue;
      }
      if (!ts.isIdentifier(current)) continue;
      const symbol = this.rootSymbol(current);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        pending.push({ expression: declaration.initializer, projection: item.projection, depth: item.depth + 1 });
      } else if (declaration !== undefined && ts.isBindingElement(declaration)) {
        for (const source of bindingSources(declaration)) pending.push({ expression: source.expression,
          projection: source.projection === null || item.projection === null
            ? null : [...source.projection, ...item.projection], depth: item.depth + 1 });
      }
      if (symbol !== undefined) for (const source of this.#assignmentSourcesFor(symbol, item.projection,
        item.projection === null)) {
        let projection = item.projection === null ? source.sourceProjection
          : provenanceProjection(source, item.projection, false);
        if (projection !== undefined && (source.sourceProjection === null || source.targetProjection === null)) {
          projection = null;
        }
        if (projection !== undefined) pending.push({ expression: source.expression,
          projection, depth: item.depth + 1 });
      }
    }
    if (cacheSymbol !== undefined) {
      let byPath = this.#ownedReceiverCache.get(cacheSymbol);
      if (byPath === undefined) { byPath = new Map(); this.#ownedReceiverCache.set(cacheSymbol, byPath); }
      byPath.set(cacheKey, results);
    }
    return results;
  }

  /** 직접 project-class new의 인자를 constructor parameter source에 보수적으로 합친다. */
  #indexConstructionSources(allocation: ts.NewExpression): void {
    const args = allocation.arguments ?? [];
    for (const owner of this.#constructedClasses(allocation)) {
      const constructor = owner.members.find(ts.isConstructorDeclaration);
      if (constructor === undefined) continue;
      for (let index = 0; index < constructor.parameters.length; index++) {
        if (!this.#chargeMutation()) return;
        const parameter = constructor.parameters[index]!;
        if (!ts.isIdentifier(parameter.name)) continue;
        const symbol = this.rootSymbol(parameter.name);
        if (symbol === undefined) continue;
        const argument = args[index];
        if (argument !== undefined && !ts.isSpreadElement(argument)) {
          this.#addAssignmentSource(symbol, [], argument, []);
        } else {
          for (const candidate of args) if (ts.isSpreadElement(candidate)) {
            this.#addAssignmentSource(symbol, [], candidate.expression, null);
          }
        }
      }
    }
  }

  #constructedClasses(allocation: ts.NewExpression): readonly ts.ClassLikeDeclaration[] {
    return this.#projectClassReferences(allocation.expression);
  }

  /** project-owned mutable/conditional class values의 가능한 class source를 bounded하게 합친다. */
  #projectClassReferences(expression: ts.Expression): readonly ts.ClassLikeDeclaration[] {
    const initial = unwrap(expression);
    const cacheSymbol = ts.isIdentifier(initial) ? this.rootSymbol(initial) : undefined;
    if (this.#building && cacheSymbol !== undefined) {
      const closed = this.#closedNonClassRoot(cacheSymbol);
      if (this.mutationAnalysisIncomplete || closed) return [];
    }
    const cached = this.#building || this.mutationAnalysisIncomplete || cacheSymbol === undefined
      ? undefined : this.#rootClassReferenceCache.get(cacheSymbol);
    if (cached !== undefined) return cached;
    const incompleteBefore = this.mutationAnalysisIncomplete;
    const pending: { expression: ts.Expression; projection: readonly ProjectionKey[] | null; depth: number }[] = [
      { expression, projection: [], depth: 0 },
    ];
    const visited = new Map<ts.Node, Set<string>>();
    const classes = new Set<ts.ClassLikeDeclaration>();
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return [...classes];
      const item = pending.pop()!;
      if (item.depth > MAX_PROJECTION_DEPTH) {
        this.mutationAnalysisIncomplete = true; return [...classes];
      }
      const current = unwrap(item.expression);
      const state = item.projection === null ? '*' : item.projection.map(projectionState).join('/');
      let states = visited.get(current);
      if (states?.has(state) === true) continue;
      if (states === undefined) { states = new Set(); visited.set(current, states); }
      states.add(state);
      if (ts.isClassExpression(current) && this.project.pathOf(current.getSourceFile()) !== undefined) {
        if (item.projection === null || item.projection.length === 0) classes.add(current);
        else for (const source of this.#staticClassProjectedSources(current, item.projection)) pending.push({
          expression: source.expression, projection: source.projection, depth: item.depth + 1,
        });
        continue;
      }
      if (ts.isConditionalExpression(current)) {
        pending.push({ expression: current.whenTrue, projection: item.projection, depth: item.depth + 1 },
          { expression: current.whenFalse, projection: item.projection, depth: item.depth + 1 });
        continue;
      }
      if (ts.isBinaryExpression(current) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) {
        if (current.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
          pending.push({ expression: current.left, projection: item.projection, depth: item.depth + 1 });
        }
        pending.push({ expression: current.right, projection: item.projection, depth: item.depth + 1 });
        continue;
      }
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        const key = accessKey(current);
        if (key !== undefined) pending.push({ expression: current.expression,
          projection: item.projection === null ? null : [key, ...item.projection], depth: item.depth + 1 });
        continue;
      }
      if (ts.isObjectLiteralExpression(current) && (item.projection === null || item.projection.length > 0)) {
        const key = item.projection?.[0];
        const rest = item.projection === null ? null : item.projection.slice(1);
        for (const property of current.properties) {
          if (!this.#chargeMutation()) return [...classes];
          if (ts.isSpreadAssignment(property)) {
            pending.push({ expression: property.expression, projection: item.projection, depth: item.depth + 1 });
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const name = property.name === undefined ? undefined : staticName(property.name);
          if (item.projection !== null && property.name !== undefined && !ts.isComputedPropertyName(property.name)
            && name !== String(key)) continue;
          pending.push({ expression: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            projection: rest, depth: item.depth + 1 });
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current) && (item.projection === null || item.projection.length > 0)) {
        if (item.projection === null) {
          for (const element of current.elements) {
            if (!this.#chargeMutation()) return [...classes];
            if (!ts.isOmittedExpression(element)) pending.push({
              expression: ts.isSpreadElement(element) ? element.expression : element,
              projection: null, depth: item.depth + 1,
            });
          }
          continue;
        }
        const [key, ...rest] = item.projection;
        const index = typeof key === 'number' ? key : key === undefined ? undefined : arrayIndexKey(key);
        if (index !== undefined) {
          let uncertainIndex = false;
          for (let position = 0; position < current.elements.length && position <= index; position++) {
            if (!this.#chargeMutation()) return [...classes];
            if (ts.isSpreadElement(current.elements[position]!)) { uncertainIndex = true; break; }
          }
          if (uncertainIndex) {
            pending.push({ expression: current, projection: null, depth: item.depth + 1 });
            continue;
          }
          const element = current.elements[index];
          if (element !== undefined && !ts.isOmittedExpression(element)) pending.push({
            expression: ts.isSpreadElement(element) ? element.expression : element,
            projection: rest, depth: item.depth + 1,
          });
        }
        continue;
      }
      if (!ts.isIdentifier(current)) continue;
      const namespaceValues = this.#namespaceProjectedValues(current, item.projection ?? [], item.projection === null);
      if (namespaceValues !== undefined) {
        for (const value of namespaceValues) {
          if (ts.isClassLike(value.node)) {
            if (value.projection.length === 0) classes.add(value.node);
            else for (const source of this.#staticClassProjectedSources(value.node, value.projection)) pending.push({
              expression: source.expression, projection: source.projection, depth: item.depth + 1,
            });
          } else if (ts.isExpression(value.node)) pending.push({ expression: value.node,
            projection: value.projection, depth: item.depth + 1 });
        }
        continue;
      }
      const shorthand = ts.isShorthandPropertyAssignment(current.parent)
        ? this.project.checker.getShorthandAssignmentValueSymbol(current.parent) : undefined;
      const raw = shorthand ?? symbolAt(this.project.checker, current);
      const symbol = raw === undefined ? undefined : resolveAlias(this.project.checker, raw);
      if (symbol === undefined) continue;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (declaration === undefined || this.project.pathOf(declaration.getSourceFile()) === undefined) continue;
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
        if (item.projection === null || item.projection.length === 0) classes.add(declaration);
        else for (const source of this.#staticClassProjectedSources(declaration, item.projection)) pending.push({
          expression: source.expression, projection: source.projection, depth: item.depth + 1,
        });
        continue;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        pending.push({ expression: declaration.initializer, projection: item.projection, depth: item.depth + 1 });
      } else if (ts.isBindingElement(declaration)) {
        for (const source of bindingSources(declaration)) pending.push({ expression: source.expression,
          projection: source.projection === null || item.projection === null
            ? null : [...source.projection, ...item.projection],
          depth: item.depth + 1 });
      }
      for (const source of this.#assignmentSourcesFor(symbol, item.projection, false)) {
        let projection = item.projection === null
          ? source.targetProjection?.length === 0 ? source.sourceProjection : undefined
          : provenanceProjection(source, item.projection, false);
        if (projection !== undefined && (source.sourceProjection === null || source.targetProjection === null)) {
          projection = null;
        }
        if (projection !== undefined) pending.push({ expression: source.expression,
          projection, depth: item.depth + 1 });
      }
    }
    const result = [...classes];
    if (!this.#building && !incompleteBefore && !this.mutationAnalysisIncomplete && cacheSymbol !== undefined) {
      this.#rootClassReferenceCache.set(cacheSymbol, result);
    }
    return result;
  }

  /** 타입 주석이 namespace의 runtime 수신자 출처를 대신하지 못하게 한다. */
  #namespaceValue(expression: ts.Expression): boolean {
    return this.#namespaceModule(expression) !== undefined;
  }

  #namespaceModule(expression: ts.Expression): ts.Symbol | undefined {
    let current = unwrap(expression);
    const visited = new Set<ts.Symbol>();
    for (let depth = 0; depth <= MAX_PROJECTION_DEPTH; depth++) {
      if (!this.#chargeMutation() || !ts.isIdentifier(current)) return undefined;
      const symbol = symbolAt(this.project.checker, current);
      if (symbol === undefined || visited.has(symbol)) return undefined;
      visited.add(symbol);
      const declaration = symbol.declarations?.[0];
      if (declaration !== undefined && ts.isNamespaceImport(declaration)) {
        return declaration.parent.isTypeOnly ? undefined : resolveAlias(this.project.checker, symbol);
      }
      if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0
        || this.project.pathOf(declaration.getSourceFile()) === undefined) return undefined;
      current = unwrap(declaration.initializer);
    }
    this.mutationAnalysisIncomplete = true;
    return undefined;
  }

  #namespaceProjectedValues(expression: ts.Expression, projection: readonly ProjectionKey[], whole: boolean):
    readonly { readonly node: NamespaceRuntimeValue; readonly projection: readonly ProjectionKey[] }[] | undefined {
    const module = this.#namespaceModule(expression);
    if (module === undefined) return undefined;
    const exports = this.project.checker.getExportsOfModule(module);
    const selected = projection.length === 0
      ? whole ? exports : []
      : exports.filter(symbol => symbol.getName() === String(projection[0]));
    const rest = projection.length === 0 ? [] : projection.slice(1);
    const values: { node: NamespaceRuntimeValue; projection: readonly ProjectionKey[] }[] = [];
    for (const exported of selected) {
      if (!this.#chargeMutation()) return values;
      const symbol = resolveAlias(this.project.checker, exported);
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.find(candidate =>
        ts.isVariableDeclaration(candidate) || ts.isBindingElement(candidate) || ts.isFunctionDeclaration(candidate)
        || ts.isClassDeclaration(candidate) || ts.isExportAssignment(candidate));
      if (declaration === undefined) continue;
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        values.push({ node: declaration.name, projection: rest });
      } else if (ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name)) {
        values.push({ node: declaration.name, projection: rest });
      } else if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
        values.push({ node: declaration, projection: rest });
      } else if (ts.isExportAssignment(declaration)) values.push({ node: declaration.expression, projection: rest });
    }
    return values;
  }

  /** assignment pattern leaf와 RHS projection을 같은 immutable provenance edge로 기록한다. */
  #indexAssignmentSources(target: ts.Expression, source: ts.Expression,
    initialProjection: readonly ProjectionKey[] | null = []): void {
    const pending: { readonly target: ts.Expression; readonly source: ts.Expression;
      readonly sourceProjection: readonly ProjectionKey[] | null }[] = [
      { target, source, sourceProjection: initialProjection },
    ];
    const visited = new Map<ts.Node, Set<string>>();
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const item = pending.pop()!;
      const current = unwrap(item.target);
      if (item.sourceProjection !== null && item.sourceProjection.length > MAX_PROJECTION_DEPTH) {
        this.mutationAnalysisIncomplete = true; return;
      }
      const projectionKey = item.sourceProjection === null ? '*'
        : item.sourceProjection.map(projectionState).join('/');
      let states = visited.get(current);
      if (states?.has(projectionKey) === true) continue;
      if (states === undefined) { states = new Set(); visited.set(current, states); }
      states.add(projectionKey);
      if (ts.isObjectLiteralExpression(current)) {
        for (const property of current.properties) {
          if (!this.#chargeMutation()) return;
          if (ts.isSpreadAssignment(property)) {
            pending.push({ target: property.expression, source: item.source, sourceProjection: null });
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const key = property.name === undefined ? undefined : staticName(property.name);
          const projection = item.sourceProjection === null || key === undefined
            ? null : [...item.sourceProjection, key];
          pending.push({ target: ts.isPropertyAssignment(property) ? property.initializer : property.name,
            source: item.source, sourceProjection: projection });
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current)) {
        for (let index = 0; index < current.elements.length; index++) {
          if (!this.#chargeMutation()) return;
          const element = current.elements[index]!;
          if (ts.isOmittedExpression(element)) continue;
          const rest = ts.isSpreadElement(element);
          pending.push({ target: rest ? element.expression : element, source: item.source,
            sourceProjection: rest || item.sourceProjection === null
              ? null : [...item.sourceProjection, index] });
        }
        continue;
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        pending.push({ target: current.left, source: item.source, sourceProjection: item.sourceProjection });
        pending.push({ target: current.left, source: current.right, sourceProjection: [] });
        continue;
      }
      const destination = this.#assignmentDestination(current);
      if (destination === undefined) continue;
      this.#addAssignmentSource(destination.symbol, destination.projection, item.source, item.sourceProjection);
    }
  }

  /** property/index store의 root symbol과 static target path를 분리한다. */
  #assignmentDestination(expression: ts.Expression): {
    readonly symbol: ts.Symbol; readonly projection: readonly ProjectionKey[] | null;
  } | undefined {
    let current = unwrap(expression);
    const projection: ProjectionKey[] = [];
    let dynamic = false;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const key = accessKey(current);
      if (key === undefined) dynamic = true;
      else {
        projection.unshift(key);
        if (projection.length > MAX_PROJECTION_DEPTH) {
          this.mutationAnalysisIncomplete = true; return undefined;
        }
      }
      current = unwrap(current.expression);
    }
    if (!ts.isIdentifier(current)) return undefined;
    const symbol = this.rootSymbol(current);
    return symbol === undefined ? undefined : { symbol, projection: dynamic ? null : projection };
  }

  /** for-of binding은 iteration protocol이 재색인하므로 iterable 전체를 보수적 source로 둔다. */
  #indexIterationBinding(name: ts.BindingName, source: ts.Expression): void {
    const pending: ts.BindingName[] = [name];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const current = pending.pop()!;
      if (ts.isIdentifier(current)) {
        const symbol = this.rootSymbol(current);
        if (symbol !== undefined) {
          this.#addAssignmentSource(symbol, [], source, null);
        }
        continue;
      }
      if (ts.isObjectBindingPattern(current)) {
        for (const element of current.elements) pending.push(element.name);
      } else {
        for (const element of current.elements) if (ts.isBindingElement(element)) pending.push(element.name);
      }
    }
  }

  /** 한 ClientValues instance의 alias/escape traversal 전체가 같은 20k work를 공유한다. */
  #chargeMutation(): boolean {
    const work = this.#building ? this.#buildWork : this.#mutationWork;
    if (work >= MAX_MUTATION_WORK) {
      this.mutationAnalysisIncomplete = true;
      return false;
    }
    if (this.#building) this.#buildWork++;
    else this.#mutationWork++;
    return true;
  }

  /** 대입 pattern은 값 projection이 아니라 실제로 쓰이는 receiver/binding을 순회한다. */
  #markMutationTarget(expression: ts.Expression): void {
    const pending = [expression];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const current = unwrap(pending.pop()!);
      let states = this.#mutationVisited.get(current);
      if (states?.has('target') === true) continue;
      if (states === undefined) { states = new Set(); this.#mutationVisited.set(current, states); }
      states.add('target');
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        this.markMutated(current.expression, true, true, false); continue;
      }
      if (ts.isObjectLiteralExpression(current)) {
        for (const property of current.properties) {
          if (!this.#chargeMutation()) return;
          if (ts.isPropertyAssignment(property)) pending.push(property.initializer);
          else if (ts.isShorthandPropertyAssignment(property)) pending.push(property.name);
          else if (ts.isSpreadAssignment(property)) pending.push(property.expression);
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(current)) {
        for (const element of current.elements) {
          if (!this.#chargeMutation()) return;
          if (!ts.isOmittedExpression(element)) pending.push(ts.isSpreadElement(element) ? element.expression : element);
        }
        continue;
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        pending.push(current.left); continue;
      }
      this.markMutated(current, false, true, false);
    }
  }

  /** 속성 접근의 루트 식별자에 붙은 심볼이다. */
  rootSymbol(expression: ts.Expression): ts.Symbol | undefined {
    let node = unwrap(expression);
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = unwrap(node.expression);
    if (!ts.isIdentifier(node)) return undefined;
    const shorthand = ts.isShorthandPropertyAssignment(node.parent)
      ? this.project.checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const rawSymbol = shorthand ?? symbolAt(this.project.checker, node);
    const symbol = rawSymbol === undefined ? undefined : resolveAlias(this.project.checker, rawSymbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration !== undefined && this.project.pathOf(declaration.getSourceFile()) !== undefined && ts.isVariableDeclaration(declaration)
      ? symbolAt(this.project.checker, declaration.name) : symbol;
  }

  /** 같은 객체를 가리키는 상수 별칭과 escape된 컨테이너를 bounded worklist로 변경 대상으로 기록한다. */
  markMutated(expression: ts.Expression, contentsMayEscape = false, unresolvedIsIncomplete = false,
    wholeContentsEscape = contentsMayEscape): void {
    if (this.mutationAnalysisIncomplete) {
      const symbol = this.rootSymbol(expression);
      if (symbol !== undefined) this.mutated.add(symbol);
      return;
    }
    const pending: MutationWork[] = [{ kind: 'value', expression, contentsMayEscape,
      projection: [], unresolvedIsIncomplete, wholeContentsEscape }];
    while (pending.length > 0) {
      if (!this.#chargeMutation()) return;
      const current = pending.pop()!;
      const node = current.kind === 'capture' ? current.node : unwrap(current.expression);
      if (current.projection.length > MAX_PROJECTION_DEPTH) {
        this.mutationAnalysisIncomplete = true; return;
      }
      const projection = current.projection.map(projectionState).join('/');
      const state = current.kind === 'capture' || current.kind === 'callable'
        ? `${current.kind}:${current.unresolvedIsIncomplete ? 'required' : 'optional'}:${current.wholeContentsEscape ? 'whole' : 'exact'}:${projection}`
        : `${current.contentsMayEscape ? 'escape' : 'direct'}:${current.unresolvedIsIncomplete ? 'required' : 'optional'}:${current.wholeContentsEscape ? 'whole' : 'exact'}:${projection}`;
      let states = this.#mutationVisited.get(node);
      if (states?.has(state) === true) continue;
      if (states === undefined) { states = new Set(); this.#mutationVisited.set(node, states); }
      states.add(state);
      if (current.kind === 'capture') {
        if (ts.isReturnStatement(node) && node.expression !== undefined) {
          pending.push({ kind: 'value', expression: node.expression, contentsMayEscape: true,
            projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          continue;
        }
        if (ts.isFunctionLike(node) || ts.isClassLike(node)) continue;
        let exhausted = false;
        ts.forEachChild(node, child => {
          if (!this.#chargeMutation()) { exhausted = true; return child; }
          pending.push({ ...current, node: child });
          return undefined;
        });
        if (exhausted) return;
        continue;
      }
      if (current.kind === 'callable') {
        if (ts.isConditionalExpression(node)) {
          pending.push({ ...current, expression: node.whenTrue }, { ...current, expression: node.whenFalse });
          continue;
        }
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
          if (node.operatorToken.kind !== ts.SyntaxKind.CommaToken) pending.push({ ...current, expression: node.left });
          pending.push({ ...current, expression: node.right });
          continue;
        }
        if (ts.isIdentifier(node)) {
          const namespaceValues = this.#namespaceProjectedValues(node, current.projection, current.wholeContentsEscape);
          if (namespaceValues !== undefined) {
            for (const value of namespaceValues) {
              if (ts.isExpression(value.node)) pending.push({ ...current,
                expression: value.node, projection: value.projection });
              else if (ts.isClassLike(value.node)) this.#enqueueClassSources(value.node,
                { ...current, projection: value.projection }, pending, true);
              else if (ts.isFunctionDeclaration(value.node) && value.node.body !== undefined
                && value.node.parameters.length === 0) {
                pending.push({ kind: 'capture', node: value.node.body, projection: value.projection,
                  unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                  wholeContentsEscape: current.wholeContentsEscape });
              }
            }
            continue;
          }
        }
        if (this.#enqueueCallableShape(node as ts.Expression, current, pending)) continue;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          if (node.parameters.length !== 0) {
            if (current.unresolvedIsIncomplete) this.mutationAnalysisIncomplete = true;
            continue;
          }
          if (ts.isBlock(node.body)) pending.push({ kind: 'capture', node: node.body,
            projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          else pending.push({ kind: 'value', expression: node.body, contentsMayEscape: true,
            projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          continue;
        }
        if (!ts.isIdentifier(node)) {
          if (current.unresolvedIsIncomplete) this.mutationAnalysisIncomplete = true;
          continue;
        }
        const symbol = this.rootSymbol(node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        let found = false;
        if (declaration !== undefined && this.project.pathOf(declaration.getSourceFile()) !== undefined) {
          if (ts.isClassLike(declaration)) {
            this.#enqueueClassSources(declaration, current, pending, true);
            found = true;
          } else if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
            pending.push({ ...current, expression: declaration.initializer }); found = true;
          } else {
            const body = callableBody(declaration);
            if (body !== undefined && ts.isFunctionLike(declaration) && declaration.parameters.length === 0) {
              if (ts.isBlock(body)) pending.push({ kind: 'capture', node: body,
                projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                wholeContentsEscape: current.wholeContentsEscape });
              else pending.push({ kind: 'value', expression: body, contentsMayEscape: true,
                projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                wholeContentsEscape: current.wholeContentsEscape });
              found = true;
            }
          }
        }
        if (symbol !== undefined && this.#claimAssignmentExpansion(symbol, state)) {
          for (const source of this.#assignmentSourcesFor(symbol, current.projection,
            current.wholeContentsEscape)) {
            if (!this.#chargeMutation()) return;
            const projection = provenanceProjection(source, current.projection, current.wholeContentsEscape);
            if (projection === undefined) continue;
            pending.push({ ...current, expression: source.expression, projection,
              wholeContentsEscape: current.wholeContentsEscape || source.sourceProjection === null
                || source.targetProjection === null });
            found = true;
          }
        } else if (symbol !== undefined) found = true;
        if (declaration !== undefined && ts.isBindingElement(declaration)) {
          for (const source of bindingSources(declaration)) {
            if (!this.#chargeMutation()) return;
            pending.push({ ...current, expression: source.expression, projection: source.projection === null
              ? [] : [...source.projection, ...current.projection],
              wholeContentsEscape: current.wholeContentsEscape || source.projection === null });
            found = true;
          }
          if (declaration.initializer !== undefined) {
            pending.push({ ...current, expression: declaration.initializer }); found = true;
          }
        }
        if (!found && current.unresolvedIsIncomplete) this.mutationAnalysisIncomplete = true;
        continue;
      }
      if (ts.isSpreadElement(node)) {
        pending.push({ ...current, expression: node.expression });
        continue;
      }
      if (ts.isConditionalExpression(node)) {
        pending.push({ ...current, expression: node.whenTrue }, { ...current, expression: node.whenFalse });
        continue;
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        if (node.operatorToken.kind !== ts.SyntaxKind.CommaToken) pending.push({ ...current, expression: node.left });
        pending.push({ ...current, expression: node.right });
        continue;
      }
      if (ts.isCallExpression(node) && current.contentsMayEscape) {
        if (node.arguments.length !== 0 || node.questionDotToken !== undefined) {
          if (current.unresolvedIsIncomplete) this.mutationAnalysisIncomplete = true;
          continue;
        }
        pending.push({ kind: 'callable', expression: node.expression,
          projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
          wholeContentsEscape: current.wholeContentsEscape });
        continue;
      }
      if (ts.isNewExpression(node) && current.contentsMayEscape) {
        for (const owner of this.#constructedClasses(node)) this.#enqueueClassSources(owner, current, pending, false);
        continue;
      }
      if (ts.isClassExpression(node) && current.contentsMayEscape) {
        this.#enqueueClassSources(node, current, pending, true);
        continue;
      }
      if (ts.isPropertyAccessExpression(node) && current.contentsMayEscape && current.wholeContentsEscape
        && this.#namespaceValue(node.expression)) {
        const owners = this.#projectClassReferences(node);
        if (owners.length > 0) {
          for (const owner of owners) this.#enqueueClassSources(owner, current, pending, true);
          continue;
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = accessKey(node);
        if (key === undefined) pending.push({ ...current, expression: node.expression, projection: [], wholeContentsEscape: true });
        else pending.push({ ...current, expression: node.expression, projection: [key, ...current.projection] });
        continue;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = lexicalThisClass(node);
        if (owner === undefined) {
          if (current.unresolvedIsIncomplete) this.mutationAnalysisIncomplete = true;
          continue;
        }
        if (current.projection.length === 0 && !current.wholeContentsEscape) continue;
        this.#enqueueClassSources(owner, current, pending, false);
        continue;
      }
      if (current.projection.length > 0) {
        const [key, ...rest] = current.projection;
        if (ts.isObjectLiteralExpression(node) && typeof key === 'string') {
          for (const property of node.properties) {
            if (!this.#chargeMutation()) return;
            if (ts.isSpreadAssignment(property)) {
              pending.push({ ...current, expression: property.expression, projection: current.projection });
              continue;
            }
            const propertyKey = property.name === undefined ? undefined : staticName(property.name);
            if (property.name !== undefined && ts.isComputedPropertyName(property.name)) {
              if (ts.isPropertyAssignment(property)) pending.push({ ...current,
                expression: property.initializer, projection: rest });
              else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
                pending.push({ kind: 'capture', node: property.body ?? property, projection: rest,
                  unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                  wholeContentsEscape: current.wholeContentsEscape });
              }
              continue;
            }
            if (propertyKey !== key) continue;
            if (ts.isPropertyAssignment(property)) pending.push({ ...current, expression: property.initializer, projection: rest });
            else if (ts.isShorthandPropertyAssignment(property)) pending.push({ ...current, expression: property.name, projection: rest });
            else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
              pending.push({ kind: 'capture', node: property.body ?? property, projection: rest,
                unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                wholeContentsEscape: current.wholeContentsEscape });
            }
          }
          continue;
        }
        if (ts.isArrayLiteralExpression(node) && typeof key === 'number') {
          let uncertainIndex = false;
          for (let index = 0; index < node.elements.length && index <= key; index++) {
            if (!this.#chargeMutation()) return;
            if (ts.isSpreadElement(node.elements[index]!)) { uncertainIndex = true; break; }
          }
          if (uncertainIndex) {
            pending.push({ ...current, expression: node, projection: [] });
            continue;
          }
          const element = node.elements[key];
          if (element !== undefined && !ts.isOmittedExpression(element)) pending.push({ ...current,
            expression: ts.isSpreadElement(element) ? element.expression : element, projection: rest });
          continue;
        }
      }
      if (ts.isIdentifier(node)) {
        const namespaceValues = this.#namespaceProjectedValues(node, current.projection, current.wholeContentsEscape);
        if (namespaceValues !== undefined) {
          for (const value of namespaceValues) {
            if (ts.isExpression(value.node)) pending.push({ ...current,
              expression: value.node, projection: value.projection });
            else if (ts.isClassLike(value.node)) this.#enqueueClassSources(value.node,
              { ...current, projection: value.projection }, pending, true);
            else if (value.node.body !== undefined && value.projection.length === 0) {
              pending.push({ kind: 'capture', node: value.node.body, projection: value.projection,
                unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                wholeContentsEscape: true });
            }
          }
          continue;
        }
      }
      const symbol = ts.isIdentifier(node) ? this.rootSymbol(node) : undefined;
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      const callbackBody = symbol === undefined ? undefined : this.#callableBindingBody(symbol);
      if (symbol !== undefined && current.projection.length > 0
        && (declaration === undefined || !ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))) {
        this.mutated.add(symbol);
      }
      if (symbol !== undefined && current.projection.length === 0
        && callbackBody === undefined
        && (!current.contentsMayEscape || !this.#definitelyPrimitive(node as ts.Expression))) this.mutated.add(symbol);
      if (ts.isArrowFunction(node) && current.contentsMayEscape) {
        if (ts.isBlock(node.body)) pending.push({ kind: 'capture', node: node.body,
          projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
          wholeContentsEscape: current.wholeContentsEscape });
        else pending.push({ kind: 'value', expression: node.body, contentsMayEscape: true,
          projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
          wholeContentsEscape: current.wholeContentsEscape });
      } else if (ts.isFunctionExpression(node) && current.contentsMayEscape) {
        pending.push({ kind: 'capture', node: node.body, projection: current.projection,
          unresolvedIsIncomplete: current.unresolvedIsIncomplete,
          wholeContentsEscape: current.wholeContentsEscape });
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          if (!this.#chargeMutation()) return;
          if (!ts.isOmittedExpression(element)) pending.push({ kind: 'value',
            expression: ts.isSpreadElement(element) ? element.expression : element, contentsMayEscape: true, projection: [],
            unresolvedIsIncomplete: current.unresolvedIsIncomplete, wholeContentsEscape: current.wholeContentsEscape,
          });
        }
      } else if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!this.#chargeMutation()) return;
          if (ts.isPropertyAssignment(property)) pending.push({ kind: 'value', expression: property.initializer,
            contentsMayEscape: true, projection: [], unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          else if (ts.isShorthandPropertyAssignment(property)) pending.push({ kind: 'value', expression: property.name,
            contentsMayEscape: true, projection: [], unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          else if (ts.isSpreadAssignment(property)) pending.push({ kind: 'value', expression: property.expression,
            contentsMayEscape: true, projection: [], unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
            if (property.body !== undefined) pending.push({ kind: 'capture', node: property.body, projection: [],
              unresolvedIsIncomplete: current.unresolvedIsIncomplete, wholeContentsEscape: true });
          }
        }
      }
      if (symbol === undefined) {
        if (current.unresolvedIsIncomplete && !ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)
          && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !this.#definitelyPrimitive(node as ts.Expression)) {
          this.mutationAnalysisIncomplete = true;
        }
        continue;
      }
      if (declaration !== undefined && ts.isClassLike(declaration) && current.contentsMayEscape) {
        this.#enqueueClassSources(declaration, current, pending, true);
        continue;
      }
      if ((current.contentsMayEscape || current.projection.length > 0)
        && this.#claimAssignmentExpansion(symbol, state)) {
        for (const source of this.#assignmentSourcesFor(symbol, current.projection,
          current.wholeContentsEscape)) {
          if (!this.#chargeMutation()) return;
          const nextProjection = provenanceProjection(source, current.projection, current.wholeContentsEscape);
          if (nextProjection !== undefined) pending.push({ ...current,
            expression: source.expression, projection: nextProjection,
            wholeContentsEscape: current.wholeContentsEscape || source.sourceProjection === null
              || source.targetProjection === null });
        }
      }
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
        && (current.wholeContentsEscape || current.projection.length > 0 || ts.isIdentifier(unwrap(declaration.initializer)))) {
        if (current.projection.length > 0 && !canProject(declaration.initializer)) this.mutated.add(symbol);
        else pending.push({ ...current, expression: declaration.initializer });
      } else if (declaration !== undefined && ts.isBindingElement(declaration)) {
        for (const source of bindingSources(declaration)) {
          if (!this.#chargeMutation()) return;
          pending.push({ ...current, expression: source.expression, projection: source.projection === null
            ? [] : [...source.projection, ...current.projection],
            wholeContentsEscape: current.wholeContentsEscape || source.projection === null });
        }
        if (declaration.initializer !== undefined) pending.push({ ...current, expression: declaration.initializer });
      } else {
        const body = declaration === undefined ? undefined : callableBody(declaration);
        if (body !== undefined && current.contentsMayEscape) {
          if (ts.isBlock(body)) pending.push({ kind: 'capture', node: body,
            projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
          else pending.push({ kind: 'value', expression: body, contentsMayEscape: true,
            projection: current.projection, unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
        }
      }
    }
  }

  /** callable source mode에서만 property/array projection을 풀고 일반 mutation 값으로 내리지 않는다. */
  #enqueueCallableShape(node: ts.Expression, current: Extract<MutationWork, { readonly kind: 'callable' }>,
    pending: MutationWork[]): boolean {
    if (ts.isNewExpression(node)) {
      for (const owner of this.#constructedClasses(node)) this.#enqueueClassSources(owner, current, pending, false);
      return true;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = accessKey(node);
      pending.push({ ...current, expression: node.expression,
        projection: key === undefined ? [] : [key, ...current.projection],
        wholeContentsEscape: current.wholeContentsEscape || key === undefined });
      return true;
    }
    if (current.projection.length > 0) {
      const [key, ...rest] = current.projection;
      if (ts.isObjectLiteralExpression(node) && typeof key === 'string') {
        for (const property of node.properties) {
          if (!this.#chargeMutation()) return true;
          if (ts.isSpreadAssignment(property)) {
            pending.push({ ...current, expression: property.expression, projection: current.projection });
            continue;
          }
          const name = property.name === undefined ? undefined : staticName(property.name);
          if (property.name !== undefined && ts.isComputedPropertyName(property.name) || name === key) {
            if (ts.isPropertyAssignment(property)) pending.push({ ...current,
              expression: property.initializer, projection: rest });
            else if (ts.isShorthandPropertyAssignment(property)) pending.push({ ...current,
              expression: property.name, projection: rest });
            else if (ts.isMethodDeclaration(property) && property.body !== undefined) {
              pending.push({ kind: 'capture', node: property.body, projection: rest,
                unresolvedIsIncomplete: current.unresolvedIsIncomplete,
                wholeContentsEscape: current.wholeContentsEscape });
            } else if (ts.isGetAccessorDeclaration(property) && property.body !== undefined) {
              this.#enqueueCallableReturns(property.body, { ...current, projection: rest }, pending);
            }
          }
        }
        return true;
      }
      const numeric = typeof key === 'number' ? key : key === undefined ? undefined : arrayIndexKey(key);
      if (ts.isArrayLiteralExpression(node) && numeric !== undefined) {
        let uncertain = false;
        for (let index = 0; index < node.elements.length && index <= numeric; index++) {
          if (!this.#chargeMutation()) return true;
          if (ts.isSpreadElement(node.elements[index]!)) { uncertain = true; break; }
        }
        if (uncertain) {
          pending.push({ ...current, expression: node, projection: [], wholeContentsEscape: true });
        } else {
          const element = node.elements[numeric];
          if (element !== undefined && !ts.isOmittedExpression(element)) pending.push({ ...current,
            expression: ts.isSpreadElement(element) ? element.expression : element, projection: rest });
        }
        return true;
      }
    }
    if (!current.wholeContentsEscape || current.projection.length > 0) return false;
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!this.#chargeMutation()) return true;
        if (!ts.isOmittedExpression(element)) pending.push({ ...current,
          expression: ts.isSpreadElement(element) ? element.expression : element });
      }
      return true;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!this.#chargeMutation()) return true;
        if (ts.isPropertyAssignment(property)) pending.push({ ...current, expression: property.initializer });
        else if (ts.isShorthandPropertyAssignment(property)) pending.push({ ...current, expression: property.name });
        else if (ts.isSpreadAssignment(property)) pending.push({ ...current, expression: property.expression });
        else if (ts.isMethodDeclaration(property) && property.body !== undefined) {
          pending.push({ kind: 'capture', node: property.body, projection: current.projection,
            unresolvedIsIncomplete: current.unresolvedIsIncomplete,
            wholeContentsEscape: current.wholeContentsEscape });
        } else if (ts.isGetAccessorDeclaration(property) && property.body !== undefined) {
          this.#enqueueCallableReturns(property.body, current, pending);
        }
      }
      return true;
    }
    return false;
  }

  /** getter가 돌려준 callable source만 callable mode로 이어간다. */
  #enqueueCallableReturns(body: ts.Block, current: Extract<MutationWork, { readonly kind: 'callable' }>,
    pending: MutationWork[]): void {
    const statements: ts.Node[] = [body];
    while (statements.length > 0) {
      if (!this.#chargeMutation()) return;
      const node = statements.pop()!;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        pending.push({ ...current, expression: node.expression });
        continue;
      }
      if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) continue;
      ts.forEachChild(node, child => {
        if (ts.isStatement(child) || ts.isBlock(child) || ts.isCaseBlock(child)
          || ts.isCaseClause(child) || ts.isDefaultClause(child) || ts.isCatchClause(child)) statements.push(child);
      });
    }
  }

  /** class field source를 현재 this/new projection에만 투영한다. */
  #enqueueClassSources(owner: ts.ClassLikeDeclaration,
    current: Exclude<MutationWork, { readonly kind: 'capture' }>,
    pending: MutationWork[], includeStatic: boolean): boolean {
    let found = false;
    const seen = new Set<ts.ClassLikeDeclaration>();
    const classes = [{ candidate: owner, depth: 0 }];
    while (classes.length > 0) {
      if (!this.#chargeMutation()) return found;
      const { candidate, depth } = classes.pop()!;
      if (depth > MAX_PROJECTION_DEPTH) { this.mutationAnalysisIncomplete = true; return found; }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const wholeAtPath = current.wholeContentsEscape && current.projection.length === 0;
      this.#materializeClassReturns(candidate, current.projection, wholeAtPath, includeStatic);
      for (const source of this.#classSources.get(candidate) ?? []) {
        if (!this.#chargeMutation()) return found;
        if (source.isStatic && !includeStatic) continue;
        const projection = provenanceProjection(source, current.projection, wholeAtPath);
        if (projection === undefined) continue;
        const wholeContentsEscape = current.wholeContentsEscape && projection.length === 0
          || source.sourceProjection === null || source.targetProjection === null;
        if (current.kind === 'callable' && source.mode === 'value') {
          pending.push({ kind: 'value', expression: source.expression, contentsMayEscape: true, projection,
            unresolvedIsIncomplete: current.unresolvedIsIncomplete, wholeContentsEscape });
        } else pending.push({ ...current, expression: source.expression, projection, wholeContentsEscape });
        found = true;
      }
      for (const base of this.#baseClasses(candidate)) classes.push({ candidate: base, depth: depth + 1 });
      for (const child of this.#subclasses.get(candidate) ?? []) classes.push({ candidate: child, depth: depth + 1 });
    }
    return found;
  }

  #materializeClassReturns(owner: ts.ClassLikeDeclaration, projection: readonly ProjectionKey[],
    whole: boolean, includeStatic: boolean): void {
    for (const root of this.#classReturnRoots.get(owner) ?? []) {
      if (this.#materializedClassReturns.has(root) || root.isStatic && !includeStatic
        || !whole && root.targetProjection !== null
        && !projectionPrefix(root.targetProjection, projection)
        && !projectionPrefix(projection, root.targetProjection)) continue;
      this.#materializedClassReturns.add(root);
      this.#indexClassReturns(owner, root);
    }
  }

  /** class-value projection은 기존 static field/getter source edge만 소비한다. */
  #staticClassProjectedSources(owner: ts.ClassLikeDeclaration, projection: readonly ProjectionKey[]): readonly {
    readonly expression: ts.Expression; readonly projection: readonly ProjectionKey[] | null;
  }[] {
    const projected: { expression: ts.Expression; projection: readonly ProjectionKey[] | null }[] = [];
    const pending = [{ owner, depth: 0 }];
    const seen = new Set<ts.ClassLikeDeclaration>();
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (item.depth > MAX_PROJECTION_DEPTH) {
        this.mutationAnalysisIncomplete = true; return projected;
      }
      if (seen.has(item.owner)) continue;
      seen.add(item.owner);
      this.#materializeClassReturns(item.owner, projection, false, true);
      for (const source of this.#classSources.get(item.owner) ?? []) {
        if (!source.isStatic || !this.#chargeMutation()) continue;
        let next: readonly ProjectionKey[] | null | undefined = provenanceProjection(source, projection, false);
        if (next === undefined) continue;
        if (source.sourceProjection === null || source.targetProjection === null) next = null;
        projected.push({ expression: source.expression, projection: next });
      }
      for (const base of this.#baseClasses(item.owner)) pending.push({ owner: base, depth: item.depth + 1 });
    }
    return projected;
  }

  /** static project-class extends의 가능한 모든 bounded base source를 합친다. */
  #baseClasses(owner: ts.ClassLikeDeclaration): readonly ts.ClassLikeDeclaration[] {
    const clauses = owner.heritageClauses?.filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? [];
    if (clauses.length === 0) return [];
    const types = clauses[0]!.types;
    return types.length === 1 ? this.#projectClassReferences(types[0]!.expression) : [];
  }

  /** 외부 escape는 명백한 primitive binding 자체를 변경 가능 객체로 승격하지 않는다. */
  #definitelyPrimitive(expression: ts.Expression): boolean {
    const primitive = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
      | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined
      | ts.TypeFlags.Void | ts.TypeFlags.Never;
    const type = this.project.checker.getTypeAtLocation(expression);
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0 && members.every((member) => (member.flags & primitive) !== 0);
  }

  /** callback binding 자체와 callback이 반환해 노출하는 capture 값을 구분한다. */
  #callableBindingBody(symbol: ts.Symbol): ts.ConciseBody | undefined {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration === undefined) return undefined;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = unwrap(declaration.initializer);
      return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer.body : undefined;
    }
    return callableBody(declaration);
  }

  /** 변경되지 않은 const 초기값만 따라간다. 분석 대상 밖의 선언은 읽지 않는다. */
  resolve(expression: ts.Expression, depth = 0): ts.Expression | undefined {
    if (depth > 16) return undefined;
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) return node;
    const shorthand = ts.isShorthandPropertyAssignment(node.parent) ? this.project.checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const declaration = shorthand === undefined ? declarationOf(this.project.checker, node) : resolveAlias(this.project.checker, shorthand).declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0 || this.project.pathOf(declaration.getSourceFile()) === undefined) return undefined;
    const symbol = shorthand ?? symbolAt(this.project.checker, node);
    const declaredSymbol = symbolAt(this.project.checker, declaration.name);
    if ((symbol !== undefined && this.mutated.has(symbol)) || (declaredSymbol !== undefined && this.mutated.has(declaredSymbol))) return undefined;
    return this.resolve(declaration.initializer, depth + 1);
  }

  /** 문자열 리터럴로 확정된 설정 값이다. */
  string(expression: ConfigValue): string | undefined {
    if (expression == null) return undefined;
    const node = this.resolve(expression);
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  }

  /** 객체 속성을 읽는다. 전개·계산된 이름·메서드가 있으면 추측하지 않는다. */
  config(expression: ts.Expression | undefined): ClientConfig {
    if (expression === undefined) return new Map();
    if (this.mutationAnalysisIncomplete) return null;
    const node = this.resolve(expression);
    if (node === undefined || !ts.isObjectLiteralExpression(node)) return null;
    const properties = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) properties.set(property.name.text, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) properties.set(property.name.text, property.name);
      else return null;
    }
    return properties;
  }

  /** URL 보간을 값·쿼리 꼬리로 구분한다. 깊이와 순환에는 상한을 둔다. */
  parts(expression: ts.Expression | undefined, depth = 0): UrlPart[] {
    if (expression === undefined || depth > 16) return [{ value: true }];
    const node = this.resolve(expression);
    if (node === undefined) return [{ value: true }];
    if (ts.isStringLiteralLike(node)) return [{ literal: node.text }];
    if (ts.isTemplateExpression(node)) return [{ literal: node.head.text }, ...node.templateSpans.flatMap((span) => [
      ...this.parts(span.expression, depth + 1), { literal: span.literal.text },
    ])];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [
      ...this.parts(node.left, depth + 1), ...this.parts(node.right, depth + 1),
    ];
    if (ts.isConditionalExpression(node) && this.isQuerySuffix(node.whenTrue, depth + 1) && this.isQuerySuffix(node.whenFalse, depth + 1)) return [{ queryTail: true }];
    return [{ value: true }];
  }

  /** 조건식 가지가 빈 문자열 또는 고정된 '?' 접두사인지 증명한다. */
  private isQuerySuffix(expression: ts.Expression, depth: number): boolean {
    if (depth > 16) return false;
    const node = this.resolve(expression);
    if (node === undefined) return false;
    if (ts.isConditionalExpression(node)) return this.isQuerySuffix(node.whenTrue, depth + 1) && this.isQuerySuffix(node.whenFalse, depth + 1);
    const head = this.parts(node, depth + 1)[0];
    return head !== undefined && 'literal' in head && (head.literal.startsWith('?') || (head.literal === '' && ts.isStringLiteralLike(node)));
  }
}

/** static member access만 object/array initializer projection으로 보낸다. */
function accessKey(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ProjectionKey | undefined {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const argument = access.argumentExpression === undefined ? undefined : unwrap(access.argumentExpression);
  if (argument !== undefined && ts.isStringLiteralLike(argument)) return argument.text;
  if (argument !== undefined && ts.isNumericLiteral(argument)) return Number(argument.text);
  return undefined;
}

function arrayIndexKey(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const value = Number(key);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** class/member store pass는 실제 property/index leaf가 있는 assignment만 방문한다. */
function memberAssignmentTarget(expression: ts.Expression): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = unwrap(pending.pop()!);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) return true;
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) pending.push(property.initializer);
        else if (ts.isSpreadAssignment(property)) pending.push(property.expression);
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) if (!ts.isOmittedExpression(element)) {
        pending.push(ts.isSpreadElement(element) ? element.expression : element);
      }
    } else if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      pending.push(current.left);
    }
  }
  return false;
}

/** bounded visited state에서 key 종류와 길이를 충돌 없이 직렬화한다. */
function projectionState(key: ProjectionKey): string {
  const value = String(key);
  return `${typeof key === 'number' ? 'n' : 's'}${value.length}:${value}`;
}

function classSourceProjection(projection: readonly ProjectionKey[] | null): string {
  return projection === null ? '*' : `=${projection.map(projectionState).join('/')}`;
}

function projectionPath(keys: readonly ProjectionKey[]): string {
  return keys.map(key => {
    const value = String(key);
    return `${value.length}:${value}`;
  }).join('/');
}

function projectionPrefix(prefix: readonly ProjectionKey[], value: readonly ProjectionKey[]): boolean {
  return prefix.length <= value.length && prefix.every((key, index) => String(key) === String(value[index]));
}

/** target path와 겹치는 assignment/store source의 후속 projection을 계산한다. */
function provenanceProjection(source: MutationSource,
  current: readonly ProjectionKey[], wholeContentsEscape: boolean): readonly ProjectionKey[] | undefined {
  if (source.targetProjection === null) {
    return current.length > 0 || wholeContentsEscape ? [] : undefined;
  }
  if (current.length === 0) {
    if (source.targetProjection.length > 0 && !wholeContentsEscape) return undefined;
    return source.sourceProjection ?? [];
  }
  if (projectionPrefix(source.targetProjection, current)) {
    return source.sourceProjection === null ? []
      : [...source.sourceProjection, ...current.slice(source.targetProjection.length)];
  }
  if (wholeContentsEscape && projectionPrefix(current, source.targetProjection)) return source.sourceProjection ?? [];
  return undefined;
}

/** projection을 정확한 initializer branch로 계속 내릴 수 있는 문법이다. */
function canProject(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  return ts.isIdentifier(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
    || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isConditionalExpression(node)
    || ts.isNewExpression(node)
    || ts.isBinaryExpression(node) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
}

/** literal object/binding의 실행 시점 고정 key다. */
function staticName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** runtime body를 가진 callable 선언만 capture traversal에 넘긴다. */
function callableBody(node: ts.Node): ts.ConciseBody | undefined {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    ? node.body : undefined;
}

function staticMember(node: ts.ClassElement): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

/** class member와 그 안의 lexical arrow만 instance this source를 소유한다. */
function lexicalThisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isArrowFunction(current)) { current = current.parent; continue; }
    if (ts.isPropertyDeclaration(current) && ts.isClassLike(current.parent)) {
      return staticMember(current) ? undefined : current.parent;
    }
    if (ts.isConstructorDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      return ts.isClassLike(current.parent) && !staticMember(current) ? current.parent : undefined;
    }
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

/** destructuring binding이 읽은 initializer와 정확한 projection 경로다. */
function bindingSources(declaration: ts.BindingElement): readonly {
  readonly expression: ts.Expression; readonly projection: readonly ProjectionKey[] | null;
}[] {
  let projection: ProjectionKey[] | null = [];
  let element = declaration;
  while (true) {
    const pattern = element.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      if (element.dotDotDotToken !== undefined) projection = null;
      else if (projection !== null) {
        const key = element.propertyName === undefined
          ? ts.isIdentifier(element.name) ? element.name.text : undefined
          : staticName(element.propertyName);
        if (key === undefined) projection = null;
        else {
          projection.unshift(key);
          if (projection.length > MAX_PROJECTION_DEPTH) projection = null;
        }
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      if (element.dotDotDotToken !== undefined) projection = null;
      else if (projection !== null) {
        const index = pattern.elements.indexOf(element);
        if (index < 0) projection = null;
        else {
          projection.unshift(index);
          if (projection.length > MAX_PROJECTION_DEPTH) projection = null;
        }
      }
    } else return [];
    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) { element = owner; continue; }
    return ts.isVariableDeclaration(owner) && owner.initializer !== undefined
      ? [{ expression: owner.initializer, projection }] : [];
  }
}

/** 소스 trivia에 영향받지 않고 interceptor 속성 접근 사슬을 찾는다. */
function hasInterceptorAccess(expression: ts.Expression): boolean {
  let node = unwrap(expression);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if ((ts.isPropertyAccessExpression(node) && node.name.text === 'interceptors')
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'interceptors')) return true;
    node = unwrap(node.expression);
  }
  return false;
}

/** 뒤쪽 override부터 속성을 찾는다. 미상 설정은 앞 설정의 부재 증명을 가린다. */
export function configValue(configs: readonly ClientConfig[], name: string): ConfigValue {
  for (const config of configs.toReversed()) {
    if (config === null) return null;
    if (config.has(name)) return config.get(name)!;
  }
  return undefined;
}
