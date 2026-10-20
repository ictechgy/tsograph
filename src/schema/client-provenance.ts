/**
 * 파일 사이로 Prisma Client 출처를 전파한다.
 *
 * 각 모듈의 export가 클라이언트 인스턴스·클래스·타입·팩토리인지를 고정점까지 반복 계산한다
 * (`export const prisma = new PrismaClient()` → `import { prisma } from '@/lib/db'` →
 * 재수출 사슬). import 지정자는 Prisma 모듈(`@prisma/client`, `.prisma/client`, 스키마 generator의
 * `output` 디렉터리)이거나 프로젝트 소스로 해석될 때만 의미를 가진다.
 *
 * 첫 라운드는 파싱 직후 모듈마다 계산하고, 둘째 라운드부터는 앞 계산이 읽은 표 칸의 값이 바뀐 모듈만 다시 계산한다.
 * 모듈 하나의 계산은 그 모듈의 트리와 표에서 읽은 값으로만 정해지므로, 모든 모듈을 매 라운드 다시 계산한 것과 결과가
 * 같다. 그래서 고정점이 프로젝트의 모든 파싱 트리를 끝까지 붙잡지 않는다(다시 계산할 모듈만 트리를 다시 얻는다).
 * 파싱하는 동안에는 추정 표도 채운다. 파싱 직후의 사용 스캔 기록이 고정점 뒤의 표와 같은 값을 읽을 법하게 하려는
 * 것이고, 같은지는 기록이 읽은 칸으로 따로 확인한다.
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

/** export 의미 표의 칸 하나를 읽은 기록이다. */
export interface KnowledgeRead {
  /** 모듈 절대 경로다. */
  readonly path: string;
  /** export 이름이다. undefined면 그 모듈의 export 표 전체(`all`)를 읽었다. */
  readonly name: string | undefined;
  /** 읽은 값의 비교용 직렬화다. */
  readonly observed: string;
}

/** 읽기를 기록하며 계산한 값과 그동안 읽은 칸이다. */
export interface Recorded<T> {
  readonly value: T;
  readonly reads: readonly KnowledgeRead[];
}

/** 모듈별 export 의미 표다. */
export class ProjectKnowledge {
  /** 절대 경로 → export 이름 → 의미다(`other`는 싣지 않는다). */
  private exportKinds = new Map<string, ReadonlyMap<string, BindingKind>>();
  /**
   * 지금 기록 중인 읽기 목록들이다(칸 키 → 읽은 기록, 안쪽 기록이 바깥 기록을 가리지 않게 모두에 싣는다). 한 계산 안에서는
   * 표가 바뀌지 않으므로 같은 칸은 한 번만 싣는다 — 이름공간 멤버 접근처럼 같은 칸을 여러 번 읽는 파일에서 기록이 읽은
   * 횟수만큼 커지지 않게 하려는 것이다.
   */
  private readonly recorders: Map<string, KnowledgeRead>[] = [];

  /**
   * export 의미를 묻는다.
   *
   * @param path 모듈 절대 경로
   * @param name export 이름
   * @returns 의미
   */
  lookup(path: string, name: string): BindingKind {
    const kind = this.exportKinds.get(path)?.get(name) ?? OTHER;
    this.note(`=${path}\u0000${name}`, () => ({ path, name, observed: JSON.stringify(kind) }));
    return kind;
  }

  /**
   * 모듈의 모든 export 의미다.
   *
   * @param path 모듈 절대 경로
   * @returns export 표
   */
  all(path: string): ReadonlyMap<string, BindingKind> {
    const exports = this.exportKinds.get(path) ?? new Map<string, BindingKind>();
    this.note(`*${path}`, () => ({ path, name: undefined, observed: serializeExports(exports) }));
    return exports;
  }

