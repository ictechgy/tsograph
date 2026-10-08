/**
 * Bundled TypeScript library SourceFile을 여러 Program 사이에서 재사용한다.
 *
 * 프로젝트 소스와 선언은 각 Program이 소유한다. 이 모듈은 TypeScript가 배포한
 * 바로 아래의 `lib*.d.ts`만 DocumentRegistry에 고정하고, 파일 내용 digest가
 * 바뀌면 이전 AST를 갱신하지 않고 새 AST를 만든다. 따라서 기존 Program이
 * 들고 있는 SourceFile의 부모 포인터와 심볼 그래프를 나중 요청이 바꾸지 않는다.
 */

import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

import ts from 'typescript';

/** SDK AST 캐시의 기본 엔트리 수 상한이다. */
export const SDK_SOURCE_FILE_CACHE_MAX_ENTRIES = 96;

/** SDK AST 캐시가 보유하는 텍스트의 UTF-16 retention weight 상한이다. 전체 프로세스 메모리 상한은 아니다. */
export const SDK_SOURCE_FILE_CACHE_MAX_WEIGHT = 9 * 1024 * 1024;

/** 캐시 생성 시 바꿀 수 있는 경계다(제품은 기본값을 사용한다). */
export interface SdkSourceFileCacheSettings {
  /** 테스트나 별도 JS 격리를 위한 DocumentRegistry다. 생략하면 모듈 전역 registry를 쓴다. */
  readonly registry?: ts.DocumentRegistry;
  /** 최대 캐시 엔트리 수다. */
  readonly maxEntries?: number;
  /** 보유 텍스트의 최대 `text.length * 2` retention weight 합계다. */
  readonly maxWeight?: number;
}

/** 캐시 상태를 관찰하기 위한 값이다. */
export interface SdkSourceFileCacheStats {
  readonly entries: number;
  readonly utf16Weight: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly reads: number;
}

/** 호스트 설치 결과다. `release`는 Program 생성과 checker 획득 뒤 한 번 호출한다. */
export interface SdkSourceFileCacheLease {
  readonly host: ts.CompilerHost;
  readonly release: () => void;
}

interface CacheEntry {
  readonly key: string;
  readonly fileName: string;
  readonly options: ts.CompilerOptions;
  readonly scriptKind: ts.ScriptKind;
  readonly impliedNodeFormat: ts.ResolutionMode;
  version: string;
  weight: number;
}

interface RegistryLease {
  readonly fileName: string;
  readonly options: ts.CompilerOptions;
  readonly scriptKind: ts.ScriptKind;
  readonly impliedNodeFormat: ts.ResolutionMode;
}

/** TypeScript 5.9.3의 JS isolate마다 하나만 공유하는 기본 registry다. */
const defaultDocumentRegistry = ts.createDocumentRegistry(
  ts.sys.useCaseSensitiveFileNames,
  ts.sys.getCurrentDirectory(),
  ts.JSDocParsingMode.ParseForTypeInfo,
);

/** 캐시 밖의 SourceFile에도 기존 default-library 판정을 적용한다. */
export function isBundledDefaultLibraryFile(fileName: string, defaultLibDirectory: string): boolean {
  const normalized = resolve(fileName);
  return dirname(normalized) === defaultLibDirectory && /^lib[^/]*\.d\.ts$/u.test(basename(normalized));
}

/**
 * Bundled SDK SourceFile만 제한적으로 캐시하는 LRU다.
 *
 * `registry`의 cache-owned acquire 하나와 Program 생성 중 temporary acquire를
 * 분리한다. temporary lease는 `SdkSourceFileCacheLease.release`에서 모두 반납하고
 * 그 뒤 trim하므로, eviction/replacement 중에도 registry 참조 수가 음수가 되지 않는다.
 */
export class SdkSourceFileCache {
  private readonly registry: ts.DocumentRegistry;
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly entries = new Map<string, CacheEntry>();
  private utf16Weight = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private reads = 0;

