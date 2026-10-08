/**
 * 실행 없이 읽는 명시적 navigation router 모델과 screen-route 추출기다.
 *
 * 설정은 factory 선언과 route object의 property 이름을 정확히 지정한다. 추출기는 그 선언
 * identity와 닫힌 literal 값만 따라가며, 불확실한 route·path·screen·children은 정적 사실로
 * 추측하지 않고 dynamic 사실과 계수화한 limitation으로 남긴다.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

import {
  formatBridgeTimestamp,
  isSafeIdentifier,
  type BridgeLocation,
} from '../exchange/bridge-facts.ts';
import { scanJsonNumberToken } from '../exchange/json-number-token.ts';
import { isFunctionValued, skipWrappers } from '../graph/node-collector.ts';
import { scopeIdOf } from '../graph/symbol-ids.ts';
import { MAX_TEMPLATE_LENGTH } from '../openapi/path-template.ts';
import { canonicalizeLiteral } from '../openapi/percent-encoding.ts';
import {
  hasParseErrors,
  isNodeTestPath,
  loadNodeProject,
  type NodeProject,
} from './node/node-project.ts';
import { resolveAlias, symbolAt } from './node/symbols.ts';

/** router model JSON의 UTF-8 byte 상한이다. */
export const MAX_ROUTER_MODEL_BYTES = 1024 * 1024;
/** 한 설정 문서에 허용하는 factory model 수다. */
export const MAX_ROUTER_MODELS = 128;
/** children을 따라가는 최대 route object 깊이다. */
export const MAX_NAVIGATION_DEPTH = 64;
/** 문서 하나의 최대 screen-route 사실 수다. */
export const MAX_NAVIGATION_FACTS = 100_000;

const MAX_ROUTER_JSON_DEPTH = 32;
const MAX_ROUTER_JSON_NODES = 100_000;
const MAX_MODEL_STRING_LENGTH = 2048;
const MAX_PROPERTY_NAME_LENGTH = 256;
const MAX_ALIAS_DEPTH = 64;
const MAX_BINDING_NODES = 1_000_000;
const ARRAY_MUTATORS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** 설정이 가리키는 project-owned factory 선언이다. */
export interface RouterFactoryIdentity {
  readonly path: string;
  readonly name: string;
}

/** factory 하나가 받는 route object 규칙이다. */
export interface RouterModel {
  readonly factory: RouterFactoryIdentity;
  readonly routesArgument: number;
  readonly pathProperty: string;
  readonly screenProperty: string;
  readonly childrenProperty?: string;
  readonly pathSyntax: 'colon' | 'template';
}

/** 명시적 router model machine contract다. */
export interface RouterModels {
  readonly format: 'router-models';
  readonly version: 1;
  readonly models: readonly RouterModel[];
}

/** navigation screen의 graph-compatible identity다. */
export interface NavigationScreenIdentity {
  readonly usr: string;
  readonly qualifiedName: string;
}

/** 화면 라우트 하나다. */
export interface ScreenRouteFact {
  readonly kind: 'screen-route';
  /** 확정한 URL template. path를 확정하지 못했으면 null이다. */
  readonly urlTemplate: string | null;
  /** URL과 실제 project screen 중 하나라도 확정하지 못했으면 true다. */
  readonly dynamic: boolean;
  readonly location: BridgeLocation;
  readonly screen?: NavigationScreenIdentity;
}

/** navigation-facts v1 문서다. */
export interface NavigationFactsDocument {
  readonly format: 'navigation-facts';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly platform: 'js';
  readonly project: string;
  readonly facts: readonly ScreenRouteFact[];
  readonly limitations: readonly string[];
}

/** router model 오류 종류다. */
export type RouterModelErrorCode =
  | 'too-large'
  | 'invalid-json'
  | 'too-deep'
  | 'too-many-nodes'
  | 'duplicate-key'
  | 'duplicate-model'
  | 'invalid-shape'
  | 'unsafe-value';

/** 입력 원문이나 경로를 노출하지 않는 router model 오류다. */
export class RouterModelError extends Error {
  readonly code: RouterModelErrorCode;

  constructor(code: RouterModelErrorCode) {
    super(routerModelErrorMessage(code));
    this.name = 'RouterModelError';
    this.code = code;
  }
}

/** 사실 상한을 넘겨 부분 문서를 만들 수 없을 때의 오류다. */
export class NavigationFactLimitError extends Error {
  constructor() {
    super(`project produces more than ${MAX_NAVIGATION_FACTS} screen-route facts`);
    this.name = 'NavigationFactLimitError';
  }
}

