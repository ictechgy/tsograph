/**
 * 인터페이스로 주입한 의존성의 bound·candidate 디스패치를 합성 fixture(`fixtures/graph/di-dispatch`)와
 * 임시 프로젝트로 검증한다: deps 객체·생성자 매개변수·팩터리·기본 매개변수·모듈 싱글턴 주입, 여러 조립 지점의
 * 여러 구현, 흐름을 증명하지 못하는 자리(호출자 없는 내보낸 함수·선언만 있는 함수·새어 나간 함수·진입점
 * 매개변수·공개 패키지·몽키 패치·반사적 쓰기·데코레이터), 모드별 미해석 계수, reach 문서의 evidence·
 * unresolvedCalls·dispatch, 결정성.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runReachCommand } from '../cli/graph-command.ts';
import { buildCallGraph } from './build-graph.ts';
import { computeGraphRevision } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';

const fixture = realpathSync(fileURLToPath(new URL('../../fixtures/graph/di-dispatch/', import.meta.url)));
const fileSystem = createNodeFileSystem();
const graph = await buildCallGraph(fixture, fileSystem);

/**
 * 근거가 direct가 아닌 간선을 `from -> to evidence` 문자열로 줄인다.
 *
 * @param target 그래프
 * @returns 간선 문자열(정렬 순서 그대로)
 */
function dispatchEdges(target: CallGraph): string[] {
  return target.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
}

/**
 * 임시 프로젝트의 그래프를 만든다. tsconfig가 없으면 strict 기본값을 넣는다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-dispatch-')));
  try {
    const all = { 'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }', ...files };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, fileSystem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 임시 프로젝트들이 공유하는 인터페이스와 구현 두 개다. */
const storeModule = [
  'export interface Store { find(id: string): string; }',
  'export class RemoteStore implements Store { find(id: string) { return remote(id); } }',
  'export class LocalStore implements Store { find(id: string) { return id; } }',
  'function remote(id: string) { return id; }',
].join('\n');

test('fixture: 주입 방식별 bound 간선과 증명하지 못한 호출의 candidate 간선', () => {
  assert.deepEqual(dispatchEdges(graph), [
    // 진입점 매개변수(기본값이 있어도 프레임워크가 채운다)
    'src/app/api/items/route.ts#PATCH -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/app/api/items/route.ts#PATCH -> src/lib/store.ts#SqlItemStore.findItem candidate',
    // 인터페이스 타입 const에 담긴 팩터리 반환값(객체 리터럴의 화살표 멤버)
    'src/app/api/items/route.ts#PUT -> src/lib/lookup.ts#createLookup.run bound',
    // 기본 매개변수 DI
    'src/lib/defaults.ts#countItems -> src/lib/store.ts#MemoryItemStore.findItem bound',
    // deps 객체 주입: 두 조립 지점의 두 구현이 모두 이어진다
    'src/lib/handler.ts#ItemHandler.get -> src/lib/store.ts#MemoryItemStore.findItem bound',
    'src/lib/handler.ts#ItemHandler.get -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 팩터리 매개변수의 deps 객체
    'src/lib/lookup.ts#createLookup.run -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 호출자가 모두 프로젝트 안인 내보낸 함수
    'src/lib/open.ts#lookupAnywhere -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 선언만 있는 함수의 반환값, 호출자 없는 내보낸 함수, 값으로 새어 나간 함수
    'src/lib/open.ts#lookupExternal -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/lib/open.ts#lookupExternal -> src/lib/store.ts#SqlItemStore.findItem candidate',
    'src/lib/open.ts#lookupUncalled -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/lib/open.ts#lookupUncalled -> src/lib/store.ts#SqlItemStore.findItem candidate',
    'src/lib/open.ts#viaCallback -> src/lib/store.ts#MemoryItemStore.saveItem candidate',
    'src/lib/open.ts#viaCallback -> src/lib/store.ts#SqlItemStore.saveItem candidate',
    // 생성자 매개변수 주입, 모듈 싱글턴(팩터리 반환값)
    'src/lib/service.ts#ItemService.save -> src/lib/store.ts#SqlItemStore.saveItem bound',
    'src/lib/singleton.ts#readSingleton -> src/lib/store.ts#SqlItemStore.findItem bound',
  ]);
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 7, boundPartial: 0, candidate: 4, candidatePartial: 0, overBudget: 0 });
  assert.equal(graph.statistics.calls.unresolved.interface, 11);
});

test('callable value flow: closed callbacks, returned callbacks, and constructor fallback', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'type Clock = () => string;',
      'function invoke(cb: Clock) { return cb(); }',
      'function make(): Clock { return () => "made"; }',
      'class Service {',
      '  private readonly clock: Clock;',
      '  constructor(private readonly deps: { clock?: Clock } = {}) { this.clock = deps.clock ?? (() => "inline"); }',
      '  run() { return invoke(this.clock); }',
      '}',
      'const namedClock = () => "named";',
      'const service = new Service({ clock: namedClock });',
      'export const named = () => service.run();',
      'const omitted = new Service();',
      'export const omittedRun = () => omitted.run();',
      'const cb = make();',
      'export const returned = () => cb();',
      'export const immediate = () => make()();',
    ].join('\n'),
  });
  const bound = (from: string): string[] => graph.edges.filter((edge) => edge.from === from && edge.evidence === 'bound').map((edge) => edge.to);
  assert.deepEqual(bound('src/main.ts#invoke'), ['src/main.ts#Service.constructor', 'src/main.ts#namedClock']);
  assert.deepEqual(bound('src/main.ts#make'), []);
  assert.deepEqual(bound('src/main.ts#Service.run'), []);
  assert.deepEqual(bound('src/main.ts#returned'), ['src/main.ts#make']);
  // make()()의 바깥 호출은 반환 화살표를 make 노드로 bound하지만 같은 direct 쌍이 더 강해 간선은 하나만 남는다.
  assert.deepEqual(bound('src/main.ts#immediate'), []);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'src/main.ts#immediate')?.unresolvedCalls, { direct: 1 });
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 3, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 });
  assert.deepEqual(graph.statistics.calls.unresolved, {
    parameter: 1, interface: 0, untyped: 0, computed: 1, indirect: 1, 'unresolved-import': 0,
  });
});

test('callable value flow: anonymous inline callback arguments use closed direct invocation sites', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'interface Service { run: () => string; }',
      'function effect() { return "effect"; }',
      'class ServiceImpl implements Service { run = effect; }',
      'type Callback = (service: Service) => string;',
      'function useService(callback: Callback) { return callback(new ServiceImpl()); }',
      'export const direct = () => useService((service) => service.run());',
      'function wrapService(callback: Callback) { return () => callback(new ServiceImpl()); }',
      'export const returned = () => wrapService((service) => service.run())();',
    ].join('\n'),
  });
  const calls = (from: string): [string, string][] => graph.edges
    .filter((edge) => edge.from === `src/main.ts#${from}` && edge.kinds.includes('call'))
    .map((edge) => [edge.to, edge.evidence]);
  const callbackTarget = (factory: string): string => {
    const target = calls(factory).find(([to, evidence]) => to.includes(`${factory}(`) && evidence === 'bound')?.[0];
    assert.ok(target);
    return target;
  };
  for (const factory of ['useService', 'wrapService']) {
    const target = callbackTarget(factory);
    assert.ok(graph.edges.some((edge) => edge.from === target && edge.to === 'src/main.ts#effect' && edge.evidence === 'bound'));
    assert.deepEqual(graph.nodes.find((node) => node.id === target)?.unresolvedCalls, { direct: 1 });
    assert.deepEqual(graph.nodes.find((node) => node.id === `src/main.ts#${factory}`)?.unresolvedCalls, { direct: 1 });
  }
});

test('callable value flow: returned closures follow a closed callable factory parameter', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'interface Service { run: () => string; }',
      'function effect() { return "effect"; }',
      'class ServiceImpl implements Service { run = effect; }',
      'type Maker = () => Service;',
      'type Callback = (service: Service) => string;',
      'function makeService(): Service { return new ServiceImpl(); }',
      'function wrap(make: Maker, callback: Callback) { return () => callback(make()); }',
      'export const handler = wrap(makeService, (service) => service.run());',
    ].join('\n'),
  });
  const callback = graph.nodes.find((node) => node.id.includes('.wrap('));
  assert.ok(callback);
  assert.ok(graph.edges.some((edge) => edge.from === callback.id && edge.to === 'src/main.ts#effect' && edge.evidence === 'bound'));
  assert.deepEqual(callback.unresolvedCalls, { direct: 1 });
});

