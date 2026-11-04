/**
 * 프로젝트 안 선언 산출물(`.d.ts`)을 같은 프로젝트의 소스로 되짚는다.
 *
 * workspace 패키지는 흔히 `exports.types`로 빌드 산출물(`dist/index.d.ts`)을 가리킨다. 그대로 두면 앱의 호출이
 * 외부 선언으로 끝나 소비자 쪽 호출자가 그래프에서 조용히 사라진다. 산출물이 어느 소스에서 나왔는지는 다음 근거로만
 * 정한다(추측하지 않는다).
 *
 * 1. declaration map(`*.d.ts.map`)의 단일 `sources` 항목
 * 2. 산출물을 낸 설정의 `declarationDir`/`outDir` ↔ `rootDir`(composite면 설정 디렉터리, 아니면 공통 소스 디렉터리) 역매핑
 * 3. 같은 디렉터리·같은 이름의 JavaScript 구현(손으로 쓴 `legacy.d.ts` + `legacy.js`)
 *
 * 되짚은 소스가 이 스캔의 소스일 때만 잇는다. 근거가 없거나 스캔 밖 소스를 가리키면 잇지 않고 호출자가 limitation으로 센다.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';

/** declaration map 하나에 허용하는 최대 byte 수다. 산출물 메타데이터라 작다. */
const MAX_DECLARATION_MAP_BYTES = 1024 * 1024;

/** 선언 파일 접미사와, 그 선언을 낼 수 있는 소스 확장자다(TypeScript 우선, 다음 JavaScript). */
const SOURCE_EXTENSIONS: readonly (readonly [suffix: string, typeScript: readonly string[], javaScript: readonly string[]])[] = [
  ['.d.mts', ['.mts'], ['.mjs']],
  ['.d.cts', ['.cts'], ['.cjs']],
  ['.d.ts', ['.ts', '.tsx'], ['.js', '.jsx']],
];

/** 선언 파일 하나를 되짚은 결과다. */
export type DeclarationOutputMatch =
  /** 스캔한 소스 하나로 되짚었다. */
  | { readonly kind: 'source'; readonly fileName: string }
  /** 프로젝트 안 산출물이지만 스캔한 소스로 되짚을 근거가 없다. */
  | { readonly kind: 'unmapped' }
  /** 프로젝트 밖·의존성 선언이거나 프로젝트가 직접 쓴 선언이라 산출물로 보지 않는다. */
  | { readonly kind: 'not-output' };

/** 역매핑에 쓰는 설정 정보다. `options`의 경로 옵션은 parse 결과처럼 절대 경로다. */
export interface DeclarationOutputConfig {
  readonly path?: string;
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
}

/** 산출물 디렉터리와 그 산출물을 낸 소스 디렉터리 한 쌍이다. */
interface OutputRoot {
  readonly outputDirectory: string;
  readonly sourceDirectory: string;
}

/** 선언 산출물을 스캔한 소스로 되짚는다. 같은 파일은 한 번만 판정한다. */
export class DeclarationOutputMapper {
  readonly #root: string;
  readonly #scannedSources: ReadonlySet<string>;
  readonly #scannedDeclarations: ReadonlySet<string>;
  readonly #outputRoots: readonly OutputRoot[];
  readonly #cache = new Map<string, DeclarationOutputMatch>();

  /**
   * @param root 프로젝트 경계 realpath
   * @param configs 이 계획이 읽은 compiler 설정들
   * @param scannedFiles 걷기가 고른 소스·선언 파일 절대 경로
   */
  constructor(root: string, configs: readonly DeclarationOutputConfig[], scannedFiles: Iterable<string>) {
    this.#root = resolve(root);
    const files = [...scannedFiles].map((path) => resolve(path));
    this.#scannedDeclarations = new Set(files.filter(isDeclarationFile));
    this.#scannedSources = new Set(files.filter((path) => !isDeclarationFile(path)));
    this.#outputRoots = configs.flatMap(outputRootOf);
  }

  /**
   * 해석된 module 파일을 판정한다.
   *
   * @param fileName module 해석이 고른 파일(TypeScript 경로 표기)
   * @returns 되짚은 소스, 되짚지 못한 산출물, 또는 산출물 아님
   */
  match(fileName: string): DeclarationOutputMatch {
    const absolute = resolve(fileName);
    const cached = this.#cache.get(absolute);
    if (cached !== undefined) return cached;
    const result = this.#classify(absolute);
    this.#cache.set(absolute, result);
    return result;
  }