/** binding AST 예산을 넘어 mutation·alias 완전성을 증명할 수 없을 때의 오류다. */
export class NavigationBindingLimitError extends Error {
  constructor() {
    super(`navigation binding analysis exceeds its ${MAX_BINDING_NODES}-node limit`);
    this.name = 'NavigationBindingLimitError';
  }
}

/** JSON 문자열을 bounded하게 검사하고 router model 계약으로 바꾼다. */
export function parseRouterModels(text: string): RouterModels {
  if (byteLength(text) > MAX_ROUTER_MODEL_BYTES) throw new RouterModelError('too-large');
  new RouterJsonScanner(text).scan();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RouterModelError('invalid-json');
  }
  return validateRouterModels(value);
}

/**
 * 명시적 router model과 정확히 일치하는 등록 호출에서 navigation 사실을 추출한다.
 *
 * @param root project root
 * @param models 검증된 router model
 * @param toolVersion tsograph version
 * @param generatedAt 생성 시각
 * @param tsconfig 선택한 TypeScript config
 */
export function extractNavigationRoutes(
  root: string,
  models: RouterModels,
  toolVersion: string,
  generatedAt: Date,
  tsconfig?: string,
): NavigationFactsDocument {
  const projectRoot = realpathSync(resolve(root));
  const project = loadNodeProject(projectRoot, tsconfig);
  const productionEntries = [...project.files].filter(([path]) => !isNodeTestPath(path));
  const parseErrors = productionEntries.filter(([, sourceFile]) => hasParseErrors(sourceFile)).length;
  const productionFiles = new Map(productionEntries.filter(([, sourceFile]) => !hasParseErrors(sourceFile)));
  const bindings = buildBindingIndex(project, productionEntries.map(([, sourceFile]) => sourceFile));
  if (!bindings.complete) throw new NavigationBindingLimitError();
  const matches = collectFactoryCalls(project, productionFiles.values(), models, bindings);
  const facts: ScreenRouteFact[] = [];
  const tally = createTally();
  const matchedModels = new Set<number>();
  const calls = new Set(matches.map((match) => match.call));
  const context: ExtractionContext = {
    project,
    bindings,
    calls,
    facts,
    tally,
    compositeSafety: new Map(),
  };
  for (const match of matches) {
    matchedModels.add(match.modelIndex);
    const argument = match.call.arguments[match.model.routesArgument];
    if (argument === undefined || ts.isSpreadElement(argument)) {
      tally.routeContainer += 1;
      addDynamicFact(context, argument ?? match.call);
      continue;
    }
    extractArray(argument, undefined, 0, match.model, context, argument);
  }
  const limitations = buildLimitations(
    project,
    tally,
    models.models.length - matchedModels.size,
    parseErrors,
  );
  return {
    format: 'navigation-facts',
    version: 1,
    tool: { name: 'tsograph', version: toolVersion },
    generatedAt: formatBridgeTimestamp(generatedAt),
    platform: 'js',
    project: projectRoot,
    facts,
    limitations,
  };
}

interface FactoryCallMatch {
  readonly call: ts.CallExpression;
  readonly model: RouterModel;
  readonly modelIndex: number;
}

interface BindingIndex {
  readonly references: ReadonlyMap<ts.Symbol, readonly ts.Identifier[]>;
  readonly written: ReadonlySet<ts.Symbol>;
  readonly complete: boolean;
}

interface ExtractionTally {
  routeContainer: number;
  mutatedRouteContainer: number;
  unprovenRouteContainer: number;
  arraySpread: number;
  routeEntry: number;
  objectShape: number;
  path: number;
  screen: number;
  children: number;
  nestingDepth: number;
}

type CompositeSafety = 'stable' | 'mutated' | 'unproven';

interface ExtractionContext {
  readonly project: NodeProject;
  readonly bindings: BindingIndex;
  readonly calls: ReadonlySet<ts.CallExpression>;
  readonly facts: ScreenRouteFact[];
  readonly tally: ExtractionTally;
  readonly compositeSafety: Map<ts.Symbol, CompositeSafety>;
}

function createTally(): ExtractionTally {
  return {
    routeContainer: 0,
    mutatedRouteContainer: 0,
    unprovenRouteContainer: 0,
    arraySpread: 0,
    routeEntry: 0,
    objectShape: 0,
    path: 0,
    screen: 0,
    children: 0,
    nestingDepth: 0,
  };
}