test('callable value flow: callable factory parameters fail closed for mixed, mutated, open, and external makers', async () => {
  const cases: Record<string, Record<string, string>> = {
    mixed: {
      'src/main.ts': [
        'interface Service { run: () => string; }',
        'function effect() { return "effect"; }',
        'class ServiceImpl implements Service { run = effect; }',
        'type Maker = () => Service;',
        'type Callback = (service: Service) => string;',
        'function makeService(): Service { return new ServiceImpl(); }',
        'function wrap(make: Maker, callback: Callback) { return () => callback(make()); }',
        'declare const unknownMaker: Maker;',
        'export const known = wrap(makeService, (service) => service.run());',
        'export const unknown = wrap(unknownMaker, (service) => service.run());',
      ].join('\n'),
    },
    mutated: {
      'src/main.ts': [
        'interface Service { run: () => string; }',
        'function effect() { return "effect"; }',
        'class ServiceImpl implements Service { run = effect; }',
        'type Maker = () => Service;',
        'type Callback = (service: Service) => string;',
        'function makeService(): Service { return new ServiceImpl(); }',
        'declare const unknownMaker: Maker;',
        'function wrap(make: Maker, callback: Callback) { make = unknownMaker; return () => callback(make()); }',
        'export const handler = wrap(makeService, (service) => service.run());',
      ].join('\n'),
    },
    open: {
      'package.json': '{ "name": "open-callable-factory", "main": "src/main.ts" }',
      'src/main.ts': [
        'interface Service { run: () => string; }',
        'function effect() { return "effect"; }',
        'class ServiceImpl implements Service { run = effect; }',
        'type Maker = () => Service;',
        'type Callback = (service: Service) => string;',
        'function makeService(): Service { return new ServiceImpl(); }',
        'export function wrap(make: Maker, callback: Callback) { return () => callback(make()); }',
        'export const handler = wrap(makeService, (service) => service.run());',
      ].join('\n'),
    },
    external: {
      'src/main.ts': [
        'interface Service { run: () => string; }',
        'function effect() { return "effect"; }',
        'class ServiceImpl implements Service { run = effect; }',
        'type Maker = () => Service;',
        'type Callback = (service: Service) => string;',
        'declare function externalMaker(): Service;',
        'function wrap(make: Maker, callback: Callback) { return () => callback(make()); }',
        'export const handler = wrap(externalMaker, (service) => service.run());',
      ].join('\n'),
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    const graph = await graphOf(files);
    const callbackNodes = graph.nodes.filter((node) => node.id.includes('.wrap('));
    assert.ok(callbackNodes.length > 0, name);
    assert.deepEqual(graph.edges.filter((edge) => edge.to === 'src/main.ts#effect' && edge.evidence === 'bound'
      && edge.from.includes('.wrap(')), [], name);
    for (const node of callbackNodes) assert.deepEqual(node.unresolvedCalls, { direct: 1, bound: 1, candidates: 1 }, name);
  }
});

test('callable value flow: inline callback gaps remain unresolved on escapes, writes, open factories, unknowns, spreads, and named expressions', async () => {
  const cases: Record<string, { files: Record<string, string>; factory: string }> = {
    escape: {
      factory: 'escape',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'function escape(callback: Callback) { const saved = callback; return saved(new ServiceImpl()); }',
          'export const run = () => escape((service) => service.run());',
        ].join('\n'),
      },
    },
    reassign: {
      factory: 'invoke',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'function replacement(_service: Service) { return "replacement"; }',
          'function invoke(callback: Callback) { callback = replacement; return callback(new ServiceImpl()); }',
          'export const run = () => invoke((service) => service.run());',
        ].join('\n'),
      },
    },
    open: {
      factory: 'invoke',
      files: {
        'package.json': '{ "name": "open-inline-callback", "main": "src/main.ts" }',
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'export function invoke(callback: Callback) { callback(new ServiceImpl()); }',
          'export const run = () => invoke((service) => service.run());',
        ].join('\n'),
      },
    },
    unknown: {
      factory: 'invoke',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'declare const unknownService: Service;',
          'function invoke(callback: Callback) { callback(unknownService); }',
          'export const run = () => invoke((service) => service.run());',
        ].join('\n'),
      },
    },
    spread: {
      factory: 'invoke',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'declare const services: Service[];',
          'function invoke(callback: Callback) { callback(...services); }',
          'export const run = () => invoke((service) => service.run());',
        ].join('\n'),
      },
    },
    named: {
      factory: 'invoke',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'function invoke(callback: Callback) { callback(new ServiceImpl()); }',
          'export const run = () => invoke(function named(service) { return service.run(); });',
        ].join('\n'),
      },
    },
    mutated: {
      factory: 'first',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'function first(callback: Callback) { callback(new ServiceImpl()); }',
          'function second(callback: Callback) { return callback; }',
          'first = second;',
          'export const run = () => first((service) => service.run());',
        ].join('\n'),
      },
    },
    'mutated-alias': {
      factory: 'alias',
      files: {
        'src/main.ts': [
          'interface Service { run: () => string; }',
          'function effect() { return "effect"; }',
          'class ServiceImpl implements Service { run = effect; }',
          'type Callback = (service: Service) => string;',
          'function first(callback: Callback) { callback(new ServiceImpl()); }',
          'function second(callback: Callback) { return callback; }',
          'first = second;',
          'const alias = first;',
          'export const run = () => alias((service) => service.run());',
        ].join('\n'),
      },
    },
  };
  for (const [name, entry] of Object.entries(cases)) {
    const graph = await graphOf(entry.files);
    const callbackEdges = graph.edges.filter((edge) => edge.from.includes(`.${entry.factory}(`));
    assert.deepEqual(callbackEdges.filter((edge) => edge.to === 'src/main.ts#effect' && edge.evidence === 'bound'), [], name);
    assert.deepEqual(callbackEdges.filter((edge) => edge.evidence === 'candidate'), [], name);
    assert.deepEqual(graph.nodes.find((node) => node.id.includes(`.${entry.factory}(`))?.unresolvedCalls, {
      direct: 1, bound: 1, candidates: 1,
    }, name);
  }
});

test('callable value flow: mutable aliases union every callable write', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'type Clock = () => string;',
      'function first() { return "first"; }',
      'function second() { return "second"; }',
      'let callback: Clock = first;',
      'callback = second;',
      'export function run() { return callback(); }',
    ].join('\n'),
  });
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#run' && edge.evidence === 'bound').map((edge) => edge.to), [
    'src/main.ts#first',
    'src/main.ts#second',
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#run' && edge.evidence === 'candidate'), []);
  assert.deepEqual(graph.statistics.calls.unresolved, {
    parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 1, 'unresolved-import': 0,
  });
});

test('callable value flow: reassigned declarations and callback members union every observed write', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'type Clock = () => string;',
      'function first() { return "first"; }',
      'function second() { return "second"; }',
      'function reassignedDeclaration() { return "declaration"; }',
      'reassignedDeclaration = second;',
      'export function runDeclaration() { return reassignedDeclaration(); }',
      'class Holder {',
      '  readonly callback: Clock = first;',
      '  constructor() { this.callback = second; }',
      '  run() { return this.callback(); }',
      '}',
      'const holder = new Holder();',
      'export const runHolder = () => holder.run();',
      'const callbacks = { callback: first };',
      'callbacks.callback = second;',
      'export const runObject = () => callbacks.callback();',
      'const immutable = () => "immutable";',
      'export const runImmutable = () => immutable();',
      'function makeCallback(): Clock { return first; }',
      'function otherMaker(): Clock { return second; }',
      'makeCallback = otherMaker;',
      'export const runReturnedWrite = () => makeCallback()();',
    ].join('\n'),
  });
  const targets = (from: string, evidence: 'direct' | 'bound'): string[] => graph.edges
    .filter((edge) => edge.from === from && edge.evidence === evidence).map((edge) => edge.to);
  assert.deepEqual(targets('src/main.ts#runDeclaration', 'bound'), ['src/main.ts#reassignedDeclaration', 'src/main.ts#second']);
  assert.deepEqual(targets('src/main.ts#Holder.run', 'bound'), ['src/main.ts#first', 'src/main.ts#second']);
  assert.deepEqual(targets('src/main.ts#runObject', 'bound'), ['src/main.ts#first', 'src/main.ts#second']);
  assert.deepEqual(targets('src/main.ts#runImmutable', 'direct'), ['src/main.ts#immutable']);
  assert.deepEqual(targets('src/main.ts#runImmutable', 'bound'), []);
  assert.deepEqual(targets('src/main.ts#runReturnedWrite', 'bound'), [
    'src/main.ts#first', 'src/main.ts#makeCallback', 'src/main.ts#otherMaker', 'src/main.ts#second',
  ]);
});

