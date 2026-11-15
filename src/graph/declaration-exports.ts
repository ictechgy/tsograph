/**
 * 선언 산출물(`.d.ts`)과 그것을 냈다고 보는 소스의 export 이름 표를 구문으로 만들고 서로 맞는지 판정한다.
 *
 * `declarationDir`/`outDir` ↔ `rootDir` 역매핑은 배치만 보고 산출물의 출처를 정한다. 번들러가 같은 `outDir`을 다른 진입점의
 * 선언으로 덮어쓰면 같은 상대 경로의 다른 소스로 이어 잘못된 direct 간선이 생긴다. 그래서 그 경로로 잇기 전에 선언이
 * 내보내는 이름이 모두 소스에도 있는지 본다. tsc의 선언 emit은 소스의 export 이름을 그대로 옮기고(`stripInternal`이면 일부를
 * 뺀다), 재내보내기 지정자도 쓴 그대로 남기므로 "선언 이름 ⊆ 소스 이름"이 진짜 emit의 필요조건이다.
 *
 * 역매핑은 module 해석 hook 안에서 일어나 아직 checker가 없다. 산출물마다 별도 Program을 만들면 패키지 소스 폐쇄를 다시
 * 파싱하고 Program host의 상한·경계를 우회하므로, TypeScript 파서로 최상위 export 문장만 읽고 `export *`는
 * `ts.resolveModuleName`(같은 4 MiB bounded reader)으로 따라간다. 분석 대상 코드는 실행하지 않는다.
 *
 * 이름 표를 확정하지 못하면(읽기·구문 실패, 해석하지 못한 상대 `export *`, 파일 예산 초과) 맞는다고 증명하지 못한 것이므로
 * 호출자는 잇지 않고 limitation으로 센다. 같은 이름을 내보내는 다른 구현은 이름만으로 구별하지 못한다.
 *
 * JavaScript 모듈의 export 이름은 구문으로 정하지 않는다. tsc는 CommonJS 내보내기와 JSDoc 타입을 checker로 읽어
 * (`const api = { helper }; module.exports = api`의 `helper`, `var x = exports.x = …`, `if`·`try`·함수 안의 `exports.x`, 조건부
 * `module.exports = require(…)`의 `export =`) 선언에 옮기므로, 최상위 문장만 보는 표는 맞는 소스를 틀렸다고 판정한다. 그래서
 * 소스 쪽 폐쇄에 JavaScript 모듈이 있으면 대조하지 않고 맞는다고 본다(같은 이름 형제 경로와 같은 이유, 예전 동작 유지).
 */

import { isAbsolute, resolve } from 'node:path';

import ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';
import { MAX_SOURCE_BYTES } from '../schema/project-reader.ts';
import { parseWithinSyntaxDepth, TOO_DEEP } from '../schema/syntax-depth.ts';

/** export 이름 표 하나가 `export *`로 따라가 읽는 최대 파일 수다. 큰 barrel 패키지도 담되 끝없는 폐쇄는 막는다. */
const MAX_EXPORT_TABLE_FILES = 1024;

/** `export =`(CommonJS 내보내기 할당)를 나타내는 이름이다. 식별자가 될 수 없는 문자열이라 실제 이름과 겹치지 않는다. */
const EXPORT_EQUALS = 'export=';

/** `export *`가 옮기지 않는 이름이다(ES module 규칙의 `default`, 그리고 `export =`). */
const NOT_STAR_EXPORTED: ReadonlySet<string> = new Set(['default', EXPORT_EQUALS]);

/**
 * 파일 하나를 읽은 결과다. TypeScript 문법 파일은 최상위 export 이름과 따라가야 할 `export *` 지정자를 담는다. JavaScript 파일은
 * export 이름을 checker가 정하므로 이름 없이 종류만 표시한다.
 */
type LocalExports =
  | {
    readonly kind: 'typescript';
    readonly names: readonly string[];
    readonly stars: readonly { readonly specifier: string; readonly mode: ts.ResolutionMode }[];
  }
  | { readonly kind: 'javascript' };

/** 모듈의 export 이름 표다. */
export interface ExportTable {
  /** 값·타입을 가리지 않은 export 이름(`default`, `export =`는 {@link EXPORT_EQUALS})이다. */
  readonly names: ReadonlySet<string>;
  /** 해석하지 못한 bare 지정자(`export * from "pkg"`)다. 같은 패키지 안의 같은 지정자는 같은 모듈이라 서로 상쇄할 수 있다. */
  readonly unresolvedPackages: ReadonlySet<string>;
  /**
   * 이름을 모두 확정했는지다. 읽기·구문 실패, 해석하지 못한 상대 `export *`, `export *`가 닿은 JavaScript 모듈, 파일 예산 초과면
   * false다.
   */
  readonly complete: boolean;
  /**
   * 폐쇄(자신 또는 `export *` 대상)에 JavaScript 모듈이 있는지다. 그 export 이름은 tsc가 checker로 정해 구문 표가 빠뜨리므로,
   * 소스 쪽 표에서 true면 이름을 대조하지 않는다.
   */
  readonly includesJavaScript: boolean;
}

