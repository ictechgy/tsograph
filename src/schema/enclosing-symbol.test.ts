import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { enclosingSymbol } from './enclosing-symbol.ts';

/**
 * 소스에서 `HERE` 식별자 위치의 심볼을 모두 구한다.
 *
 * @param source 소스 텍스트
 * @returns `HERE`마다의 심볼
 */
function symbolsAt(source: string): (string | undefined)[] {
  const file = ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
  const result: (string | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'HERE') result.push(enclosingSymbol(node, 'src/a.ts'));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

test('함수·메서드·생성자·접근자·필드·변수·객체 속성 이름을 바깥부터 잇는다', () => {
  assert.deepEqual(symbolsAt([
    'export function listJobs() { const rows = HERE; return rows.map(() => HERE); }',
    'export class Repo { constructor() { HERE; } get total() { return HERE; } field = HERE; static #p() { HERE; } }',
    'export const handler = async () => { const inner = () => HERE; };',
    'export const handlers = { GET: async () => HERE, async POST() { HERE; }, nested: { value: HERE } };',
    'export default function () { HERE; }',
    'export const eager = HERE;',
    'const wrapped = cache(async () => HERE);',
    'const Klass = class Named { m() { HERE; } };',
    'const anonymous = class { m() { HERE; } };',
    '',
  ].join('\n')), [
    'src/a.ts#listJobs',
    'src/a.ts#listJobs',
    'src/a.ts#Repo.constructor',
    'src/a.ts#Repo.total',
    'src/a.ts#Repo.field',
    'src/a.ts#Repo.#p',
    'src/a.ts#handler.inner',
    'src/a.ts#handlers.GET',
    'src/a.ts#handlers.POST',
    'src/a.ts#handlers',
    'src/a.ts#default',
    'src/a.ts#eager',
    'src/a.ts#wrapped',
    'src/a.ts#Klass.Named.m',
    'src/a.ts#anonymous.m',
  ]);
});

test('최상위 문장·계산된 이름은 심볼을 만들지 않는다', () => {
  assert.deepEqual(symbolsAt('HERE;\ndescribe("x", () => { HERE; });\nclass C { [key]() { HERE; } }\nconst o = { [k]: () => HERE };\n'), [
    undefined, undefined, undefined, undefined,
  ]);
});