test('callable value flow: unknown destructuring, loop, and reflective writes fail closed in every mode', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'type Clock = () => string;',
      'function first() { return "first"; }',
      'function second() { return "second"; }',
      'let destructured: Clock = first;',
      '({ callback: destructured } = { callback: second });',
      'export const runDestructured = () => destructured();',
      'let looped: Clock = first;',
      'for (looped of [second]) { break; }',
      'export const runLooped = () => looped();',
      'const reflected = { callback: first };',
      'const reflectedAlias = reflected;',
      'Object.assign(reflectedAlias, { callback: second });',
      'export const runReflected = () => reflected.callback();',
      'const deleted: { callback?: Clock } = { callback: first };',
      'delete deleted.callback;',
      'export const runDeleted = () => deleted.callback!();',
      'declare const dynamicKey: string;',
      'const computedDeleted: { callback?: Clock } = { callback: first };',
      'delete computedDeleted[dynamicKey];',
      'export const runComputedDeleted = () => computedDeleted.callback!();',
      'const reflectDeleted: { callback?: Clock } = { callback: first };',
      'Reflect.deleteProperty(reflectDeleted, "callback");',
      'export const runReflectDeleted = () => reflectDeleted.callback!();',
      'const assigned = { callback: first };',
      'Object.assign(assigned, { callback: second });',
      'const assignedCallback: Clock = assigned.callback;',
      'export const runAssignedAlias = () => assignedCallback();',
      'const defined = { callback: first };',
      'Object.defineProperty(defined, "callback", { value: second });',
      'const definedCallback: Clock = defined.callback;',
      'export const runDefinedAlias = () => definedCallback();',
      'const { callback: assignedDestructured } = assigned;',
      'export const runAssignedDestructured = () => assignedDestructured();',
      'class PatchedMethod { run() { return "old"; } }',
      'const patchedMethod = new PatchedMethod();',
      'patchedMethod.run = second;',
      'const patchedAlias: Clock = patchedMethod.run;',
      'const { run: patchedDestructured } = patchedMethod;',
      'export const runPatchedAlias = () => patchedAlias();',
      'export const runPatchedDestructured = () => patchedDestructured();',
    ].join('\n'),
  });
  for (const from of [
    'runDestructured', 'runLooped', 'runReflected', 'runDeleted', 'runComputedDeleted', 'runReflectDeleted',
    'runAssignedAlias', 'runDefinedAlias',
    'runAssignedDestructured', 'runPatchedAlias', 'runPatchedDestructured',
  ]) {
    assert.deepEqual(graph.edges.filter((edge) => edge.from === `src/main.ts#${from}` && edge.kinds.includes('call')), [], from);
    assert.deepEqual(graph.nodes.find((node) => node.id === `src/main.ts#${from}`)?.unresolvedCalls, {
      direct: 1, bound: 1, candidates: 1,
    });
  }
});

test('callable value flow: getter values bind returned callbacks while decorators fail closed', async () => {
  const graph = await graphOf({
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
    'src/main.ts': [
      'type Clock = () => string;',
      'function first() { return "first"; }',
      'function marker(..._args: any[]) {}',
      'class PlainGetter { get callback(): Clock { return first; } }',
      'const plainCallback: Clock = new PlainGetter().callback;',
      'export const runPlainGetter = () => plainCallback();',
      '@marker class ClassDecorated {',
      '  callback: Clock = first;',
      '  method() { return "method"; }',
      '  get getter(): Clock { return first; }',
      '  make(): Clock { return first; }',
      '}',
      'const classField: Clock = new ClassDecorated().callback;',
      'const classMethod: Clock = new ClassDecorated().method;',
      'const classGetter: Clock = new ClassDecorated().getter;',
      'export const runClassField = () => classField();',
      'export const runClassMethod = () => classMethod();',
      'export const runClassGetter = () => classGetter();',
      'export const runClassReturn = () => new ClassDecorated().make()();',
      'class MemberDecorated {',
      '  @marker callback: Clock = first;',
      '  @marker method() { return "method"; }',
      '  @marker get getter(): Clock { return first; }',
      '}',
      'const memberField: Clock = new MemberDecorated().callback;',
      'const memberMethod: Clock = new MemberDecorated().method;',
      'const memberGetter: Clock = new MemberDecorated().getter;',
      'export const runMemberField = () => memberField();',
      'export const runMemberMethod = () => memberMethod();',
      'export const runMemberGetter = () => memberGetter();',
    ].join('\n'),
  });
  const plain = graph.edges.filter((edge) => edge.from === 'src/main.ts#runPlainGetter' && edge.kinds.includes('call'));
  assert.deepEqual(plain.map((edge) => [edge.to, edge.evidence]), [
    ['src/main.ts#PlainGetter.callback', 'direct'],
    ['src/main.ts#first', 'bound'],
  ]);
  for (const from of [
    'runClassField', 'runClassMethod', 'runClassGetter', 'runClassReturn',
    'runMemberField', 'runMemberMethod', 'runMemberGetter',
  ]) {
    assert.deepEqual(graph.edges.filter((edge) => edge.from === `src/main.ts#${from}` && edge.kinds.includes('call')), [], from);
    assert.ok((graph.nodes.find((node) => node.id === `src/main.ts#${from}`)?.unresolvedCalls?.candidates ?? 0) > 0, from);
  }
});

test('callable value flow: class and accessor decorators keep extracted callbacks unknown', async () => {
  const graph = await graphOf({
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
    'src/main.ts': [
      'type Clock = () => string;',
      'function invoke(cb: Clock) { return cb(); }',
      'function replace<T extends new (...args: any[]) => any>(target: T): T { return class extends target { run() { return "replacement"; } } as T; }',
      '@replace class Decorated { field = () => "field"; get getter(): Clock { return () => "getter"; } run() { return "old"; } }',
      'function marker(_value: unknown, _context: unknown) {}',
      'class AccessorDecorated { @marker get callback(): Clock { return () => "accessor"; } }',
      'function use() { invoke(new Decorated().field); invoke(new Decorated().getter); invoke(new AccessorDecorated().callback); return invoke(new Decorated().run); }',
      'export const run = () => use();',
    ].join('\n'),
  });
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#invoke' && edge.evidence === 'bound'), []);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#invoke' && edge.evidence === 'candidate'), []);
});

test('dispatch limitations retain a separate partial gap when another full gap is bound', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'interface Runner { run(): string; }',
      'class First { run() { return "first"; } }',
      'class Second { run() { return "second"; } }',
      'function makeComplete(): Runner { return new First(); }',
      'const complete: Runner = makeComplete();',
      'declare function unknown(): Runner;',
      'const partial: First | Runner = unknown();',
      'export const runComplete = () => complete.run();',
      'export const runPartial = () => partial.run();',
    ].join('\n'),
  });
  assert.ok(graph.limitationsByMode.bound.some((line) => line.startsWith('partial-dispatch: 1 call(s)')));
  assert.ok(!graph.limitationsByMode.bound.some((line) => line.includes('unresolved-calls:') && line.includes('interface:')));
  assert.ok(!graph.limitationsByMode.candidates.some((line) => line.startsWith('partial-dispatch:')));
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 1, boundPartial: 0, candidate: 0, candidatePartial: 1, overBudget: 0 });
});

