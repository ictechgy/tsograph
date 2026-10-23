import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { createGraphPrograms } from './program.ts';
import { extractClientRoutes } from '../routes/client/client-routes.ts';
import { parseTypedClientModels } from '../routes/client/typed-client-model.ts';
import { extractNavigationRoutes, parseRouterModels } from '../routes/navigation-routes.ts';
import { extractPersistenceFacts } from '../schema/extract.ts';
import { analyzeChange } from '../change/impact.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { loadNodeProjects } from '../routes/node/node-project.ts';

/** 서로 독립적인 합성 앱만 작성하고 실행하지 않는다. */
async function fixture(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-package-config-')));
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    await body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const config = (options: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  compilerOptions: { noLib: true, types: [], ...options }, ...extra,
});

const apps = {
  'tsconfig.json': config({ baseUrl: './app-a/src' }),
  'app-a/tsconfig.json': config({ baseUrl: './src' }),
  'app-b/tsconfig.json': config({ baseUrl: './src' }),
  'app-a/src/components/Button.ts': 'export function Button(){ return "A"; }',
  'app-b/src/components/Button.ts': 'export function Button(){ return "B"; }',
  'app-a/src/page.ts': 'import {Button} from "components/Button"; export function PageA(){ return Button(); }',
  'app-b/src/page.ts': 'import {Button} from "components/Button"; export function PageB(){ return Button(); }',
};

test('패키지별 baseUrl은 각 앱의 선언에 연결하며 선택 프로젝트 순서에 독립적이다', async () => {
  await fixture(apps, async (root) => {
    for (const selected of [root, join(root, 'app-a'), join(root, 'app-b')]) {
      const graph = await buildCallGraph(selected, createNodeFileSystem(), selected === root ? {} : { workspace: root });
      for (const [app, name] of [['app-a', 'PageA'], ['app-b', 'PageB']]) {
        const calls = graph.edges.filter(edge => edge.from === `${app}/src/page.ts#${name}` && edge.kinds.includes('call'));
        assert.deepEqual(calls.map(edge => edge.to), [`${app}/src/components/Button.ts#Button`]);
      }
      assert.ok(!graph.limitations.some(line => line.includes('config-conflict:')));
    }
  });
});

test('다른 패키지의 반환 타입에 쓰인 내부 alias도 제공 패키지 설정으로 해석한다', async () => {
  await fixture({
    ...apps,
    'app-a/src/types/Value.ts': 'export class Value { wrong(){} }',
    'app-b/src/types/Value.ts': 'export class Value { run(){} }',
    'app-b/src/api.ts': 'import {Value} from "types/Value"; export function make():Value{return new Value();}',
    'app-a/src/cross.ts': 'import {make} from "../../app-b/src/api"; export function cross(){make().run();}',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some(edge => edge.from === 'app-a/src/cross.ts#cross' && edge.to === 'app-b/src/types/Value.ts#Value.run'));
    assert.ok(!graph.edges.some(edge => edge.from === 'app-a/src/cross.ts#cross' && edge.to.startsWith('app-a/src/types/')));
  });
});

test('타입 의미가 다른 패키지는 독립적으로 분석하고 검증하지 못한 경계 호출을 확정하지 않는다', async () => {
  await fixture({
    ...apps,
    'app-b/tsconfig.json': config({ baseUrl: './src', strictNullChecks: true }),
    'app-b/src/api.ts': 'import {Button} from "components/Button"; export function make(){return Math.random() ? {run:Button} : undefined;}',
    'app-a/src/cross.ts': 'import {make} from "../../app-b/src/api"; export function cross(){make().run();}',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some(edge => edge.from === 'app-b/src/page.ts#PageB' && edge.to === 'app-b/src/components/Button.ts#Button'));
    assert.ok(!graph.edges.some(edge => edge.from === 'app-a/src/cross.ts#cross' && edge.to === 'app-b/src/components/Button.ts#Button'));
    assert.ok(graph.limitations.some(line => line.includes('config-context-boundary:')));
  });
});

