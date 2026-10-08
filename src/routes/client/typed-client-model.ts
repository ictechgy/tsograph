/**
 * 실행 없이 읽는 명시적 typed HTTP client 모델이다.
 *
 * 모델은 transport 구현을 추측하지 않고, 프로젝트에 선언된 정확한 type/class와 메서드 호출의
 * URL·동사만 보강한다. 입력은 JSON 하나이며 크기·깊이·원소 수를 먼저 제한한다.
 */
import ts from 'typescript';
import { scanJsonNumberToken } from '../../exchange/json-number-token.ts';

import { isSafeIdentifier, type HttpMethod } from '../../exchange/bridge-facts.ts';
import { resolveAlias, symbolAt, unwrap } from '../node/symbols.ts';

/** 모델 파일의 바이트 상한이다. */
export const MAX_TYPED_CLIENT_MODEL_BYTES = 1024 * 1024;
/** 모델 receiver 수의 상한이다. */
export const MAX_TYPED_CLIENT_MODELS = 1024;
/** 전체 method 수의 상한이다. */
export const MAX_TYPED_CLIENT_METHODS = 8192;
const MAX_TYPED_JSON_DEPTH = 32;
const MAX_TYPED_JSON_NODES = 100_000;
const MAX_TYPED_STRING_LENGTH = 2048;
const MAX_SERVICE_LENGTH = 256;

/** 모델 receiver가 가리키는 선언 종류다. `type`은 type alias와 interface를 포함한다. */
export type TypedClientReceiverKind = 'type' | 'class';

/** 모델이 가리키는 프로젝트 선언의 안정 identity다. */
export interface TypedClientReceiver {
  readonly kind: TypedClientReceiverKind;
  readonly path: string;
  readonly name: string;
}

/** 하나의 typed HTTP method 규칙이다. */
export interface TypedClientMethod {
  readonly name: string;
  readonly method: HttpMethod;
  readonly pathArgument: number;
  readonly base: string;
  readonly service?: string;
}

/** receiver 하나와 그 named method 규칙이다. */
export interface TypedClientModel {
  readonly receiver: TypedClientReceiver;
  readonly methods: readonly TypedClientMethod[];
}

/** 명시적 machine contract 파일이다. */
export interface TypedClientModels {
  readonly format: 'http-client-models';
  readonly version: 1;
  readonly models: readonly TypedClientModel[];
}

/** 호출과 모델 method가 정확히 만났을 때의 정적 결과다. */
export interface TypedClientMatch {
  readonly receiver: ts.Expression;
  readonly method: TypedClientMethod;
}

/** 모델 파일 오류다. 원문·경로를 오류에 넣지 않는다. */
export class TypedClientModelError extends Error {
  readonly code: TypedClientModelErrorCode;
  constructor(code: TypedClientModelErrorCode) {
    super(typedClientModelMessage(code));
    this.name = 'TypedClientModelError';
    this.code = code;
  }
}

/** 모델 파일 오류 종류다. */
export type TypedClientModelErrorCode =
  | 'too-large' | 'invalid-json' | 'too-deep' | 'too-many-nodes' | 'invalid-shape'
  | 'duplicate-key' | 'duplicate-model' | 'duplicate-method' | 'unsafe-value';

/** JSON 문자열을 bounded AST로 검사한 뒤 typed model을 검증한다. */
export function parseTypedClientModels(text: string): TypedClientModels {
  if (byteLength(text) > MAX_TYPED_CLIENT_MODEL_BYTES) throw new TypedClientModelError('too-large');
  new JsonLimitsScanner(text).scan();
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new TypedClientModelError('invalid-json'); }
  return validateDocument(value);
}

/**
 * 호출 수신자의 선언 symbol과 모델 receiver를 맞춘다.
 *
 * 이름이나 property shape만으로는 매칭하지 않는다. type alias·import alias는 checker가 푼
 * 프로젝트 선언까지 따라가고, union·any·unknown·inline type은 보수적으로 거부한다.
 */