test('unrelated computed and same-named writes preserve proven receiver calls', async () => {
  const calls = (graph: CallGraph, from: string): [string, string][] => graph.edges
    .filter((edge) => edge.from === from && edge.kinds.includes('call')).map((edge) => [edge.to, edge.evidence]);
  const nominal = await graphOf({
    'src/main.ts': [
      'interface Store { find(): number; }',
      'class Repo implements Store { private brand = 1; find() { return 1; } }',
      'function lookup(store: Store) { return store.find(); }',
      'declare const style: CSSStyleDeclaration;',
      'declare const key: string;',
      'style[key] = "x";',
      'export const result = lookup(new Repo());',
    ].join('\n'),
  });
  assert.deepEqual(calls(nominal, 'src/main.ts#lookup'), [['src/main.ts#Repo.find', 'bound']]);

  const distinct = await graphOf({
    'src/main.ts': [
      'class DirectRepo { find() { return 2; } }',
      'class Other { private readonly find: () => number; constructor() { this.find = () => 0; } }',
      'export function runDirect() { return new DirectRepo().find(); }',
      'new Other();',
    ].join('\n'),
  });
  assert.deepEqual(calls(distinct, 'src/main.ts#runDirect'), [['src/main.ts#DirectRepo.find', 'direct']]);

  const overlapGraph = await graphOf({
    'src/main.ts': [
      'class StructuralRepo { find() { return 3; } }',
      'declare const maybeRepo: StructuralRepo;',
      'declare const overlap: { other: number };',
      'declare const key: string;',
      'overlap[key] = 1;',
      'export function runOverlap() { return maybeRepo.find(); }',
    ].join('\n'),
  });
  assert.deepEqual(calls(overlapGraph, 'src/main.ts#runOverlap'), []);
  assert.deepEqual(overlapGraph.nodes.find((node) => node.id === 'src/main.ts#runOverlap')?.unresolvedCalls, {
    direct: 1, bound: 1, candidates: 1,
  });

  const literalAlias = await graphOf({
    'src/main.ts': [
      'function implA() { return "a"; }',
      'function implB() { return "b"; }',
      'function implC() { return "c"; }',
      'class C { run() { return implA(); } }',
      'const config = { run: () => implB() };',
      'function main(value: C) { config.run = () => implC(); return value.run(); }',
      'export const result = main(config);',
    ].join('\n'),
  });
  assert.ok(!calls(literalAlias, 'src/main.ts#main').some(([to, evidence]) => to === 'src/main.ts#C.run' && evidence === 'direct'));

  const genericTarget = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'src/main.ts': [
      'interface Store { find(): number; }',
      'export class Repo implements Store { private brand = 1; find() { return 1; } }',
      'export function lookup(store: Store) { return store.find(); }',
      'export const result = lookup(new Repo());',
    ].join('\n'),
    'app/api/x/route.ts': [
      'export function POST<T extends object>(target: T, key: keyof T) {',
      '  target[key] = target[key];',
      '  return new Response();',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(calls(genericTarget, 'src/main.ts#lookup').filter(([, evidence]) => evidence === 'bound'), []);
  assert.ok(calls(genericTarget, 'src/main.ts#lookup').some(([, evidence]) => evidence === 'candidate'));
});

test('callable property signatures recover only safe fixed receiver targets', async () => {
  const stable = await graphOf({
    'src/main.ts': [
      'interface Handler { run: () => string; }',
      'function effect() { return "stable"; }',
      'class Impl { run = effect; }',
      'const handler: Handler = new Impl();',
      'export const call = () => handler.run();',
    ].join('\n'),
  });
  const edgesFrom = (graph: CallGraph): [string, string][] => graph.edges
    .filter((edge) => edge.from === 'src/main.ts#call' && edge.kinds.includes('call')).map((edge) => [edge.to, edge.evidence]);
  assert.deepEqual(edgesFrom(stable), [['src/main.ts#effect', 'direct']]);

  const mutated = await graphOf({
    'src/main.ts': [
      'interface Handler { run: () => string; }',
      'function first() { return "first"; }',
      'function second() { return "second"; }',
      'class Impl { run = first; }',
      'const handler: Handler = new Impl();',
      'handler.run = second;',
      'export const call = () => handler.run();',
    ].join('\n'),
  });
  assert.deepEqual(edgesFrom(mutated), [
    ['src/main.ts#first', 'bound'],
    ['src/main.ts#second', 'bound'],
  ]);

  const deleted = await graphOf({
    'src/main.ts': [
      'interface Handler { run?: () => string; }',
      'function first() { return "first"; }',
      'class Impl { run = first; }',
      'const handler: Handler = new Impl();',
      'delete handler.run;',
      'export const call = () => handler.run!();',
    ].join('\n'),
  });
  assert.deepEqual(edgesFrom(deleted), []);
  assert.deepEqual(deleted.nodes.find((node) => node.id === 'src/main.ts#call')?.unresolvedCalls, {
    direct: 1, bound: 1, candidates: 1,
  });
});

test('callable value flow: mixed, empty, patched, reflective, and named method paths fail closed', async () => {
  const aliases = Array.from({ length: 300 }, (_, index) => `const c${index + 1}: Clock = c${index};`).join('\n');
  const graph = await graphOf({
    'src/main.ts': [
      'type Clock = () => string;',
      'function invokeNamed(cb: Clock) { return cb(); }',
      'const namedObject = { run() { return "named"; } };',
      'function namedMethod() { return invokeNamed(namedObject.run); }',
      'export const runNamed = () => namedMethod();',
      'function invokeMixed(cb: Clock) { return cb(); }',
      'declare const unknownClock: Clock;',
      'function mixedFallback() { return invokeMixed(unknownClock ?? (() => "fallback")); }',
      'export const runMixed = () => mixedFallback();',
      'function invokeMixedObject(cb: Clock) { return cb(); }',
      'declare const mixedFlag: boolean;',
      'const mixedObject = mixedFlag ? (() => "callable") : { run() { return "object"; } };',
      'function mixedObjectMethod() { return invokeMixedObject(mixedObject as Clock); }',
      'export const runMixedObject = () => mixedObjectMethod();',
      'function invokeReassigned(cb: Clock) { return cb(); }',
      'let reassigned: Clock = () => "first";',
      'reassigned = unknownClock;',
      'function reassignedMethod() { return invokeReassigned(reassigned); }',
      'export const runReassigned = () => reassignedMethod();',
      'function invokeFunctionObject(cb: Clock) { return cb(); }',
      'const callableObject = (() => "callable") as Clock & { marker: Clock };',
      'function functionObjectProperty() { return invokeFunctionObject(callableObject.marker); }',
      'export const runFunctionObjectProperty = () => functionObjectProperty();',
      'function invokeDetached(cb: Clock) { return cb(); }',
      'class Detached { value = "detached"; run() { return this.value; } }',
      'function detachedMethod() { return invokeDetached(new Detached().run); }',
      'export const runDetached = () => detachedMethod();',
      'function invokeEmpty(cb: Clock) { return cb(); }',
      'export const runEmpty = () => 1;',
      'function invokePatched(cb: Clock) { return cb(); }',
      'const patchedObject = { run() { return "original"; } };',
      'patchedObject.run = () => "patched";',
      'function patchedMethod() { return invokePatched(patchedObject.run); }',
      'export const runPatched = () => patchedMethod();',
      'function invokeReflective(cb: Clock) { return cb(); }',
      'class ReflectiveHolder { run() { return "original"; } }',
      'const reflectiveObject = new ReflectiveHolder();',
      'Object.assign(reflectiveObject, { run: () => "patched" });',
      'function reflectiveMethod() { return invokeReflective(reflectiveObject.run); }',
      'export const runReflective = () => reflectiveMethod();',
      'function invokeBudget(cb: Clock) { return cb(); }',
      'const c0: Clock = () => "budget";',
      aliases,
      'function budgetMethod() { return invokeBudget(c300); }',
      'export const runBudget = () => budgetMethod();',
    ].join('\n'),
  });
  const edges = (from: string, evidence: 'bound' | 'candidate'): string[] => graph.edges
    .filter((edge) => edge.from === from && edge.evidence === evidence).map((edge) => edge.to);
  assert.deepEqual(edges('src/main.ts#invokeNamed', 'bound'), ['src/main.ts#namedObject.run']);
  for (const id of ['invokeMixed', 'invokeMixedObject', 'invokeReassigned', 'invokeFunctionObject', 'invokeDetached', 'invokeEmpty', 'invokePatched', 'invokeReflective', 'invokeBudget']) {
    assert.deepEqual(edges(`src/main.ts#${id}`, 'bound'), [], id);
    assert.deepEqual(edges(`src/main.ts#${id}`, 'candidate'), [], id);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === `src/main.ts#${id}` && edge.kinds.includes('call')), [], id);
    assert.deepEqual(graph.nodes.find((node) => node.id === `src/main.ts#${id}`)?.unresolvedCalls, {
      direct: 1, bound: 1, candidates: 1,
    }, id);
  }
  assert.equal(graph.statistics.calls.dispatch.candidate, 0);
  assert.equal(graph.statistics.calls.dispatch.overBudget, 1);
  assert.ok(graph.limitations.some((line) => line.startsWith('dispatch-budget: 1 deferred interface/callable call(s)')));
  assert.ok(graph.nodes.find((node) => node.id === 'src/main.ts#invokeMixed')?.unresolvedCalls?.direct === 1);
  assert.ok(graph.nodes.find((node) => node.id === 'src/main.ts#invokeEmpty')?.unresolvedCalls?.direct === 1);
});

test('callable value flow: exported/open callback and decorated method remain unbound', async () => {
  const open = await graphOf({
    'package.json': '{ "name": "callable-open", "exports": "./src/main.ts" }',
    'src/main.ts': [
      'type Clock = () => string;',
      'export function invokeOpen(cb: Clock) { return cb(); }',
      'export const runOpen = () => invokeOpen(() => "open");',
    ].join('\n'),
  });
  assert.deepEqual(open.edges.filter((edge) => edge.from === 'src/main.ts#invokeOpen' && edge.evidence === 'bound'), []);
  assert.deepEqual(open.edges.filter((edge) => edge.from === 'src/main.ts#invokeOpen' && edge.evidence === 'candidate'), []);
  assert.deepEqual(open.nodes.find((node) => node.id === 'src/main.ts#invokeOpen')?.unresolvedCalls, {
    direct: 1, bound: 1, candidates: 1,
  });
  assert.ok(open.limitations.some((line) => line.startsWith('bound-dispatch: package.json declares public entry points')));

  const decorated = await graphOf({
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
    'src/main.ts': [
      'type Clock = () => string;',
      'function invokeDecorated(cb: Clock) { return cb(); }',
      'function marker(_value: unknown, _context: unknown) {}',
      'class Decorated { @marker run() { return "decorated"; } }',
      'function decoratedMethod() { return invokeDecorated(new Decorated().run); }',
      'export const runDecorated = () => decoratedMethod();',
    ].join('\n'),
  });
  assert.deepEqual(decorated.edges.filter((edge) => edge.from === 'src/main.ts#invokeDecorated' && edge.evidence === 'bound'), []);
  assert.deepEqual(decorated.edges.filter((edge) => edge.from === 'src/main.ts#invokeDecorated' && edge.evidence === 'candidate'), []);
  assert.deepEqual(decorated.nodes.find((node) => node.id === 'src/main.ts#invokeDecorated')?.unresolvedCalls, {
    direct: 1, bound: 1, candidates: 1,
  });

  const entry = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'app/api/x/route.ts': [
      'type Clock = () => string;',
      'export function GET(callback: Clock = () => "default") { return callback(); }',
    ].join('\n'),
  });
  assert.deepEqual(entry.nodes.find((node) => node.id === 'app/api/x/route.ts#GET')?.entries, ['route-handler']);
  assert.deepEqual(entry.nodes.find((node) => node.id === 'app/api/x/route.ts#GET')?.unresolvedCalls, {
    direct: 1, bound: 1, candidates: 1,
  });
});