test('문맥 분리 기준은 strict뿐 아니라 emit 의미와 lib/types 옵션을 포함하며 checker 객체를 공유하지 않는다', async () => {
  for (const options of [{ target: 'ES2022' }, { jsx: 'react-jsx' }, { useDefineForClassFields: true }, { strict: true }, { lib: ['es2022'] }, { types: ['missing-type'] }]) {
    await fixture({ 'a/tsconfig.json': config({}), 'b/tsconfig.json': config(options), 'a/main.ts': 'export function a(){}', 'b/main.ts': 'export function b(){}' }, async root => {
      const contexts = [...createGraphPrograms(root, [join(root, 'a/main.ts'), join(root, 'b/main.ts')])];
      assert.equal(contexts.length, 2);
      assert.notEqual(contexts[0]!.checker, contexts[1]!.checker);
      assert.equal(contexts[0]!.program.getSourceFile(join(root, 'b/main.ts')), undefined);
      assert.equal(contexts[1]!.program.getSourceFile(join(root, 'a/main.ts')), undefined);
    });
  }
});

test('타입 경계의 직접 명시 client sink는 위치와 개수를 유지한 dynamic 후보다', async () => {
  await fixture({
    'tsconfig.json': config({}), 'a/tsconfig.json': config({}), 'b/tsconfig.json': config({ strictNullChecks: true }),
    'b/http.ts': 'export class Http { get(path:string){return path;} } export interface TClient {get(path:string):string}',
    'a/main.ts': 'import {Http,TClient} from "../b/http"; const http=new Http(); export function direct(){http.get("/one");} export function typed(client:TClient){client.get("/two");} const fake={get(path:string){}}; fake.get("/fake");',
  }, async root => {
    const models = parseTypedClientModels(JSON.stringify({ format: 'http-client-models', version: 1, models: ['Http', 'TClient'].map(name => ({ receiver: { kind: name === 'Http' ? 'class' : 'type', path: 'b/http.ts', name }, methods: [{name:'get', method:'GET', pathArgument:0}] })) }));
    const document = extractClientRoutes(root, undefined, false, 'test', new Date(0), models);
    assert.equal(document.facts.length, 2);
    assert.ok(document.facts.every(fact => fact.dynamic && fact.channel === null && fact.location.path === 'a/main.ts'));
    assert.notEqual(document.facts[0]!.location.column, document.facts[1]!.location.column);
    assert.ok(document.limitations.some(line => line.includes('config-context-boundary:')));
    assert.ok(document.limitations.some(line => line.includes('2 known call site(s)')));
  });
});

test('client/navigation/persistence 모두 소유 alias와 entry/dependency 구분을 유지한다', async () => {
  const files: Record<string, string> = { 'tsconfig.json': config({}), };
  for (const app of ['a', 'b']) {
    files[`${app}/tsconfig.json`] = config({ baseUrl:'./src' }, { include:['src'], exclude:['src/unused.ts'] });
    files[`${app}/src/factory.ts`] = 'export function register(routes:unknown){}';
    files[`${app}/src/Screen.ts`] = 'export function Screen(){}';
    files[`${app}/src/db.ts`] = 'import {Pool} from "pg"; export const db=new Pool();';
    files[`${app}/src/main.ts`] = `import {register} from "factory"; import {Screen} from "Screen"; import {db} from "db"; import "../shared"; register([{path:"/${app}",screen:Screen}]); fetch("/${app}"); db.query("select * from users_${app}");`;
    files[`${app}/shared.ts`] = `fetch("/${app}/dependency");`;
    files[`${app}/src/unused.ts`] = 'fetch("/unused"); import {Pool} from "pg"; new Pool().query("select * from unused");';
  }
  await fixture(files, async root => {
    const client = extractClientRoutes(root, undefined, false, 'test', new Date(0));
    assert.deepEqual(client.facts.map(fact => fact.channel).sort(), ['/a', '/a/dependency', '/b', '/b/dependency']);
    const models = parseRouterModels(JSON.stringify({ format:'router-models', version:1, models:['a','b'].map(app => ({factory:{path:`${app}/src/factory.ts`,name:'register'},routesArgument:0,pathProperty:'path',screenProperty:'screen',pathSyntax:'colon'})) }));
    const navigation = extractNavigationRoutes(root, models, 'test', new Date(0));
    assert.deepEqual(navigation.facts.map(fact => [fact.urlTemplate, fact.screen?.usr]), [['/a','a/src/Screen.ts#Screen'],['/b','b/src/Screen.ts#Screen']]);
    const persistence = extractPersistenceFacts(root);
    assert.deepEqual(persistence.facts.filter(fact => fact.kind === 'relation-use').map(fact => fact.channel).sort(), ['users_a', 'users_b']);
    for (const output of [client,navigation,persistence]) assert.ok(output.limitations.some(line => line.includes('source-scope:')));
  });
});

