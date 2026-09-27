/**
 * 잠금 파일에서 Prisma 패키지 버전을 읽어 적용할 이름 규칙 후보를 정한다.
 *
 * 규칙은 Prisma 공식 소스에서 확인한 범위만 인정한다(README "Prisma naming rules"):
 *
 * - `prisma`·`@prisma/client` 2.x–7.x: 테이블 = `@@map` 값, 없으면 모델 이름 그대로
 *   (prisma-engines `psl/parser-database/src/walkers/model.rs` `database_name()`).
 * - `@prisma/orm-family-sql` 8.0.0-rc.1–rc.11: `@@map`이 없으면 모델 이름의 첫 글자를 소문자로
 *   (`lowerFirst(model.name)`).
 * - `@prisma/orm-family-sql` 8.0.0-rc.12: 모델 이름 그대로(`defaultTableName`), 암시적 다대다 없음.
 *
 * 8.x의 `prisma` 패키지는 다른 제품(CLI)이라 이름 규칙의 근거가 아니다. 확인하지 않은 버전이나
 * 규칙이 둘 이상 섞이면 후보 전체로 평가해 결과가 갈리는 이름만 dynamic으로 낸다.
 */

import { compareStrings } from '../exchange/sorted-json.ts';

/** 확인된 이름 규칙이다. */
export type NamingRuleId = 'prisma-7' | 'prisma-8-lower-first' | 'prisma-8-verbatim';

/** 모든 규칙이다. 버전을 모를 때의 후보 집합이다. */
export const ALL_NAMING_RULES: readonly NamingRuleId[] = ['prisma-7', 'prisma-8-lower-first', 'prisma-8-verbatim'];

/** 이름 규칙을 정하는 패키지다. */
const trackedPackages = ['prisma', '@prisma/client', '@prisma/orm-family-sql'] as const;

/** 추적 패키지 이름이다. */
export type TrackedPackage = (typeof trackedPackages)[number];

/** 관찰한 패키지 버전 하나다. */
export interface ObservedVersion {
  readonly packageName: TrackedPackage;
  readonly version: string;
  /** 근거 파일(프로젝트 기준 경로)이다. */
  readonly source: string;
}

/** 이름 규칙 판정 결과다. */
export interface NamingDecision {
  /** 평가할 규칙 후보다. 하나면 확정, 둘 이상이면 갈리는 이름을 dynamic으로 낸다. */
  readonly rules: readonly NamingRuleId[];
  /** 확정하지 못한 이유다. 확정이면 undefined다. */
  readonly unverifiedReason: string | undefined;
  /** 관찰한 버전이다(정렬됨). */
  readonly observed: readonly ObservedVersion[];
}

/** 파싱한 semver다. prerelease 식별자는 문자열 배열이다. */
interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/**
 * 관찰한 버전으로 이름 규칙 후보를 정한다.
 *
 * @param observed 관찰한 버전(잠금 파일 우선, 없으면 package.json 명세에서 얻은 값)
 * @returns 판정 결과
 */
export function decideNamingRules(observed: readonly ObservedVersion[]): NamingDecision {
  const sorted = [...observed].sort(compareObserved);
  if (sorted.length === 0) {
    return { rules: ALL_NAMING_RULES, unverifiedReason: 'no Prisma package version was found in a lockfile or package.json', observed: sorted };
  }
  const rules = new Set<NamingRuleId>();
  const unknown: string[] = [];
  for (const entry of sorted) {
    const rule = ruleForVersion(entry.packageName, entry.version);
    if (rule === 'unknown') unknown.push(`${entry.packageName}@${entry.version}`);
    else if (rule !== 'ignored') rules.add(rule);
  }
  if (unknown.length > 0) {
    return { rules: ALL_NAMING_RULES, unverifiedReason: `unverified Prisma version(s): ${unique(unknown).join(', ')}`, observed: sorted };
  }
  if (rules.size === 0) {
    return { rules: ALL_NAMING_RULES, unverifiedReason: 'no Prisma ORM package version was found', observed: sorted };
  }
  const list = ALL_NAMING_RULES.filter((rule) => rules.has(rule));
  const reason = list.length > 1 ? `Prisma packages with different naming rules are installed: ${list.join(', ')}` : undefined;
  return { rules: list, unverifiedReason: reason, observed: sorted };
}