  /** 캐시하지 않은 판정이다. */
  #classify(absolute: string): DeclarationOutputMatch {
    if (!isDeclarationFile(absolute) || !this.#isProjectFile(absolute)) return { kind: 'not-output' };
    const fromMap = this.#fromDeclarationMap(absolute);
    if (fromMap !== undefined) return fromMap;
    const fromOutput = uniqueSource(this.#outputRoots.flatMap((root) => this.#fromOutputRoot(absolute, root)));
    if (fromOutput !== undefined) return { kind: 'source', fileName: fromOutput };
    const sibling = this.#sourceFor(absolute.slice(0, -suffixOf(absolute).length), suffixOf(absolute), true);
    if (sibling !== undefined) return { kind: 'source', fileName: sibling };
    // 프로젝트가 직접 쓰고 스캔한 선언(`src/types.d.ts`)은 그 자체가 프로젝트의 선언이다. 산출물로 세지 않는다.
    return this.#scannedDeclarations.has(absolute) ? { kind: 'not-output' } : { kind: 'unmapped' };
  }

  /** 프로젝트 경계 안이고 의존성 디렉터리(`node_modules`) 밖인 실제 경로인지 본다. */
  #isProjectFile(absolute: string): boolean {
    const offset = relative(this.#root, absolute);
    if (offset === '' || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return false;
    return !offset.split(sep).includes('node_modules');
  }

  /**
   * declaration map의 단일 소스로 되짚는다. map이 있는데 소스가 스캔 밖이면 다른 규칙으로 추측하지 않고 되짚지 못한 것으로 본다.
   *
   * @param absolute 선언 파일
   * @returns 판정, map을 쓸 수 없으면 undefined
   */
  #fromDeclarationMap(absolute: string): DeclarationOutputMatch | undefined {
    const read = readBoundedConfigText(`${absolute}.map`, MAX_DECLARATION_MAP_BYTES);
    if (!read.ok) return undefined;
    const source = singleMapSource(read.text);
    if (source === undefined) return undefined;
    const candidate = resolve(dirname(absolute), source.sourceRoot, source.path);
    return this.#scannedSources.has(candidate) ? { kind: 'source', fileName: candidate } : { kind: 'unmapped' };
  }

  /** 산출물 디렉터리 안의 선언이면 소스 디렉터리의 같은 상대 경로 소스를 찾는다. */
  #fromOutputRoot(absolute: string, root: OutputRoot): string[] {
    const offset = relative(root.outputDirectory, absolute);
    if (offset === '' || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return [];
    const suffix = suffixOf(absolute);
    const source = this.#sourceFor(join(root.sourceDirectory, offset.slice(0, -suffix.length)), suffix, false);
    return source === undefined ? [] : [source];
  }

  /**
   * 확장자 없는 경로에 맞는 스캔한 소스 하나를 고른다. TypeScript 소스가 하나면 그것, 없으면 JavaScript 소스가 하나일 때 그것이다.
   *
   * @param stem 확장자 없는 절대 경로
   * @param suffix 선언 접미사
   * @param javaScriptOnly 같은 디렉터리 형제는 JavaScript 구현만 본다(TypeScript 형제가 있으면 선언이 산출물이 아니다)
   * @returns 소스 절대 경로, 하나로 정하지 못하면 undefined
   */
  #sourceFor(stem: string, suffix: string, javaScriptOnly: boolean): string | undefined {
    const entry = SOURCE_EXTENSIONS.find(([candidate]) => candidate === suffix);
    if (entry === undefined) return undefined;
    const [, typeScript, javaScript] = entry;
    const pick = (extensions: readonly string[]) => uniqueSource(extensions.map((extension) => stem + extension)
      .filter((path) => this.#scannedSources.has(path)));
    return javaScriptOnly ? pick(javaScript) : pick(typeScript) ?? pick(javaScript);
  }
}

/** 선언 파일 이름인지 본다. */
function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/u.test(path);
}

/** 선언 파일의 접미사(`.d.ts`·`.d.mts`·`.d.cts`)다. */
function suffixOf(path: string): string {
  return SOURCE_EXTENSIONS.find(([suffix]) => path.endsWith(suffix))?.[0] ?? '.d.ts';
}

/** 후보가 정확히 하나일 때만 그 경로를 돌려준다. */
function uniqueSource(candidates: readonly string[]): string | undefined {
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * declaration map JSON에서 소스 하나를 읽는다. 원격 URL이나 여러 소스는 쓰지 않는다.
 *
 * @param text map 원문
 * @returns sourceRoot와 소스 상대 경로, 쓸 수 없으면 undefined
 */
function singleMapSource(text: string): { readonly sourceRoot: string; readonly path: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { sources, sourceRoot } = value as { sources?: unknown; sourceRoot?: unknown };
  if (!Array.isArray(sources) || sources.length !== 1 || typeof sources[0] !== 'string') return undefined;
  const root = typeof sourceRoot === 'string' ? sourceRoot : '';
  const path = sources[0];
  if (path === '' || /^[a-z][a-z0-9+.-]*:/iu.test(path) || /^[a-z][a-z0-9+.-]*:/iu.test(root)) return undefined;
  return { sourceRoot: root, path };
}

/**
 * 설정이 선언을 내보내는 디렉터리와 그 소스 디렉터리를 구한다. `rootDir`이 없으면 TypeScript와 같이 composite면 설정 디렉터리,
 * 아니면 선언이 아닌 진입 파일의 공통 디렉터리를 쓴다.
 *
 * @param config compiler 설정
 * @returns 산출물 루트(내보내지 않는 설정이면 빈 목록)
 */
function outputRootOf(config: DeclarationOutputConfig): OutputRoot[] {
  const output = config.options.declarationDir ?? config.options.outDir;
  if (output === undefined) return [];
  const explicit = config.options.rootDir;
  const source = explicit ?? (config.options.composite === true && config.path !== undefined ? dirname(config.path)
    : commonDirectory(config.fileNames.filter((path) => !isDeclarationFile(path))));
  return source === undefined ? [] : [{ outputDirectory: resolve(output), sourceDirectory: resolve(source) }];
}

/** 파일들의 가장 깊은 공통 디렉터리다. 파일이 없으면 undefined다. */
function commonDirectory(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  let common = dirname(resolve(files[0]!)).split(sep);
  for (const file of files.slice(1)) {
    const parts = dirname(resolve(file)).split(sep);
    let index = 0;
    while (index < common.length && index < parts.length && common[index] === parts[index]) index++;
    common = common.slice(0, index);
  }
  return common.length === 0 ? undefined : common.join(sep) || sep;
}
