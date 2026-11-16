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
 * `export *` 대상 중 따라가지 않고 위치로만 비교하는 것이 있다. tsc는 지정자를 쓴 그대로 옮기므로 선언과 소스의 같은 상대 위치에서
 * 같은 지정자는 같은 재내보내기다. 해석하지 못한 대상(tsc가 `outDir`로 복사하지 않는 손으로 쓴 `src/types.d.ts` 등), 읽지 못한
 * 대상, JavaScript 대상은 소스에도 같은 위치의 같은 지정자가 있을 때만 상쇄한다. `node_modules`나 프로젝트 밖으로 해석한 대상은
 * 패키지 폐쇄(4 MiB 넘는 생성 선언, 깨진 상대 재내보내기, 예산을 넘는 barrel)를 읽지 않고 해석한 파일 경로를 불투명한 표지로
 * 비교한다(같은 지정자도 같다고 본다). 표 하나가 1,024개 파일을 넘으면 남은 `export *` 대상도 위치로만 남긴다.
 *
 * 이름을 읽지 못한 재내보내기는 소스 쪽에도 생긴다(4 MiB를 넘는 생성 소스와 4 MiB 안의 그 선언, 체크아웃에 없는 생성 소스와 남아 있는
 * 선언). 그 대상의 이름은 소스 표에 없으므로, 소스 쪽에 해석·읽기에 실패했거나 예산 밖인 프로젝트 안 `export *`가 있으면 위치 비교만
 * 하고 이름은 대조하지 않는다(외부 대상은 양쪽 모두 읽지 않으므로 해당하지 않는다).
 *
 * 선언 이름 표를 확정하지 못하면(선언 파일 읽기·구문 실패) 맞는다고 증명하지 못한 것이므로 호출자는 잇지 않고 limitation으로 센다.
 * 같은 이름을 내보내는 다른 구현은 이름만으로 구별하지 못한다.
 *
 * JavaScript 모듈의 export 이름은 구문으로 정하지 않는다. tsc는 CommonJS 내보내기와 JSDoc 타입을 checker로 읽어
 * (`const api = { helper }; module.exports = api`의 `helper`, `var x = exports.x = …`, `if`·`try`·함수 안의 `exports.x`, 조건부
 * `module.exports = require(…)`의 `export =`) 선언에 옮기므로, 최상위 문장만 보는 표는 맞는 소스를 틀렸다고 판정한다. 그래서
 * 소스 쪽 폐쇄에 JavaScript 모듈이 있으면 대조하지 않고 맞는다고 본다(같은 이름 형제 경로와 같은 이유, 예전 동작 유지).
 */

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';
import { MAX_SOURCE_BYTES } from '../schema/project-reader.ts';
import { parseWithinSyntaxDepth, TOO_DEEP } from '../schema/syntax-depth.ts';

/** export 이름 표 하나가 `export *`로 따라가 읽는 최대 파일 수다. 큰 barrel 패키지도 담되 끝없는 폐쇄는 막고, 넘는 대상은 위치로 비교한다. */
const MAX_EXPORT_TABLE_FILES = 1024;

/** `export =`(CommonJS 내보내기 할당)를 나타내는 이름이다. 식별자가 될 수 없는 문자열이라 실제 이름과 겹치지 않는다. */
const EXPORT_EQUALS = 'export=';

/** `export *`가 옮기지 않는 이름이다(ES module 규칙의 `default`, 그리고 `export =`). */
const NOT_STAR_EXPORTED: ReadonlySet<string> = new Set(['default', EXPORT_EQUALS]);

/**
 * 상대 지정자(`./`·`../`) `export *`의 위치 키 접두사다. 뒤는 지정자가 가리키는 절대 경로(쓴 그대로, 확장자 보정 없음)이고, 비교할 때
 * 선언 루트 기준 상대 위치를 소스 루트 기준으로 옮긴다.
 */
const PATH_STAR_KEY = 'path:';

/** bare 지정자 `export *`의 위치 키 접두사다. 같은 패키지 안의 같은 bare 지정자는 같은 모듈이다. */
const PACKAGE_STAR_KEY = 'package:';