/**
 * 패키지 버전 하나가 가리키는 규칙이다.
 *
 * @param packageName 패키지 이름
 * @param version 버전 문자열
 * @returns 규칙, 무관('ignored'), 또는 확인하지 않은 버전('unknown')
 */
export function ruleForVersion(packageName: TrackedPackage, version: string): NamingRuleId | 'ignored' | 'unknown' {
  const parsed = parseVersion(version);
  if (parsed === undefined) return 'unknown';
  if (packageName === '@prisma/orm-family-sql') return familySqlRule(parsed);
  if (parsed.major >= 2 && parsed.major <= 7) return 'prisma-7';
  // 8.x `prisma`는 ORM이 아니라 별도 CLI 제품이라 이름 규칙의 근거가 아니다.
  if (packageName === 'prisma' && parsed.major >= 8) return 'ignored';
  return 'unknown';
}

/**
 * `@prisma/orm-family-sql` 버전의 규칙이다. 소스로 확인한 rc.1–rc.12만 인정한다.
 *
 * @param version 파싱한 버전
 * @returns 규칙 또는 'unknown'
 */
function familySqlRule(version: SemanticVersion): NamingRuleId | 'unknown' {
  const [label, number, ...rest] = version.prerelease;
  const isRc8 = version.major === 8 && version.minor === 0 && version.patch === 0 && label === 'rc' && rest.length === 0;
  const candidate = number === undefined ? Number.NaN : Number(number);
  if (!isRc8 || !Number.isInteger(candidate)) return 'unknown';
  if (candidate >= 1 && candidate <= 11) return 'prisma-8-lower-first';
  if (candidate === 12) return 'prisma-8-verbatim';
  return 'unknown';
}

/**
 * semver 문자열을 파싱한다. 빌드 메타데이터는 버린다.
 *
 * @param version 버전 문자열
 * @returns 파싱 결과. 모양이 다르면 undefined
 */
export function parseVersion(version: string): SemanticVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * package.json 의존성 명세에서 버전을 뽑는다. 정확한 버전과 `^`·`~` 범위만 읽는다 — 그 밖의
 * 범위는 설치될 버전을 정적으로 정할 수 없다.
 *
 * @param specifier 의존성 명세
 * @returns 대표 버전 또는 undefined
 */
export function versionFromSpecifier(specifier: string): string | undefined {
  const match = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(specifier.trim());
  if (match === null) return undefined;
  const version = match[1]!;
  // `^8.0.0-rc.3`처럼 prerelease에 범위 연산자가 붙으면 다른 rc로 풀릴 수 있다.
  if (specifier.trim() !== version && version.includes('-')) return undefined;
  return version;
}

/**
 * 잠금 파일 텍스트에서 추적 패키지 버전을 뽑는다.
 *
 * @param fileName 잠금 파일 이름
 * @param text 파일 텍스트
 * @returns 패키지 이름과 버전 목록
 */
export function versionsFromLockfile(fileName: string, text: string): { packageName: TrackedPackage; version: string }[] {
  switch (fileName) {
    case 'pnpm-lock.yaml': return pnpmVersions(text);
    case 'package-lock.json':
    case 'npm-shrinkwrap.json': return npmVersions(text);
    case 'yarn.lock': return yarnVersions(text);
    case 'bun.lock': return bunVersions(text);
    default: return [];
  }
}

/** 이름 규칙 근거로 읽는 잠금 파일 이름이다. */
export const LOCKFILE_NAMES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock'];

/**
 * pnpm 잠금 파일(v5 `/name/1.0.0`, v6+ `name@1.0.0`, 피어 접미사 포함)의 패키지 키를 읽는다.
 *
 * @param text 파일 텍스트
 * @returns 버전 목록
 */