  public constructor(settings: SdkSourceFileCacheSettings = {}) {
    this.registry = settings.registry ?? defaultDocumentRegistry;
    this.maxEntries = validateLimit(settings.maxEntries ?? SDK_SOURCE_FILE_CACHE_MAX_ENTRIES, 'maxEntries');
    this.maxWeight = validateLimit(settings.maxWeight ?? SDK_SOURCE_FILE_CACHE_MAX_WEIGHT, 'maxWeight');
  }

  /**
   * CompilerHost에 SDK 경로 전용 getSourceFile을 설치한다.
   *
   * @param host 원래 CompilerHost
   * @param options Program의 최종 CompilerOptions
   * @param defaultLibDirectory 기본 lib가 있는 신뢰 경계. 제품에서는 TS 배포 디렉터리다.
   */
  public install(
    host: ts.CompilerHost,
    options: ts.CompilerOptions,
    defaultLibDirectory = dirname(resolve(ts.getDefaultLibFilePath(options))),
  ): SdkSourceFileCacheLease {
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const stableOptions = stableCompilerOptions(options);
    const registryKey = this.registry.getKeyForCompilationSettings(stableOptions);
    const temporaryLeases: RegistryLease[] = [];
    let released = false;

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const normalized = resolve(fileName);
      if (!isBundledDefaultLibraryFile(normalized, defaultLibDirectory)) {
        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
      }

      // Program 수명이 끝난 뒤에도 host가 호출될 수 있다. 이 요청은 registry/cache
      // lease를 만들지 않고, SDK JSDoc 경계만 적용한 원래 host로 넘긴다.
      if (released) {
        return originalGetSourceFile(fileName, sourceFileOptionsForSdk(languageVersionOrOptions), onError, shouldCreateNewSourceFile);
      }

      let text: string | undefined;
      try {
        text = host.readFile(fileName);
      } catch {
        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
      }
      if (text === undefined) {
        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
      }

      this.reads++;
      const version = createHash('sha256').update(text).digest('hex');
      const sourceFileOptions = sourceFileOptionsForSdk(languageVersionOrOptions);
      const scriptKind = scriptKindFromFileName(fileName);
      const impliedNodeFormat = sourceFileOptions.impliedNodeFormat;
      const incomingLanguageVersion = sourceFileOptions.languageVersion;
      const effectiveCompilerTarget = effectiveScriptTarget(stableOptions);
      const key = sourceFileCacheKey(
        registryKey,
        host.getCanonicalFileName(normalized),
        scriptKind,
        impliedNodeFormat,
      );

      // DocumentRegistry가 compiler target과 다른 languageVersion을 받으면 같은
      // bucket 안에서 target AST를 잘못 재사용할 수 있다. 이 경우에는 cache를
      // 건너뛰고 JSDoc 경계만 조정한 원래 host를 사용한다.
      if (incomingLanguageVersion !== effectiveCompilerTarget) {
        return originalGetSourceFile(fileName, sourceFileOptions, onError, shouldCreateNewSourceFile);
      }

      // TypeScript의 fresh 요청은 registry/cache를 우회해야 한다. 같은 JSDoc 경계와
      // 모든 incoming 옵션을 유지하되 original host가 다시 ParseAll을 선택하지 않게 한다.
      if (shouldCreateNewSourceFile === true) {
        return originalGetSourceFile(fileName, sourceFileOptions, onError, true);
      }

      const existing = this.entries.get(key);
      if (existing !== undefined && existing.version === version) {
        this.hits++;
        this.entries.delete(key);
        this.entries.set(key, existing);
        return this.acquireTemporary(existing, text, sourceFileOptions, temporaryLeases);
      }

      this.misses++;
      if (existing !== undefined) {
        this.entries.delete(key);
        this.utf16Weight -= existing.weight;
        this.releaseEntry(existing);
      }

      const weight = text.length * 2;
      if (weight > this.maxWeight) {
        return this.acquireUncached(fileName, stableOptions, text, version, scriptKind, sourceFileOptions, temporaryLeases);
      }

      const entry: CacheEntry = {
        key,
        fileName,
        options: stableOptions,
        scriptKind,
        impliedNodeFormat,
        version,
        weight,
      };
      let cacheLeaseAcquired = false;
      try {
        this.registry.acquireDocument(
          fileName,
          stableOptions,
          ts.ScriptSnapshot.fromString(text),
          version,
          scriptKind,
          sourceFileOptions,
        );
        cacheLeaseAcquired = true;
        this.entries.set(key, entry);
        this.utf16Weight += weight;
        return this.acquireTemporary(entry, text, sourceFileOptions, temporaryLeases);
      } catch (error) {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.utf16Weight -= weight;
        }
        if (cacheLeaseAcquired) this.releaseEntry(entry);
        throw error;
      }
    };

    return {
      host,
      release: () => {
        if (released) return;
        released = true;
        let hasFirstError = false;
        let firstError: unknown;
        for (const lease of temporaryLeases) {
          try {
            this.releaseLease(lease);
          } catch (error) {
            if (!hasFirstError) {
              hasFirstError = true;
              firstError = error;
            }
          }
        }
        try {
          this.trim();
        } catch (error) {
          if (!hasFirstError) {
            hasFirstError = true;
            firstError = error;
          }
        }
        if (hasFirstError) throw firstError;
      },
    };
  }

  /** 캐시 상한을 적용한다. temporary Program lease가 반납된 뒤 호출한다. */
  public trim(): void {
    let hasFirstError = false;
    let firstError: unknown;
    while (this.entries.size > this.maxEntries || this.utf16Weight > this.maxWeight) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) return;
      const [key, entry] = oldest;
      this.entries.delete(key);
      this.utf16Weight -= entry.weight;
      try {
        this.releaseEntry(entry);
      } catch (error) {
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }
      }
      this.evictions++;
    }
    if (hasFirstError) throw firstError;
  }

  /** 현재 캐시 상태를 반환한다. */
  public getStats(): SdkSourceFileCacheStats {
    return {
      entries: this.entries.size,
      utf16Weight: this.utf16Weight,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      reads: this.reads,
    };
  }

  /** 테스트 격리나 명시적 수명 종료에 사용할 수 있는 정리다. */
  public clear(): void {
    let hasFirstError = false;
    let firstError: unknown;
    for (const entry of this.entries.values()) {
      try {
        this.releaseEntry(entry);
      } catch (error) {
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }
      }
    }
    this.entries.clear();
    this.utf16Weight = 0;
    if (hasFirstError) throw firstError;
  }

  /** registry에서 cache-owned acquire 하나를 반납한다. */
  private releaseEntry(entry: CacheEntry): void {
    this.releaseLease(entry);
  }

  /** registry temporary acquire 하나를 만들고 release 목록에 기록한다. */
  private acquireTemporary(
    entry: CacheEntry,
    text: string,
    sourceFileOptions: ts.CreateSourceFileOptions,
    temporaryLeases: RegistryLease[],
  ): ts.SourceFile {
    const sourceFile = this.registry.acquireDocument(
      entry.fileName,
      entry.options,
      ts.ScriptSnapshot.fromString(text),
      entry.version,
      entry.scriptKind,
      sourceFileOptions,
    );
    temporaryLeases.push({
      fileName: entry.fileName,
      options: entry.options,
      scriptKind: entry.scriptKind,
      impliedNodeFormat: entry.impliedNodeFormat,
    });
    return sourceFile;
  }

  /** 캐시하지 않는 큰 파일도 현재 Program 동안만 registry lease를 유지한다. */
  private acquireUncached(
    fileName: string,
    options: ts.CompilerOptions,
    text: string,
    version: string,
    scriptKind: ts.ScriptKind,
    sourceFileOptions: ts.CreateSourceFileOptions,
    temporaryLeases: RegistryLease[],
  ): ts.SourceFile {
    const sourceFile = this.registry.acquireDocument(
      fileName,
      options,
      ts.ScriptSnapshot.fromString(text),
      version,
      scriptKind,
      sourceFileOptions,
    );
    temporaryLeases.push({
      fileName,
      options,
      scriptKind,
      impliedNodeFormat: sourceFileOptions.impliedNodeFormat,
    });
    return sourceFile;
  }

  /** registry overload에서 format이 없을 때도 올바른 release overload를 고른다. */
  private releaseLease(lease: RegistryLease): void {
    if (lease.impliedNodeFormat === undefined) {
      this.registry.releaseDocument(lease.fileName, lease.options, lease.scriptKind);
    } else {
      this.registry.releaseDocument(lease.fileName, lease.options, lease.scriptKind, lease.impliedNodeFormat);
    }
  }
}