/**
 * 선언의 export 이름이 소스 export 이름과 맞는지 판정한다. 소스 폐쇄에 JavaScript 모듈이 있으면 이름을 구문으로 다 알 수 없으므로
 * 대조하지 않고 맞는다고 본다. 그 밖에는 선언 이름 표를 확정했고, 선언의 모든 이름이 소스에 있고, 선언이 해석하지 못한 bare
 * `export *`를 소스도 같은 지정자로 가질 때만 맞는다고 본다.
 *
 * @param declaration 선언 산출물의 이름 표
 * @param source 역매핑한 소스의 이름 표
 * @returns 맞으면 true
 */
export function declarationExportsCovered(declaration: ExportTable, source: ExportTable): boolean {
  if (source.includesJavaScript) return true;
  if (!declaration.complete) return false;
  for (const specifier of declaration.unresolvedPackages) if (!source.unresolvedPackages.has(specifier)) return false;
  for (const name of declaration.names) if (!source.names.has(name)) return false;
  return true;
}

/** 파일별 export 이름 표를 읽는다. 같은 설정·같은 파일은 한 번만 파싱한다. */
export class ExportTableReader {
  readonly #host: ts.ModuleResolutionHost = { ...ts.sys, readFile: readBoundedSource };
  readonly #local = new WeakMap<ts.CompilerOptions, Map<string, LocalExports | undefined>>();
  readonly #tables = new WeakMap<ts.CompilerOptions, Map<string, ExportTable>>();

  /**
   * 모듈의 export 이름 표를 만든다. `export *`는 대상의 이름(`default` 제외)을 보태며 따라간다.
   *
   * @param fileName 모듈 절대 경로
   * @param options module 해석에 쓸 compiler 옵션(산출물을 낸 설정)
   * @returns 이름 표
   */
  table(fileName: string, options: ts.CompilerOptions): ExportTable {
    const tables = this.#tables.get(options) ?? new Map<string, ExportTable>();
    this.#tables.set(options, tables);
    const absolute = resolve(fileName);
    const cached = tables.get(absolute);
    if (cached !== undefined) return cached;
    const table = this.#closure(absolute, options);
    tables.set(absolute, table);
    return table;
  }

