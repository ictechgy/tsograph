/**
 * ORM·드라이버 표면이 쓰는 이름 해석기다: 식별자가 프로젝트의 어느 선언을 가리키는지, 또는 어느
 * 외부 패키지의 어떤 export를 가져온 것인지 답한다.
 *
 * TypeScript 바인더·checker의 **심볼 해석만** 쓴다. Program에는 프로젝트 소스만 넣고(기본 lib·
 * `node_modules`·`@types` 없음), 모듈 해석은 기존 `ModuleResolver`(프로젝트 안 파일만)에 맡긴다.
 * 그래서 의존성 설치 여부와 무관하게 같은 결과가 나오고, 타입 추론 결과는 쓰지 않는다 — 외부 패키지의
 * 값은 import 문의 지정자와 이름으로만 식별한다(`import { pgTable } from 'drizzle-orm/pg-core'`).
 */

import { extname, resolve } from 'node:path';

import ts from 'typescript';

import type { ModuleResolver } from '../module-resolver.ts';
import type { SourceModule } from '../source-module.ts';

/** 별칭 사슬을 따라가는 최대 단계다. 순환 재수출을 끊는다. */
const MAX_ALIAS_STEPS = 32;

/** 식별자가 가리키는 대상이다. */
export type BindingOrigin =
  /** 외부 패키지 export(`name`은 `default`·`*`·export 이름)다. */
  | { readonly kind: 'external'; readonly module: string; readonly name: string }
  /** 프로젝트 안 선언이다. */
  | { readonly kind: 'declaration'; readonly declaration: ts.Declaration }
  /** 프로젝트 모듈 이름공간(`import * as schema from './schema'`)이다. */
  | { readonly kind: 'module'; readonly sourceFile: ts.SourceFile }
  /** 어디에도 선언되지 않은 전역 이름이다. */
  | { readonly kind: 'global'; readonly name: string }
  /** 해석하지 못했다. */
  | { readonly kind: 'unknown' };

/** 해석하지 못한 결과의 공유 값이다. */
export const UNKNOWN_ORIGIN: BindingOrigin = { kind: 'unknown' };

/**
 * require 재수출 사슬이 `require`로 들어간 모듈 파일 목록이다(앞이 바깥). 꼬리를 공유하는 연결 목록이라 사슬을
 * 이을 때 복사하지 않는다.
 */
interface RequireTrail {
  readonly file: ts.SourceFile;
  readonly rest: RequireTrail | undefined;
}

/** 모듈 export 하나(파일, 이름)를 따라간 결과다. */
interface ExportChain {
  readonly origin: BindingOrigin;
  /** 이 사슬이 require로 들어간 파일이다(첫 원소가 이 export의 파일). 바깥 사슬이 이 안의 파일이면 순환이다. */
  readonly trail: RequireTrail;
}

/** 별칭 사슬 하나를 따라간 결과다. */
interface Resolution {
  readonly origin: BindingOrigin;
  /** 사슬 끝이 `require('./m').name` 꼴이면 그 export의 사슬이다(바깥 export의 순환 판정에 쓴다). */
  readonly via?: ExportChain;
}

/** 파일 확장자 → 컴파일러 확장자 종류다. */
const extensions: ReadonlyMap<string, ts.Extension> = new Map([
  ['.ts', ts.Extension.Ts], ['.tsx', ts.Extension.Tsx], ['.mts', ts.Extension.Mts], ['.cts', ts.Extension.Cts],
  ['.js', ts.Extension.Js], ['.jsx', ts.Extension.Jsx], ['.mjs', ts.Extension.Mjs], ['.cjs', ts.Extension.Cjs],
]);

