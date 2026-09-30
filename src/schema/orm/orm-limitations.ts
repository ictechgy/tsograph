/**
 * ORM·드라이버 표면의 limitation 문장이다. 접두사는 계약이라 바꾸지 않는다(README 목록).
 */

import { formatBreakdown } from '../db-packages.ts';
import type { OrmCounts } from './orm-facts.ts';

/**
 * ORM 계수를 limitation 문장으로 바꾼다(고정 순서).
 *
 * @param counts ORM 계수
 * @returns limitation 목록
 */
export function ormLimitations(counts: OrmCounts): string[] {
  const result: string[] = [];
  const unresolved = total(counts.unresolvedReceivers);
  if (unresolved > 0) {
    result.push(`unresolved-orm-receivers: ${unresolved} ORM call(s) have a query shape but receivers that could not be traced to a model, repository, or client; not emitted: ${formatBreakdown(counts.unresolvedReceivers)}`);
  }
  if (counts.namingUnverified.size > 0) {
    result.push(`orm-naming-unverified: ${[...counts.namingUnverified].sort().join('; ')}`);
  }
  const unreadable = total(counts.unreadableDeclarations);
  if (unreadable > 0) {
    result.push(`unreadable-orm-declarations: ${unreadable} ORM declaration part(s) (spreads, computed keys, non-literal names or options) could not be read statically and were not emitted: ${formatBreakdown(counts.unreadableDeclarations)}`);
  }
  return result;
}

/**
 * 표면별 계수의 합이다.
 *
 * @param counts 표면 → 수
 * @returns 합
 */
function total(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const value of counts.values()) sum += value;
  return sum;
}
