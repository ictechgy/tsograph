/**
 * Sequelize 6 이름 규칙이 쓰는 문자열 변환의 포트다.
 *
 * - `pluralize`·`singularize`·`underscore`: inflection 1.13.4(`lib/inflection.js`)의 `_apply_rules`·`underscore`.
 * - `camelize`: Sequelize `lib/utils.js`의 `camelize`(inflection의 camelize가 아니다).
 */

import { type InflectionRule, pluralRules, singularRules, uncountableWords } from './inflection-rules.ts';

/** 컴파일한 규칙이다. */
type CompiledRule = readonly [pattern: RegExp, replacement: string | undefined];

/**
 * 규칙 데이터를 정규식으로 만든다.
 *
 * @param rules 규칙 데이터
 * @returns 컴파일한 규칙
 */
function compile(rules: readonly InflectionRule[]): CompiledRule[] {
  return rules.map(([source, flags, replacement]) => [new RegExp(source, flags), replacement]);
}

/** 복수화 규칙이다. */
const plurals = compile(pluralRules);

/** 단수화 규칙이다. */
const singulars = compile(singularRules);

/** 단·복수가 같은 단어 집합이다. */
const uncountables: ReadonlySet<string> = new Set(uncountableWords);

/**
 * inflection `_apply_rules`다: 셀 수 없는 단어가 아니면 처음 일치한 규칙 하나를 적용한다.
 *
 * @param text 입력
 * @param rules 규칙
 * @returns 변환 결과
 */
function applyRules(text: string, rules: readonly CompiledRule[]): string {
  if (uncountables.has(text.toLowerCase())) return text;
  for (const [pattern, replacement] of rules) {
    if (text.match(pattern) === null) continue;
    return replacement === undefined ? text : text.replace(pattern, replacement);
  }
  return text;
}

/**
 * 명사를 복수형으로 바꾼다(inflection `pluralize`).
 *
 * @param text 명사
 * @returns 복수형
 */
export function pluralize(text: string): string {
  return applyRules(text, plurals);
}

/**
 * 명사를 단수형으로 바꾼다(inflection `singularize`).
 *
 * @param text 명사
 * @returns 단수형
 */
export function singularize(text: string): string {
  return applyRules(text, singulars);
}

/**
 * camelCase를 snake_case로 바꾼다(inflection `underscore`, `all_upper_case` 없이).
 *
 * @param text 입력
 * @returns snake_case
 */
export function underscore(text: string): string {
  return text.split('::').map((part) => part.replace(/([A-Z])/g, '_$1').replace(/^_/, '')).join('/').toLowerCase();
}

/**
 * Sequelize `camelize`다: 구분자(`-`·`_`·공백) 뒤 글자를 대문자로 올린다.
 *
 * @param text 입력
 * @returns camelCase
 */
export function camelize(text: string): string {
  return text.trim().replace(/[-_\s]+(.)?/g, (_match, next: string | undefined) => (next === undefined ? '' : next.toUpperCase()));
}