/** 프로젝트 소스만 담은 Program 위의 이름 해석기다. */
export class OrmBinder {
  /** 심볼 해석에만 쓰는 checker다. */
  private readonly checker: ts.TypeChecker;
  /** 절대 경로 → 소스 모듈이다. */
  private readonly modulesByPath: ReadonlyMap<string, SourceModule>;
  /** 모듈 해석기다. */
  private readonly resolver: ModuleResolver;
  /**
   * 모듈 파일 → export 이름 → 대상 메모다. Program은 실행 중 바뀌지 않고 export 사슬 결과도 파일마다 늘 같다. 메모가
   * 없으면 `schema.users` 같은 이름공간 접근·require 구조 분해마다 모든 export를 다시 따라가, 비용이 참조 수 × export
   * 수가 된다.
   */
  private readonly exportsMemo = new Map<ts.SourceFile, ReadonlyMap<string, BindingOrigin>>();
  /** 모듈 파일 → export 이름 → 심볼이다(`getExportsOfModule` 순서, 같은 이름은 뒤의 심볼). */
  private readonly exportSymbolsMemo = new Map<ts.SourceFile, ReadonlyMap<string, ts.Symbol>>();
  /**
   * (모듈 파일, export 이름) → 사슬 메모다. 사슬 결과는 시작한 곳과 무관하다: 바깥 사슬이 이 사슬의 파일로 다시
   * 들어가는지는 `trail`로 바깥이 판정한다. 그래서 서로를 require로 재수출하는 고리에서도 export마다 한 번만 따라간다.
   */
  private readonly chainMemo = new Map<ts.SourceFile, Map<string, ExportChain>>();
  /** 따라가는 중인 (모듈 파일, export 이름)이다. 같은 export로 돌아오는 고리를 끊는다. */
  private readonly following = new Map<ts.SourceFile, Set<string>>();

  /**
   * @param modules 스캔한 소스 모듈(이미 파싱한 트리를 그대로 Program에 넣는다)
   * @param resolver 프로젝트 안 모듈 해석기
   */
  constructor(modules: readonly SourceModule[], resolver: ModuleResolver) {
    this.modulesByPath = new Map(modules.map((module) => [resolve(module.absolutePath), module]));
    this.resolver = resolver;
    const program = ts.createProgram({
      rootNames: modules.map((module) => module.absolutePath),
      options: programOptions(),
      host: this.compilerHost(),
    });
    this.checker = program.getTypeChecker();
  }

  /**
   * 식별자(또는 `a.b`의 `b`)가 가리키는 대상을 돌려준다.
   *
   * @param node 식별자·속성 이름 노드
   * @returns 대상
   */
  originOf(node: ts.Node): BindingOrigin {
    const symbol = this.symbolAt(node);
    // 선언이 없는 심볼은 checker가 풀지 못한 이름에 주는 `unknown` 심볼이다(lib 없이 만든 Program의 전역 타입 등).
    if (symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0) {
      return ts.isIdentifier(node) && !isPropertyName(node) ? { kind: 'global', name: node.text } : UNKNOWN_ORIGIN;
    }
    return this.followSymbol(symbol);
  }

  /**
   * 프로젝트 모듈 파일의 export 이름 → 대상 표를 돌려준다(재수출 포함). 파일마다 한 번만 계산해 같은 표를 다시 준다.
   * 사슬이 이미 require로 들어간 파일로 다시 들어가면(순환 require 재수출) 그 export는 모르는 대상이다(CommonJS
   * 순환 require도 실행 시 그 자리에 값이 없다).
   *
   * @param sourceFile 모듈 파일
   * @returns export 이름 → 대상(읽기 전용, 호출자끼리 공유한다)
   */
  exportsOf(sourceFile: ts.SourceFile): ReadonlyMap<string, BindingOrigin> {
    const cached = this.exportsMemo.get(sourceFile);
    if (cached !== undefined) return cached;
    const result = new Map<string, BindingOrigin>();
    for (const name of this.exportSymbols(sourceFile).keys()) result.set(name, this.exportChain(sourceFile, name).origin);
    this.exportsMemo.set(sourceFile, result);
    return result;
  }

  /**
   * 모듈 파일의 export 이름 → 심볼이다. 파일마다 한 번만 묻는다.
   *
   * @param sourceFile 모듈 파일
   * @returns export 이름 → 심볼(모듈이 아닌 스크립트면 비어 있다)
   */
  private exportSymbols(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Symbol> {
    const cached = this.exportSymbolsMemo.get(sourceFile);
    if (cached !== undefined) return cached;
    const symbols = new Map<string, ts.Symbol>();
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol !== undefined) for (const symbol of this.checker.getExportsOfModule(moduleSymbol)) symbols.set(symbol.name, symbol);
    this.exportSymbolsMemo.set(sourceFile, symbols);
    return symbols;
  }