export function typedClientMethodOf(
  call: ts.CallExpression,
  models: TypedClientModels | undefined,
  checker: ts.TypeChecker,
  pathOf: (sourceFile: ts.SourceFile) => string | undefined,
): TypedClientMatch | undefined {
  if (models === undefined || !ts.isPropertyAccessExpression(unwrap(call.expression)) || call.questionDotToken !== undefined) return undefined;
  const callee = unwrap(call.expression) as ts.PropertyAccessExpression;
  const receiver = unwrap(callee.expression);
  const identities = receiverIdentities(receiver, checker, pathOf);
  if (identities.length === 0) return undefined;
  const model = identities.map((identity) => models.models.find((candidate) => candidate.receiver.kind === identity.kind
    && candidate.receiver.path === identity.path && candidate.receiver.name === identity.name)).find((candidate) => candidate !== undefined);
  if (model === undefined) return undefined;
  const method = model.methods.find((candidate) => candidate.name === callee.name.text);
  if (method === undefined) return undefined;
  const type = checker.getTypeAtLocation(receiver);
  if (isAmbiguousType(type)) return undefined;
  const property = type.getProperty(method.name);
  if (property === undefined) return undefined;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration ?? receiver);
  if (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length === 0) return undefined;
  return { receiver, method };
}

interface DeclarationIdentity {
  readonly kind: TypedClientReceiverKind;
  readonly path: string;
  readonly name: string;
}

function receiverIdentities(expression: ts.Expression, checker: ts.TypeChecker, pathOf: (sourceFile: ts.SourceFile) => string | undefined): readonly DeclarationIdentity[] {
  const type = checker.getTypeAtLocation(expression);
  if (isAmbiguousType(type)) return [];
  const declared = declaredTypeIdentities(expression, checker, pathOf);
  if (declared !== undefined) return declared;
  const fallback = symbolIdentity(type.aliasSymbol ?? type.symbol, checker, pathOf);
  return fallback === undefined ? [] : [fallback];
}

function declaredTypeIdentities(expression: ts.Expression, checker: ts.TypeChecker, pathOf: (sourceFile: ts.SourceFile) => string | undefined): readonly DeclarationIdentity[] | undefined {
  const node = unwrap(expression);
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const symbol = symbolAt(checker, ts.isIdentifier(node) ? node : node);
  const declaration = symbol === undefined ? undefined : resolveAlias(checker, symbol).valueDeclaration ?? resolveAlias(checker, symbol).declarations?.[0];
  const typeNode = declarationTypeNode(declaration);
  if (typeNode === undefined) return undefined;
  if (ts.isTypeReferenceNode(typeNode)) {
    const namedSymbol = symbolAt(checker, typeNode.typeName);
    if (namedSymbol !== undefined) {
      const named = symbolIdentity(namedSymbol, checker, pathOf);
      if (named === undefined) return [];
      const namedDeclaration = resolveAlias(checker, namedSymbol).valueDeclaration ?? resolveAlias(checker, namedSymbol).declarations?.[0];
      if (namedDeclaration !== undefined && ts.isTypeAliasDeclaration(namedDeclaration)
        && ts.isTypeReferenceNode(namedDeclaration.type)) {
        const expanded = checker.getTypeFromTypeNode(namedDeclaration.type);
        const expandedIdentity = isAmbiguousType(expanded) ? undefined : symbolIdentity(expanded.aliasSymbol ?? expanded.symbol, checker, pathOf);
        return expandedIdentity === undefined ? [named] : [named, expandedIdentity];
      }
      return [named];
    }
  }
  const type = checker.getTypeFromTypeNode(typeNode);
  if (isAmbiguousType(type)) return [];
  const identity = symbolIdentity(type.aliasSymbol ?? type.symbol, checker, pathOf);
  return identity === undefined ? [] : [identity];
}

function declarationTypeNode(declaration: ts.Declaration | undefined): ts.TypeNode | undefined {
  if (declaration === undefined) return undefined;
  if (ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)
    || ts.isVariableDeclaration(declaration)) return declaration.type;
  return undefined;
}

function symbolIdentity(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, pathOf: (sourceFile: ts.SourceFile) => string | undefined): DeclarationIdentity | undefined {
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declarations = (resolved.declarations ?? []).filter((candidate) => ts.isClassDeclaration(candidate)
    || ts.isClassExpression(candidate) || ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate));
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (declaration === undefined) return undefined;
  const path = pathOf(declaration.getSourceFile());
  if (path === undefined) return undefined;
  if (!ts.isSourceFile(declaration.parent)) return undefined;
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return declaration.name === undefined ? undefined : { kind: 'class', path, name: declaration.name.text };
  }
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    return { kind: 'type', path, name: declaration.name.text };
  }
  return undefined;
}

function isAmbiguousType(type: ts.Type): boolean {
  return type.isUnionOrIntersection() || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
}