test('fixture: 노드별 미해석 계수는 모드마다 다르다', () => {
  const counts = Object.fromEntries(graph.nodes.filter((node) => node.unresolvedCalls !== undefined).map((node) => [node.id, node.unresolvedCalls]));
  assert.deepEqual(counts['src/lib/handler.ts#ItemHandler.get'], { direct: 1 });
  assert.deepEqual(counts['src/lib/open.ts#lookupUncalled'], { direct: 1, bound: 1 });
  assert.deepEqual(counts['src/app/api/items/route.ts#PATCH'], { direct: 1, bound: 1 });
  assert.equal(counts['src/lib/store.ts#SqlItemStore.findItem'], undefined);
});

test('fixture: reach는 모드별로 간선을 따르고 evidence·unresolvedCalls·dispatch를 싣는다', async () => {
  const environment = { fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) };
  const roots = ['src/app/api/items/route.ts#GET', 'src/app/api/items/route.ts#PATCH', 'src/app/api/lookup/route.ts#GET'];
  const documents = Object.fromEntries(await Promise.all(['direct', 'bound', 'candidates'].map(async (mode) => {
    const result = await runReachCommand(['--project', fixture, '--dispatch', mode, ...roots], environment);
    assert.equal(result.exitCode, 0, result.standardError);
    return [mode, JSON.parse(result.standardOutput)] as const;
  })));
  type Row = { symbol: { usr: string }; roots: number[]; evidence: string; unresolvedCalls?: number };
  const rowOf = (mode: string, usr: string): Row | undefined => documents[mode].reached.find((row: Row) => row.symbol.usr === usr);
  const query = 'src/lib/store.ts#SqlClient.query';
  assert.equal(rowOf('direct', query), undefined);
  assert.deepEqual([rowOf('bound', query)?.roots, rowOf('bound', query)?.evidence], [[0, 2], 'bound']);
  // candidates에서는 PATCH(1)도 닿고, 그 root는 candidate 간선으로만 닿으므로 하한은 candidate다.
  assert.deepEqual([rowOf('candidates', query)?.roots, rowOf('candidates', query)?.evidence], [[0, 1, 2], 'candidate']);
  assert.equal(rowOf('bound', 'src/compose.ts#primaryHandler'), undefined);
  assert.deepEqual(documents.direct.reached.map((row: Row) => row.evidence).filter((evidence: string) => evidence !== 'direct'), []);
  assert.deepEqual(documents.bound.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, 1, undefined]);
  assert.deepEqual(documents.direct.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, 1, undefined]);
  assert.deepEqual(documents.candidates.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, undefined, undefined]);
  assert.equal(rowOf('direct', 'src/lib/handler.ts#ItemHandler.get')?.unresolvedCalls, 1);
  assert.equal(rowOf('bound', 'src/lib/handler.ts#ItemHandler.get')?.unresolvedCalls, undefined);
  assert.deepEqual(['direct', 'bound', 'candidates'].map((mode) => documents[mode].dispatch), ['direct', 'bound', 'candidates']);
  assert.ok(!documents.direct.limitations.some((line: string) => line.startsWith('bound-dispatch:')));
  assert.ok(documents.bound.limitations.some((line: string) => line.startsWith('bound-dispatch: 7 call(s)')));
  assert.ok(!documents.bound.limitations.some((line: string) => line.startsWith('candidate-dispatch:')));
  assert.ok(documents.candidates.limitations.some((line: string) => line.startsWith('candidate-dispatch: 4 call(s)')));
  assert.equal(new Set(Object.values(documents).map((document) => document.graphRevision)).size, 1);
  // 다른 root에서 닿은 root는 roots[]와 reached[]에 같은 unresolvedCalls를 싣는다(계약 검사 항목).
  const overlap = JSON.parse((await runReachCommand(['--project', fixture, '--dispatch', 'direct', roots[0]!, 'src/lib/handler.ts#ItemHandler.get'], environment)).standardOutput);
  const reachedRoot = overlap.reached.find((row: Row) => row.symbol.usr === 'src/lib/handler.ts#ItemHandler.get');
  assert.deepEqual([overlap.roots[1].unresolvedCalls, reachedRoot.unresolvedCalls, reachedRoot.roots], [1, 1, [0]]);
});

test('fixture: 같은 입력은 같은 그래프이고 graphRevision은 간선 근거를 덮는다', async () => {
  const again = await buildCallGraph(fixture, fileSystem);
  assert.deepEqual(again, graph);
  const flattened: CallGraph = { ...graph, edges: graph.edges.map((edge) => ({ ...edge, evidence: 'direct' as const })) };
  assert.notEqual(computeGraphRevision(flattened), computeGraphRevision(graph));
  const uncounted: CallGraph = { ...graph, nodes: graph.nodes.map(({ unresolvedCalls: _ignored, ...node }) => node) };
  assert.notEqual(computeGraphRevision(uncounted), computeGraphRevision(graph));
});

test('공개 패키지와 불완전 스캔에서는 내보낸 선언의 흐름을 증명하지 않는다', async () => {
  const files = {
    'src/store.ts': storeModule,
    'src/service.ts': 'import type { Store } from "./store";\nexport class Service { constructor(private readonly store: Store) {} run() { return this.store.find("a"); } }\n',
    'src/main.ts': 'import { Service } from "./service";\nimport { RemoteStore } from "./store";\nexport const run = () => new Service(new RemoteStore()).run();\n',
  };
  assert.deepEqual(dispatchEdges(await graphOf(files)), ['src/service.ts#Service.run -> src/store.ts#RemoteStore.find bound']);
  const published = await graphOf({ ...files, 'package.json': '{ "name": "lib", "exports": "./src/main.ts" }' });
  assert.deepEqual(dispatchEdges(published), [
    'src/service.ts#Service.run -> src/store.ts#LocalStore.find candidate',
    'src/service.ts#Service.run -> src/store.ts#RemoteStore.find candidate',
  ]);
  assert.ok(published.limitations.includes('bound-dispatch: package.json declares public entry points, so exported functions and classes and non-private properties are treated as reachable from unseen code and their flows are not bound'));
  const unreadable = await graphOf({ ...files, 'package.json': '{ "name": ' });
  assert.ok(unreadable.limitations.some((line) => line.startsWith('bound-dispatch: package.json could not be read')));
  assert.equal(dispatchEdges(unreadable).filter((line) => line.endsWith(' bound')).length, 0);
  assert.deepEqual(dispatchEdges(await graphOf({ ...files, 'package.json': '{ "name": "app", "private": true }' })).length, 1);
  const broken = await graphOf({ ...files, 'src/broken.ts': 'export const x = (;\n' });
  assert.ok(broken.limitations.some((line) => line.startsWith('bound-dispatch: the scan is incomplete')));
  assert.equal(dispatchEdges(broken).filter((line) => line.endsWith(' bound')).length, 0);
});