test('실제 Git before/after는 각 시점의 패키지 소유 caller를 유지한다', async () => {
  await fixture(apps, async root => {
    const git = (...args:string[]) => execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
    git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid'); git('config','core.autocrlf','false'); git('add','.'); git('commit','-qm','fixture');
    writeFileSync(join(root,'app-b/src/components/Button.ts'),'export function Button(){return "changed";}');
    const report = await analyzeChange({project:root,base:'HEAD',maxDepth:128,maxReached:100000,dispatch:'bound',toolVersion:'test',generatedAt:new Date(0)});
    for (const side of [report.before,report.after]) {
      assert.ok(side.traversal.reached.some(row => row.symbol.usr === 'app-b/src/page.ts#PageB'));
      assert.ok(!side.traversal.reached.some(row => row.symbol.usr === 'app-a/src/page.ts#PageA'));
    }
    assert.notEqual(report.before.input.contentDigest,report.after.input.contentDigest);
    assert.equal(report.status,'incomplete');
  });
});

test('서로 다른 server 문맥의 AST는 각 checker로 문서화하고 등록 순서를 합치지 않는다', async () => {
  await fixture({
    'package.json': JSON.stringify({dependencies:{hono:'4.6.0'}}),
    'a/tsconfig.json': config({baseUrl:'./src'}), 'b/tsconfig.json': config({baseUrl:'./src',strict:true}),
    'a/src/handler.ts': 'export function handle(c:any){return c.text("a");}',
    'b/src/handler.ts': 'export function handle(c:any){return c.text("b");}',
    'a/src/main.ts': 'import {Hono} from "hono"; import {handle} from "handler"; const app=new Hono(); app.get("/a",handle); export default app;',
    'b/src/main.ts': 'import {Hono} from "hono"; import {handle} from "handler"; const app=new Hono(); app.get("/b",handle); export default app;',
  }, async root => {
    const output = await runRoutesCommand(['--role','server','--project',root], {fileSystem:createNodeFileSystem(),toolVersion:'test',now:()=>new Date(0)});
    assert.equal(output.exitCode,0);
    const document = JSON.parse(output.standardOutput) as {facts:{channel:string;symbol:{usr:string};order?:number}[];limitations:string[]};
    assert.deepEqual(document.facts.map(fact => [fact.channel,fact.symbol.usr]), [['/a','a/src/handler.ts#handle'],['/b','b/src/handler.ts#handle']]);
    assert.ok(document.facts.every(fact => fact.order === undefined));
    assert.ok(document.limitations.some(line => line.includes('separate compiler contexts')));
  });
});

test('문맥 예산 초과는 선언 후보와 한계를 유지하고 import 연결을 보류한다', async () => {
  const files: Record<string,string> = {};
  for (let index=0;index<17;index++) {
    files[`p${index}/tsconfig.json`] = config({types:[`missing-${index}`]});
    files[`p${index}/main.ts`] = 'import {target} from "./target"; export function main(){target();}';
    files[`p${index}/target.ts`] = 'export function target(){}';
  }
  await fixture(files, async root => {
    const graph = await buildCallGraph(root,createNodeFileSystem());
    assert.equal(graph.nodes.filter(node => node.id.endsWith('main.ts#main')).length,17);
    assert.ok(!graph.edges.some(edge => edge.kinds.includes('call')));
    assert.ok(graph.limitations.some(line => line.includes('config-context-budget:')));
  });
});

