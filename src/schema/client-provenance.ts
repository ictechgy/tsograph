/**
 * 파일 사이로 Prisma Client 출처를 전파한다.
 *
 * 각 모듈의 export가 클라이언트 인스턴스·클래스·타입·팩토리인지를 고정점까지 반복 계산한다
 * (`export const prisma = new PrismaClient()` → `import { prisma } from '@/lib/db'` →
 * 재수출 사슬). import 지정자는 Prisma 모듈(`@prisma/client`, `.prisma/client`, 스키마 generator의
 * `output` 디렉터리)이거나 프로젝트 소스로 해석될 때만 의미를 가진다.
 */

import {
  BindingEvaluator,
  type BindingKind,
  CLIENT,
  OTHER,
  PRISMA_MODULE,
  prismaModuleMember,
  Scope,
} from './client-binding.ts';
import { isWithinDirectory, type ModuleResolver } from './module-resolver.ts';
import { declareImport, ScopeBuilder } from './scope-builder.ts';
import type { ImportBinding, SourceModule } from './source-module.ts';

/** 고정점 반복 상한이다. 재수출 사슬이 이보다 길면 남은 출처는 해석하지 않는다. */
export const MAX_PROVENANCE_ROUNDS = 16;

/** 모듈별 export 의미 표다. */
export class ProjectKnowledge {
  /** 절대 경로 → export 이름 → 의미다(`other`는 싣지 않는다). */
  private exportKinds = new Map<string, ReadonlyMap<string, BindingKind>>();

  /**
   * export 의미를 묻는다.
   *
   * @param path 모듈 절대 경로
   * @param name export 이름
   * @returns 의미
   */
  lookup(path: string, name: string): BindingKind {
    return this.exportKinds.get(path)?.get(name) ?? OTHER;
  }

  /**
   * 모듈의 모든 export 의미다.
   *
   * @param path 모듈 절대 경로
   * @returns export 표
   */
  all(path: string): ReadonlyMap<string, BindingKind> {
    return this.exportKinds.get(path) ?? new Map();
  }

  /**
   * 한 라운드의 결과로 표를 바꾼다.
   *
   * @param next 새 표
   * @returns 바뀌었으면 true
   */
  replace(next: Map<string, ReadonlyMap<string, BindingKind>>): boolean {
    const changed = serialize(next) !== serialize(this.exportKinds);
    this.exportKinds = next;
    return changed;
  }
}

/** Prisma 모듈 지정자 판정기다. */
export class PrismaModuleMatcher {
  /** generator output 절대 디렉터리다. */
  private readonly outputDirectories: readonly string[];
  /** 모듈 해석기다. */
  private readonly resolver: ModuleResolver;

  /**
   * @param outputDirectories generator output 절대 디렉터리
   * @param resolver 모듈 해석기
   */
  constructor(outputDirectories: readonly string[], resolver: ModuleResolver) {
    this.outputDirectories = outputDirectories;
    this.resolver = resolver;
  }

  /**
   * 지정자가 Prisma Client 모듈인지 본다. `@prisma/client/sql`(TypedSQL)과 런타임 경로는 제외한다.
   *
   * @param specifier import 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns Prisma 모듈이면 true
   */
  isPrismaModule(specifier: string, importer: string): boolean {
    if (/^(@prisma\/client|\.prisma\/client)(\/(edge|wasm|default|index|index-browser|react-native))?$/u.test(specifier)) {
      return true;
    }
    if (this.outputDirectories.length === 0) return false;
    const candidates = this.resolver.lexicalCandidates(specifier, importer);
    return candidates.some((candidate) => this.outputDirectories.some((directory) => isWithinDirectory(candidate, directory)));
  }
}

/** 파일 분석 도구 묶음이다. 모듈 스코프를 만들 때마다 새로 만든다. */
export interface ModuleAnalysis {
  readonly scope: Scope;
  readonly evaluator: BindingEvaluator;
  readonly builder: ScopeBuilder;
}

/** 출처 계산기다. */
export class ClientProvenance {
  /** 소스 모듈(절대 경로 순)이다. */
  private readonly modules: readonly SourceModule[];
  /** 모듈 해석기다. */
  private readonly resolver: ModuleResolver;
  /** Prisma 모듈 판정기다. */
  private readonly matcher: PrismaModuleMatcher;
  /** export 의미 표다. */
  readonly knowledge = new ProjectKnowledge();
  /** 고정점에 닿지 못하고 반복 상한에서 멈췄는지 여부다. */
  truncated = false;

  /**
   * @param modules 소스 모듈
   * @param resolver 모듈 해석기
   * @param matcher Prisma 모듈 판정기
   */
  constructor(modules: readonly SourceModule[], resolver: ModuleResolver, matcher: PrismaModuleMatcher) {
    this.modules = modules;
    this.resolver = resolver;
    this.matcher = matcher;
  }

