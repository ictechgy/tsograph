/** fetch·axios·ky 호출을 JS route-call 문서로 만든다. 분석 대상 코드는 실행하지 않는다. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { formatBridgeTimestamp, type BridgeLocation, type HttpMethod } from '../../exchange/bridge-facts.ts';
import { scopeIdOf } from '../../graph/symbol-ids.ts';
import { hasParseErrors, isNodeTestPath, loadNodeProject } from '../node/node-project.ts';
import { declarationOf, packageBindingOf, symbolAt, unwrap } from '../node/symbols.ts';
import { MAX_ROUTE_FACTS, RouteFactLimitError } from '../route-document.ts';
import { ClientValues, configValue, type ClientConfig } from './client-values.ts';
import { composeUrl, type ComposedUrl, type UrlJoin } from './url-compose.ts';

/** 호출 사실의 위치와 impact id다. */
export interface ClientRouteFact extends ComposedUrl {
  readonly kind: 'route-call';
  readonly method?: HttpMethod;
  readonly methodDynamic?: true;
  readonly service?: string;
  readonly testSource?: true;
  readonly location: BridgeLocation;
  readonly symbol: { readonly qualifiedName: string; readonly usr: string };
}
/** routes --role client 문서다. 서버 dispatch 정책은 호출 문서에 싣지 않는다. */
export interface ClientRouteDocument {
  readonly format: 'bridge-facts'; readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string; readonly platform: 'js'; readonly target: 'http';
  readonly roles: readonly ['client']; readonly sourceSets: { readonly tests: 'included' | 'excluded' };
  readonly project: string; readonly service?: string;
  readonly facts: readonly ClientRouteFact[]; readonly limitations: readonly string[];
}
/** 패키지 provenance로 확인한 클라이언트와 누적 설정이다. */
interface Client { readonly library: 'axios' | 'ky'; readonly configs: readonly ClientConfig[]; readonly unsafe: boolean }
/** 요청 호출의 인자 바인딩이다. */
interface Sink { readonly library: 'fetch' | 'axios' | 'ky'; readonly configs: readonly ClientConfig[]; readonly path?: ts.Expression | undefined; readonly forcedMethod?: string; readonly unsafe: boolean }
/** 계약 동사 집합이다. */
const methods = new Set<string>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']);

/** const 별칭·import·create/extend를 심볼로 따라가 클라이언트를 식별한다. */
function clientOf(expression: ts.Expression, values: ClientValues, depth = 0): Client | undefined {
  if (depth > 16) return undefined;
  const node = unwrap(expression);
  const root = values.rootSymbol(node);
  const unsafe = root !== undefined && values.mutated.has(root);
  const binding = packageBindingOf(values.project.checker, node);
  if (binding !== undefined && ['default', '*'].includes(binding.name) && (binding.module === 'axios' || binding.module === 'ky')) {
    return { library: binding.module, configs: [], unsafe };
  }
  if (ts.isIdentifier(node)) {
    const declaration = declarationOf(values.project.checker, node);
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && values.project.pathOf(declaration.getSourceFile()) !== undefined) {
      const client = clientOf(declaration.initializer, values, depth + 1);
      return client === undefined ? undefined : { ...client, unsafe: client.unsafe || unsafe };
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'default') return clientOf(node.expression, values, depth + 1);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['create', 'extend'].includes(node.expression.name.text)) {
    const parent = clientOf(node.expression.expression, values, depth + 1);
    if (parent === undefined || (parent.library === 'axios' && node.expression.name.text === 'extend')) return undefined;
    const inherits = parent.library === 'axios' || node.expression.name.text === 'extend';
    return { ...parent, configs: [...(inherits ? parent.configs : []), values.config(node.arguments[0])], unsafe: parent.unsafe };
  }
  return undefined;
}

