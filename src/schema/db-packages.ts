/**
 * 지원 표면 밖 DB 패키지(다른 ORM·raw 드라이버·비관계 저장소)의 사용을 파일 수로 센다.
 *
 * 이 패키지들의 쿼리는 사실로 만들지 않는다 — API마다 테이블 이름 규칙이 달라 추측하면 거짓
 * 진단이 된다. 대신 "관측했지만 읽지 않은" 범위를 limitation으로 드러낸다. 게이트 없는 대문자
 * SQL 리터럴은 패키지와 무관하게 따로 읽힌다.
 */

import ts from 'typescript';

import { compareStrings } from '../exchange/sorted-json.ts';
import type { SourceModule } from './source-module.ts';

/** 관계형이지만 지원 표면 밖인 패키지다(가져오기 이름의 패키지 부분). */
const unsupportedSqlPackages: ReadonlySet<string> = new Set([
  'typeorm', 'sequelize', 'sequelize-typescript', 'drizzle-orm', 'knex', 'kysely', 'objection', 'pg', 'pg-promise',
  'postgres', 'mysql', 'mysql2', 'better-sqlite3', 'sqlite3', 'sqlite', '@libsql/client', '@neondatabase/serverless',
  '@vercel/postgres', '@planetscale/database', 'mssql', 'tedious', 'oracledb', '@mikro-orm/core', 'slonik',
]);

/** 비관계 저장소 패키지다. */
const nonRelationalPackages: ReadonlySet<string> = new Set([
  'mongoose', 'mongodb', '@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'firebase-admin', 'firebase',
  'redis', 'ioredis', '@upstash/redis',
]);

/** Cloudflare D1 바인딩 타입 이름이다. 패키지 import 없이 전역 타입으로 쓰인다. */
const d1TypeName = 'D1Database';

/** 패키지별 관측 파일 수다. */
export interface PackageObservations {
  /** 지원 표면 밖 SQL 패키지 → 파일 수(D1은 `d1`)다. */
  readonly unsupported: ReadonlyMap<string, number>;
  /** 비관계 저장소 패키지 → 파일 수다. */
  readonly nonRelational: ReadonlyMap<string, number>;
  /** 지원 표면 밖 SQL 패키지를 하나라도 쓴 파일 수다. */
  readonly unsupportedFiles: number;
  /** 비관계 저장소 패키지를 하나라도 쓴 파일 수다. */
  readonly nonRelationalFiles: number;
}

/**
 * 모듈들의 import·require·D1 타입 참조를 센다.
 *
 * @param modules 소스 모듈
 * @returns 관측 계수
 */
export function observeDbPackages(modules: readonly SourceModule[]): PackageObservations {
  const unsupported = new Map<string, number>();
  const nonRelational = new Map<string, number>();
  let unsupportedFiles = 0;
  let nonRelationalFiles = 0;
  for (const module of modules) {
    const packages = modulePackages(module);
    const sql = [...packages].filter((name) => unsupportedSqlPackages.has(name));
    if (usesD1(module)) sql.push('d1');
    const stores = [...packages].filter((name) => nonRelationalPackages.has(name));
    if (sql.length > 0) unsupportedFiles++;
    if (stores.length > 0) nonRelationalFiles++;
    for (const name of sql) unsupported.set(name, (unsupported.get(name) ?? 0) + 1);
    for (const name of stores) nonRelational.set(name, (nonRelational.get(name) ?? 0) + 1);
  }
  return { unsupported, nonRelational, unsupportedFiles, nonRelationalFiles };
}

/**
 * 계수를 `이름 (수), …` 문장으로 바꾼다(이름 순).
 *
 * @param counts 이름 → 수
 * @returns 문장
 */
export function formatBreakdown(counts: ReadonlyMap<string, number>): string {
  return [...counts.keys()].sort(compareStrings).map((name) => `${name} (${counts.get(name)})`).join(', ');
}

/**
 * 모듈이 가져오는 패키지 이름 집합(import·re-export·`require`·동적 import)이다.
 *
 * @param module 소스 모듈
 * @returns 패키지 이름 집합
 */
function modulePackages(module: SourceModule): Set<string> {
  const specifiers = module.imports.map((binding) => binding.specifier);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && isModuleLoad(node) && node.arguments[0] !== undefined
      && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return new Set(specifiers.map(packageName).filter((name): name is string => name !== undefined));
}

/**
 * 호출이 `require(…)`·`import(…)`인지 본다.
 *
 * @param call 호출 식
 * @returns 모듈 로드면 true
 */
function isModuleLoad(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(call.expression) && call.expression.text === 'require');
}

/**
 * 지정자의 패키지 부분이다(`@scope/name/sub` → `@scope/name`, `name/sub` → `name`).
 *
 * @param specifier import 지정자
 * @returns 패키지 이름. 상대 경로·내장 모듈이면 undefined
 */
export function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * 모듈이 D1 바인딩 타입을 참조하는지 본다.
 *
 * @param module 소스 모듈
 * @returns 참조하면 true
 */
function usesD1(module: SourceModule): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === d1TypeName) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return found;
}