/** 제품 Program이 공유하는 process-local SDK cache다. */
export const sdkSourceFileCache = new SdkSourceFileCache();

interface SourceFileAffectingOptionDeclaration {
  readonly name: string;
}

interface InternalCompilerOptionApi {
  readonly sourceFileAffectingCompilerOptions: readonly SourceFileAffectingOptionDeclaration[];
  readonly getCompilerOptionValue: (options: ts.CompilerOptions, declaration: SourceFileAffectingOptionDeclaration) => unknown;
}

/**
 * registry key가 읽는 설정만 계산해 고정한다.
 *
 * CompilerOptions에는 module resolution cache와 callback을 포함한 객체가 있을 수
 * 있으므로 structuredClone을 쓰지 않는다. TypeScript 5.9.3이 공개한 runtime
 * sourceFileAffectingCompilerOptions/getCompilerOptionValue를 사용해 registry key에
 * 실제로 참여하는 값만 복사하고, callback 등 나머지 값은 얕은 복사로 보존한다.
 */
function stableCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  const api = ts as unknown as InternalCompilerOptionApi;
  const stable: Record<string, unknown> = { ...options, pathsBasePath: options.pathsBasePath };
  for (const declaration of api.sourceFileAffectingCompilerOptions) {
    stable[declaration.name] = cloneCompilerOptionValue(api.getCompilerOptionValue(options, declaration));
  }
  return stable as ts.CompilerOptions;
}