  /**
   * 계산하는 동안 표에서 읽은 칸을 기록한다. 계산이 같은 칸에서 같은 값을 읽으면 결과도 같다는 것이 메모의 전제다.
   *
   * @param compute 표를 읽을 수 있는 계산
   * @returns 계산 결과와 읽은 칸(칸마다 하나, 처음 읽은 순서)
   */
  record<T>(compute: () => T): Recorded<T> {
    const reads = new Map<string, KnowledgeRead>();
    this.recorders.push(reads);
    try {
      const value = compute();
      return { value, reads: [...reads.values()] };
    } finally {
      this.recorders.pop();
    }
  }

  /**
   * 기록한 칸이 지금 표에서도 같은 값인지 본다. 같으면 그 계산을 지금 표로 다시 해도 같은 결과다.
   *
   * @param reads 읽은 칸
   * @returns 모두 같으면 true
   */
  unchanged(reads: readonly KnowledgeRead[]): boolean {
    return reads.every((read) => read.observed === (read.name === undefined
      ? serializeExports(this.exportKinds.get(read.path) ?? new Map<string, BindingKind>())
      : JSON.stringify(this.exportKinds.get(read.path)?.get(read.name) ?? OTHER)));
  }

  /**
   * 읽은 칸을 기록 중인 모든 목록에 싣는다. 이미 실은 칸은 건너뛴다.
   *
   * @param key 칸 키(`=경로\0이름`은 이름 하나, `*경로`는 export 표 전체다. 경로에는 NUL이 없어 겹치지 않는다)
   * @param read 실을 기록을 만드는 함수(실을 때만 값을 직렬화한다)
   */
  private note(key: string, read: () => KnowledgeRead): void {
    for (const reads of this.recorders) if (!reads.has(key)) reads.set(key, read());
  }

