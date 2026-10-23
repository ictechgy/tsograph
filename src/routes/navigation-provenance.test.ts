import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { extractNavigationRoutes, type RouterModels } from './navigation-routes.ts';

const model: RouterModels = { format: 'router-models', version: 1, models: [{
  factory: { path: 'src/register.ts', name: 'registerRoutes' }, routesArgument: 0,
  pathProperty: 'path', screenProperty: 'screen', childrenProperty: 'children', pathSyntax: 'colon',
}] };

/** owned·external 소스 모두 합성으로 만들며 함수·loader를 실행하지 않는다. */
function fixture(files: Record<string, string>, run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-navigation-proof-')));
  try {
    for (const [path, source] of Object.entries({
      'tsconfig.json': '{"compilerOptions":{"types":[],"noLib":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}',
      'src/register.ts': 'export function registerRoutes(input: unknown) {return input;}',
      'src/Screen.ts': 'export function Screen(){return null;}', ...files,
    })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); }
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('owned default·re-export·const alias의 공유 배열은 literal 후보를 복원하되 dynamic이다', () => {
  fixture({
    'src/table.ts': "import {Screen} from './Screen'; const table=[{path:'/catalog',screen:Screen,children:[{path:':id',screen:Screen}]}]; export default table;",
    'src/barrel.ts': "export {default as importedTable} from './table'; export {registerRoutes as register} from './register';",
    'src/main.ts': "import {importedTable,register} from './barrel'; const alias=importedTable; const make=register; make(alias);",
  }, root => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map(f => [f.urlTemplate, f.dynamic, f.screen?.usr]), [
      ['/catalog', true, 'src/Screen.ts#Screen'], ['/catalog/{}', true, 'src/Screen.ts#Screen'],
    ]);
    assert.ok(doc.limitations.some(l => l.includes('external consumers') && l.includes('not an immutability proof')));
  });
});

test('alias·re-export 경유 push·element write·unknown escape는 공유 후보를 확정하지 않는다', () => {
  for (const mutation of ["alias.push({path:'/extra',screen:Screen});", "alias[0].path='/changed';", 'opaque(alias);', 'registerRoutes([],alias);']) {
    fixture({
      'src/table.ts': "import {Screen} from './Screen'; export const table=[{path:'/catalog',screen:Screen}];",
      'src/barrel.ts': "export {table as reexported} from './table';",
      'src/main.ts': `import {registerRoutes} from './register'; import {Screen} from './Screen'; import {reexported} from './barrel'; const alias=reexported; declare function opaque(x:unknown):void; ${mutation} registerRoutes(reexported);`,
    }, root => {
      const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
      assert.ok(doc.facts.every(f => f.dynamic && f.urlTemplate === null), mutation);
      assert.ok(doc.limitations.some(l => /mutated route container|unproven route container/u.test(l)), mutation);
    });
  }
});

test('무인자 owned factory의 단일 fresh literal 반환은 실행 없이 읽고 shared-return·effect는 보류한다', () => {
  for (const returned of [
    'export function make(){return [{path:"/fresh",screen:Screen}];}',
    'export const make=()=>[{path:"/fresh",screen:Screen}];',
    'export default function make(){return [{path:"/fresh",screen:Screen}];}',
  ]) fixture({
    'src/factory.ts': `import {Screen} from './Screen'; ${returned}`,
    'src/main.ts': `import {registerRoutes} from './register'; import ${returned.includes('default') ? 'make' : '{make}'} from './factory'; const alias=make; registerRoutes(alias());`,
  }, root => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map(f => [f.urlTemplate, f.dynamic]), [['/fresh', false]]);
    assert.ok(doc.limitations.some(l => l.includes('fresh literal array') && l.includes('execution')));
  });
  for (const body of [
    'const table=[{path:"/shared",screen:Screen}]; export function make(){return table;}',
    'export function make(){opaque();return [{path:"/effect",screen:Screen}];}',
    'export function make(){return [{path:"/effect",screen:Screen,meta:opaque()}];}',
    'export function make(){return unknownFactory();}',
    'export function make(){return make();}',
    'export function make(){const routes=[{path:"/escaped",screen:Screen}]; opaque(routes);return routes;}',
    'export function make(){return [{path:"/recursive",screen:Screen,children:make()}];}',
    'export async function make(){return [{path:"/async",screen:Screen}];}',
    'export function make(x=opaque()){return [{path:"/default",screen:Screen}];}',
  ]) fixture({
    'src/factory.ts': `import {Screen} from './Screen'; declare function opaque():unknown; declare function unknownFactory():unknown[]; ${body}`,
    'src/main.ts': "import {registerRoutes} from './register'; import {make} from './factory'; registerRoutes(make());",
  }, root => assert.deepEqual(extractNavigationRoutes(root, model, 'test', new Date(0)).facts.map(f => [f.urlTemplate, f.dynamic]), [[null, true]], body));
});