/** registry key에 들어갈 배열만 얕은 구조 복사한다. */
function cloneCompilerOptionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneCompilerOptionValue(item));
  return value;
}

/** TypeScript가 module/target 조합에서 실제로 선택한 target을 계산한다. */
function effectiveScriptTarget(options: ts.CompilerOptions): ts.ScriptTarget {
  const getEmitScriptTarget = (ts as unknown as {
    getEmitScriptTarget: (compilerOptions: ts.CompilerOptions) => ts.ScriptTarget;
  }).getEmitScriptTarget;
  return getEmitScriptTarget(options);
}

/** 숫자 인자와 CreateSourceFileOptions 모두에서 SDK JSDoc 경계를 보존한다. */
function sourceFileOptionsForSdk(
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.CreateSourceFileOptions {
  return typeof languageVersionOrOptions === 'object'
    ? { ...languageVersionOrOptions, jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeInfo }
    : { languageVersion: languageVersionOrOptions, jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeInfo };
}

/** registry bucket과 SourceFile shape를 모두 포함하는 LRU key다. */
function sourceFileCacheKey(
  registryKey: ts.DocumentRegistryBucketKey,
  canonicalPath: string,
  scriptKind: ts.ScriptKind,
  impliedNodeFormat: ts.ResolutionMode,
): string {
  return JSON.stringify([registryKey, canonicalPath, scriptKind, impliedNodeFormat ?? null]);
}

/** CompilerHost API에 공개되지 않은 파일명→ScriptKind 판정을 안정적으로 재현한다. */
function scriptKindFromFileName(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (lower.endsWith('.json')) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

/** 캐시 상한이 양의 정수인지 확인한다. */
function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