test('몽키 패치·반사적 쓰기·데코레이터·동적 import·값으로 쓰인 네임스페이스는 흐름을 연다', async () => {
  const shared = { 'src/store.ts': storeModule };
  const patched = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nconst store: Store = make();\nfunction make(): Store { const s = new RemoteStore(); s.find = () => "x"; return s; }\nexport const run = () => store.find("a");\n',
  });
  assert.deepEqual(dispatchEdges(patched).filter((line) => line.endsWith(' bound')), []);
  const reflective = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nconst deps: { store: Store } = { store: new RemoteStore() };\nObject.assign(deps, load());\ndeclare function load(): object;\nexport const run = () => deps.store.find("a");\nexport const err = () => Object.assign(new Error("x"), { code: 1 });\n',
  });
  assert.deepEqual(dispatchEdges(reflective).filter((line) => line.endsWith(' bound')), []);
  const decorated = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nfunction injectable<T>(value: T) { return value; }\n@injectable class Service { constructor(private readonly store: Store) {} run() { return this.store.find("a"); } }\nexport const run = () => new Service(new RemoteStore()).run();\n',
  });
  assert.deepEqual(dispatchEdges(decorated).filter((line) => line.endsWith(' bound')), []);
  const lazy = await graphOf({
    ...shared,
    'src/use.ts': 'import type { Store } from "./store";\nexport function use(store: Store) { return store.find("a"); }\n',
    'src/main.ts': 'import { RemoteStore } from "./store";\nimport { use } from "./use";\nexport const run = () => use(new RemoteStore());\nexport const later = () => import("./use");\n',
  });
  assert.deepEqual(dispatchEdges(lazy).filter((line) => line.endsWith(' bound')), []);
  const namespace = {
    ...shared,
    'src/use.ts': 'import type { Store } from "./store";\nexport function use(store: Store) { return store.find("a"); }\n',
    'src/main.ts': 'import { RemoteStore } from "./store";\nimport * as uses from "./use";\nexport const run = () => uses.use(new RemoteStore());\n',
  };
  assert.deepEqual(dispatchEdges(await graphOf(namespace)), ['src/use.ts#use -> src/store.ts#RemoteStore.find bound']);
  const escaped = await graphOf({ ...namespace, 'src/leak.ts': 'import * as uses from "./use";\nexport const all = uses;\n' });
  assert.deepEqual(dispatchEdges(escaped).filter((line) => line.endsWith(' bound')), []);
});

test('고립된 반환 객체 리터럴은 무관한 반사 대상과 분리해 bound 디스패치한다', async () => {
  const result = await graphOf({
    'src/main.ts': [
      'interface Service { run(): string; }',
      'type Maker = (config: Service) => { service: Service };',
      'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
      'const live: Service = new LiveService();',
      'declare const unknownRecord: Record<string, unknown>;',
      'Object.assign(unknownRecord, { unrelated: true });',
      'Reflect.set(unknownRecord, "other", true);',
      'function deps(_config: Service): { service: Service } { return { service: live }; }',
      'const { service } = deps(live);',
      'export const direct = () => service.run();',
      'function wrap(make: Maker, config: Service, callback: (service: Service) => string) {',
      '  function nestedNormal() { return arguments.length; } nestedNormal();',
      '  return () => { const { service } = make(config); callback(service); };',
      '}',
      'async function asyncWrap(make: Maker, config: Service, callback: (service: Service) => string) {',
      '  const { service } = make(config); callback(service);',
      '}',
      'function* generatorWrap(make: Maker, config: Service, callback: (service: Service) => string) {',
      '  const { service } = make(config); callback(service); yield 0;',
      '}',
      'export const handler = wrap(deps, live, (service) => service.run());',
      'export const asyncHandler = asyncWrap(deps, live, (service) => service.run());',
      'export const generatorHandler = generatorWrap(deps, live, (service) => service.run());',
    ].join('\n'),
  });
  const bound = result.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound');
  assert.ok(bound.some((edge) => edge.from === 'src/main.ts#direct'));
  assert.ok(bound.some((edge) => edge.from.includes('.wrap(')));
  assert.ok(bound.some((edge) => edge.from.includes('.asyncWrap(')));
  assert.ok(bound.some((edge) => edge.from.includes('.generatorWrap(')));
});

test('private memo가 재할당하는 반환 리터럴도 discarded ??=와 안전한 guard만 있으면 bound한다', async () => {
  const result = await graphOf({
    'src/main.ts': [
      'interface Service { run(): string; }',
      'type Maker = () => { service: Service };',
      'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
      'const live: Service = new LiveService();',
      'declare const unknownRecord: Record<string, unknown>;',
      'Object.assign(unknownRecord, { unrelated: true });',
      'Reflect.set(unknownRecord, "other", true);',
      'let memo: { service: Service } | null;',
      'function deps(): { service: Service } { if (!memo) memo ??= { service: live }; return memo; }',
      'function clear() { memo = null; }',
      'const { service } = deps();',
      'export const direct = () => service.run();',
      'function wrap(make: Maker, callback: (service: Service) => string) {',
      '  return () => { const { service } = make(); callback(service); };',
      '}',
      'export const handler = wrap(deps, (service) => service.run());',
      'clear();',
      'const { service: afterClear } = deps();',
      'export const afterClearRun = () => afterClear.run();',
    ].join('\n'),
  });
  const bound = result.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound');
  assert.ok(bound.some((edge) => edge.from === 'src/main.ts#direct'));
  assert.ok(bound.some((edge) => edge.from.includes('.wrap(')));
  assert.ok(bound.some((edge) => edge.from === 'src/main.ts#afterClearRun'));
});

test('private memo는 bare truthy return과 global undefined reset도 고립된 literal로 증명한다', async () => {
  const result = await graphOf({
    'src/main.ts': [
      'interface Service { run(): string; }',
      'type Container = { service: Service };',
      'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
      'const live: Service = new LiveService();',
      'declare const unknownRecord: Record<string, unknown>;',
      'Object.assign(unknownRecord, { unrelated: true });',
      'Reflect.set(unknownRecord, "other", true);',
      'let memo: Container | null | undefined = null;',
      'function deps() { if (memo) return memo; memo = { service: live }; return memo; }',
      'export function clear() { memo = undefined; }',
      'const { service } = deps();',
      'export const direct = () => service.run();',
      'clear();',
      'const { service: afterClear } = deps();',
      'export const afterClearRun = () => afterClear.run();',
    ].join('\n'),
  });
  const bound = result.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound');
  assert.ok(bound.some((edge) => edge.from === 'src/main.ts#direct'));
  assert.ok(bound.some((edge) => edge.from === 'src/main.ts#afterClearRun'));
});