test('freeze 이름·shallow freeze·freeze 교체·외부 dependency는 불변성 증명이 아니다', () => {
  for (const body of [
    "export const table=Object.freeze([{path:'/shallow',screen:Screen,children:[]}]);",
    "export const table=Object.freeze([{path:'/shallow',screen:Screen,children:[]}]); table[0].path='/changed';",
    "export const table=Object.freeze([{path:'/shallow',screen:Screen,children:[]}]); table[0].children.push({path:'child',screen:Screen});",
    "const Object={freeze:(x:unknown)=>[]}; export const table=Object.freeze([{path:'/shadow',screen:Screen}]);",
    "Object.freeze=(x:unknown)=>x; export const table=Object.freeze([{path:'/replaced',screen:Screen}]);",
  ]) fixture({
    'src/table.ts': `import {Screen} from './Screen'; ${body}`,
    'src/main.ts': "import {registerRoutes} from './register'; import {table} from './table'; registerRoutes(table);",
  }, root => assert.deepEqual(extractNavigationRoutes(root, model, 'test', new Date(0)).facts.map(f => [f.urlTemplate, f.dynamic]), [[null, true]]));
  fixture({
    'node_modules/external/package.json': '{"name":"external","main":"index.js","types":"index.ts"}',
    'node_modules/external/index.ts': 'export function make(){throw new Error("not executed"); return [{path:"/external",screen:()=>null}];}',
    'src/main.ts': "import {registerRoutes} from './register'; import {make} from 'external'; registerRoutes(make());",
  }, root => assert.deepEqual(extractNavigationRoutes(root, model, 'test', new Date(0)).facts.map(f => [f.urlTemplate, f.dynamic]), [[null, true]]));
});

test('entry에서 제외된 mutation은 unknown으로 남고 import 폐쇄에 들어오면 실제 write를 반영한다', () => {
  for (const imported of [false, true]) fixture({
    'tsconfig.json': '{"compilerOptions":{"types":[],"noLib":true},"include":["src"],"exclude":["src/omitted.ts"]}',
    'src/table.ts': "import {Screen} from './Screen'; export default [{path:'/candidate',screen:Screen}];",
    'src/omitted.ts': "import table from './table'; table[0].path='/changed';",
    'src/main.ts': `${imported ? "import './omitted';" : ''} import {registerRoutes} from './register'; import table from './table'; registerRoutes(table);`,
  }, root => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map(f => [f.urlTemplate, f.dynamic]), [[imported ? null : '/candidate', true]]);
    assert.ok(doc.limitations.some(l => l.includes('source-scope:')));
    if (!imported) assert.ok(doc.limitations.some(l => l.includes('omitted sources are not assessed')));
  });
});

test('factory 재대입·추가 인자·순환 alias·객체 접근·전개는 fresh proof를 만들지 않는다', () => {
  for (const [factory, call] of [
    ['export function make(){return [{path:"/x",screen:Screen}];} make=()=>[];', 'make()'],
    ['export function make(){return [{path:"/x",screen:Screen}];}', 'make(1)'],
    ['export const make=again; const again=make;', 'make()'],
    ['export const make=()=>[{path:"/x",screen:Screen,meta:holder.value}];', 'make()'],
    ['export const make=()=>[...unknownRoutes];', 'make()'],
    ['export function* make(){yield [{path:"/x",screen:Screen}];}', 'make()'],
  ]) fixture({
    'src/factory.ts': `import {Screen} from './Screen'; declare const holder:any,unknownRoutes:any[]; ${factory}`,
    'src/main.ts': `import {registerRoutes} from './register'; import {make} from './factory'; registerRoutes(${call});`,
  }, root => assert.deepEqual(extractNavigationRoutes(root, model, 'test', new Date(0)).facts.map(f => [f.urlTemplate, f.dynamic]), [[null, true]], factory));
});