test('같은 디렉터리의 서로 다른 reference 소유 파일은 module 해석 캐시를 섞지 않는다', async () => {
  await fixture({
    'tsconfig.json': config({}, {files:[],references:[{path:'./a.json'},{path:'./b.json'}]}),
    'a.json': config({baseUrl:'./a'},{files:['src/a.ts']}), 'b.json': config({baseUrl:'./b'},{files:['src/b.ts']}),
    'a/db.ts':'import {Pool} from "pg"; export const db=new Pool(); export function target(){}',
    'b/db.ts':'import {Pool} from "pg"; export const db=new Pool(); export function target(){}',
    'src/a.ts':'import {db,target} from "db"; export function a(){target();db.query("select * from users_a");}',
    'src/b.ts':'import {db,target} from "db"; export function b(){target();db.query("select * from users_b");}',
  }, async root => {
    const graph=await buildCallGraph(root,createNodeFileSystem());
    assert.ok(graph.edges.some(edge=>edge.from==='src/a.ts#a' && edge.to==='a/db.ts#target'));
    assert.ok(graph.edges.some(edge=>edge.from==='src/b.ts#b' && edge.to==='b/db.ts#target'));
    const persistence=extractPersistenceFacts(root);
    assert.deepEqual(persistence.facts.filter(fact=>fact.kind==='relation-use').map(fact=>fact.channel).sort(),['users_a','users_b']);
  });
});

test('설정별 include 열거도 하나의 공통 준비 예산을 소비한다', async () => {
  await fixture({
    'tsconfig.json':config({}, {files:[],references:[{path:'./a.json'},{path:'./b.json'}]}),
    'a.json':config({}, {include:['src']}), 'b.json':config({}, {include:['src']}),
    'src/a.ts':'export function a(){}', 'src/b.ts':'export function b(){}',
  }, async root => {
    const contexts=[...createGraphPrograms(root,[join(root,'src/a.ts'),join(root,'src/b.ts')],undefined,{root,excludedDirectories:new Set(),maxVisitedEntries:3})];
    assert.ok(contexts.every(context=>context.status.configOwnershipIncomplete));
  });
});

test('NodeNext의 import/require 조건은 같은 소유 Program에서도 구분한다', async () => {
  await fixture({
    'tsconfig.json':config({module:'NodeNext',moduleResolution:'NodeNext'}),
    'main.mts':'import {kind} from "pkg"; import other=require("pkg"); const a=kind(); const b=other.kind();',
    'node_modules/pkg/package.json':JSON.stringify({name:'pkg',exports:{import:'./import.d.mts',require:'./require.d.cts'}}),
    'node_modules/pkg/import.d.mts':'export declare function kind():"import";',
    'node_modules/pkg/require.d.cts':'export declare function kind():"require";',
  }, async root=>{
    const context=[...createGraphPrograms(root,[join(root,'main.mts')])][0]!;
    const file=context.program.getSourceFile(join(root,'main.mts'))!;
    const initializers=file.statements.filter(ts.isVariableStatement).flatMap(statement=>statement.declarationList.declarations.map(declaration=>declaration.initializer!));
    assert.deepEqual(initializers.map(node=>context.checker.typeToString(context.checker.getTypeAtLocation(node))),['"import"','"require"']);
  });
});

test('같은 의미 그룹의 다른 설정 준비 공백과 reference/nearest 중복 소유권을 보존한다', async () => {
  await fixture({
    'tsconfig.json': config({}, {files:[],references:[{path:'./ref.json'}]}),
    'ref.json': config({baseUrl:'./other'}, {files:['app/main.ts']}),
    'app/tsconfig.json': config({baseUrl:'.'}, {files:['main.ts','../../outside.ts']}),
    'app/main.ts': 'import {target} from "target"; export function main(){target();}',
    'app/target.ts': 'export function target(){}', 'other/target.ts': 'export function target(){}',
  }, async root => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.nodes.some(node => node.id === 'app/main.ts#main'));
    assert.ok(!graph.edges.some(edge => edge.from === 'app/main.ts#main'));
    assert.ok(graph.limitations.some(line => line.includes('config-conflict:')));
    assert.ok(graph.limitations.some(line => line.includes('outside the scanned root')));
  });
});

test('review: 같은 옵션의 독립 설정은 다른 앱의 global 선언을 보지 않는다', async () => {
  await fixture({
    'a/tsconfig.json':config({}, {include:['main.ts']}), 'b/tsconfig.json':config({}, {include:['main.ts']}),
    'a/main.ts':'function callFromA(){foreignFromB();}', 'b/main.ts':'function foreignFromB(){return 42;}',
  }, async root => {
    const graph=await buildCallGraph(root,createNodeFileSystem());
    assert.ok(!graph.edges.some(edge=>edge.from==='a/main.ts#callFromA' && edge.to==='b/main.ts#foreignFromB'));
    assert.ok(Object.values(graph.statistics.calls.unresolved).some(count=>count > 0));
  });
});