test('private memo identity proof는 소비·export·setter·탈출·coercion·중첩 함수와 known write를 닫는다', async () => {
  const result = await graphOf({
    'src/main.ts': [
      'interface Service { run(): string; }',
      'type Container = { service: Service };',
      'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
      'const live: Service = new LiveService();',
      'declare const unknownRecord: Record<string, unknown>;',
      'declare const unknownService: Service;',
      'Object.assign(unknownRecord, { unrelated: true });',
      'Reflect.set(unknownRecord, "other", true);',
      'let consumedMemo: Container | null;',
      'function consumedDeps() { const leaked = (consumedMemo ??= { service: live }); return consumedMemo; }',
      'const { service: consumedService } = consumedDeps();',
      'export const consumedRun = () => consumedService.run();',
      'export let exportedMemo: Container | null;',
      'function exportedDeps() { exportedMemo ??= { service: live }; return exportedMemo; }',
      'const { service: exportedService } = exportedDeps();',
      'export const exportedRun = () => exportedService.run();',
      'let namedMemo: Container | null;',
      'let defaultMemo: Container | null;',
      'export { namedMemo };',
      'export default defaultMemo;',
      'function namedExportDeps() { namedMemo ??= { service: live }; return namedMemo; }',
      'function defaultExportDeps() { defaultMemo ??= { service: live }; return defaultMemo; }',
      'const { service: namedExportService } = namedExportDeps();',
      'const { service: defaultExportService } = defaultExportDeps();',
      'export const exportStyleRun = () => namedExportService.run() + defaultExportService.run();',
      'let setterMemo: Container | null;',
      'function setMemo(value: Container) { setterMemo = value; }',
      'function setterDeps() { setterMemo ??= { service: live }; return setterMemo; }',
      'setMemo({ service: unknownService });',
      'const { service: setterService } = setterDeps();',
      'export const setterRun = () => setterService.run();',
      'let wholeMemo: Container | null;',
      'function wholeDeps() { wholeMemo ??= { service: live }; return wholeMemo; }',
      'const wholeValue = wholeDeps();',
      'export const wholeRun = () => wholeValue.service.run();',
      'let memberMemo: Container | null;',
      'function memberDeps() { memberMemo ??= { service: live }; return memberMemo; }',
      'export const memberRun = () => memberDeps().service.run();',
      'let coercionMemo: Container | null;',
      'function coercionDeps() { coercionMemo ??= { service: live }; if (coercionMemo + "") return coercionMemo; return coercionMemo; }',
      'const { service: coercionService } = coercionDeps();',
      'export const coercionRun = () => coercionService.run();',
      'let arrowMemo: Container | null;',
      'function arrowDeps() { arrowMemo ??= { service: live }; const read = () => arrowMemo; return arrowMemo; }',
      'const { service: arrowService } = arrowDeps();',
      'export const arrowRun = () => arrowService.run();',
      'let resetMemo: Container | null;',
      'function resetDeps() { resetMemo ??= { service: live }; resetMemo ??= null; return resetMemo; }',
      'const { service: resetService } = resetDeps();',
      'export const resetRun = () => resetService.run();',
      'let knownMemo: Container | null;',
      'function knownDeps() { knownMemo ??= { service: live }; return knownMemo; }',
      'const { service: knownService } = knownDeps();',
      'Object.assign(knownDeps(), { service: live });',
      'export const knownRun = () => knownService.run();',
      'let resetShadowMemo: Container | null;',
      'function shadowReset(undefined: unknown) { resetShadowMemo = undefined; }',
      'function resetShadowDeps() { resetShadowMemo ??= { service: live }; return resetShadowMemo; }',
      'shadowReset(unknownService);',
      'const { service: resetShadowService } = resetShadowDeps();',
      'export const resetShadowRun = () => resetShadowService.run();',
      'function localMemoDeps() { let localMemo: Container | null; localMemo ??= { service: live }; return localMemo; }',
      'const { service: localMemoService } = localMemoDeps();',
      'export const localMemoRun = () => localMemoService.run();',
      'let multiMemo: Container | null;',
      'function multiDeps() { multiMemo ??= { service: live }; multiMemo = { service: live }; return multiMemo; }',
      'const { service: multiService } = multiDeps();',
      'export const multiRun = () => multiService.run();',
    ].join('\n'),
  });
  assert.deepEqual(result.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound'), []);
});

test('반환 리터럴 identity proof는 탈출·위험한 투영·열린 consumer를 모두 닫는다', async () => {
  const result = await graphOf({
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
    'src/main.ts': [
      'interface Service { run(): string; }',
      'type Maker = () => { service: Service };',
      'type Callback = (service: Service) => string;',
      'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
      'const live: Service = new LiveService();',
      'declare const unknownRecord: Record<string, unknown>;',
      'declare const flag: boolean;',
      'declare const unknownMaker: Maker;',
      'declare const unknownService: Service;',
      'Object.assign(unknownRecord, { unrelated: true });',
      'Reflect.set(unknownRecord, "other", true);',
      'function badWholeStore(): { service: Service } { return { service: live }; }',
      'const badWholeStoreValue = badWholeStore();',
      'export const badWholeStoreRun = () => badWholeStoreValue.service.run();',
      'function consumeWhole(value: { service: Service }) { return value.service.run(); }',
      'function badWholePass(): { service: Service } { return { service: live }; }',
      'export const badWholePassRun = () => consumeWhole(badWholePass());',
      'function badWholeReturn(): { service: Service } { return { service: live }; }',
      'function forwardWhole(): { service: Service } { return badWholeReturn(); }',
      'const badWholeReturnValue = forwardWhole();',
      'export const badWholeReturnRun = () => badWholeReturnValue.service.run();',
      'function badWholeAlias(): { service: Service } { return { service: live }; }',
      'const badWholeAliasValue = badWholeAlias();',
      'const badWholeAliasCopy = badWholeAliasValue;',
      'export const badWholeAliasRun = () => badWholeAliasCopy.service.run();',
      'function badWholeReflection(): { service: Service } { return { service: live }; }',
      'Object.assign(unknownRecord, badWholeReflection());',
      'export const badWholeReflectionRun = () => badWholeReflection().service.run();',
      'function badKnownReflection(): { service: Service } { return { service: live }; }',
      'Object.assign(badKnownReflection(), { service: live });',
      'export const badKnownReflectionRun = () => badKnownReflection().service.run();',
      'function badMethod(): { service: Service } { return { service: live, method() { return "method"; } }; }',
      'const { service: badMethodService } = badMethod();',
      'export const badMethodRun = () => badMethodService.run();',
      'function badGetter(): { service: Service } { return { get service() { return live; } }; }',
      'const { service: badGetterService } = badGetter();',
      'export const badGetterRun = () => badGetterService.run();',
      'function badSpread(): { service: Service } { return { ...{ service: live } }; }',
      'const { service: badSpreadService } = badSpread();',
      'export const badSpreadRun = () => badSpreadService.run();',
      'function badComputed(): { service: Service } { return { ["service"]: live }; }',
      'const { service: badComputedService } = badComputed();',
      'export const badComputedRun = () => badComputedService.run();',
      'function badProto(): { service: Service } { return { __proto__: {}, service: live }; }',
      'const { service: badProtoService } = badProto();',
      'export const badProtoRun = () => badProtoService.run();',
      'function badThen(): { service: Service } { return { service: live, then: live }; }',
      'const { service: badThenService } = badThen();',
      'export const badThenRun = () => badThenService.run();',
      'function badDefaultProjection(): { service: Service } { return { service: live }; }',
      'const { service: badDefaultService = live } = badDefaultProjection();',
      'export const badDefaultRun = () => badDefaultService.run();',
      'function prefixWrap(_prefix: unknown, make: Maker, callback: Callback) { const { service } = make(); callback(service); }',
      'function badPrefix(): { service: Service } { return { service: live }; }',
      'declare const prefixArgs: unknown[];',
      'export const badPrefixRun = () => prefixWrap(...prefixArgs, badPrefix, (service) => service.run());',
      'function argumentsWrap(make: Maker, callback: Callback) { const invoke = () => { const { service } = make(); callback(service); return arguments; }; return invoke(); }',
      'function badArguments(): { service: Service } { return { service: live }; }',
      'export const badArgumentsRun = () => argumentsWrap(badArguments, (service) => service.run());',
      'function shorthandArgumentsWrap(make: Maker, callback: Callback) { const invoke = () => { const leaked = { arguments }; const { service } = make(); callback(service); return leaked; }; return invoke(); }',
      'function badShorthandArguments(): { service: Service } { return { service: live }; }',
      'export const badShorthandArgumentsRun = () => shorthandArgumentsWrap(badShorthandArguments, (service) => service.run());',
      'function defaultArgumentsWrap(make: Maker, callback: Callback = arguments[0] as Callback) { const { service } = make(); callback(service); }',
      'function badDefaultArguments(): { service: Service } { return { service: live }; }',
      'export const badDefaultArgumentsRun = () => defaultArgumentsWrap(badDefaultArguments, (service) => service.run());',
      'function computedMethodWrap(make: Maker, callback: Callback) { const value = { [keyFrom(arguments[0])]() { return "key"; } }; const { service } = make(live); callback(service); return value; }',
      'function keyFrom(_value: unknown) { return "key"; }',
      'function badComputedMethod(): { service: Service } { return { service: live }; }',
      'export const badComputedMethodRun = () => computedMethodWrap(badComputedMethod, (service) => service.run());',
      'function heritageWrap(make: Maker, callback: Callback) { class Derived extends baseFrom(arguments[0]) {} const { service } = make(live); callback(service); return Derived; }',
      'function baseFrom(_value: unknown) { return class Base {}; }',
      'function badHeritage(): { service: Service } { return { service: live }; }',
      'export const badHeritageRun = () => heritageWrap(badHeritage, (service) => service.run());',
      'function classComputedWrap(make: Maker, callback: Callback) { class Computed { [keyFrom(arguments[0])]() { return "key"; } } const { service } = make(live); callback(service); return Computed; }',
      'function badClassComputed(): { service: Service } { return { service: live }; }',
      'export const badClassComputedRun = () => classComputedWrap(badClassComputed, (service) => service.run());',
      'function decoratorWrap(make: Maker, callback: Callback) { @mark(arguments[0]) class Decorated {} const { service } = make(live); callback(service); return Decorated; }',
      'function mark(_value: unknown) { return () => {}; }',
      'function badDecorator(): { service: Service } { return { service: live }; }',
      'export const badDecoratorRun = () => decoratorWrap(badDecorator, (service) => service.run());',
      'function assignedParam(make: Maker, callback: Callback) { make = unknownMaker; const { service } = make(); callback(service); }',
      'function badAssigned(): { service: Service } { return { service: live }; }',
      'export const badAssignedRun = () => assignedParam(badAssigned, (service) => service.run());',
      'function defaultParam(make: Maker = badAssigned, callback: Callback) { const { service } = make(); callback(service); }',
      'export const badParamDefaultRun = () => defaultParam(badAssigned, (service) => service.run());',
      'function restParam(...makes: Maker[]) { const make = makes[0]!; const { service } = make(); return service.run(); }',
      'export const badParamRestRun = () => restParam(badAssigned);',
      'function optionalParam(make?: Maker, callback?: Callback) { const { service } = make!(); callback!(service); }',
      'export const badParamOptionalRun = () => optionalParam(badAssigned, (service) => service.run());',
      'function forwardedParam(make: Maker, callback: Callback) { return prefixWrap(0, make, callback); }',
      'export const badParamForwardedRun = () => forwardedParam(badAssigned, (service) => service.run());',
      'function zeroParam(_make: Maker, callback: Callback) { callback(unknownService); }',
      'export const badParamZeroRun = () => zeroParam(badAssigned, (service) => service.run());',
      'function badMixed(): { service: Service } { return { service: live }; }',
      'const { service: badMixedService } = badMixed();',
      'const badMixedValue = badMixed();',
      'export const badMixedRun = () => badMixedService.run();',
      'function badRecursive(): { service: Service } { if (flag) { const { service } = badRecursive(); return { service }; } return { service: live }; }',
      'const { service: badRecursiveService } = badRecursive();',
      'export const badRecursiveRun = () => badRecursiveService.run();',
    ].join('\n'),
  });
  assert.deepEqual(result.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound'), []);
});

test('반환 리터럴 identity proof는 공개·opaque·async·generator 범위에서 열려 있다', async () => {
  const source = [
    'interface Service { run(): string; }',
    'class LiveService implements Service { private readonly brand = true; run() { return "live"; } }',
    'const live: Service = new LiveService();',
    'declare const unknownRecord: Record<string, unknown>;',
    'Object.assign(unknownRecord, { unrelated: true });',
    'function factory(): { service: Service } { return { service: live }; }',
    'const { service } = factory();',
    'export const run = () => service.run();',
  ].join('\n');
  const open = await graphOf({
    'package.json': '{ "name": "public-package", "exports": "./src/main.ts" }',
    'src/main.ts': source,
  });
  assert.deepEqual(open.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound'), []);

  const opaqueAsyncGenerator = await graphOf({
    'src/main.ts': [
      source,
      'declare const moduleName: string;',
      'const opaque = import(moduleName);',
      'async function asyncFactory(): Promise<{ service: Service }> { return { service: live }; }',
      'export const asyncRun = () => asyncFactory().then((value) => value.service.run());',
      'function* generatorFactory(): Generator<never, { service: Service }> { return { service: live }; }',
      'export const generatorRun = () => generatorFactory().return(undefined);',
    ].join('\n'),
  });
  assert.deepEqual(opaqueAsyncGenerator.edges.filter((edge) => edge.to === 'src/main.ts#LiveService.run' && edge.evidence === 'bound'), []);
});

test('하위 클래스 생성·super 인자·this 필드·재대입 변수·구조 분해·getter·조건식·async 팩터리를 따라간다', async () => {
  const result = await graphOf({
    'src/store.ts': storeModule,
    'src/base.ts': [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      'export class Base { constructor(protected readonly store: Store) {} run() { return this.store.find("a"); } }',
      'export class Implicit extends Base {}',
      'export class Explicit extends Base { constructor() { super(new LocalStore()); } }',
      'export const made = [new Implicit(new RemoteStore()), new Explicit()];',
      'let current: Store = new RemoteStore();',
      'export function swap() { current = new LocalStore(); }',
      'export function readCurrent() { return current.find("b"); }',
      'function destructured({ store }: { store: Store }) { return store.find("c"); }',
      'export const viaDestructuring = () => destructured({ store: new RemoteStore() });',
      'class Holder { private readonly inner: Store = new LocalStore(); get store(): Store { return this.inner; } read() { return this.store.find("d"); } }',
      'export const holder = new Holder();',
      'declare const flag: boolean;',
      'const chosen: Store = flag ? new RemoteStore() : new LocalStore();',
      'export const readChosen = () => chosen.find("e");',
      'async function build(): Promise<Store> { return new RemoteStore(); }',
      'export async function readBuilt() { const store = await build(); return store.find("f"); }',
    ].join('\n'),
  });
  assert.deepEqual(dispatchEdges(result), [
    'src/base.ts#Base.run -> src/store.ts#LocalStore.find bound',
    'src/base.ts#Base.run -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#Holder.read -> src/store.ts#LocalStore.find bound',
    'src/base.ts#destructured -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readBuilt -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readChosen -> src/store.ts#LocalStore.find bound',
    'src/base.ts#readChosen -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readCurrent -> src/store.ts#LocalStore.find bound',
    'src/base.ts#readCurrent -> src/store.ts#RemoteStore.find bound',
  ]);
});

test('union 수신자의 인터페이스 부분만 bound로 잇고, 순환 흐름도 끝난다', async () => {
  const result = await graphOf({
    'src/store.ts': storeModule,
    'src/main.ts': [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      'class Direct { find(id: string) { return id; } }',
      'const either: Direct | Store = pick();',
      'function pick(): Direct | Store { return new RemoteStore(); }',
      'export const readEither = () => either.find("a");',
      'let a: Store = new LocalStore();',
      'let b: Store = a;',
      'export function rotate() { a = b; b = a; }',
      'export const readA = () => a.find("b");',
      'export { a as aliasA };',
    ].join('\n'),
  });
  const lines = result.edges.filter((edge) => edge.from.endsWith('readEither') || edge.from.endsWith('readA')).map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
  assert.deepEqual(lines, [
    'src/main.ts#readA -> src/store.ts#LocalStore.find bound',
    'src/main.ts#readEither -> src/main.ts#Direct.find direct',
    'src/main.ts#readEither -> src/store.ts#RemoteStore.find bound',
  ]);
  assert.deepEqual(result.statistics.calls.dispatch, { bound: 1, boundPartial: 1, candidate: 0, candidatePartial: 0, overBudget: 0 });
});

test('진입점 별칭(export { h as GET })의 대상 함수 매개변수는 열린 자리다', async () => {
  const result = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'src/store.ts': storeModule,
    'app/api/x/route.ts': [
      'import { LocalStore, type Store } from "../../../src/store";',
      'async function handle(request: Request, store: Store = new LocalStore()) { return new Response(store.find(request.url)); }',
      'export { handle as GET };',
    ].join('\n'),
  });
  assert.deepEqual(dispatchEdges(result), [
    'app/api/x/route.ts#handle -> src/store.ts#LocalStore.find candidate',
    'app/api/x/route.ts#handle -> src/store.ts#RemoteStore.find candidate',
  ]);
});

test('모듈 200개에 흩어진 주입 호출도 모두 bound로 잇고 예산 안에 끝난다', async () => {
  const count = 200;
  const files: Record<string, string> = { 'src/store.ts': storeModule };
  for (let index = 0; index < count; index++) {
    const previous = index === 0 ? '' : `import { handler${index - 1} } from "./handler${index - 1}";\n`;
    const chain = index === 0 ? '' : ` handler${index - 1}.handle();`;
    files[`src/handler${index}.ts`] = [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      previous,
      `export interface Deps${index} { store: Store; fallback?: Store }`,
      `export class Handler${index} {`,
      `  constructor(private readonly deps: Deps${index}) {}`,
      `  handle(): string {${chain} return this.deps.store.find("${index}"); }`,
      '}',
      `export const handler${index} = new Handler${index}({ store: ${index % 2 === 0 ? 'new RemoteStore()' : 'new LocalStore()'} });`,
    ].join('\n');
  }
  const started = performance.now();
  const result = await graphOf(files);
  const elapsed = performance.now() - started;
  assert.equal(result.statistics.calls.dispatch.bound, count);
  assert.equal(result.edges.filter((edge) => edge.evidence === 'bound').length, count);
  assert.ok(elapsed < 60_000, `took ${Math.round(elapsed)} ms`);
});

test('export *로 route 파일에 다시 내보낸 핸들러와 스크립트(비모듈) 파일의 전역 함수는 열린 자리다', async () => {
  const result = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'src/store.ts': storeModule,
    'src/impl.ts': [
      'import { LocalStore, type Store } from "./store";',
      'export async function GET(request: Request, store: Store = new LocalStore()) { return new Response(store.find(request.url)); }',
      'export const warm = () => GET(new Request("http://x"));',
    ].join('\n'),
    'app/api/x/route.ts': 'export * from "../../../src/impl";\n',
    'src/legacy.js': [
      '/** @param {import("./store").Store} store */',
      'function legacyFind(store) { return store.find("x"); }',
      'legacyFind(new (require("./store").LocalStore)());',
    ].join('\n'),
  });
  assert.deepEqual(result.edges.filter((edge) => edge.evidence === 'bound'), []);
});