/**
 * 절대 경로 지정자 `export *`의 위치 키 접두사다. tsc는 절대 지정자도 쓴 그대로 옮기므로 선언과 소스에서 같은 파일을 가리킨다. 그래서
 * 상대 키처럼 `outDir`↔`rootDir`로 옮기지 않고 지정자 그대로 비교한다(옮기면 두 루트 깊이가 다를 때 다른 경로가 된다).
 */
const ABSOLUTE_STAR_KEY = 'absolute:';

/** 해석까지 마친 `export *` 하나다. */
interface StarExport {
  /** 표끼리 비교하는 위치 키({@link PATH_STAR_KEY}·{@link PACKAGE_STAR_KEY}·{@link ABSOLUTE_STAR_KEY})다. */
  readonly key: string;
  /** 따라가 이름을 읽을 프로젝트 안 대상 파일이다. */
  readonly local?: string;
  /** 따라가지 않고 경로를 표지로 비교할 외부 대상 파일(`node_modules`·프로젝트 밖)이다. */
  readonly external?: string;
}

/**
 * 파일 하나를 읽은 결과다. TypeScript 문법 파일은 최상위 export 이름과 해석한 `export *`를 담는다. JavaScript 파일은
 * export 이름을 checker가 정하므로 이름 없이 종류만 표시한다.
 */
type LocalExports =
  | { readonly kind: 'typescript'; readonly names: readonly string[]; readonly stars: readonly StarExport[] }
  | { readonly kind: 'javascript' };

/** 모듈의 export 이름 표다. */
export interface ExportTable {
  /** 값·타입을 가리지 않은 export 이름(`default`, `export =`는 {@link EXPORT_EQUALS})이다. */
  readonly names: ReadonlySet<string>;
  /** 표 루트 파일의 디렉터리다. 상대 위치 키를 다른 표와 비교할 때 기준이다. */
  readonly directory: string;
  /** 폐쇄 안 모든 `export *`의 위치 키다(해석 여부와 무관). */
  readonly starKeys: ReadonlySet<string>;
  /**
   * 이름을 읽지 않은 `export *`의 위치 키와, 외부로 해석했다면 그 대상 경로다. 해석하지 못한 대상, 읽지 못한 대상,
   * JavaScript 대상, 파일 예산 밖 대상, 외부 대상이 들어간다.
   */
  readonly opaqueStars: ReadonlyMap<string, string | undefined>;
  /** 따라가지 않은 외부 `export *` 대상 경로다. */
  readonly externalTargets: ReadonlySet<string>;
  /**
   * 표 루트 파일의 이름을 읽었는지다. 표 루트 파일을 읽지 못했거나 구문 깊이를 넘으면 false다. 읽지 못한 `export *` 대상과 파일 예산
   * 밖 대상은 {@link opaqueStars}에 위치로 남는다.
   */
  readonly complete: boolean;
  /**
   * 폐쇄(자신 또는 `export *` 대상)에 JavaScript 모듈이 있는지다. 그 export 이름은 tsc가 checker로 정해 구문 표가 빠뜨리므로,
   * 소스 쪽 표에서 true면 이름을 대조하지 않는다.
   */
  readonly includesJavaScript: boolean;
}

/**
 * 한 설정의 `export *` 해석 옵션과 TypeScript 해석 캐시다. 캐시는 (디렉터리, 지정자, 모드)별 해석 결과와 package.json 조회
 * (파일 module 형식 판정)를 함께 담아, 같은 barrel을 `export *`하는 선언이 많아도 해석을 반복하지 않는다.
 */
interface ResolutionContext {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
}

/** 폐쇄를 걸으며 채우는 이름 표다({@link ExportTable}의 쓰기 가능한 모양). */
interface TableDraft {
  readonly names: Set<string>;
  readonly directory: string;
  readonly starKeys: Set<string>;
  readonly opaqueStars: Map<string, string | undefined>;
  readonly externalTargets: Set<string>;
  complete: boolean;
  includesJavaScript: boolean;
}