function validateDocument(value: unknown): TypedClientModels {
  if (!isRecord(value) || value.format !== 'http-client-models' || value.version !== 1 || !Array.isArray(value.models)) {
    throw new TypedClientModelError('invalid-shape');
  }
  assertKeys(value, ['format', 'version', 'models']);
  if (value.models.length > MAX_TYPED_CLIENT_MODELS) throw new TypedClientModelError('invalid-shape');
  let methodCount = 0;
  const seenModels = new Set<string>();
  const models: TypedClientModel[] = [];
  for (const raw of value.models) {
    const model = validateModel(raw);
    const key = `${model.receiver.kind}:${model.receiver.path}:${model.receiver.name}`;
    if (seenModels.has(key)) throw new TypedClientModelError('duplicate-model');
    seenModels.add(key);
    methodCount += model.methods.length;
    if (methodCount > MAX_TYPED_CLIENT_METHODS) throw new TypedClientModelError('invalid-shape');
    models.push(model);
  }
  return { format: 'http-client-models', version: 1, models };
}

function validateModel(value: unknown): TypedClientModel {
  if (!isRecord(value) || !isRecord(value.receiver)) throw new TypedClientModelError('invalid-shape');
  assertKeys(value, ['receiver', 'methods']);
  assertKeys(value.receiver, ['kind', 'path', 'name']);
  const kind = value.receiver.kind;
  const path = value.receiver.path;
  const name = value.receiver.name;
  if ((kind !== 'type' && kind !== 'class') || !isSafeSourcePath(path) || !isIdentifier(name)) {
    throw new TypedClientModelError('unsafe-value');
  }
  const rawMethods = value.methods;
  const methods: TypedClientMethod[] = [];
  if (Array.isArray(rawMethods)) {
    for (const raw of rawMethods) methods.push(validateMethod(raw));
  } else if (isRecord(rawMethods)) {
    for (const [nameKey, raw] of Object.entries(rawMethods)) {
      if (!isIdentifier(nameKey) || !isRecord(raw)) throw new TypedClientModelError('invalid-shape');
      methods.push(validateMethod({ ...raw, name: nameKey }));
    }
  } else throw new TypedClientModelError('invalid-shape');
  const names = new Set<string>();
  for (const method of methods) {
    if (names.has(method.name)) throw new TypedClientModelError('duplicate-method');
    names.add(method.name);
  }
  return { receiver: { kind, path, name }, methods };
}

function validateMethod(value: unknown): TypedClientMethod {
  if (!isRecord(value) || !isIdentifier(value.name) || !isHttpMethod(value.method)
    || !isPathArgument(value.pathArgument) || typeof value.base !== 'string' || !isBase(value.base)) {
    throw new TypedClientModelError('unsafe-value');
  }
  assertKeys(value, ['name', 'method', 'pathArgument', 'base', 'service']);
  const service = value.service;
  if (service !== undefined && (typeof service !== 'string' || service.length > MAX_SERVICE_LENGTH || !isIdentifier(service))) {
    throw new TypedClientModelError('unsafe-value');
  }
  return {
    name: value.name, method: value.method.toUpperCase() as HttpMethod, pathArgument: value.pathArgument, base: value.base,
    ...(service === undefined ? {} : { service }),
  };
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new TypedClientModelError('invalid-shape');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TYPED_STRING_LENGTH
    && isSafeIdentifier(value) && /^(?:[$_\p{ID_Start}])[$\u200C\u200D\p{ID_Continue}]*$/u.test(value);
}

function isSafeSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TYPED_STRING_LENGTH || !isSafeIdentifier(value)) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isPathArgument(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 64;
}

const HTTP_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']);
function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === 'string' && HTTP_METHODS.has(value.toUpperCase() as HttpMethod);
}

function isBase(value: string): boolean {
  if (value.length > MAX_TYPED_STRING_LENGTH || !value.isWellFormed() || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|%00/iu.test(value)) return false;
  if (value.includes('?') || value.includes('#')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === '';
    } catch { return false; }
  }
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && !value.startsWith('//');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function typedClientModelMessage(code: TypedClientModelErrorCode): string {
  switch (code) {
    case 'too-large': return `the client model exceeds ${MAX_TYPED_CLIENT_MODEL_BYTES} bytes; split the model file.`;
    case 'invalid-json': return 'the client model is not valid JSON; fix the model file.';
    case 'too-deep': return `the client model exceeds the ${MAX_TYPED_JSON_DEPTH}-level JSON depth limit; flatten it.`;
    case 'too-many-nodes': return 'the client model exceeds the bounded JSON node limit; split the model file.';
    case 'duplicate-key': return 'the client model contains a duplicate JSON key; remove the duplicate.';
    case 'duplicate-model': return 'the client model declares the same receiver more than once; keep one exact receiver entry.';
    case 'duplicate-method': return 'the client model declares the same method more than once for one receiver; keep one entry.';
    case 'unsafe-value': return 'the client model contains an invalid receiver, method, URL base, or service value.';
    case 'invalid-shape': return 'the client model does not match format http-client-models version 1.';
  }
}