/** 프로젝트에서 선언한 동명 함수는 global fetch로 보지 않는다. */
function isGlobal(expression: ts.Expression, name: string, values: ClientValues): boolean {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node) && node.name.text === name && ts.isIdentifier(node.expression)
    && ['globalThis', 'window', 'self'].includes(node.expression.text)) return isGlobal(node.expression, node.expression.text, values);
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  const symbol = symbolAt(values.project.checker, node);
  return symbol === undefined || !(symbol.declarations ?? []).some((d) => values.project.pathOf(d.getSourceFile()) !== undefined);
}

/** 라우트 요청만 선택한다. create·extend·일반 객체의 get은 요청이 아니다. */
function sinkOf(call: ts.CallExpression, values: ClientValues): Sink | undefined {
  const callee = unwrap(call.expression);
  if (isGlobal(callee, 'fetch', values)) return { library: 'fetch', path: call.arguments[0], configs: [values.config(call.arguments[1])], unsafe: false };
  const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const direct = clientOf(callee, values);
  const client = direct ?? (ts.isPropertyAccessExpression(callee) ? clientOf(callee.expression, values) : undefined);
  if (client === undefined) return undefined;
  const aliases = client.library === 'axios' ? ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] : ['get', 'head', 'post', 'put', 'patch', 'delete'];
  if (direct === undefined && !(client.library === 'axios' && member === 'request') && !aliases.includes(member ?? '')) return undefined;
  const fixed = direct === undefined && member !== 'request' ? member!.toUpperCase() : undefined;
  const first = call.arguments[0] === undefined ? undefined : values.resolve(call.arguments[0]);
  const objectCall = client.library === 'axios' && fixed === undefined && (first === undefined || ts.isObjectLiteralExpression(first));
  const configs = [...client.configs, values.config(objectCall ? call.arguments[0] : call.arguments[fixed !== undefined && ['POST', 'PUT', 'PATCH'].includes(fixed) && client.library === 'axios' ? 2 : 1])];
  const url = objectCall ? configValue(configs, 'url') : call.arguments[0];
  return { library: client.library, configs, ...(url == null ? {} : { path: url }), ...(fixed === undefined ? {} : { forcedMethod: fixed }), unsafe: client.unsafe };
}

/** ky의 선언된 major만 읽는다. 모호한 버전 범위는 추측하지 않는다. */
function kyMajor(root: string): number | undefined {
  try {
    const path = join(root, 'package.json');
    if (statSync(path).size > 1024 * 1024) return undefined;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    const version = manifest.dependencies?.['ky'] ?? manifest.devDependencies?.['ky'];
    const match = typeof version === 'string' ? /^(?:\^|~)?([12])\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.exec(version) : null;
    return match === null ? undefined : Number(match[1]);
  } catch { return undefined; }
}

/** 요청 설정에서 결합 방식과 base를 정한다. 미상 값을 base 없음으로 바꾸지 않는다. */
function composition(sink: Sink, values: ClientValues, major: number | undefined): { join: UrlJoin; base: string | null; unsafe: boolean; allowAbsolute: boolean } {
  let kind: UrlJoin = sink.library === 'axios' ? 'axios-base-url' : 'fetch';
  let field = 'baseURL';
  let unsafe = sink.unsafe || configValue(sink.configs, 'hooks') !== undefined
    || configValue(sink.configs, 'fetch') !== undefined || configValue(sink.configs, 'adapter') !== undefined
    || configValue(sink.configs, 'transformRequest') !== undefined;
  if (sink.library === 'ky') {
    const legacy = configValue(sink.configs, 'prefixUrl');
    const prefix = configValue(sink.configs, 'prefix');
    const base = configValue(sink.configs, 'baseUrl');
    if (legacy !== undefined) { kind = 'ky-prefix-url'; field = 'prefixUrl'; unsafe ||= major !== 1 || prefix !== undefined || base !== undefined; }
    else if (prefix !== undefined) { kind = 'ky-prefix'; field = 'prefix'; unsafe ||= major !== 2 || base !== undefined; }
    else if (base !== undefined) { kind = 'ky-base-url'; field = 'baseUrl'; unsafe ||= major !== 2; }
    else field = '';
  }
  if (sink.library === 'fetch') field = '';
  const baseValue = field === '' ? undefined : configValue(sink.configs, field);
  const base = baseValue === undefined ? '' : values.string(baseValue) ?? null;
  const absolute = configValue(sink.configs, 'allowAbsoluteUrls');
  const resolved = absolute == null ? undefined : values.resolve(absolute);
  if (sink.library === 'axios' && absolute !== undefined && resolved?.kind !== ts.SyntaxKind.TrueKeyword && resolved?.kind !== ts.SyntaxKind.FalseKeyword) unsafe = true;
  return { join: kind, base, unsafe, allowAbsolute: resolved?.kind !== ts.SyntaxKind.FalseKeyword };
}