/**
 * 선언의 export 이름이 소스 export 이름과 맞는지 판정한다. 소스 폐쇄에 JavaScript 모듈이 있으면 이름을 구문으로 다 알 수 없으므로
 * 대조하지 않고 맞는다고 본다. 그 밖에는 선언 루트 파일을 읽었고, 이름을 읽지 않은 선언의 `export *`마다 소스에 같은 위치의
 * 같은 지정자나 같은 외부 대상이 있어야 한다. 소스 쪽에 이름을 읽지 못한 프로젝트 안 `export *`가 있으면 거기까지만 보고 맞는다고
 * 보며, 없으면 선언의 모든 이름이 소스에 있을 때만 맞는다고 본다.
 *
 * @param declaration 선언 산출물의 이름 표
 * @param source 역매핑한 소스의 이름 표
 * @returns 맞으면 true
 */
export function declarationExportsCovered(declaration: ExportTable, source: ExportTable): boolean {
  if (source.includesJavaScript) return true;
  if (!declaration.complete) return false;
  for (const [key, external] of declaration.opaqueStars) {
    const sameSpecifier = source.starKeys.has(sourceFrameKey(key, declaration.directory, source.directory));
    if (!sameSpecifier && (external === undefined || !source.externalTargets.has(external))) return false;
  }
  if (hasUnreadProjectStar(source)) return true;
  for (const name of declaration.names) if (!source.names.has(name)) return false;
  return true;
}

/**
 * 표에 이름을 읽지 못한 프로젝트 안 `export *`(해석·읽기 실패, JavaScript, 파일 예산 밖)가 있는지 본다. 소스 쪽에서 그 대상의 이름은
 * 표에 없으므로, 선언 쪽이 같은 위치에서 따라가 읽은 이름과 대조하면 맞는 소스를 틀렸다고 판정한다. 외부 대상은 양쪽 모두 읽지 않으므로
 * 세지 않는다.
 *
 * @param table 이름 표
 * @returns 그런 재내보내기가 있으면 true
 */
function hasUnreadProjectStar(table: ExportTable): boolean {
  for (const external of table.opaqueStars.values()) if (external === undefined) return true;
  return false;
}

/**
 * 선언 표의 상대 위치 키를 소스 표 기준으로 옮긴다. tsc는 `rootDir` 아래 배치를 `outDir`에 그대로 두고 지정자를 쓴 그대로
 * 옮기므로, 선언 루트에서의 상대 위치가 같으면 같은 재내보내기다. bare 키는 위치와 무관하다.
 *
 * @param key 선언 표의 위치 키
 * @param declarationDirectory 선언 표 루트 디렉터리
 * @param sourceDirectory 소스 표 루트 디렉터리
 * @returns 소스 표 기준 위치 키
 */
function sourceFrameKey(key: string, declarationDirectory: string, sourceDirectory: string): string {
  if (!key.startsWith(PATH_STAR_KEY)) return key;
  return PATH_STAR_KEY + resolve(sourceDirectory, relative(declarationDirectory, key.slice(PATH_STAR_KEY.length)));
}

/**
 * 파일별 export 이름 표를 읽는다. 같은 설정·같은 파일은 한 번만 파싱하고 해석하며, 해석과 package.json 조회는 설정마다
 * TypeScript 해석 캐시를 공유한다.
 */
export class ExportTableReader {
  readonly #root: string;
  readonly #host: ts.ModuleResolutionHost = { ...ts.sys, readFile: readBoundedSource };
  readonly #resolutions = new WeakMap<ts.CompilerOptions, ResolutionContext>();
  readonly #local = new WeakMap<ts.CompilerOptions, Map<string, LocalExports | undefined>>();
  readonly #tables = new WeakMap<ts.CompilerOptions, Map<string, ExportTable>>();

