/**
 * 프로젝트 하나에서 persistence `relation-use` 사실과 limitation을 뽑는다.
 *
 * 단계: Prisma 입력 수집 → 스키마 사실 → 소스 읽기 → 파일별 파싱(노드 없는 요약·출처 첫 라운드·사용 스캔 기록 뒤 트리를
 * 놓는다) → ORM·드라이버 표면(`orm/`, 게이트가 열리면 모든 트리로 Program) → 파일 사이 클라이언트 출처 고정점(읽은 칸이
 * 바뀐 모듈만 다시) → 파일별 사용 스캔 확정(그 파일의 트리를 놓는다) → TypedSQL 파일 → 지원 표면 밖 패키지 계수 →
 * limitation 조립. 사실로 만들지 못한 근거는 모두 계수로 남긴다 — 빈 결과를 완전성의 증거로 읽지 않게 한다.
 *
 * 파싱 트리는 소스 문자당 약 40 B라, 프로젝트의 모든 트리를 끝까지 붙잡으면 대형 저장소에서 V8 힙 한도를 넘는다(종료
 * 코드 134). 그래서 파일 하나의 일이 끝나면 트리를 놓고, 다시 필요한 파일만 텍스트에서 다시 파싱한다. 결과는 모든 트리를
 * 붙잡았을 때와 같다 — 파싱은 결정적이고, 파일 사이 단계에 넘기는 것은 노드 없는 표뿐이며, ORM 단계가 소비한 노드는 그
 * 단계가 붙잡은 같은 트리로만 사용 스캔에 넘긴다. ORM 게이트가 열리면 이름 해석기 Program이 모든 트리를 담으므로 그
 * 단계가 끝날 때까지는 트리를 모두 붙잡는다(그 단계의 최대 메모리는 그대로다).
 */

import { basename, extname, isAbsolute, resolve } from 'node:path';

import type ts from 'typescript';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { ClientProvenance, type ModuleHandle, PrismaModuleMatcher } from './client-provenance.ts';
import { commitUsage, recordUsage, type UsageCounts, type UsageRecord } from './client-usage.ts';
import { formatBreakdown, modulePackages, observeDbPackages, type PackageObservations } from './db-packages.ts';
import { ModuleResolver, isWithinDirectory } from './module-resolver.ts';
import type { PrismaCatalog } from './prisma-catalog.ts';
import {
  extractOrmFacts, likelyOrmText, type OrmExtractionInput, ormModulePackages, type OrmModulePackages, projectPackages,
} from './orm/orm-extract.ts';
import type { OrmCounts } from './orm/orm-facts.ts';
import { ormLimitations } from './orm/orm-limitations.ts';
import { isDeclarationFileName, loadPrismaProject, type PrismaProject } from './prisma-project.ts';
import { ProjectReader } from './project-reader.ts';
import { toPosixRelative } from './project-files.ts';
import { type RelationUseFact, RelationFactSink } from './relation-facts.ts';
import { isSourceFileName, parseBoundedSourceModule, parseSourceModule, type SourceModule } from './source-module.ts';
import { SourceText } from './source-text.ts';
import { sqlRelations } from './sql-relations.ts';
import { SYNTAX_DEPTH_CAUSE, TOO_DEEP } from './syntax-depth.ts';
import { dynamicChannel } from './relation-facts.ts';

/** 추출 결과다. */
export interface ExtractionResult {
  readonly facts: readonly RelationUseFact[];
  readonly limitations: readonly string[];
  /** 읽은 입력 파일 중 가장 늦은 수정 시각이다. */
  readonly sourceModifiedAt: Date | undefined;
}

/** 추출 전체의 계수다. */
interface ExtractionCounts extends UsageCounts {
  parseErrorFiles: string[];
  /** 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 분석에서 뺀 파일(프로젝트 기준 경로)이다. */
  deeplyNestedFiles: string[];
}

/** limitation 한 줄에 싣는 parse-error 파일 수 상한이다. */
const MAX_PARSE_ERROR_FILES = 10;