test('review: triple slash는 다른 설정의 global 선언을 반입하거나 route 후보를 중복하지 않는다', async () => {
  await fixture({
    'a/tsconfig.json':config({}), 'b/tsconfig.json':config({strict:true}),
    'a/main.ts':'/// <reference path="../b/main.ts" />\nexport function a(){foreign();}',
    'b/main.ts':'function foreign(){}; fetch("/b");',
  }, async root => {
    const projects=[...loadNodeProjects(root)];
    assert.equal(projects.reduce((n,project)=>n+Number(project.files.has('b/main.ts')),0),1);
    const graph=await buildCallGraph(root,createNodeFileSystem());
    assert.ok(Object.values(graph.statistics.calls.unresolved).some(count=>count > 0));
    assert.ok(graph.limitations.some(line=>line.includes('config-context-boundary:')));
    const client=extractClientRoutes(root,undefined,false,'test',new Date(0));
    assert.equal(client.facts.length,1);
  });
});

test('review: 문맥 예산 초과에도 직접 알려진 typed sink의 위치와 dynamic 후보가 남는다', async () => {
  const files:Record<string,string>={};
  for(let i=0;i<17;i++) {
    files[`p${i}/tsconfig.json`]=config({types:[`missing-${i}`]});
    files[`p${i}/main.ts`]='import {Http} from "./http"; const http=new Http(); http.get("/known");';
    files[`p${i}/http.ts`]='export class Http {get(path:string){return path;}}';
  }
  await fixture(files, async root=>{
    const models=parseTypedClientModels(JSON.stringify({format:'http-client-models',version:1,models:Array.from({length:17},(_,i)=>({receiver:{kind:'class',path:`p${i}/http.ts`,name:'Http'},methods:[{name:'get',method:'GET',pathArgument:0}]}))}));
    const client=extractClientRoutes(root,undefined,false,'test',new Date(0),models);
    assert.equal(client.facts.length,17);
    assert.equal(new Set(client.facts.map(fact=>fact.location.path)).size,17);
    assert.ok(client.facts.every(fact=>fact.dynamic && fact.channel===null));
    assert.ok(client.limitations.some(line=>line.includes('config-context-budget:')));
  });
});

test('review: external module의 global augmentation과 자동 types도 독립 universe를 유지한다', async () => {
  for (const external of [false,true]) await fixture({
    'a/tsconfig.json':config({}), 'b/tsconfig.json':config({}),
    'a/main.ts': external ? 'import "ambient"; export function a(){}' : 'export {}; declare global {function foreign():void}',
    'b/main.ts':'export function b(){foreign();}',
    ...(external ? {'node_modules/ambient/package.json':JSON.stringify({name:'ambient',types:'index.d.ts'}),
      'node_modules/ambient/index.d.ts':'export {}; declare global {function foreign():void}'} : {}),
  }, async root=>{
    const graph=await buildCallGraph(root,createNodeFileSystem());
    assert.ok(Object.values(graph.statistics.calls.unresolved).some(count=>count>0));
    const contexts=[...loadNodeProjects(root)];
    assert.equal(contexts.length,2);
    const b=contexts.find(context=>context.files.has('b/main.ts'))!;
    assert.ok(b.program.getSemanticDiagnostics().some(diagnostic=>diagnostic.code===2304));
  });
});

test('review: SDK lib 및 no-default-lib pragma는 다른 설정의 ambient 범위를 바꾸지 않는다', async () => {
  for (const pragma of ['lib="dom"','no-default-lib="true"']) await fixture({
    'a/tsconfig.json':config({noLib:false,lib:['ES2022']}), 'b/tsconfig.json':config({noLib:false,lib:['ES2022']}),
    'a/main.ts':`/// <reference ${pragma} />\nexport {};`,
    'b/main.ts':pragma.startsWith('lib=') ? 'export const value=document.title;' : 'export const value=Promise.resolve(1);',
  }, async root=>{
    const contexts=[...loadNodeProjects(root)];
    assert.equal(contexts.length,2);
    const b=contexts.find(context=>context.files.has('b/main.ts'))!;
    assert.equal(b.program.getSemanticDiagnostics().some(diagnostic=>diagnostic.code===2584 || diagnostic.code===2304),pragma.startsWith('lib='));
  });
});