/** project의 identifier 참조와 binding write를 checker symbol 기준으로 bounded하게 색인한다. */
function buildBindingIndex(project: NodeProject, files: Iterable<ts.SourceFile>): BindingIndex {
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const written = new Set<ts.Symbol>();
  let visited = 0;
  let complete = true;
  const appendReference = (symbol: ts.Symbol, identifier: ts.Identifier): void => {
    const list = references.get(symbol);
    if (list === undefined) references.set(symbol, [identifier]);
    else list.push(identifier);
  };
  const resolvedSymbol = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = symbolAt(project.checker, node);
    return symbol === undefined ? undefined : resolveAlias(project.checker, symbol);
  };
  const markWritten = (expression: ts.Expression): void => {
    for (const target of assignmentRoots(expression)) {
      const symbol = resolvedSymbol(target);
      if (symbol !== undefined) written.add(symbol);
    }
  };
  const visit = (node: ts.Node): void => {
    if (!complete) return;
    visited += 1;
    if (visited > MAX_BINDING_NODES) {
      complete = false;
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = resolvedSymbol(node);
      if (symbol !== undefined) appendReference(symbol, node);
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) markWritten(node.left);
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && isUpdateOperator(node.operator)) markWritten(node.operand);
    else if (ts.isDeleteExpression(node)) markWritten(node.expression);
    else if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && ts.isExpression(node.initializer)) markWritten(node.initializer);
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of files) visit(sourceFile);
  return { references, written, complete };
}

function collectFactoryCalls(
  project: NodeProject,
  files: Iterable<ts.SourceFile>,
  models: RouterModels,
  bindings: BindingIndex,
): FactoryCallMatch[] {
  const matches: FactoryCallMatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.questionDotToken === undefined) {
      const modelIndex = factoryModelIndex(node.expression, project, models.models, bindings, 0, new Set());
      if (modelIndex !== undefined) {
        matches.push({ call: node, model: models.models[modelIndex]!, modelIndex });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of files) visit(sourceFile);
  return matches;
}

function factoryModelIndex(
  expression: ts.Expression,
  project: NodeProject,
  models: readonly RouterModel[],
  bindings: BindingIndex,
  depth: number,
  seen: Set<ts.Declaration>,
): number | undefined {
  if (depth > MAX_ALIAS_DEPTH || !bindings.complete) return undefined;
  const inner = skipWrappers(expression);
  if (!ts.isIdentifier(inner) && !ts.isPropertyAccessExpression(inner)
    && !ts.isElementAccessExpression(inner)) return undefined;
  const symbol = symbolAt(project.checker, inner);
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(project.checker, symbol);
  const declarations = runtimeFactoryDeclarations(resolved);
  for (const declaration of declarations) {
    const identity = factoryIdentity(declaration, resolved, project, bindings);
    if (identity === undefined) continue;
    const index = models.findIndex((model) => model.factory.path === identity.path
      && model.factory.name === identity.name);
    if (index >= 0) return index;
  }
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || !isStableConstDeclaration(declaration, resolved, bindings) || seen.has(declaration)) return undefined;
  seen.add(declaration);
  return factoryModelIndex(declaration.initializer, project, models, bindings, depth + 1, seen);
}

function runtimeFactoryDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const functions = (symbol.declarations ?? []).filter(
    (declaration): declaration is ts.FunctionDeclaration => ts.isFunctionDeclaration(declaration)
      && declaration.body !== undefined,
  );
  const variables = (symbol.declarations ?? []).filter(ts.isVariableDeclaration);
  if (functions.length === 1) return functions;
  if (variables.length === 1) return variables;
  return [];
}

function factoryIdentity(
  declaration: ts.Declaration,
  symbol: ts.Symbol,
  project: NodeProject,
  bindings: BindingIndex,
): RouterFactoryIdentity | undefined {
  const path = project.pathOf(declaration.getSourceFile());
  if (path === undefined || isNodeTestPath(path) || bindings.written.has(symbol)) return undefined;
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.name !== undefined && ts.isSourceFile(declaration.parent)
      ? { path, name: declaration.name.text }
      : undefined;
  }
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent)
    || !ts.isVariableStatement(declaration.parent.parent)
    || !ts.isSourceFile(declaration.parent.parent.parent)
    || declaration.initializer === undefined
    || !isStableConstDeclaration(declaration, symbol, bindings)) return undefined;
  const type = project.checker.getTypeAtLocation(declaration.name);
  return project.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    ? { path, name: declaration.name.text }
    : undefined;
}