/**
 * 프로젝트를 분석한다.
 *
 * @param root 프로젝트 realpath
 * @returns 사실·limitation·수정 시각
 */
export function extractPersistenceFacts(root: string): ExtractionResult {
  const reader = new ProjectReader();
  const project = loadPrismaProject(root, reader);
  const sink = new RelationFactSink();
  const counts: ExtractionCounts = {
    dynamicRelations: 0, skippedSqlLiterals: 0, unresolvedReceivers: 0, unknownDelegates: 0,
    parseErrorFiles: [], deeplyNestedFiles: [],
  };
  const relational = isRelational(project.catalog);
  if (relational && project.catalog !== undefined) emitSchemaFacts(project.catalog, sink);
  const sources = readSources(root, project, reader);
  const resolver = new ModuleResolver(root, new Set(sources.map((source) => source.absolutePath)));
  const provenance = new ClientProvenance(resolver, new PrismaModuleMatcher(project.outputDirectories, resolver));
  const usage: UsageStage = { provenance, catalog: relational ? project.catalog : 'non-relational' };
  const entries = parseSources(sources, usage, counts);
  const orm = ormStage(entries, { resolver, sink, declarationFiles: () => declarationFiles(root, project, reader) });
  counts.dynamicRelations += orm.counts.dynamicRelations;
  counts.deeplyNestedFiles.push(...orm.counts.deeplyNestedFiles);
  provenance.run(entries);
  scanEntries(entries, usage, orm.consumed, { sink, counts });
  emitTypedSql(root, project.typedSqlFiles, reader, sink, counts);
  const facts = sink.sorted();
  const limitations = buildLimitations({
    project, counts, facts, sink, reader, packages: observeDbPackages(entries.map((entry) => entry.packages)),
    unreadableConfigs: resolver.unreadableConfigs, provenanceTruncated: provenance.truncated, relational, ormCounts: orm.counts,
  });
  return { facts, limitations, sourceModifiedAt: reader.newestModifiedAt };
}

/** 읽은 소스 파일 하나다. */
interface SourceInput {
  /** 프로젝트 루트 기준 POSIX 경로다. */
  readonly path: string;
  /** 절대 경로다. */
  readonly absolutePath: string;
  /** 파일 텍스트(BOM 제거 뒤)다. */
  readonly text: string;
}

/** 파일별 사용 스캔의 문맥이다. */
interface UsageStage {
  readonly provenance: ClientProvenance;
  /** 스키마 이름 표. `'non-relational'`이면 delegate 접근을 사실로 내지 않는다. */
  readonly catalog: PrismaCatalog | undefined | 'non-relational';
}

/** 사용 스캔 결과를 넣는 곳이다. */
interface UsageOutput {
  readonly sink: RelationFactSink;
  readonly counts: UsageCounts;
}

/**
 * 파싱한 소스 하나의 노드 없는 요약과 트리 수명이다.
 *
 * 파일 하나의 일이 끝나면 트리를 놓고 텍스트와 요약만 남긴다. 트리를 다시 얻을 때는 같은 텍스트를 같은 옵션으로 다시
 * 파싱하므로 같은 트리다. 트리를 붙잡는 때는 ORM 게이트가 열려 이름 해석기가 모든 모듈로 Program을 만들 때뿐이다.
 */
class SourceEntry implements ModuleHandle {
  /** 프로젝트 루트 기준 POSIX 경로다. */
  readonly path: string;
  /** 절대 경로다. */
  readonly absolutePath: string;
  /** 지원 표면 밖 DB 패키지 계수의 재료다(`modulePackages`). */
  readonly packages: ReadonlySet<string>;
  /** ORM 단계 게이트의 재료다. */
  readonly orm: OrmModulePackages;
  /** 다시 파싱할 텍스트다. */
  private readonly text: string;
  /** 파싱 직후 출처 추정 표로 해 둔 사용 스캔 기록이다(ORM 게이트가 열리기 전에 파싱한 모듈만 있다). */
  usage: UsageRecord | undefined;
  /** 붙잡은 트리다. */
  private module: SourceModule | undefined;

