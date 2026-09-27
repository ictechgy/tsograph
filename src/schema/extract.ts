/**
 * 프로젝트 하나에서 persistence `relation-use` 사실과 limitation을 뽑는다.
 *
 * 단계: Prisma 입력 수집 → 스키마 사실 → 소스 파싱 → 파일 사이 클라이언트 출처 고정점 →
 * 파일별 사용 스캔 → TypedSQL 파일 → 지원 표면 밖 패키지 계수 → limitation 조립.
 * 사실로 만들지 못한 근거는 모두 계수로 남긴다 — 빈 결과를 완전성의 증거로 읽지 않게 한다.
 */

import { basename, extname } from 'node:path';

import { ClientProvenance, PrismaModuleMatcher } from './client-provenance.ts';
import { ClientUsageScanner, type UsageCounts } from './client-usage.ts';
import { formatBreakdown, observeDbPackages, type PackageObservations } from './db-packages.ts';
import { ModuleResolver, isWithinDirectory } from './module-resolver.ts';
import type { PrismaCatalog } from './prisma-catalog.ts';
import { loadPrismaProject, type PrismaProject } from './prisma-project.ts';
import { ProjectReader } from './project-reader.ts';
import { toPosixRelative } from './project-files.ts';
import { type RelationUseFact, RelationFactSink } from './relation-facts.ts';
import { isSourceFileName, parseSourceModule, type SourceModule } from './source-module.ts';
import { SourceText } from './source-text.ts';
import { sqlRelations } from './sql-relations.ts';
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
  parseErrors: number;
}

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
    dynamicRelations: 0, skippedSqlLiterals: 0, unresolvedReceivers: 0, unknownDelegates: 0, parseErrors: 0,
  };
  const relational = isRelational(project.catalog);
  if (relational && project.catalog !== undefined) emitSchemaFacts(project.catalog, sink);
  const modules = parseModules(root, project, reader, counts);
  const resolver = new ModuleResolver(root, new Set(modules.map((module) => module.absolutePath)));
  const provenance = new ClientProvenance(modules, resolver, new PrismaModuleMatcher(project.outputDirectories, resolver));
  provenance.run();
  for (const module of modules) {
    const catalog = relational ? project.catalog : 'non-relational';
    new ClientUsageScanner(module, provenance.analyze(module), catalog, sink, counts).scan();
  }
  emitTypedSql(root, project.typedSqlFiles, reader, sink, counts);
  const facts = sink.sorted();
  const limitations = buildLimitations({
    project, counts, facts, sink, reader, packages: observeDbPackages(modules),
    unreadableConfigs: resolver.unreadableConfigs, provenanceTruncated: provenance.truncated, relational,
  });
  return { facts, limitations, sourceModifiedAt: reader.newestModifiedAt };
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
 * 그 컬럼 `A`·`B`.
 *
 * @param catalog 이름 표
 * @param sink 사실 수집기
 */
function emitSchemaFacts(catalog: PrismaCatalog, sink: RelationFactSink): void {
  for (const model of catalog.models) {
    const base = { path: model.file.path, text: model.file.text };
    sink.add({ ...base, channel: model.table.channel, dynamic: model.table.dynamic, offset: model.nameOffset, symbol: model.name });
    for (const column of model.columns) {
      sink.add({
        ...base, channel: model.table.channel, method: column.column, dynamic: false,
        offset: column.nameOffset, symbol: `${model.name}.${column.field}`,
      });
    }
  }
  for (const join of catalog.joinTables) {
    const base = { path: join.file.path, text: join.file.text, offset: join.nameOffset, symbol: join.symbol };
    sink.add({ ...base, channel: join.table.channel, dynamic: join.table.dynamic });
    if (join.table.dynamic) continue;
    for (const column of ['A', 'B']) sink.add({ ...base, channel: join.table.channel, method: column, dynamic: false });
  }
}

/**
 * 소스 파일을 읽고 파싱한다. generator 출력 디렉터리(생성된 클라이언트)는 분석 대상 코드가 아니다.
 *
 * @param root 프로젝트 realpath
 * @param project Prisma 입력
 * @param reader 파일 읽기 도우미
 * @param counts 계수(갱신된다)
 * @returns 소스 모듈(경로 순)
 */
function parseModules(root: string, project: PrismaProject, reader: ProjectReader, counts: ExtractionCounts): SourceModule[] {
  const modules: SourceModule[] = [];
  for (const [path, absolutePath] of project.walk.files) {
    if (!isSourceFileName(basename(path))) continue;
    if (project.outputDirectories.some((directory) => isWithinDirectory(absolutePath, directory))) continue;
    const text = reader.read(absolutePath)?.text;
    if (text === undefined) continue;
    const module = parseSourceModule(toPosixRelative(root, absolutePath), absolutePath, text);
    if (module.hasParseErrors) counts.parseErrors++;
    modules.push(module);
  }
  return modules;
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
    const symbol = `${path}#${basename(file, extname(file))}`;
    const result = sqlRelations(text);
    for (const relation of result.relations) {
      sink.add({ channel: relation.name, dynamic: false, path, text: source, offset: relation.keyword, symbol });
    }
    if (result.unresolved > 0) {
      counts.dynamicRelations += result.unresolved;
      sink.add({ channel: dynamicChannel(text), dynamic: true, path, text: source, offset: 0, symbol });
    }
  }
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
function sourceLimitations({ counts, facts, sink, packages, provenanceTruncated }: LimitationInput): string[] {
  const result: string[] = [];
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
    result.push(`missing-relation-symbols: ${missingSymbols} relation-use fact(s) have source locations but no enclosing declaration name`);
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
function inputLimitations({ project, counts, reader, unreadableConfigs }: LimitationInput): string[] {
  const { walk, location } = project;
  const result: string[] = [];
  if (reader.unreadable + walk.unreadableDirectories > 0) {
    result.push(`unreadable-sources: ${reader.unreadable} file(s) and ${walk.unreadableDirectories} directory entr(ies) could not be read and were skipped`);
  }
  if (reader.oversized > 0) {
    result.push(`oversized-sources: ${reader.oversized} file(s) larger than 4 MiB were skipped`);
  }
  if (counts.parseErrors > 0) {
    result.push(`parse-errors: ${counts.parseErrors} source file(s) could not be parsed completely`);
  }
  if (unreadableConfigs > 0) {
    result.push(`unreadable-module-configs: ${unreadableConfigs} tsconfig/jsconfig file(s) could not be parsed; imports under them use default resolution`);
  }
  const symlinks = walk.skippedSymlinks + location.skippedSymlinks;
  if (symlinks > 0) result.push(`skipped-symlinks: ${symlinks} symbolic link(s) were not followed`);
  if (walk.truncated) result.push('scan-truncated: the project tree exceeded the directory entry limit; later files were not scanned');
  return result;
}