  /**
   * export 하나를 따라간 사슬이다. (파일, 이름)마다 한 번만 따라간다. 따라가는 중인 같은 export로 돌아오면 그 고리의
   * 모든 사슬이 자기 파일로 다시 들어가므로 모르는 대상이다(모르는 사슬을 이은 바깥 사슬도 모르는 대상이라, 고리
   * 자리의 `trail`은 자기 파일만 둔다).
   *
   * @param sourceFile 모듈 파일
   * @param name export 이름
   * @returns 사슬
   */
  private exportChain(sourceFile: ts.SourceFile, name: string): ExportChain {
    const known = this.chainMemo.get(sourceFile)?.get(name);
    if (known !== undefined) return known;
    const active = this.following.get(sourceFile) ?? new Set<string>();
    if (active.has(name)) return { origin: UNKNOWN_ORIGIN, trail: { file: sourceFile, rest: undefined } };
    active.add(name);
    this.following.set(sourceFile, active);
    try {
      const symbol = this.exportSymbols(sourceFile).get(name);
      return this.rememberChain(sourceFile, name, enterTrail(sourceFile, symbol === undefined ? { origin: UNKNOWN_ORIGIN } : this.followChain(symbol)));
    } finally {
      active.delete(name);
    }
  }

  /**
   * 사슬을 메모에 두고 그대로 돌려준다.
   *
   * @param sourceFile 모듈 파일
   * @param name export 이름
   * @param chain 사슬
   * @returns 같은 사슬
   */
  private rememberChain(sourceFile: ts.SourceFile, name: string, chain: ExportChain): ExportChain {
    const byName = this.chainMemo.get(sourceFile) ?? new Map<string, ExportChain>();
    byName.set(name, chain);
    this.chainMemo.set(sourceFile, byName);
    return chain;
  }

  /**
   * CommonJS `module.exports = <식>`의 값 식이다(checker는 `export =` 모듈의 export 이름표에 `default`를 두지 않는다).
   *
   * @param sourceFile 모듈 파일
   * @returns 값 식 또는 undefined
   */
  commonJsDefault(sourceFile: ts.SourceFile): ts.Expression | undefined {
    const target = this.modulesByPath.get(resolve(sourceFile.fileName))?.exports.get('default');
    return target?.kind === 'expression' ? target.expression : undefined;
  }

  /**
   * `require('…')`·`import('…')` 지정자를 해석한다.
   *
   * @param specifier 지정자
   * @param importer 가져오는 파일
   * @returns 프로젝트 모듈이면 모듈 대상, 아니면 외부 패키지 이름공간
   */
  moduleOrigin(specifier: string, importer: ts.SourceFile): BindingOrigin {
    const target = this.resolver.resolve(specifier, importer.fileName);
    const module = target === undefined ? undefined : this.modulesByPath.get(resolve(target));
    if (module !== undefined) return { kind: 'module', sourceFile: module.sourceFile };
    return isPackageSpecifier(specifier) ? { kind: 'external', module: specifier, name: '*' } : UNKNOWN_ORIGIN;
  }