  /** `export *` 폐쇄를 너비 우선으로 걸으며 이름을 모은다. 순환은 방문 집합이 끊는다. */
  #closure(fileName: string, options: ts.CompilerOptions): ExportTable {
    const names = new Set<string>();
    const unresolvedPackages = new Set<string>();
    let complete = true;
    let includesJavaScript = false;
    const visited = new Set<string>();
    const queue: { readonly file: string; readonly star: boolean }[] = [{ file: fileName, star: false }];
    for (let index = 0; index < queue.length; index++) {
      const { file, star } = queue[index]!;
      if (visited.has(file)) continue;
      if (visited.size >= MAX_EXPORT_TABLE_FILES) {
        complete = false;
        break;
      }
      visited.add(file);
      const local = this.#localExports(file, options);
      if (local === undefined) {
        complete = false;
        continue;
      }
      if (local.kind === 'javascript') {
        // 소스 쪽에서는 대조를 끄는 표시이고, 선언 쪽에서는 이름을 모르는 대상이다(선언 루트는 항상 `.d.ts`다).
        includesJavaScript = true;
        if (star) complete = false;
        continue;
      }
      for (const name of local.names) if (!star || !NOT_STAR_EXPORTED.has(name)) names.add(name);
      for (const { specifier, mode } of local.stars) {
        const target = this.#resolve(specifier, file, options, mode);
        if (target !== undefined) queue.push({ file: target, star: true });
        else if (isRelativeSpecifier(specifier)) complete = false;
        else unresolvedPackages.add(specifier);
      }
    }
    return { names, unresolvedPackages, complete, includesJavaScript };
  }

  /** 파일 하나의 최상위 export를 읽는다. 읽지 못하거나 구문 깊이 상한을 넘으면 undefined다. */
  #localExports(fileName: string, options: ts.CompilerOptions): LocalExports | undefined {
    const files = this.#local.get(options) ?? new Map<string, LocalExports | undefined>();
    this.#local.set(options, files);
    if (files.has(fileName)) return files.get(fileName);
    const exports = this.#parseExports(fileName, options);
    files.set(fileName, exports);
    return exports;
  }

  /**
   * 파일을 파싱해 최상위 export 이름과 `export *` 지정자를 모은다. 해석 모드는 TypeScript처럼 파일의 module 형식에서 정한다.
   * JavaScript 파일은 이름을 구문으로 정하지 않으므로 읽지 않고 종류만 돌려준다.
   *
   * @param fileName 파일 절대 경로
   * @param options compiler 옵션
   * @returns export 목록, 쓸 수 없으면 undefined
   */
  #parseExports(fileName: string, options: ts.CompilerOptions): LocalExports | undefined {
    const kind = scriptKindOf(fileName);
    if (kind === undefined) return undefined;
    if (kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX) return { kind: 'javascript' };
    const read = readBoundedConfigText(fileName, MAX_SOURCE_BYTES);
    if (!read.ok) return undefined;
    const impliedNodeFormat = ts.getImpliedNodeFormatForFile(fileName, undefined, this.#host, options);
    const sourceFile = parseWithinSyntaxDepth(() => ts.createSourceFile(fileName, read.text,
      { languageVersion: ts.ScriptTarget.Latest, impliedNodeFormat }, true, kind));
    if (sourceFile === TOO_DEEP) return undefined;
    const names = sourceFile.statements.flatMap(statementExportNames);
    const stars = sourceFile.statements.flatMap((statement) => {
      if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) return [];
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return [];
      return [{ specifier: specifier.text, mode: ts.getModeForUsageLocation(sourceFile, specifier, options) }];
    });
    return { kind: 'typescript', names, stars };
  }

  /** `export *` 지정자를 같은 bounded host로 해석한다. 해석 결과는 파일 경로다. */
  #resolve(specifier: string, containingFile: string, options: ts.CompilerOptions, mode: ts.ResolutionMode): string | undefined {
    const resolved = ts.resolveModuleName(specifier, containingFile, { ...options, allowJs: true }, this.#host, undefined, undefined, mode);
    const target = resolved.resolvedModule?.resolvedFileName;
    return target === undefined ? undefined : resolve(target);
  }
}

/** Program host와 같은 4 MiB 상한으로 파일을 읽는다. 상한을 넘거나 읽지 못하면 없는 파일처럼 undefined다. */
function readBoundedSource(fileName: string): string | undefined {
  const read = readBoundedConfigText(fileName, MAX_SOURCE_BYTES);
  return read.ok ? read.text : undefined;
}

/** 상대·절대 경로 지정자인지 본다. 그런 지정자를 해석하지 못하면 대상 파일이 없는 것이다. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..' || isAbsolute(specifier);
}

/** 확장자로 파싱 종류를 고른다. 스크립트가 아닌 파일(JSON 등)은 undefined다. */
function scriptKindOf(fileName: string): ts.ScriptKind | undefined {
  if (/\.d\.[cm]?ts$|\.[cm]?ts$/u.test(fileName)) return ts.ScriptKind.TS;
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/u.test(fileName)) return ts.ScriptKind.JS;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return undefined;
}

/**
 * ES module·TypeScript 문법의 최상위 문장이 내보내는 이름이다. 값과 타입을 가리지 않는다(선언 산출물은 타입도 옮긴다).
 * `export default`는 `default`, `export =`는 {@link EXPORT_EQUALS}다. `export *`의 이름은 호출자가 대상을 따라가 모은다.
 *
 * @param statement 최상위 문장
 * @returns 내보낸 이름
 */
function statementExportNames(statement: ts.Statement): string[] {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause === undefined) return [];
    return ts.isNamespaceExport(clause) ? [clause.name.text] : clause.elements.map((element) => element.name.text);
  }
  if (ts.isExportAssignment(statement)) return [statement.isExportEquals === true ? EXPORT_EQUALS : 'default'];
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return ['default'];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
    // 이름 없는 `export class {}`나 복구 파싱이 만든 빈 식별자는 이름이 아니다.
    const name = statement.name?.text ?? '';
    return name === '' ? [] : [name];
  }
  // `export namespace N`·`export declare namespace N`만 이름이다. 문자열 이름 module 선언은 다른 모듈의 augmentation이다.
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) return [statement.name.text];
  return [];
}

/** 변수 선언의 바인딩 이름을 모두 모은다(구조 분해 포함). */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/** 선언에 특정 수정자가 있는지 본다. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}