function pnpmVersions(text: string): { packageName: TrackedPackage; version: string }[] {
  const pattern = /^ {2}'?\/?(@prisma\/client|@prisma\/orm-family-sql|prisma)[@/](\d+\.\d+\.\d+[^\s'():_]*)/gmu;
  return [...text.matchAll(pattern)].map((match) => ({ packageName: match[1] as TrackedPackage, version: match[2]! }));
}

/**
 * npm 잠금 파일(v1 `dependencies`, v2+ `packages`)의 버전을 읽는다.
 *
 * @param text 파일 텍스트
 * @returns 버전 목록. JSON이 아니면 빈 목록
 */
function npmVersions(text: string): { packageName: TrackedPackage; version: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 잠금 파일은 근거가 아니다. 호출자는 버전 없음으로 보고 limitation을 낸다.
    return [];
  }
  const result: { packageName: TrackedPackage; version: string }[] = [];
  const document = isRecord(parsed) ? parsed : {};
  for (const [key, entry] of Object.entries(isRecord(document.packages) ? document.packages : {})) {
    const name = trackedPackages.find((candidate) => key === `node_modules/${candidate}` || key.endsWith(`/node_modules/${candidate}`));
    if (name !== undefined && isRecord(entry) && typeof entry.version === 'string') result.push({ packageName: name, version: entry.version });
  }
  const dependencies = isRecord(document.dependencies) ? document.dependencies : {};
  for (const name of trackedPackages) {
    const entry = dependencies[name];
    if (isRecord(entry) && typeof entry.version === 'string') result.push({ packageName: name, version: entry.version });
  }
  return result;
}

/**
 * yarn 잠금 파일(classic `version "x"`, berry `version: x`)의 버전을 읽는다.
 *
 * @param text 파일 텍스트
 * @returns 버전 목록
 */
function yarnVersions(text: string): { packageName: TrackedPackage; version: string }[] {
  const result: { packageName: TrackedPackage; version: string }[] = [];
  let current: TrackedPackage | undefined;
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
      current = yarnEntryPackage(line);
      continue;
    }
    const version = /^ {2}version:? "?([^"\s]+)"?/u.exec(line);
    if (current !== undefined && version !== null) {
      result.push({ packageName: current, version: version[1]! });
      current = undefined;
    }
  }
  return result;
}

/**
 * yarn 항목 머리 줄이 추적 패키지인지 본다(`prisma@^7`, `"@prisma/client@npm:^7":`).
 *
 * @param line 머리 줄
 * @returns 패키지 이름 또는 undefined
 */
function yarnEntryPackage(line: string): TrackedPackage | undefined {
  const first = line.replace(/^"/u, '').split(/,\s*/u)[0] ?? '';
  return trackedPackages.find((name) => first.startsWith(`${name}@`));
}

/**
 * bun 텍스트 잠금 파일의 `"name": ["name@1.0.0", …]` 항목을 읽는다.
 *
 * @param text 파일 텍스트
 * @returns 버전 목록
 */
function bunVersions(text: string): { packageName: TrackedPackage; version: string }[] {
  const pattern = /\["(@prisma\/client|@prisma\/orm-family-sql|prisma)@(\d+\.\d+\.\d+[^"]*)"/gu;
  return [...text.matchAll(pattern)].map((match) => ({ packageName: match[1] as TrackedPackage, version: match[2]! }));
}

/**
 * JSON 객체인지 본다.
 *
 * @param value 값
 * @returns 객체면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 관찰 버전의 결정적 순서다.
 *
 * @param left 왼쪽
 * @param right 오른쪽
 * @returns 비교 결과
 */
function compareObserved(left: ObservedVersion, right: ObservedVersion): number {
  return compareStrings(left.packageName, right.packageName)
    || compareStrings(left.version, right.version)
    || compareStrings(left.source, right.source);
}

/**
 * 중복을 없애고 정렬한다.
 *
 * @param values 문자열 목록
 * @returns 정렬된 고유 목록
 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}