  /**
   * @param source 읽은 소스
   * @param module 방금 파싱한 트리(요약만 뽑고 붙잡지 않는다)
   */
  constructor(source: SourceInput, module: SourceModule) {
    this.path = source.path;
    this.absolutePath = source.absolutePath;
    this.text = source.text;
    this.packages = modulePackages(module);
    this.orm = ormModulePackages(module);
  }

  /**
   * 트리를 돌려준다. 붙잡은 트리가 없으면 다시 파싱하고, 그 트리는 붙잡지 않는다.
   *
   * @returns 소스 모듈
   */
  load(): SourceModule {
    return this.module ?? parseSourceModule(this.path, this.absolutePath, this.text);
  }

  /**
   * 트리를 붙잡는다. 붙잡은 트리가 없으면 주어진 트리를, 그것도 없으면 다시 파싱한 트리를 붙잡는다.
   *
   * @param module 방금 파싱한 트리
   * @returns 붙잡은 트리
   */
  retain(module?: SourceModule): SourceModule {
    this.module ??= module ?? this.load();
    return this.module;
  }

  /** 이 파일의 일이 끝났으므로 트리와 사용 스캔 기록을 놓는다. */
  release(): void {
    this.module = undefined;
    this.usage = undefined;
  }
}

/**
 * 소스 파일을 읽는다. generator 출력 디렉터리(생성된 클라이언트)는 분석 대상 코드가 아니다.
 *
 * @param root 프로젝트 realpath
 * @param project Prisma 입력
 * @param reader 파일 읽기 도우미
 * @returns 읽은 소스(경로 순)
 */
function readSources(root: string, project: PrismaProject, reader: ProjectReader): SourceInput[] {
  const sources: SourceInput[] = [];
  for (const [path, absolutePath] of project.walk.files) {
    if (!isSourceFileName(basename(path))) continue;
    if (project.outputDirectories.some((directory) => isWithinDirectory(absolutePath, directory))) continue;
    const text = reader.read(absolutePath)?.text;
    if (text !== undefined) sources.push({ path: toPosixRelative(root, absolutePath), absolutePath, text });
  }
  return sources;
}

/**
 * 소스를 파싱해 요약과 출처 첫 라운드를 남긴다. 트리는 ORM 게이트를 연 모듈부터 붙잡는다.
 *
 * 게이트가 닫혀 있는 동안은 사용 스캔도 그 자리에서 출처 추정 표로 기록하고 트리를 놓는다. 게이트가 끝내 닫혀 있으면
 * 기록이 읽은 칸이 고정점 뒤의 표와 같은 파일은 그 기록을 그대로 확정해 다시 파싱하지 않는다. 파싱 순서는 결과에 영향이
 * 없다 — 첫 라운드는 빈 출처 표로 모듈마다 따로 계산하고, 추정 표로 한 기록은 읽은 칸으로 따로 확인하며, 모듈 목록은
 * 경로 순으로 돌려준다.
 *
 * 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘긴 파일은 요약을 만들지 않고 센다. 그래서 뒤 단계(이름 해석기
 * Program·출처 고정점·사용 스캔·패키지 계수)가 그 파일을 보지 않는다. 그 파일을 가리키는 import는 export를 모르는
 * 모듈로 남는다(해석기의 소스 집합은 파싱 전에 만들었으므로 경로는 풀리지만 export 표가 없다).
 *
 * @param sources 읽은 소스(경로 순)
 * @param usage 사용 스캔 문맥
 * @param counts 계수(parse-error 파일과 깊이로 뺀 파일이 더해진다)
 * @returns 소스 요약(경로 순, 뺀 파일 제외)
 */