function extractArray(
  expression: ts.Expression,
  parentTemplate: string | null | undefined,
  depth: number,
  model: RouterModel,
  context: ExtractionContext,
  allowedReference: ts.Expression,
): boolean {
  if (depth >= MAX_NAVIGATION_DEPTH) {
    context.tally.nestingDepth += 1;
    addDynamicFact(context, expression);
    return true;
  }
  const resolved = routeArray(expression, context, allowedReference);
  if (resolved.kind !== 'array') {
    if (resolved.kind === 'mutated') context.tally.mutatedRouteContainer += 1;
    else if (resolved.kind === 'unproven') context.tally.unprovenRouteContainer += 1;
    else context.tally.routeContainer += 1;
    addDynamicFact(context, expression);
    return false;
  }
  for (const element of resolved.value.elements) {
    if (ts.isSpreadElement(element)) {
      context.tally.arraySpread += 1;
      addDynamicFact(context, element);
    } else if (ts.isOmittedExpression(element)) {
      context.tally.routeEntry += 1;
      addDynamicFact(context, element);
    } else {
      extractEntry(element, parentTemplate, depth, model, context);
    }
  }
  return true;
}

type ArrayResolution =
  | { readonly kind: 'array'; readonly value: ts.ArrayLiteralExpression }
  | { readonly kind: 'mutated' | 'unproven' | 'unknown' };

function routeArray(
  expression: ts.Expression,
  context: ExtractionContext,
  allowedReference: ts.Expression,
): ArrayResolution {
  const inner = skipWrappers(expression);
  if (ts.isArrayLiteralExpression(inner)) return { kind: 'array', value: inner };
  if (!ts.isIdentifier(inner)) return { kind: 'unknown' };
  const binding = declaredConstBinding(inner, context);
  if (binding === undefined) return { kind: 'unknown' };
  const initializer = skipWrappers(binding.declaration.initializer!);
  if (!ts.isArrayLiteralExpression(initializer)) return { kind: 'unknown' };
  const safety = compositeSafety(binding.symbol, binding.declaration, inner, allowedReference, context);
  return safety === 'stable' ? { kind: 'array', value: initializer } : { kind: safety };
}

function extractEntry(
  expression: ts.Expression,
  parentTemplate: string | null | undefined,
  depth: number,
  model: RouterModel,
  context: ExtractionContext,
): void {
  const inner = skipWrappers(expression);
  if (!ts.isObjectLiteralExpression(inner)) {
    context.tally.routeEntry += 1;
    addDynamicFact(context, expression);
    return;
  }
  const properties = closedProperties(inner);
  if (properties === undefined) {
    context.tally.objectShape += 1;
    addDynamicFact(context, inner);
    return;
  }
  const pathExpression = properties.get(model.pathProperty);
  const rawPath = pathExpression === undefined ? undefined : staticString(pathExpression, context);
  const template = rawPath === undefined ? undefined : joinNavigationPath(parentTemplate, rawPath, model.pathSyntax);
  if (template === undefined) context.tally.path += 1;
  const screenExpression = properties.get(model.screenProperty);
  const screen = screenExpression === undefined ? undefined : screenIdentity(screenExpression, context, 0, new Set());
  if (screen === undefined) context.tally.screen += 1;
  addFact(context, {
    kind: 'screen-route',
    urlTemplate: template ?? null,
    dynamic: template === undefined || screen === undefined,
    location: context.project.locationOf(inner),
    ...(screen === undefined ? {} : { screen }),
  });
  if (model.childrenProperty === undefined) return;
  const children = properties.get(model.childrenProperty);
  if (children === undefined) return;
  if (!extractArray(children, template ?? null, depth + 1, model, context, children)) {
    context.tally.children += 1;
  }
}