  /**
   * 노드 위치의 심볼이다. 축약 속성(`{ users }`)은 값 쪽 심볼을 돌려준다.
   *
   * @param node 노드
   * @returns 심볼 또는 undefined
   */
  private symbolAt(node: ts.Node): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
      return this.checker.getShorthandAssignmentValueSymbol(node.parent);
    }
    return this.checker.getSymbolAtLocation(node);
  }

  /**
   * 심볼의 별칭 사슬을 따라가 최종 대상을 돌려준다.
   *
   * @param start 시작 심볼
   * @returns 대상
   */
  private followSymbol(start: ts.Symbol): BindingOrigin {
    return this.followChain(start).origin;
  }

  /**
   * 심볼의 별칭 사슬을 따라간다. 끝이 프로젝트 모듈 export의 require면 그 export의 사슬도 돌려준다.
   *
   * @param start 시작 심볼
   * @returns 대상과 require로 이은 사슬
   */
  private followChain(start: ts.Symbol): Resolution {
    let symbol = start;
    for (let step = 0; step < MAX_ALIAS_STEPS; step++) {
      const declaration = symbol.declarations?.[0];
      if (declaration === undefined) return { origin: UNKNOWN_ORIGIN };
      if (ts.isSourceFile(declaration)) return { origin: { kind: 'module', sourceFile: declaration } };
      if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return this.plainDeclaration(declaration);
      const next = this.checker.getImmediateAliasedSymbol(symbol);
      if (next === undefined || next.declarations === undefined || next.declarations.length === 0) {
        return { origin: this.aliasOrigin(declaration) };
      }
      symbol = next;
    }
    return { origin: UNKNOWN_ORIGIN };
  }

  /**
   * 별칭이 아닌 선언의 대상이다. `const x = require('pkg')`는 TS 파일에서 별칭이 아니라 여기서 푼다.
   *
   * @param declaration 선언
   * @returns 대상과 require로 이은 사슬
   */
  private plainDeclaration(declaration: ts.Declaration): Resolution {
    const required = requireOrigin(declaration);
    if (required !== undefined) return this.requiredBinding(declaration, required);
    return { origin: { kind: 'declaration', declaration } };
  }

  /**
   * `require` 초기값 바인딩(전체 또는 구조 분해 원소)의 대상이다.
   *
   * @param declaration 변수 선언 또는 구조 분해 원소
   * @param required require 호출 정보
   * @returns 대상과, 프로젝트 모듈 export를 꺼냈으면 그 export의 사슬
   */
  private requiredBinding(declaration: ts.Declaration, required: RequireSite): Resolution {
    const module = this.moduleOrigin(required.specifier, declaration.getSourceFile());
    if (required.member === undefined) return { origin: module };
    if (module.kind === 'external') return { origin: { kind: 'external', module: module.module, name: required.member } };
    if (module.kind !== 'module') return { origin: UNKNOWN_ORIGIN };
    const via = this.exportChain(module.sourceFile, required.member);
    return { origin: via.origin, via };
  }

  /**
   * 풀리지 않는 별칭(외부 패키지 import)의 대상이다.
   *
   * @param declaration 별칭 선언
   * @returns 외부 패키지 대상 또는 unknown
   */
  private aliasOrigin(declaration: ts.Declaration): BindingOrigin {
    const site = importSite(declaration);
    if (site === undefined) return UNKNOWN_ORIGIN;
    if (!isPackageSpecifier(site.specifier)) return UNKNOWN_ORIGIN;
    return { kind: 'external', module: site.specifier, name: site.name };
  }

  /**
   * 프로젝트 모듈만 제공하는 컴파일러 호스트다. 파일 시스템을 읽지 않는다.
   *
   * @returns 호스트
   */
  private compilerHost(): ts.CompilerHost {
    const modules = this.modulesByPath;
    // TypeScript는 Windows 입력도 '/'로 요청한다. OS 경로로만 정규화하고 입력 집합 밖은 읽지 않는다.
    return {
      getSourceFile: (fileName) => modules.get(resolve(fileName))?.sourceFile,
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => undefined,
      getCurrentDirectory: () => '/',
      getCanonicalFileName: (fileName) => fileName,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (fileName) => modules.has(resolve(fileName)),
      readFile: (fileName) => modules.get(resolve(fileName))?.text.text,
      resolveModuleNameLiterals: (literals, containingFile) => literals.map((literal) => this.resolveLiteral(literal.text, containingFile)),
    };
  }

  /**
   * 모듈 지정자 하나를 프로젝트 파일로 해석한다.
   *
   * @param specifier 지정자
   * @param containingFile 가져오는 파일
   * @returns 해석 결과(프로젝트 밖이면 비어 있다)
   */
  private resolveLiteral(specifier: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations {
    const target = this.resolver.resolve(specifier, containingFile);
    const extension = target === undefined ? undefined : extensions.get(extname(target));
    if (target === undefined || extension === undefined) return { resolvedModule: undefined };
    return { resolvedModule: { resolvedFileName: target, extension, isExternalLibraryImport: false } };
  }
}

/**
 * export 하나의 사슬을 만든다. 이어 받은 사슬이 이 파일로 다시 들어가면(require 순환) 대상은 모른다 — 시작한 곳과
 * 무관하게, 사슬이 require로 이미 들어간 파일을 다시 만나는 자리에서 끊는다.
 *
 * @param sourceFile export의 파일
 * @param resolution export 심볼을 따라간 결과
 * @returns 사슬
 */
function enterTrail(sourceFile: ts.SourceFile, resolution: Resolution): ExportChain {
  const rest = resolution.via?.trail;
  const trail: RequireTrail = { file: sourceFile, rest };
  return { origin: trailIncludes(rest, sourceFile) ? UNKNOWN_ORIGIN : resolution.origin, trail };
}

/**
 * 사슬이 그 파일로 require해 들어갔는지 본다.
 *
 * @param trail 사슬이 들어간 파일 목록
 * @param sourceFile 찾을 파일
 * @returns 들어갔으면 true
 */