/** 호출 측 스캔과 사실 조립을 실행한다. */
export function extractClientRoutes(root: string, service: string | undefined, includeTests: boolean, toolVersion: string, generatedAt: Date): ClientRouteDocument {
  const project = loadNodeProject(root);
  const values = new ClientValues(project, includeTests);
  // 알 수 없는 함수에 넘긴 객체·클라이언트는 변경될 수 있다. 모듈 전역 순서와 무관하게 보수적으로 제외한다.
  for (const [path, source] of project.files) {
    if (!includeTests && isNodeTestPath(path)) continue;
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && sinkOf(node, values) === undefined && clientOf(node, values) === undefined) {
        for (const argument of node.arguments) {
          const resolved = values.resolve(argument);
          if ((resolved !== undefined && ts.isObjectLiteralExpression(resolved)) || clientOf(argument, values) !== undefined) values.markMutated(argument);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  const major = kyMajor(root);
  const facts: ClientRouteFact[] = [];
  const limitations = new Set<string>(['route-call-coverage: only global fetch and symbol-proven axios/ky calls are modeled; computed/global aliases, URL/Request objects, wrappers, custom transports and runtime configuration may add requests']);
  for (const [path, source] of project.files) {
    const test = isNodeTestPath(path);
    if (test && !includeTests) continue;
    if (hasParseErrors(source)) limitations.add('route-call-coverage: source syntax errors may hide requests');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const sink = sinkOf(node, values);
        if (sink !== undefined) {
          if (facts.length >= MAX_ROUTE_FACTS) throw new RouteFactLimitError();
          const methodExpression = configValue(sink.configs, 'method');
          const method = sink.forcedMethod ?? (methodExpression === undefined ? 'GET' : values.string(methodExpression)?.toUpperCase());
          const options = composition(sink, values, major);
          if (sink.library === 'ky' && major === undefined && options.join !== 'fetch') limitations.add('route-call-coverage: ky URL option dialect requires an unambiguous declared major version (1 or 2)');
          const url = options.unsafe ? { channel: null, dynamic: true, pathAnchor: 'base' as const }
            : composeUrl(values.parts(sink.path), options.join, options.base, options.allowAbsolute);
          if (url.dynamic) limitations.add('dynamic-route-calls: request path or configuration cannot be proven without execution');
          if (url.pathAnchor === 'base') limitations.add('unresolved-route-prefix: request base or relative URL prefix is not statically known');
          if (method === undefined || !methods.has(method)) limitations.add('route-call-coverage: some request methods cannot be proven');
          const id = scopeIdOf(node, path);
          facts.push({ kind: 'route-call', ...url,
            ...(method !== undefined && methods.has(method) ? { method: method as HttpMethod } : { methodDynamic: true }),
            ...(service === undefined ? {} : { service }), ...(test ? { testSource: true } : {}),
            location: project.locationOf(node), symbol: { qualifiedName: id, usr: id } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (Object.values(project.gaps).some((gap) => Boolean(gap))) limitations.add('route-call-coverage: unreadable, symlinked, oversized or capped project sources were skipped');
  return { format: 'bridge-facts', version: 1, tool: { name: 'tsograph', version: toolVersion }, generatedAt: formatBridgeTimestamp(generatedAt),
    platform: 'js', target: 'http', roles: ['client'], sourceSets: { tests: includeTests ? 'included' : 'excluded' }, project: root,
    ...(service === undefined ? {} : { service }), facts, limitations: [...limitations].sort() };
}