function closedProperties(object: ts.ObjectLiteralExpression): ReadonlyMap<string, ts.Expression> | undefined {
  const result = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
    const key = propertyName(property.name);
    if (key === undefined || result.has(key)) return undefined;
    result.set(key, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return result;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function staticString(
  expression: ts.Expression,
  context: ExtractionContext,
  depth = 0,
  seen = new Set<ts.Declaration>(),
): string | undefined {
  if (depth > MAX_ALIAS_DEPTH || !context.bindings.complete) {
    return undefined;
  }
  const inner = skipWrappers(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (!ts.isIdentifier(inner)) return undefined;
  const binding = constBinding(inner, context);
  if (binding === undefined || seen.has(binding.declaration)) return undefined;
  seen.add(binding.declaration);
  return staticString(binding.declaration.initializer!, context, depth + 1, seen);
}

interface ConstBinding {
  readonly declaration: ts.VariableDeclaration;
  readonly symbol: ts.Symbol;
}

function constBinding(identifier: ts.Identifier, context: ExtractionContext): ConstBinding | undefined {
  const binding = declaredConstBinding(identifier, context);
  return binding !== undefined && !context.bindings.written.has(binding.symbol) ? binding : undefined;
}

/** initializer가 있는 단일 const binding이다. composite mutation 판정은 호출자가 따로 한다. */
function declaredConstBinding(identifier: ts.Identifier, context: ExtractionContext): ConstBinding | undefined {
  const local = symbolAt(context.project.checker, identifier);
  if (local === undefined) return undefined;
  const symbol = resolveAlias(context.project.checker, local);
  const declarations = symbol.declarations ?? [];
  const onlyDeclaration = declarations.length === 1 ? declarations[0] : undefined;
  const declaration = onlyDeclaration !== undefined && ts.isVariableDeclaration(onlyDeclaration)
    ? onlyDeclaration
    : undefined;
  return declaration !== undefined
    && declaration.initializer !== undefined
    && ts.isIdentifier(declaration.name)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ? { declaration, symbol }
    : undefined;
}

function isStableConstDeclaration(
  declaration: ts.VariableDeclaration,
  symbol: ts.Symbol,
  bindings: BindingIndex,
): boolean {
  return bindings.complete
    && declaration.initializer !== undefined
    && ts.isIdentifier(declaration.name)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    && !bindings.written.has(symbol);
}

function compositeSafety(
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  reference: ts.Identifier,
  allowedReference: ts.Expression,
  context: ExtractionContext,
): CompositeSafety {
  const cached = context.compositeSafety.get(symbol);
  if (cached !== undefined) return cached;
  if (!context.bindings.complete || isExportedVariable(declaration)) return 'unproven';
  if (context.bindings.written.has(symbol)) return 'mutated';
  for (const token of context.bindings.references.get(symbol) ?? []) {
    if (token === declaration.name || token === reference || token === skipWrappers(allowedReference)) continue;
    const outer = climbExpression(token);
    const parent = outer.parent;
    if (ts.isCallExpression(parent) && context.calls.has(parent)
      && parent.arguments.some((argument) => skipWrappers(argument) === outer)) continue;
    const result = isArrayMutationReference(token) ? 'mutated' : 'unproven';
    context.compositeSafety.set(symbol, result);
    return result;
  }
  context.compositeSafety.set(symbol, 'stable');
  return 'stable';
}

/** array 내용을 바꾸는 표준 mutator의 receiver 참조인지 본다. 그 밖의 탈출은 unproven이다. */
function isArrayMutationReference(token: ts.Identifier): boolean {
  const receiver = climbExpression(token);
  const access = receiver.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver) return false;
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access && ARRAY_MUTATORS.has(access.name.text);
}

function isExportedVariable(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement)
    && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function screenIdentity(
  expression: ts.Expression,
  context: ExtractionContext,
  depth: number,
  seen: Set<ts.Declaration>,
): NavigationScreenIdentity | undefined {
  if (depth > MAX_ALIAS_DEPTH || !context.bindings.complete) return undefined;
  const reference = screenReference(expression);
  if (reference === undefined) return undefined;
  const local = symbolAt(context.project.checker, reference);
  if (local === undefined) return undefined;
  const symbol = resolveAlias(context.project.checker, local);
  if (context.bindings.written.has(symbol)) return undefined;
  const runtime = screenDeclarations(symbol);
  if (runtime.length !== 1) return undefined;
  const declaration = runtime[0]!;
  if (seen.has(declaration)) return undefined;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration)
    && !isStableConstDeclaration(declaration, symbol, context.bindings)) return undefined;
  const direct = screenDeclarationIdentity(declaration, context.project);
  if (direct !== undefined) return direct;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || !isStableConstDeclaration(declaration, symbol, context.bindings)) return undefined;
  return screenIdentity(declaration.initializer, context, depth + 1, seen);
}

function screenReference(expression: ts.Expression): ts.Node | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) return inner;
  if (ts.isJsxElement(inner)) return jsxTagReference(inner.openingElement.tagName);
  if (ts.isJsxSelfClosingElement(inner)) return jsxTagReference(inner.tagName);
  return undefined;
}