  /**
   * 모듈 하나의 export 의미를 바꾼다. 파싱하며 모듈마다 채우는 추정 표(`ClientProvenance.guesses`)용이다 — 고정점 표는
   * 라운드마다 `replace`로만 바꾼다.
   *
   * @param path 모듈 절대 경로
   * @param exports export 이름 → 의미
   */
  assign(path: string, exports: ReadonlyMap<string, BindingKind>): void {
    this.exportKinds.set(path, exports);
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

/** 고정점이 모듈을 다시 계산할 때 트리를 얻는 손잡이다. */
export interface ModuleHandle {
  /** 모듈 절대 경로다. */
  readonly absolutePath: string;
  /**
   * 모듈 트리를 돌려준다(붙잡아 둔 트리가 없으면 다시 파싱한다).
   *
   * @returns 소스 모듈
   */
  load(): SourceModule;
}

/** 출처 계산기다. */
export class ClientProvenance {
  /** 모듈 해석기다. */
  private readonly resolver: ModuleResolver;
  /** Prisma 모듈 판정기다. */
  private readonly matcher: PrismaModuleMatcher;
  /** export 의미 표(고정점)다. */
  readonly knowledge = new ProjectKnowledge();
  /**
   * 파싱하는 동안 모은 export 의미 추정 표다. 고정점 라운드와 달리, 모듈마다 앞서 파싱한 모듈의 추정을 읽어 바로 채운다.
   * 파싱 직후의 사용 스캔 기록을 이 표로 해 두면, 클라이언트를 만들거나 옮기는 모듈이 쓰는 모듈보다 먼저 파싱된 흔한
   * 경우에 고정점 뒤의 표와 같은 값을 읽어 그 기록을 그대로 확정할 수 있다(다시 파싱하지 않는다). 맞는지는 기록이 읽은
   * 칸을 고정점 뒤의 표와 비교해 따로 확인하므로, 추정이 틀려도 결과는 같고 그 파일을 다시 파싱해 스캔할 뿐이다.
   */
  readonly guesses = new ProjectKnowledge();
  /** 고정점에 닿지 못하고 반복 상한에서 멈췄는지 여부다. */
  truncated = false;
  /** 모듈 절대 경로 → 마지막으로 계산한 export 의미와 그때 읽은 표 칸이다. */
  private readonly rounds = new Map<string, Recorded<ReadonlyMap<string, BindingKind>>>();

  /**
   * @param resolver 모듈 해석기
   * @param matcher Prisma 모듈 판정기
   */
  constructor(resolver: ModuleResolver, matcher: PrismaModuleMatcher) {
    this.resolver = resolver;
    this.matcher = matcher;
  }

  /**
   * 고정점의 첫 라운드를 모듈 하나에 대해 계산해 두고 추정 표에 그 모듈을 채운다. 첫 라운드는 빈 표로 계산하므로 `run`
   * 전에, 파싱 직후 트리가 있을 때 모든 모듈에 한 번씩 부른다(트리를 고정점까지 붙잡지 않기 위해서다).
   *
   * @param module 소스 모듈
   */
  observe(module: SourceModule): void {
    const first = this.knowledge.record(() => this.exportsOf(module, this.knowledge));
    this.rounds.set(module.absolutePath, first);
    // 첫 라운드가 읽은 칸이 추정 표에서도 같은 값이면 추정 표로 계산해도 같은 결과라 다시 계산하지 않는다.
    this.guesses.assign(module.absolutePath, this.guesses.unchanged(first.reads) ? first.value : this.exportsOf(module, this.guesses));
  }

  /**
   * export 의미를 고정점까지 계산한다. 라운드마다 모든 모듈을 앞 라운드 표로 계산한 것과 같고 반복 상한도 같다. 다만
   * 앞 계산이 읽은 칸의 값이 그대로인 모듈은 계산이 같으므로 다시 하지 않는다.
   *
   * @param modules 모든 소스 모듈(`observe`로 첫 라운드를 계산해 둔 것, 절대 경로 순)
   */
  run(modules: readonly ModuleHandle[]): void {
    let changed = this.install(modules);
    for (let round = 1; changed && round < MAX_PROVENANCE_ROUNDS; round++) {
      for (const module of modules) this.refresh(module);
      changed = this.install(modules);
    }
    this.truncated = changed;
  }

  /**
   * 읽은 칸의 값이 바뀐 모듈만 지금 표로 다시 계산한다.
   *
   * @param module 모듈 손잡이
   */
  private refresh(module: ModuleHandle): void {
    // observe가 모든 모듈의 첫 라운드를 넣은 뒤에만 run이 돈다.
    const last = this.rounds.get(module.absolutePath)!;
    if (this.knowledge.unchanged(last.reads)) return;
    this.rounds.set(module.absolutePath, this.knowledge.record(() => this.exportsOf(module.load(), this.knowledge)));
  }

  /**
   * 이번 라운드 결과로 표를 바꾼다.
   *
   * @param modules 모든 소스 모듈
   * @returns 표가 바뀌었으면 true
   */
  private install(modules: readonly ModuleHandle[]): boolean {
    const next = new Map<string, ReadonlyMap<string, BindingKind>>();
    for (const module of modules) next.set(module.absolutePath, this.rounds.get(module.absolutePath)!.value);
    return this.knowledge.replace(next);
  }

  /**
   * 표 하나를 기준으로 모듈 스코프와 평가 도구를 만든다.
   *
   * @param module 소스 모듈
   * @param knowledge 읽을 export 의미 표. 기본은 고정점 표다(파싱 직후의 사용 스캔 기록은 추정 표를 준다)
   * @returns 분석 도구
   */
  analyze(module: SourceModule, knowledge: ProjectKnowledge = this.knowledge): ModuleAnalysis {
    const evaluator = new BindingEvaluator((path, name) => knowledge.lookup(path, name));
    evaluator.requireLookup = (specifier) => this.requireKind(specifier, module.absolutePath, knowledge);
    evaluator.dynamicImportLookup = (specifier) => this.importKind({ local: '', specifier, imported: '*' }, module, knowledge);
    const builder = new ScopeBuilder(evaluator);
    const scope = new Scope(undefined);
    for (const binding of module.imports) declareImport(scope, binding.local, () => this.importKind(binding, module, knowledge));
    builder.hoistStatements(module.sourceFile.statements, { scope, thisMembers: undefined });
    return { scope, evaluator, builder };
  }

  /**
   * 모듈 하나의 export 의미를 계산한다.
   *
   * @param module 소스 모듈
   * @param knowledge 읽을 export 의미 표
   * @returns export 이름 → 의미(`other` 제외)
   */
  private exportsOf(module: SourceModule, knowledge: ProjectKnowledge): Map<string, BindingKind> {
    const { scope, evaluator } = this.analyze(module, knowledge);
    const result = new Map<string, BindingKind>();
    for (const [name, target] of module.exports) {
      let kind: BindingKind;
      if (target.kind === 'local') {
        const value = scope.lookupValue(target.name);
        kind = value.kind === 'other' ? scope.lookupType(target.name) : value;
      } else if (target.kind === 'reexport') {
        kind = this.importKind({ local: name, specifier: target.specifier, imported: target.imported }, module, knowledge);
      } else {
        kind = evaluator.expression(target.expression, { scope, thisMembers: undefined });
      }
      if (isExportableKind(kind)) result.set(name, kind);
    }
    for (const specifier of module.starExports) this.addStarExports(specifier, module, result, knowledge);
    return result;
  }

  /**
   * `export * from '…'`의 의미를 더한다(default 제외, 명시 export 우선).
   *
   * @param specifier 지정자
   * @param module 재수출하는 모듈
   * @param result export 표(추가된다)
   * @param knowledge 읽을 export 의미 표
   */
  private addStarExports(specifier: string, module: SourceModule, result: Map<string, BindingKind>, knowledge: ProjectKnowledge): void {
    const entries: [string, BindingKind][] = this.matcher.isPrismaModule(specifier, module.absolutePath)
      ? [['PrismaClient', prismaModuleMember('PrismaClient')], ['Prisma', prismaModuleMember('Prisma')]]
      : [...knowledge.all(this.resolver.resolve(specifier, module.absolutePath) ?? '')];
    for (const [name, kind] of entries) {
      if (name !== 'default' && !result.has(name) && !module.exports.has(name)) result.set(name, kind);
    }
  }

  /**
   * import 바인딩의 의미다.
   *
   * @param binding import 바인딩
   * @param module 가져오는 모듈
   * @param knowledge 읽을 export 의미 표
   * @returns 의미
   */
  private importKind(binding: ImportBinding, module: SourceModule, knowledge: ProjectKnowledge): BindingKind {
    if (this.matcher.isPrismaModule(binding.specifier, module.absolutePath)) {
      return binding.imported === '*' || binding.imported === 'default' ? PRISMA_MODULE : prismaModuleMember(binding.imported);
    }
    const target = this.resolver.resolve(binding.specifier, module.absolutePath);
    if (target === undefined) return OTHER;
    if (binding.imported === '*') return { kind: 'module', path: target };
    return knowledge.lookup(target, binding.imported);
  }

  /**
   * `require('…')`의 의미다. CommonJS `module.exports = client`면 클라이언트 자체다.
   *
   * @param specifier 지정자
   * @param importer 가져오는 파일 절대 경로
   * @param knowledge 읽을 export 의미 표
   * @returns 의미
   */
  private requireKind(specifier: string, importer: string, knowledge: ProjectKnowledge): BindingKind {
    if (this.matcher.isPrismaModule(specifier, importer)) return PRISMA_MODULE;
    const target = this.resolver.resolve(specifier, importer);
    if (target === undefined) return OTHER;
    return knowledge.lookup(target, 'default').kind === 'client' ? CLIENT : { kind: 'module', path: target };
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
  const entries = [...table].map(([path, exports]) => [path, sortedExports(exports)]);
  entries.sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
  return JSON.stringify(entries);
}

/**
 * 모듈 하나의 export 표를 비교용 문자열로 바꾼다(`all` 읽기 기록용, 이름 정렬).
 *
 * @param exports export 이름 → 의미
 * @returns 직렬화 문자열
 */
function serializeExports(exports: ReadonlyMap<string, BindingKind>): string {
  return JSON.stringify(sortedExports(exports));
}

/**
 * export 표 항목을 이름 순으로 정렬한다.
 *
 * @param exports export 이름 → 의미
 * @returns 정렬한 항목
 */
function sortedExports(exports: ReadonlyMap<string, BindingKind>): [string, BindingKind][] {
  return [...exports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