  /** export 의미를 고정점까지 계산한다. */
  run(): void {
    for (let round = 0; round < MAX_PROVENANCE_ROUNDS; round++) {
      const next = new Map<string, ReadonlyMap<string, BindingKind>>();
      for (const module of this.modules) next.set(module.absolutePath, this.exportsOf(module));
      if (!this.knowledge.replace(next)) return;
    }
    this.truncated = true;
  }

  /**
   * 현재 표를 기준으로 모듈 스코프와 평가 도구를 만든다.
   *
   * @param module 소스 모듈
   * @returns 분석 도구
   */
  analyze(module: SourceModule): ModuleAnalysis {
    const evaluator = new BindingEvaluator((path, name) => this.knowledge.lookup(path, name));
    evaluator.requireLookup = (specifier) => this.requireKind(specifier, module.absolutePath);
    evaluator.dynamicImportLookup = (specifier) => this.importKind({ local: '', specifier, imported: '*' }, module);
    const builder = new ScopeBuilder(evaluator);
    const scope = new Scope(undefined);
    for (const binding of module.imports) declareImport(scope, binding.local, () => this.importKind(binding, module));
    builder.hoistStatements(module.sourceFile.statements, { scope, thisMembers: undefined });
    return { scope, evaluator, builder };
  }

  /**
   * 모듈 하나의 export 의미를 계산한다.
   *
   * @param module 소스 모듈
   * @returns export 이름 → 의미(`other` 제외)
   */
  private exportsOf(module: SourceModule): Map<string, BindingKind> {
    const { scope, evaluator } = this.analyze(module);
    const result = new Map<string, BindingKind>();
    for (const [name, target] of module.exports) {
      let kind: BindingKind;
      if (target.kind === 'local') {
        const value = scope.lookupValue(target.name);
        kind = value.kind === 'other' ? scope.lookupType(target.name) : value;
      } else if (target.kind === 'reexport') {
        kind = this.importKind({ local: name, specifier: target.specifier, imported: target.imported }, module);
      } else {
        kind = evaluator.expression(target.expression, { scope, thisMembers: undefined });
      }
      if (isExportableKind(kind)) result.set(name, kind);
    }
    for (const specifier of module.starExports) this.addStarExports(specifier, module, result);
    return result;
  }

  /**
   * `export * from '…'`의 의미를 더한다(default 제외, 명시 export 우선).
   *
   * @param specifier 지정자
   * @param module 재수출하는 모듈
   * @param result export 표(추가된다)
   */
  private addStarExports(specifier: string, module: SourceModule, result: Map<string, BindingKind>): void {
    const entries: [string, BindingKind][] = this.matcher.isPrismaModule(specifier, module.absolutePath)
      ? [['PrismaClient', prismaModuleMember('PrismaClient')], ['Prisma', prismaModuleMember('Prisma')]]
      : [...this.knowledge.all(this.resolver.resolve(specifier, module.absolutePath) ?? '')];
    for (const [name, kind] of entries) {
      if (name !== 'default' && !result.has(name) && !module.exports.has(name)) result.set(name, kind);
    }
  }

  /**
   * import 바인딩의 의미다.
   *
   * @param binding import 바인딩
   * @param module 가져오는 모듈
   * @returns 의미
   */
  private importKind(binding: ImportBinding, module: SourceModule): BindingKind {
    if (this.matcher.isPrismaModule(binding.specifier, module.absolutePath)) {
      return binding.imported === '*' || binding.imported === 'default' ? PRISMA_MODULE : prismaModuleMember(binding.imported);
    }
    const target = this.resolver.resolve(binding.specifier, module.absolutePath);
    if (target === undefined) return OTHER;
    if (binding.imported === '*') return { kind: 'module', path: target };
    return this.knowledge.lookup(target, binding.imported);
  }

  /**
   * `require('…')`의 의미다. CommonJS `module.exports = client`면 클라이언트 자체다.
   *
   * @param specifier 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns 의미
   */
  private requireKind(specifier: string, importer: string): BindingKind {
    if (this.matcher.isPrismaModule(specifier, importer)) return PRISMA_MODULE;
    const target = this.resolver.resolve(specifier, importer);
    if (target === undefined) return OTHER;
    return this.knowledge.lookup(target, 'default').kind === 'client' ? CLIENT : { kind: 'module', path: target };
  }
}

/**
 * 파일 밖으로 전파하는 의미인지 본다. 문자열 상수·SQL 조각은 같은 파일 안에서만 쓴다
 * (가족 생산자의 바인딩 규칙과 같다).
 *
 * @param kind 의미
 * @returns 전파하면 true
 */
function isExportableKind(kind: BindingKind): boolean {
  return kind.kind !== 'other' && kind.kind !== 'string' && kind.kind !== 'sql-fragment';
}

/**
 * 표를 비교용 문자열로 바꾼다(키 정렬).
 *
 * @param table export 표
 * @returns 직렬화 문자열
 */
function serialize(table: ReadonlyMap<string, ReadonlyMap<string, BindingKind>>): string {
  const entries = [...table].map(([path, exports]) => [path, [...exports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
  entries.sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
  return JSON.stringify(entries);
}