function jsxTagReference(tag: ts.JsxTagNameExpression): ts.Node | undefined {
  return ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag) ? tag : undefined;
}

function screenDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const declarations = symbol.declarations ?? [];
  const functions = declarations.filter(
    (declaration): declaration is ts.FunctionDeclaration => ts.isFunctionDeclaration(declaration)
      && declaration.body !== undefined,
  );
  const classes = declarations.filter(ts.isClassDeclaration);
  const variables = declarations.filter(ts.isVariableDeclaration);
  const runtime: ts.Declaration[] = [...functions, ...classes, ...variables];
  return runtime.length === 1 ? runtime : [];
}

function screenDeclarationIdentity(
  declaration: ts.Declaration,
  project: NodeProject,
): NavigationScreenIdentity | undefined {
  const path = project.pathOf(declaration.getSourceFile());
  if (path === undefined || isNodeTestPath(path)) return undefined;
  let probe: ts.Node | undefined;
  if (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) probe = declaration.body;
  else if (ts.isClassDeclaration(declaration)) probe = declaration.name ?? declaration.members[0];
  else if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
    && isFunctionValued(declaration.initializer)) probe = declaration.initializer;
  if (probe === undefined) return undefined;
  const usr = scopeIdOf(probe, path);
  return { usr, qualifiedName: usr };
}

function joinNavigationPath(
  parent: string | null | undefined,
  raw: string,
  syntax: RouterModel['pathSyntax'],
): string | undefined {
  if (!isSafeRoutePath(raw)) return undefined;
  const absolute = raw.startsWith('/');
  if (raw.length === 0) return parent === null ? undefined : parent ?? '/';
  const trailingSlash = raw.length > 1 && raw.endsWith('/');
  const rawSegments = raw.split('/');
  if (absolute) rawSegments.shift();
  if (rawSegments.some((segment, index) => segment.length === 0 && index !== rawSegments.length - 1)) return undefined;
  if (rawSegments.at(-1) === '') rawSegments.pop();
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === '.' || segment === '..') return undefined;
    const normalized = normalizePathSegment(segment, syntax);
    if (normalized === undefined) return undefined;
    if (normalized.length > 0) segments.push(normalized);
  }
  if (!absolute && parent === null) return undefined;
  const base = absolute || parent === undefined || parent === null ? [] : parent.split('/').filter(Boolean);
  let result = `/${[...base, ...segments].join('/')}`;
  if (trailingSlash && result !== '/') result += '/';
  return result.length <= MAX_TEMPLATE_LENGTH ? result : undefined;
}

function normalizePathSegment(segment: string, syntax: RouterModel['pathSyntax']): string | undefined {
  if (syntax === 'colon') {
    if (/^:[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(segment)) return '{}';
    if (segment.includes(':') || /[{}]/u.test(segment)) return undefined;
  } else {
    if (/^\{[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*\}$/u.test(segment)) return '{}';
    if (/[{}]/u.test(segment)) return undefined;
  }
  const canonical = canonicalizeLiteral(segment);
  return canonical === '.' || canonical === '..' ? undefined : canonical;
}

function isSafeRoutePath(value: string): boolean {
  return value.length <= MAX_TEMPLATE_LENGTH && value.isWellFormed()
    && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029\\?#]/u.test(value)
    && !value.startsWith('//')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}

function addDynamicFact(context: ExtractionContext, node: ts.Node): void {
  addFact(context, {
    kind: 'screen-route',
    urlTemplate: null,
    dynamic: true,
    location: context.project.locationOf(node),
  });
}

function addFact(context: ExtractionContext, fact: ScreenRouteFact): void {
  if (context.facts.length >= MAX_NAVIGATION_FACTS) throw new NavigationFactLimitError();
  context.facts.push(fact);
}

function buildLimitations(
  project: NodeProject,
  tally: ExtractionTally,
  unmatchedModels: number,
  parseErrors: number,
): string[] {
  const limitations: string[] = [];
  const dynamicCounts = [
    ['route container', tally.routeContainer],
    ['mutated route container', tally.mutatedRouteContainer],
    ['unproven route container', tally.unprovenRouteContainer],
    ['array spread', tally.arraySpread],
    ['route entry', tally.routeEntry],
    ['object shape', tally.objectShape],
    ['path', tally.path],
    ['screen', tally.screen],
    ['children', tally.children],
    ['nesting depth', tally.nestingDepth],
  ] as const;
  const measured = dynamicCounts.filter(([, count]) => count > 0);
  if (measured.length > 0) {
    const details = measured.map(([label, count]) => `${label}: ${count}`).join(', ');
    limitations.push(
      'navigation-coverage: dynamic screen-route facts were emitted and unresolved values were not guessed '
        + `(${details})`,
    );
  }
  if (unmatchedModels > 0) {
    limitations.push(
      `navigation-model-coverage: ${unmatchedModels} configured router model(s) matched no exact project factory call`,
    );
  }
  if (parseErrors > 0) {
    limitations.push(
      `navigation-source-coverage: ${parseErrors} production source file(s) had parse errors and were not scanned`,
    );
  }
  const gaps = project.gaps;
  if (gaps.symlinks + gaps.unreadableDirectories + gaps.oversizedFiles > 0 || gaps.truncated) {
    limitations.push(
      'navigation-project-coverage: source discovery was incomplete '
        + `(symlinks: ${gaps.symlinks}, unreadable directories: ${gaps.unreadableDirectories}, `
        + `oversized files: ${gaps.oversizedFiles}, truncated: ${gaps.truncated})`,
    );
  }
  return limitations;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner)) return inner;
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    return rootIdentifier(inner.expression);
  }
  return undefined;
}