function parseSources(sources: readonly SourceInput[], usage: UsageStage, counts: ExtractionCounts): SourceEntry[] {
  const entries: (SourceEntry | undefined)[] = [];
  let gated = false;
  for (const index of parseOrder(sources)) {
    const source = sources[index]!;
    const module = parseBoundedSourceModule(source.path, source.absolutePath, source.text);
    if (module === TOO_DEEP) {
      counts.deeplyNestedFiles.push(source.path);
      continue;
    }
    if (module.hasParseErrors) counts.parseErrorFiles.push(module.path);
    const entry = new SourceEntry(source, module);
    gated ||= entry.orm.isOrmModule;
    usage.provenance.observe(module);
    if (gated) entry.retain(module);
    else entry.usage = recordUsage(module, usage.provenance, usage.catalog, { knowledge: usage.provenance.guesses });
    entries[index] = entry;
  }
  return entries.filter((entry) => entry !== undefined);
}

/** Prisma 클라이언트를 만들 법한 소스의 글자다(클래스 이름 또는 Prisma 모듈 지정자). */
const likelyClientSourcePattern = /PrismaClient|@prisma\/client|\.prisma\/client/u;

/** 다른 모듈의 값을 옮겨 내보낼 법한 소스의 글자다(`export *`·`export {`·CommonJS export). */
const likelyReexportPattern = /\bexport\s*[*{]|\bmodule\.exports\b/u;

/**
 * 파싱 순서다(같은 무리 안에서는 경로 순). ORM 게이트를 열 법한 소스, Prisma 클라이언트를 만들 법한 소스, 다른 모듈의
 * 값을 내보낼 법한 소스, 나머지 순이다.
 *
 * 첫 무리는 게이트를 먼저 열어, 게이트가 열리는 프로젝트에서 앞서 놓은 트리를 ORM 단계용으로 다시 파싱하는 양을 줄인다.
 * 다음 두 무리는 클라이언트를 쓰는 파일보다 클라이언트를 만들거나 옮기는 파일의 추정을 먼저 채워, 사용 스캔 기록이 고정점
 * 뒤의 표와 맞아 다시 파싱하지 않게 한다. 판정은 글자 검사라 틀릴 수 있지만(주석·이스케이프) 틀려도 결과는 같고 다시
 * 파싱만 는다. 패턴은 반복이 겹치지 않는 고정 문자열·공백 반복이라 큰 입력에서도 선형 시간이다.
 *
 * @param sources 읽은 소스(경로 순)
 * @returns 소스 번호 순서
 */
function parseOrder(sources: readonly SourceInput[]): number[] {
  const groups: number[][] = [[], [], [], []];
  sources.forEach((source, index) => groups[parsePriority(source.text)]!.push(index));
  return groups.flat();
}

/**
 * 소스 하나의 파싱 순서 무리다.
 *
 * @param text 소스 텍스트
 * @returns 무리 번호(작을수록 먼저)
 */
function parsePriority(text: string): number {
  if (likelyOrmText(text)) return 0;
  if (likelyClientSourcePattern.test(text)) return 1;
  return likelyReexportPattern.test(text) ? 2 : 3;
}

/** ORM 단계 결과다. */
interface OrmStage {
  readonly counts: OrmCounts;
  /** 모듈 절대 경로 → 게이트가 소비한 노드다(소비한 노드가 있는 파일만). 파일마다 지워 그 트리를 놓는다. */
  readonly consumed: Map<string, Set<ts.Node>>;
}

/**
 * ORM·드라이버 단계를 돌린다. 게이트가 열리면 놓았던 트리까지 다시 파싱해 모든 모듈의 트리를 붙잡는다.
 *
 * @param entries 소스 요약(경로 순)
 * @param input 해석기·수집기·선언 파일 입력
 * @returns 계수와 파일별 소비 노드
 */
function ormStage(entries: readonly SourceEntry[], input: Pick<OrmExtractionInput, 'resolver' | 'sink' | 'declarationFiles'>): OrmStage {
  const orm = extractOrmFacts({
    ...input,
    packages: projectPackages(entries.map((entry) => entry.orm)),
    modules: () => entries.map((entry) => entry.retain()),
  });
  const consumed = new Map<string, Set<ts.Node>>();
  for (const node of orm.consumed) {
    // Program이 파일 이름을 '/'로 바꿔도 네이티브 경로인 SourceEntry와 같은 소비 기록을 쓴다.
    const path = resolve(node.getSourceFile().fileName);
    const nodes = consumed.get(path) ?? new Set<ts.Node>();
    consumed.set(path, nodes.add(node));
  }
  return { counts: orm.counts, consumed };
}

/**
 * 파일마다 사용 스캔을 확정하고 그 파일의 트리를 놓는다.
 *
 * 파싱 직후의 기록은 게이트가 소비한 노드가 없고, 읽은 출처 칸이 고정점 뒤의 표에서도 같은 값일 때만 그대로 쓴다(그때
 * 다시 스캔해도 같다). 아니면 지금 표와 소비 노드로 다시 스캔한다.
 *
 * @param entries 소스 요약(경로 순)
 * @param usage 사용 스캔 문맥
 * @param consumed 파일별 소비 노드(확정한 파일은 지워진다)
 * @param output 사실 수집기와 계수
 */
function scanEntries(entries: readonly SourceEntry[], usage: UsageStage, consumed: Map<string, Set<ts.Node>>, output: UsageOutput): void {
  for (const entry of entries) {
    const nodes = consumed.get(entry.absolutePath);
    const recorded = entry.usage;
    const record = recorded !== undefined && nodes === undefined && usage.provenance.knowledge.unchanged(recorded.reads)
      ? recorded
      : recordUsage(entry.load(), usage.provenance, usage.catalog, { preconsumed: nodes });
    commitUsage(record, output.sink, output.counts);
    consumed.delete(entry.absolutePath);
    entry.release();
  }
}

/**
 * datasource가 관계형인지 본다. MongoDB 스키마는 SQL 관계가 아니다.
 *
 * @param catalog 이름 표
 * @returns 관계형이면 true(스키마가 없으면 true — 원시 SQL은 여전히 읽는다)
 */
function isRelational(catalog: PrismaCatalog | undefined): boolean {
  return catalog === undefined || !catalog.providers.includes('mongodb');
}

/**
 * 스키마 선언을 사실로 낸다: 모델 테이블(심볼 `Model`), 컬럼(심볼 `Model.field`), 조인 테이블과
 * 그 컬럼 `A`·`B`. usr는 그래프 노드가 아닌 선언 이름공간 `<스키마 경로>#model:<심볼>`이다.
 *
 * @param catalog 이름 표
 * @param sink 사실 수집기
 */
function emitSchemaFacts(catalog: PrismaCatalog, sink: RelationFactSink): void {
  for (const model of catalog.models) {
    const base = { path: model.file.path, text: model.file.text };
    sink.add({ ...base, channel: model.table.channel, dynamic: model.table.dynamic, offset: model.nameOffset, ...declarationSymbol(model.file.path, model.name) });
    for (const column of model.columns) {
      sink.add({
        ...base, channel: model.table.channel, method: column.column, dynamic: false,
        offset: column.nameOffset, ...declarationSymbol(model.file.path, `${model.name}.${column.field}`),
      });
    }
  }
  for (const join of catalog.joinTables) {
    const base = { path: join.file.path, text: join.file.text, offset: join.nameOffset, ...declarationSymbol(join.file.path, join.symbol) };
    sink.add({ ...base, channel: join.table.channel, dynamic: join.table.dynamic });
    if (join.table.dynamic) continue;
    for (const column of ['A', 'B']) sink.add({ ...base, channel: join.table.channel, method: column, dynamic: false });
  }
}

/**
 * 스키마 선언 사실의 symbol·usr 입력이다. usr는 그래프 노드와 겹치지 않는 `#model:` 이름공간이다.
 *
 * @param path 스키마 파일의 프로젝트 기준 경로
 * @param symbol 모델 이름 또는 `Model.field`
 * @returns 사실 입력의 symbol·usr
 */
function declarationSymbol(path: string, symbol: string): { symbol: string; usr: string } {
  return { symbol, usr: `${path}#model:${symbol}` };
}

/**
 * TypedSQL `.sql` 파일의 관계를 사실로 낸다. 위치는 관계 키워드, 심볼은 생성 함수 이름(파일 이름)이다.
 *
 * @param root 프로젝트 realpath
 * @param files `.sql` 파일 절대 경로
 * @param reader 파일 읽기 도우미
 * @param sink 사실 수집기
 * @param counts 계수(갱신된다)
 */
function emitTypedSql(root: string, files: readonly string[], reader: ProjectReader, sink: RelationFactSink, counts: UsageCounts): void {
  for (const file of files) {
    const text = reader.read(file)?.text;
    if (text === undefined) continue;
    const path = toPosixRelative(root, file);
    const source = new SourceText(text);
    const name = basename(file, extname(file));
    // usr는 그래프 노드가 아닌 `#typedsql:` 이름공간이다(생성 함수 호출은 그래프에서 외부다).
    const symbol = { symbol: `${path}#${name}`, usr: `${path}#typedsql:${name}` };
    const result = sqlRelations(text);
    for (const relation of result.relations) {
      sink.add({ channel: relation.name, dynamic: false, path, text: source, offset: relation.keyword, ...symbol });
    }
    if (result.unresolved > 0) {
      counts.dynamicRelations += result.unresolved;
      sink.add({ channel: dynamicChannel(text), dynamic: true, path, text: source, offset: 0, ...symbol });
    }
  }
}

/**
 * 선언 파일(`.d.ts`)의 텍스트를 읽는다(D1 바인딩 선언 수집용). ORM 단계가 필요할 때만 부른다.
 *
 * @param root 프로젝트 realpath
 * @param project Prisma 입력(파일 목록)
 * @param reader 파일 읽기 도우미
 * @returns 경로·텍스트 목록
 */
function declarationFiles(root: string, project: PrismaProject, reader: ProjectReader): { path: string; text: string }[] {
  const result: { path: string; text: string }[] = [];
  for (const [path, absolutePath] of project.walk.files) {
    if (!isDeclarationFileName(basename(path))) continue;
    const text = reader.read(absolutePath)?.text;
    if (text !== undefined) result.push({ path: toPosixRelative(root, absolutePath), text });
  }
  return result;
}

/** limitation 조립 입력이다. */
interface LimitationInput {
  readonly project: PrismaProject;
  readonly counts: ExtractionCounts;
  readonly facts: readonly RelationUseFact[];
  readonly sink: RelationFactSink;
  readonly reader: ProjectReader;
  readonly packages: PackageObservations;
  readonly unreadableConfigs: number;
  readonly provenanceTruncated: boolean;
  readonly relational: boolean;
  readonly ormCounts: OrmCounts;
}

/**
 * limitation 문장을 만든다. 접두사는 계약이라 바꾸지 않는다(README 목록).
 *
 * @param input 조립 입력
 * @returns limitation 목록(고정 순서)
 */
function buildLimitations(input: LimitationInput): string[] {
  return [...prismaLimitations(input), ...sourceLimitations(input), ...inputLimitations(input)];
}

/**
 * Prisma 스키마·이름 규칙 관련 limitation이다.
 *
 * @param input 조립 입력
 * @returns limitation 목록
 */
function prismaLimitations({ project, relational }: LimitationInput): string[] {
  const { location, catalog, naming, counts } = project;
  const result: string[] = [];
  if (project.usesPrisma && project.schemaFiles.length === 0 && location.unresolvedConfigs === 0 && location.missingSchemas === 0) {
    result.push('prisma-schema-not-found: Prisma is a dependency but no schema was found at the configured or default locations; Prisma models are not emitted');
  }
  if (location.unresolvedConfigs > 0) {
    result.push(`unresolved-prisma-config: ${location.unresolvedConfigs} prisma.config file(s) set schema to a value that is not a string literal; their schemas were not read`);
  }
  if (location.missingSchemas > 0) {
    result.push(`missing-prisma-schemas: ${location.missingSchemas} configured Prisma schema path(s) do not exist`);
  }
  if (counts.schemasOutsideProject > 0) {
    result.push(`schema-outside-project: ${counts.schemasOutsideProject} Prisma schema file(s) lie outside --project and were not read`);
  }
  if (!relational) {
    result.push('non-relational-stores: the Prisma datasource provider is mongodb; collections are outside the relation join and are not emitted');
  }
  if (catalog !== undefined && naming.unverifiedReason !== undefined) {
    const dynamic = catalog.counts.dynamicTables + catalog.counts.dynamicJoinTables;
    result.push(`prisma-naming-unverified: ${naming.unverifiedReason}; ${dynamic} table name(s) that differ across the candidate naming rules (${naming.rules.join(', ')}) are emitted as dynamic facts and their columns are omitted`);
  }
  if (naming.observed.some((entry) => entry.packageName === '@prisma/orm-family-sql')) {
    result.push('prisma-8-surface-unscanned: Prisma 8 (@prisma/orm-family-sql) contract files and client API are not scanned; only Prisma 7 style schemas and PrismaClient usage are read');
  }
  if (catalog !== undefined) result.push(...catalogLimitations(catalog));
  if (counts.unresolvedGeneratorOutputs > 0) {
    result.push(`unresolved-generator-outputs: ${counts.unresolvedGeneratorOutputs} Prisma generator output(s) are not string literals; imports of those clients are not traced`);
  }
  if (counts.generatorOutputsContainingProject > 0) {
    result.push(`unresolved-generator-outputs: ${counts.generatorOutputsContainingProject} Prisma generator output(s) resolve to the project root or one of its ancestors; they were not excluded from the source scan and imports of those clients are not traced`);
  }
  if (counts.unresolvedTypedSql > 0) {
    result.push(`unresolved-typed-sql: ${counts.unresolvedTypedSql} prisma.config typedSql path(s) are not string literals; TypedSQL files there were not read`);
  }
  return result;
}

/**
 * 스키마 이름 표의 계수 limitation이다.
 *
 * @param catalog 이름 표
 * @returns limitation 목록
 */
function catalogLimitations(catalog: PrismaCatalog): string[] {
  const { counts } = catalog;
  const result: string[] = [];
  if (counts.unparsedLines > 0) {
    result.push(`unparsed-schema-lines: ${counts.unparsedLines} line(s) in Prisma schema blocks could not be parsed; their fields are not emitted`);
  }
  if (counts.unresolvedFieldTypes > 0) {
    result.push(`unresolved-field-types: ${counts.unresolvedFieldTypes} Prisma field(s) use types not declared in the scanned schema; they are not emitted`);
  }
  if (counts.ignoredModels + counts.ignoredFields > 0) {
    result.push(`ignored-prisma-elements: ${counts.ignoredModels} @@ignore model(s) and ${counts.ignoredFields} @ignore field(s) are not emitted`);
  }
  return result;
}

/**
 * 소스 스캔 관련 limitation이다.
 *
 * @param input 조립 입력
 * @returns limitation 목록
 */
function sourceLimitations({ counts, facts, sink, packages, provenanceTruncated, ormCounts }: LimitationInput): string[] {
  const result: string[] = [...ormLimitations(ormCounts)];
  if (packages.nonRelationalFiles > 0) {
    result.push(`non-relational-stores: ${packages.nonRelationalFiles} source file(s) import non-SQL persistence packages outside the relation join: ${formatBreakdown(packages.nonRelational)}`);
  }
  if (packages.unsupportedFiles > 0) {
    result.push(`unsupported-db-packages: ${packages.unsupportedFiles} source file(s) use SQL packages outside the supported surface: ${formatBreakdown(packages.unsupported)}`);
  }
  if (counts.dynamicRelations > 0) {
    result.push(`dynamic-relation-names: ${counts.dynamicRelations} SQL argument(s), relation operand(s), or delegate access(es) were not statically readable; they are emitted as dynamic facts`);
  }
  if (counts.skippedSqlLiterals > 0) {
    result.push(`skipped-sql-literals: ${counts.skippedSqlLiterals} ungated literal(s) contained SQL verbs but not the uppercase form required for heuristic scanning; not counted`);
  }
  if (counts.unresolvedReceivers > 0) {
    result.push(`unresolved-client-receivers: ${counts.unresolvedReceivers} Prisma delegate call(s) use receivers that could not be traced to a PrismaClient; not emitted`);
  }
  if (provenanceTruncated) {
    result.push('provenance-truncated: client provenance did not converge within the re-export round limit; some clients may be untraced');
  }
  const missingSymbols = facts.filter((fact) => fact.symbol === undefined).length;
  if (missingSymbols > 0) {
    result.push(`missing-relation-usrs: ${missingSymbols} relation-use fact(s) have source locations but no enclosing declaration name, so they carry no symbol and no usr`);
  }
  if (sink.invalidNames > 0) {
    result.push(`invalid-relation-names: ${sink.invalidNames} relation or column name(s) contained control characters and were skipped`);
  }
  return result;
}

/**
 * 파일 입력 관련 limitation이다.
 *
 * @param input 조립 입력
 * @returns limitation 목록
 */
function inputLimitations({ project, counts, reader, unreadableConfigs, sink }: LimitationInput): string[] {
  const { walk } = project;
  const result: string[] = [];
  if (reader.unreadable + walk.unreadableDirectories > 0) {
    result.push(`unreadable-sources: ${reader.unreadable} file(s) and ${walk.unreadableDirectories} directory entr(ies) could not be read and were skipped`);
  }
  if (reader.oversized > 0) {
    result.push(`oversized-sources: ${reader.oversized} file(s) larger than 4 MiB were skipped`);
  }
  if (counts.parseErrorFiles.length > 0) {
    result.push(`parse-errors: ${counts.parseErrorFiles.length} source file(s) could not be parsed completely`
      + parseErrorFileSuffix(counts.parseErrorFiles));
  }
  if (counts.deeplyNestedFiles.length > 0) {
    result.push(`parse-errors: ${counts.deeplyNestedFiles.length} source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed`
      + parseErrorFileSuffix(counts.deeplyNestedFiles));
  }
  if (unreadableConfigs > 0) {
    result.push(`unreadable-module-configs: ${unreadableConfigs} tsconfig/jsconfig file(s) could not be parsed; imports under them use default resolution`);
  }
  // Prisma 탐색 계수는 걷기가 이미 센 링크를 빼고 셌으므로 더해도 같은 링크를 두 번 세지 않는다.
  const symlinks = walk.skippedSymlinks + project.counts.skippedSymlinks;
  if (symlinks > 0) result.push(`skipped-symlinks: ${symlinks} symbolic link(s) were not followed`);
  if (walk.unsafeNames > 0) {
    result.push(`unsafe-names: ${walk.unsafeNames} file or directory name(s) contain characters the exchange format forbids and were skipped`);
  }
  // 걷기 밖에서 조립한 Prisma 스키마·TypedSQL 경로는 수집기가 마지막에 거른다. 걷기는 이름을, 수집기는 사실을
  // 세어 단위가 다르므로 더하지 않고 따로 싣는다.
  if (sink.unsafePaths > 0) {
    result.push(`unsafe-names: ${sink.unsafePaths} relation-use fact(s) were skipped because their file paths contain characters the exchange format forbids`);
  }
  if (walk.truncated) result.push('scan-truncated: the project tree exceeded the directory entry limit; later files were not scanned');
  return result;
}

/** 안전한 프로젝트 상대 parse-error 파일만 10개 싣고 나머지를 정확히 센다. */
function parseErrorFileSuffix(paths: readonly string[]): string {
  const safe = [...new Set(paths)].filter(isSafeDiagnosticPath).sort();
  const shown = safe.slice(0, MAX_PARSE_ERROR_FILES);
  return `; files: ${JSON.stringify(shown)}; omitted: ${new Set(paths).size - shown.length}`;
}

/** limitation에 그대로 실어도 source/절대 경로/control 문자가 새지 않는 경로인지 본다. */
function isSafeDiagnosticPath(path: string): boolean {
  return isSafeIdentifier(path) && !isAbsolute(path) && !/^[A-Za-z]:/u.test(path)
    && path.split(/[\\/]/u).every((part) => part.length > 0 && part !== '.' && part !== '..');
}
