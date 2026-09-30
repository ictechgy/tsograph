import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { enclosingSymbol } from './enclosing-symbol.ts';
import { isInlineCallback } from './inline-callback.ts';

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
    'src/a.ts#listJobs.rows.map()',
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
    'src/a.ts#wrapped.cache()',
    'src/a.ts#Klass.Named.m',
    'src/a.ts#anonymous.m',
  ]);
});

test('export default 식 안은 default이고 export = 식은 이름이 없다', () => {
  assert.deepEqual(symbolsAt('export default { list: HERE };\nexport default wrap(async () => HERE);\n'), ['src/a.ts#default', 'src/a.ts#default.wrap()']);
  assert.deepEqual(symbolsAt('export = { v: HERE };\nexport = wrap(() => HERE);\n'), [undefined, 'src/a.ts#<module>.wrap()']);
});

test('최상위 문장·계산된 이름은 심볼을 만들지 않는다(그 안의 인라인 콜백도)', () => {
  assert.deepEqual(symbolsAt('HERE;\nclass C { [key]() { HERE; run(() => HERE); } }\nconst o = { [k]: () => HERE };\n'), [
    undefined, undefined, undefined, undefined,
  ]);
});

test('호출 인자로 넘긴 인라인 콜백은 <호출 대상>(<키 인자>) 조각을 갖는다', () => {
  assert.deepEqual(symbolsAt([
    "app.get('/x', async (c) => HERE);",
    "app.get('/x', asyncHandler(async (req, res) => HERE));",
    "describe('suite', () => { it(`works`, () => HERE); });",
    "router.on('GET', '/y', 'extra', function (req) { HERE; });",
    "books.get(PATHS.list, (c) => HERE);",
    'books.get(`${BOOKS}/:id/${ids[0]}`, (c) => HERE);',
    "books.on(['PUT', 'PATCH'], `/b`, (c) => HERE);",
    "books.on([verb()], (c) => HERE);",
    "new Hono().get('/a', (c) => HERE).post('/b', (c) => HERE);",
    "this.router['post']((c) => HERE);",
    'new Promise((resolve) => HERE);',
    '(app as any).use((c) => HERE);',
    'factory()((c) => HERE);',
    "super.on('x', () => HERE);",
    '',
  ].join('\n')), [
    'src/a.ts#<module>.app.get("/x")',
    'src/a.ts#<module>.app.get("/x")~2',
    'src/a.ts#<module>.describe("suite").it("works")',
    'src/a.ts#<module>.router.on("GET","/y")',
    'src/a.ts#<module>.books.get(PATHS.list)',
    'src/a.ts#<module>.books.get("${BOOKS}/:id/${…}")',
    'src/a.ts#<module>.books.on(["PUT","PATCH"],"/b")',
    'src/a.ts#<module>.books.on()',
    'src/a.ts#<module>.….get("/a")',
    'src/a.ts#<module>.….post("/b")',
    'src/a.ts#<module>.this.router["post"]()',
    'src/a.ts#<module>.new Promise()',
    'src/a.ts#<module>.app.use()',
    'src/a.ts#<module>.…()',
    'src/a.ts#<module>.super.on("x")',
  ]);
});

test('콜백의 앞 이름은 콜백 식이 속한 스코프이고, 겹치면 소스 순서로 ~n을 붙인다', () => {
  assert.deepEqual(symbolsAt([
    'export async function load(ids) {',
    '  const rows = await Promise.all(ids.map(async (id) => HERE));',
    '  useEffect(() => HERE); useEffect(() => HERE);',
    "  app.get('/m', (c, next) => HERE, (c) => { const inner = () => HERE; return inner(); });",
    '}',
    'export function other() { useEffect(() => HERE); }',
    '',
  ].join('\n')), [
    'src/a.ts#load.Promise.all()',
    'src/a.ts#load.useEffect()',
    'src/a.ts#load.useEffect()~2',
    'src/a.ts#load.app.get("/m")',
    'src/a.ts#load.app.get("/m")~2.inner',
    'src/a.ts#other.useEffect()',
  ]);
});

test('키 리터럴은 64자에서 자르고 계약 금지 문자를 이스케이프한다', () => {
  const long = 'q'.repeat(63) + '\u{1F600}';
  assert.deepEqual(symbolsAt(`run('${long}', () => HERE);\nrun('a\\u0085b\\u2028c\\n', () => HERE);\n`), [
    `src/a.ts#<module>.run("${'q'.repeat(63)}…")`,
    'src/a.ts#<module>.run("a\\u0085b\\u2028c\\n")',
  ]);
});

test('인라인 콜백 여부: 인자 자리의 화살표·함수 식만이다', () => {
  const file = ts.createSourceFile('a.ts', 'f(() => 1, (function () {}) as any); const g = () => 2; (() => 3)(); [() => 4];\n', ts.ScriptTarget.Latest, true);
  const found: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) found.push(isInlineCallback(node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(found, [true, true, false, false, false]);
});

/**
 * 소스의 `HERE`마다 심볼을 구하되 뒤에서부터 묻는다(파일별 순번 표가 묻는 순서와 무관한지 본다).
 *
 * @param source 소스 텍스트
 * @returns 소스 순서의 심볼
 */
function symbolsAskedBackwards(source: string): (string | undefined)[] {
  const file = ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'HERE') nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return nodes.reverse().map((node) => enclosingSymbol(node, 'src/a.ts')).reverse();
}

test('인라인 콜백 id는 묻는 순서와 무관하고, 무관한 수정(선언 추가·다른 키 콜백·다른 스코프·줄 이동)에 그대로다', () => {
  const base = [
    "app.get('/a', (c) => HERE);",
    "app.get('/a', (c) => HERE);",
    'export function f() { items.map((item) => HERE); }',
    '',
  ].join('\n');
  const edited = [
    '// 머리 주석과 빈 줄',
    '',
    'export function added() { app.get("/a", () => 0); useEffect(() => 1); }',
    "app.post('/a', (c) => 0);",
    "app.get('/a', (c) => HERE);",
    "app.get('/b', (c) => 0);",
    "app.get('/a',",
    '  (c) => HERE);',
    'export function f() { other.map(() => 0); items.map((item) => HERE); }',
    '',
  ].join('\n');
  const expected = ['src/a.ts#<module>.app.get("/a")', 'src/a.ts#<module>.app.get("/a")~2', 'src/a.ts#f.items.map()'];
  assert.deepEqual(symbolsAt(base), expected);
  assert.deepEqual(symbolsAskedBackwards(base), expected);
  assert.deepEqual(symbolsAt(edited), expected);
});