/** 대입 pattern 안에서 실제로 값이 쓰이는 binding/root identifier를 모은다. */
function assignmentRoots(expression: ts.Expression): readonly ts.Identifier[] {
  const inner = skipWrappers(expression);
  const root = rootIdentifier(inner);
  if (root !== undefined) return [root];
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element)) return [];
      return assignmentRoots(ts.isSpreadElement(element) ? element.expression : element);
    });
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) return assignmentRoots(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isSpreadAssignment(property)) return assignmentRoots(property.expression);
      return [];
    });
  }
  return [];
}

function climbExpression(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)) current = current.parent;
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isUpdateOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
}

function validateRouterModels(value: unknown): RouterModels {
  if (!isRecord(value) || value.format !== 'router-models' || value.version !== 1
    || !Array.isArray(value.models)) throw new RouterModelError('invalid-shape');
  assertKeys(value, ['format', 'version', 'models']);
  if (value.models.length === 0 || value.models.length > MAX_ROUTER_MODELS) {
    throw new RouterModelError('invalid-shape');
  }
  const seen = new Set<string>();
  const models = value.models.map((entry) => validateRouterModel(entry));
  for (const entry of models) {
    const key = `${entry.factory.path}\u0000${entry.factory.name}`;
    if (seen.has(key)) throw new RouterModelError('duplicate-model');
    seen.add(key);
  }
  return { format: 'router-models', version: 1, models };
}

function validateRouterModel(value: unknown): RouterModel {
  if (!isRecord(value) || !isRecord(value.factory)) throw new RouterModelError('invalid-shape');
  assertKeys(value, [
    'factory',
    'routesArgument',
    'pathProperty',
    'screenProperty',
    'childrenProperty',
    'pathSyntax',
  ]);
  assertKeys(value.factory, ['path', 'name']);
  const factoryPath = value.factory.path;
  const factoryName = value.factory.name;
  const routesArgument = value.routesArgument;
  const pathProperty = value.pathProperty;
  const screenProperty = value.screenProperty;
  const childrenProperty = value.childrenProperty;
  const pathSyntax = value.pathSyntax;
  if (!isSafeSourcePath(factoryPath) || !isIdentifierName(factoryName)
    || typeof routesArgument !== 'number' || !Number.isSafeInteger(routesArgument)
    || routesArgument < 0 || routesArgument > 64
    || !isPropertyAssertion(pathProperty) || !isPropertyAssertion(screenProperty)
    || childrenProperty !== undefined && !isPropertyAssertion(childrenProperty)
    || pathSyntax !== 'colon' && pathSyntax !== 'template') throw new RouterModelError('unsafe-value');
  const propertyNames = [pathProperty, screenProperty, childrenProperty].filter(
    (entry): entry is string => entry !== undefined,
  );
  if (new Set(propertyNames).size !== propertyNames.length) throw new RouterModelError('unsafe-value');
  return {
    factory: { path: factoryPath, name: factoryName },
    routesArgument,
    pathProperty,
    screenProperty,
    ...(childrenProperty === undefined ? {} : { childrenProperty }),
    pathSyntax,
  };
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new RouterModelError('invalid-shape');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifierName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROPERTY_NAME_LENGTH
    && isSafeIdentifier(value)
    && /^(?:[$_\p{ID_Start}])[$\u200C\u200D\p{ID_Continue}]*$/u.test(value);
}