function trailIncludes(trail: RequireTrail | undefined, sourceFile: ts.SourceFile): boolean {
  for (let current = trail; current !== undefined; current = current.rest) {
    if (current.file === sourceFile) return true;
  }
  return false;
}

/**
 * 해석 전용 컴파일러 옵션이다. lib·타입 패키지를 읽지 않고 JS도 받는다.
 *
 * @returns 옵션
 */
function programOptions(): ts.CompilerOptions {
  return {
    noLib: true,
    types: [],
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    experimentalDecorators: true,
  };
}

/** `require('pkg')` 초기값 위치다. `member`는 구조 분해로 꺼낸 export 이름이다. */
interface RequireSite {
  readonly specifier: string;
  readonly member: string | undefined;
}

/**
 * 선언이 `const x = require('…')`·`const { a: x } = require('…')`·`const x = require('…').a`인지 본다.
 *
 * @param declaration 선언
 * @returns require 위치 또는 undefined
 */
function requireOrigin(declaration: ts.Declaration): RequireSite | undefined {
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return requireCall(declaration.initializer);
  }
  if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return undefined;
  const owner = declaration.parent.parent;
  if (!ts.isVariableDeclaration(owner) || owner.initializer === undefined) return undefined;
  const whole = requireCall(owner.initializer);
  if (whole === undefined || whole.member !== undefined) return undefined;
  const key = declaration.propertyName ?? declaration.name;
  return ts.isIdentifier(key) ? { specifier: whole.specifier, member: key.text } : undefined;
}

/**
 * 식이 `require('…')` 또는 `require('…').name`이면 위치를 돌려준다.
 *
 * @param expression 식
 * @returns require 위치 또는 undefined
 */
function requireCall(expression: ts.Expression): RequireSite | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = requireCall(expression.expression);
    return inner === undefined || inner.member !== undefined ? undefined : { specifier: inner.specifier, member: expression.name.text };
  }
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') return undefined;
  const [argument] = expression.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? { specifier: argument.text, member: undefined } : undefined;
}

/** import 선언이 가져온 지정자와 이름이다. */
interface ImportSite {
  readonly specifier: string;
  readonly name: string;
}

/**
 * 별칭 선언(import 원소·default·이름공간·재수출 원소)의 지정자와 가져온 이름을 읽는다.
 *
 * @param declaration 별칭 선언
 * @returns 지정자·이름 또는 undefined
 */
function importSite(declaration: ts.Declaration): ImportSite | undefined {
  if (ts.isImportSpecifier(declaration)) {
    return withSpecifier(declaration.parent.parent.parent.moduleSpecifier, (declaration.propertyName ?? declaration.name).text);
  }
  if (ts.isImportClause(declaration)) return withSpecifier(declaration.parent.moduleSpecifier, 'default');
  if (ts.isNamespaceImport(declaration)) return withSpecifier(declaration.parent.parent.moduleSpecifier, '*');
  if (ts.isExportSpecifier(declaration)) {
    const specifier = declaration.parent.parent.moduleSpecifier;
    return specifier === undefined ? undefined : withSpecifier(specifier, (declaration.propertyName ?? declaration.name).text);
  }
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) {
    return withSpecifier(declaration.moduleReference.expression, '*');
  }
  const required = requireOrigin(declaration);
  return required === undefined ? undefined : { specifier: required.specifier, name: required.member ?? '*' };
}

/**
 * 지정자 식이 문자열이면 import 위치를 만든다.
 *
 * @param specifier 지정자 식
 * @param name 가져온 이름
 * @returns import 위치 또는 undefined
 */
function withSpecifier(specifier: ts.Expression, name: string): ImportSite | undefined {
  return ts.isStringLiteralLike(specifier) ? { specifier: specifier.text, name } : undefined;
}

/**
 * 지정자가 패키지 이름(상대·절대 경로가 아님)인지 본다.
 *
 * @param specifier 지정자
 * @returns 패키지면 true
 */
function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/**
 * 식별자가 속성 접근·한정 이름의 오른쪽 자리(`a.b`의 `b`, 타입 `A.B`의 `B`)인지 본다. 이 자리는 전역 이름이 아니다.
 *
 * @param node 식별자
 * @returns 속성 이름 자리면 true
 */
function isPropertyName(node: ts.Identifier): boolean {
  return (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    || (ts.isQualifiedName(node.parent) && node.parent.right === node);
}