/** JSON 파서 전에 깊이·노드·중복 키를 bounded하게 검사한다. */
class JsonLimitsScanner {
  #index = 0;
  #nodes = 0;
  private readonly text: string;
  constructor(text: string) { this.text = text; }

  scan(): void {
    try {
      this.value(0);
      this.space();
      if (this.#index !== this.text.length) throw new TypedClientModelError('invalid-json');
    } catch (error) {
      if (error instanceof TypedClientModelError) throw error;
      throw new TypedClientModelError('invalid-json');
    }
  }

  private value(depth: number): void {
    if (depth > MAX_TYPED_JSON_DEPTH) throw new TypedClientModelError('too-deep');
    if (++this.#nodes > MAX_TYPED_JSON_NODES) throw new TypedClientModelError('too-many-nodes');
    this.space();
    const token = this.text[this.#index];
    if (token === '{') { this.object(depth); return; }
    if (token === '[') { this.array(depth); return; }
    if (token === '"') { this.string(); return; }
    if (token === 't' && this.literal('true')) return;
    if (token === 'f' && this.literal('false')) return;
    if (token === 'n' && this.literal('null')) return;
    if (token !== undefined && /[-0-9]/u.test(token)) { this.number(); return; }
    throw new TypedClientModelError('invalid-json');
  }

  private object(depth: number): void {
    this.#index++; this.space();
    const keys = new Set<string>();
    if (this.text[this.#index] === '}') { this.#index++; return; }
    while (true) {
      this.space();
      if (this.text[this.#index] !== '"') throw new TypedClientModelError('invalid-json');
      const key = this.stringValue();
      if (keys.has(key)) throw new TypedClientModelError('duplicate-key');
      keys.add(key);
      this.space(); if (this.text[this.#index++] !== ':') throw new TypedClientModelError('invalid-json');
      this.value(depth + 1); this.space();
      const token = this.text[this.#index++];
      if (token === '}') return;
      if (token !== ',') throw new TypedClientModelError('invalid-json');
    }
  }

  private array(depth: number): void {
    this.#index++; this.space();
    if (this.text[this.#index] === ']') { this.#index++; return; }
    while (true) {
      this.value(depth + 1); this.space();
      const token = this.text[this.#index++];
      if (token === ']') return;
      if (token !== ',') throw new TypedClientModelError('invalid-json');
    }
  }

  private stringValue(): string {
    const start = this.#index;
    this.string();
    try {
      const value = JSON.parse(this.text.slice(start, this.#index)) as unknown;
      if (typeof value !== 'string' || value.length > MAX_TYPED_STRING_LENGTH) throw new Error();
      return value;
    } catch { throw new TypedClientModelError('unsafe-value'); }
  }

  private string(): void {
    if (this.text[this.#index++] !== '"') throw new TypedClientModelError('invalid-json');
    while (this.#index < this.text.length) {
      const char = this.text[this.#index++];
      if (char === '"') return;
      if (char === '\\') {
        const escape = this.text[this.#index++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.text.slice(this.#index, this.#index + 4))) throw new TypedClientModelError('invalid-json');
          this.#index += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) throw new TypedClientModelError('invalid-json');
      }
      else if (char !== undefined && char < ' ') throw new TypedClientModelError('invalid-json');
    }
    throw new TypedClientModelError('invalid-json');
  }

  private number(): void {
    const end = scanJsonNumberToken(this.text, this.#index);
    if (end === undefined) throw new TypedClientModelError('invalid-json');
    this.#index = end;
  }

  private literal(value: string): boolean {
    if (this.text.slice(this.#index, this.#index + value.length) !== value) throw new TypedClientModelError('invalid-json');
    this.#index += value.length; return true;
  }

  private space(): void { while (/\s/u.test(this.text[this.#index] ?? '')) this.#index++; }
}