function isPropertyAssertion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROPERTY_NAME_LENGTH && isSafeIdentifier(value);
}

function isSafeSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_MODEL_STRING_LENGTH || !isSafeIdentifier(value)
    || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function routerModelErrorMessage(code: RouterModelErrorCode): string {
  switch (code) {
    case 'too-large': return `the router model exceeds ${MAX_ROUTER_MODEL_BYTES} bytes`;
    case 'invalid-json': return 'the router model is not valid JSON';
    case 'too-deep': return `the router model exceeds the ${MAX_ROUTER_JSON_DEPTH}-level JSON depth limit`;
    case 'too-many-nodes': return 'the router model exceeds the bounded JSON node limit';
    case 'duplicate-key': return 'the router model contains a duplicate JSON key';
    case 'duplicate-model': return 'the router model declares the same factory more than once';
    case 'invalid-shape': return 'the router model does not match format router-models version 1';
    case 'unsafe-value': return 'the router model contains an unsafe path, name, property, or argument';
  }
}

/** JSON.parse 전에 깊이·노드·중복 키를 검사하는 bounded scanner다. */
class RouterJsonScanner {
  #index = 0;
  #nodes = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scan(): void {
    try {
      this.value(0);
      this.space();
      if (this.#index !== this.text.length) throw new RouterModelError('invalid-json');
    } catch (error) {
      if (error instanceof RouterModelError) throw error;
      throw new RouterModelError('invalid-json');
    }
  }

  private value(depth: number): void {
    if (depth > MAX_ROUTER_JSON_DEPTH) throw new RouterModelError('too-deep');
    if (++this.#nodes > MAX_ROUTER_JSON_NODES) throw new RouterModelError('too-many-nodes');
    this.space();
    const token = this.text[this.#index];
    if (token === '{') this.object(depth);
    else if (token === '[') this.array(depth);
    else if (token === '"') this.string();
    else if (token === 't') this.literal('true');
    else if (token === 'f') this.literal('false');
    else if (token === 'n') this.literal('null');
    else if (token !== undefined && /[-0-9]/u.test(token)) this.number();
    else throw new RouterModelError('invalid-json');
  }

  private object(depth: number): void {
    this.#index += 1;
    this.space();
    const keys = new Set<string>();
    if (this.text[this.#index] === '}') {
      this.#index += 1;
      return;
    }
    while (true) {
      this.space();
      const key = this.stringValue();
      if (keys.has(key)) throw new RouterModelError('duplicate-key');
      keys.add(key);
      this.space();
      if (this.text[this.#index++] !== ':') throw new RouterModelError('invalid-json');
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === '}') return;
      if (token !== ',') throw new RouterModelError('invalid-json');
    }
  }

  private array(depth: number): void {
    this.#index += 1;
    this.space();
    if (this.text[this.#index] === ']') {
      this.#index += 1;
      return;
    }
    while (true) {
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === ']') return;
      if (token !== ',') throw new RouterModelError('invalid-json');
    }
  }

  private stringValue(): string {
    const start = this.#index;
    this.string();
    try {
      const value = JSON.parse(this.text.slice(start, this.#index)) as unknown;
      if (typeof value !== 'string' || value.length > MAX_MODEL_STRING_LENGTH) throw new Error();
      return value;
    } catch {
      throw new RouterModelError('unsafe-value');
    }
  }

  private string(): void {
    if (this.text[this.#index++] !== '"') throw new RouterModelError('invalid-json');
    while (this.#index < this.text.length) {
      const char = this.text[this.#index++];
      if (char === '"') return;
      if (char === '\\') {
        const escape = this.text[this.#index++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.text.slice(this.#index, this.#index + 4))) {
            throw new RouterModelError('invalid-json');
          }
          this.#index += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new RouterModelError('invalid-json');
        }
      } else if (char !== undefined && char < ' ') throw new RouterModelError('invalid-json');
    }
    throw new RouterModelError('invalid-json');
  }

  private number(): void {
    const end = scanJsonNumberToken(this.text, this.#index);
    if (end === undefined) throw new RouterModelError('invalid-json');
    this.#index = end;
  }

  private literal(value: string): void {
    if (this.text.slice(this.#index, this.#index + value.length) !== value) {
      throw new RouterModelError('invalid-json');
    }
    this.#index += value.length;
  }

  private space(): void {
    while (/\s/u.test(this.text[this.#index] ?? '')) this.#index += 1;
  }
}