test('흔한 멤버 이름의 쓰기·읽기가 모듈 600개에 흩어져도 메모로 예산 안에서 모두 bound로 잇는다', async () => {
  const count = 600;
  const files: Record<string, string> = { 'src/store.ts': storeModule };
  for (let index = 0; index < count; index++) {
    files[`src/m${index}.ts`] = [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      `export interface Deps${index} { store: Store }`,
      `export class Handler${index} { store: Store; constructor(private readonly deps: Deps${index}) { this.store = deps.store; } run(): string { return this.deps.store.find("${index}") + this.store.find("x"); } }`,
      `export const h${index} = new Handler${index}({ store: ${index % 2 === 0 ? 'new RemoteStore()' : 'new LocalStore()'} });`,
      `const other${index} = { store: new LocalStore() as Store, run: () => "o" };`,
      `export function rewire${index}() { other${index}.store = new RemoteStore(); }`,
      `export function call${index}() { const fn = other${index}.run; return fn(); }`,
    ].join('\n');
  }
  const started = performance.now();
  const result = await graphOf(files);
  const elapsed = performance.now() - started;
  assert.deepEqual(result.statistics.calls.dispatch, { bound: 2 * count, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 });
  // 메모 전(18547b7)에는 같은 모양 1,500개 모듈에서 21.7초, 메모 후 2.5초였다.
  assert.ok(elapsed < 30_000, `took ${Math.round(elapsed)} ms`);
});