  /** @param root 프로젝트 경계. 이 밖이나 `node_modules`로 해석한 `export *` 대상은 따라가지 않는다. */
  constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * 모듈의 export 이름 표를 만든다. 프로젝트 안 `export *` 대상은 이름(`default` 제외)을 보태며 따라간다.
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
    const table: TableDraft = { names: new Set(), directory: dirname(fileName), starKeys: new Set(), opaqueStars: new Map(),
      externalTargets: new Set(), complete: true, includesJavaScript: false };
    const visited = new Set<string>();
    const queue: { readonly file: string; readonly key?: string }[] = [{ file: fileName }];
    for (let index = 0; index < queue.length; index++) {
      const { file, key } = queue[index]!;
      if (visited.has(file)) continue;
      if (visited.size >= MAX_EXPORT_TABLE_FILES) {
        recordUnvisitedStars(table, queue.slice(index), visited);
        break;
      }
      visited.add(file);
      const local = this.#localExports(file, options);
      if (local?.kind !== 'typescript') {
        recordUnreadModule(table, local, key);
        continue;
      }
      for (const name of local.names) if (key === undefined || !NOT_STAR_EXPORTED.has(name)) table.names.add(name);
      for (const star of local.stars) {
        table.starKeys.add(star.key);
        if (star.local !== undefined) {
          queue.push({ file: star.local, key: star.key });
          continue;
        }
        table.opaqueStars.set(star.key, star.external);
        if (star.external !== undefined) table.externalTargets.add(star.external);
      }
    }
    return table;
  }

  /** 파일 하나의 최상위 export를 읽고 `export *`를 해석한다. 읽지 못하거나 구문 깊이 상한을 넘으면 undefined다. */
  #localExports(fileName: string, options: ts.CompilerOptions): LocalExports | undefined {
    const files = this.#local.get(options) ?? new Map<string, LocalExports | undefined>();
    this.#local.set(options, files);
    if (files.has(fileName)) return files.get(fileName);
    const exports = this.#parseExports(fileName, options);
    files.set(fileName, exports);
    return exports;
  }

  /**
   * 파일을 파싱해 최상위 export 이름과 `export *`를 모은다. 해석 모드는 TypeScript처럼 파일의 module 형식에서 정한다.
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
    const impliedNodeFormat = ts.getImpliedNodeFormatForFile(fileName, this.#resolution(options).cache.getPackageJsonInfoCache(), this.#host, options);
    const sourceFile = parseWithinSyntaxDepth(() => ts.createSourceFile(fileName, read.text,
      { languageVersion: ts.ScriptTarget.Latest, impliedNodeFormat }, true, kind));
    if (sourceFile === TOO_DEEP) return undefined;
    const names = sourceFile.statements.flatMap(statementExportNames);
    const stars = sourceFile.statements.flatMap((statement) => {
      if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) return [];
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return [];
      return [this.#resolveStar(specifier.text, fileName, options, ts.getModeForUsageLocation(sourceFile, specifier, options))];
    });
    return { kind: 'typescript', names, stars };
  }

  /**
   * `export *` 지정자를 같은 bounded host로 해석하고 따라갈지 정한다. `node_modules`(TypeScript의 외부 라이브러리 판정)나
   * 프로젝트 밖 대상은 따라가지 않는다.
   *
   * @param specifier 지정자
   * @param containingFile 지정자를 쓴 파일
   * @param options compiler 옵션
   * @param mode 해석 모드
   * @returns 위치 키와 대상
   */
  #resolveStar(specifier: string, containingFile: string, options: ts.CompilerOptions, mode: ts.ResolutionMode): StarExport {
    const key = starKey(specifier, containingFile);
    const resolution = this.#resolution(options);
    const resolved = ts.resolveModuleName(specifier, containingFile, resolution.options, this.#host, resolution.cache, undefined, mode).resolvedModule;
    if (resolved === undefined) return { key };
    const target = resolve(resolved.resolvedFileName);
    return resolved.isExternalLibraryImport === true || !isWithin(this.#root, target) ? { key, external: target } : { key, local: target };
  }

  /**
   * 설정의 해석 옵션과 캐시를 돌려준다. JavaScript 대상도 해석해야 소스 쪽 JavaScript 재내보내기를 표시할 수 있으므로 `allowJs`를
   * 켠다. 캐시는 그 옵션 객체 하나와만 쓴다(TypeScript 캐시는 옵션이 바뀌면 결과를 공유할 수 없다).
   *
   * @param options 산출물을 낸 설정의 compiler 옵션
   * @returns 해석 옵션과 캐시
   */
  #resolution(options: ts.CompilerOptions): ResolutionContext {
    const cached = this.#resolutions.get(options);
    if (cached !== undefined) return cached;
    const resolutionOptions = { ...options, allowJs: true };
    const context = { options: resolutionOptions, cache: ts.createModuleResolutionCache(this.#root, canonicalFileName, resolutionOptions) };
    this.#resolutions.set(options, context);
    return context;
  }
}

/** TypeScript 해석 캐시의 경로 키다. 대소문자를 구분하지 않는 파일 시스템에서는 소문자로 맞춘다. */
function canonicalFileName(fileName: string): string {
  return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
}

/**
 * 이름을 읽지 않은 모듈을 표에 적는다. JavaScript는 표시를 남긴다. 표 루트를 읽지 못하면 표를 확정하지 못한 것이고,
 * `export *` 대상이면 그 재내보내기를 위치로만 비교한다(이미 다른 지정자로 적었으면 그대로 둔다).
 *
 * @param table 채우는 표
 * @param local 읽은 결과(읽지 못했으면 undefined)
 * @param key 이 모듈을 끌어온 `export *`의 위치 키, 표 루트면 undefined
 */
function recordUnreadModule(table: TableDraft, local: LocalExports | undefined, key: string | undefined): void {
  if (local?.kind === 'javascript') table.includesJavaScript = true;
  if (key === undefined) {
    if (local === undefined) table.complete = false;
    return;
  }
  if (!table.opaqueStars.has(key)) table.opaqueStars.set(key, undefined);
}

/**
 * 파일 예산을 넘어 읽지 않은 `export *` 대상을 위치로만 남긴다. 선언 쪽에서는 소스의 같은 위치와 비교하고, 소스 쪽에서는 이름을 읽지
 * 못한 재내보내기라 이름 대조를 끈다. 그래서 양쪽의 큰 barrel이 같은 배치면 예산과 무관하게 맞는다.
 *
 * @param table 채우는 표
 * @param pending 아직 방문하지 않은 대기열 항목
 * @param visited 이미 읽은 파일
 */
function recordUnvisitedStars(table: TableDraft, pending: readonly { readonly file: string; readonly key?: string }[],
  visited: ReadonlySet<string>): void {
  for (const { file, key } of pending) {
    if (key !== undefined && !visited.has(file) && !table.opaqueStars.has(key)) table.opaqueStars.set(key, undefined);
  }
}

/**
 * `export *` 지정자의 위치 키를 만든다. 상대 지정자는 지정자를 쓴 파일 기준으로 가리키는 경로, 절대 지정자와 bare 지정자는 지정자
 * 그대로다.
 *
 * @param specifier 지정자
 * @param containingFile 지정자를 쓴 파일
 * @returns 위치 키
 */
function starKey(specifier: string, containingFile: string): string {
  if (isRelativeSpecifier(specifier)) return PATH_STAR_KEY + resolve(dirname(containingFile), specifier);
  return (isAbsolute(specifier) ? ABSOLUTE_STAR_KEY : PACKAGE_STAR_KEY) + specifier;
}

/** `path`가 `directory` 안(자신 제외)인지 본다. */
function isWithin(directory: string, path: string): boolean {
  const offset = relative(directory, path);
  return offset !== '' && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`);
}

/** Program host와 같은 4 MiB 상한으로 파일을 읽는다. 상한을 넘거나 읽지 못하면 없는 파일처럼 undefined다. */
function readBoundedSource(fileName: string): string | undefined {
  const read = readBoundedConfigText(fileName, MAX_SOURCE_BYTES);
  return read.ok ? read.text : undefined;
}

/** 상대 경로 지정자인지 본다. 그런 지정자의 위치 키는 지정자를 쓴 파일 기준으로 가리키는 경로다. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
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
