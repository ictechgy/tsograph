import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { isCanonicalTemplate } from '../exchange/route-template-grammar.ts';
import { buildCallGraph } from '../graph/build-graph.ts';
import {
  extractNavigationRoutes,
  MAX_ROUTER_MODELS,
  parseRouterModels,
  RouterModelError,
  type RouterModels,
} from './navigation-routes.ts';

const baseModel = {
  factory: { path: 'src/router-api.ts', name: 'registerScreens' },
  routesArgument: 0,
  pathProperty: 'path',
  screenProperty: 'screen',
  childrenProperty: 'children',
  pathSyntax: 'colon',
} as const;

const model: RouterModels = {
  format: 'router-models',
  version: 1,
  models: [baseModel],
};

async function fixture(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-navigation-')));
  const defaults = {
    'src/router-api.ts': 'export function registerScreens(input: unknown) { return input; }',
    'src/screens.tsx': [
      'export function Catalog() { return null; }',
      'export function Detail() { return null; }',
      'export const Arrow = () => null;',
      'export class Settings {}',
    ].join('\n'),
  };
  for (const [path, source] of Object.entries({ ...defaults, ...files })) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('configured declaration identity yields screen URLs and actual graph ids', async () => {
  await fixture({
    'src/router.tsx': `import { registerScreens as routes } from './router-api';
import { Catalog, Detail } from './screens';
const stable = routes;
stable([{ path: '/catalog', screen: Catalog, children: [{ path: ':id', screen: <Detail /> }] }]);
const closed = [{ path: '/closed', screen: Catalog }];
stable(closed);
function registerScreens(input: unknown) { return input; }
registerScreens([{ path: '/unrelated', screen: Catalog }]);
`,
  }, async (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.equal(doc.format, 'navigation-facts');
    assert.equal(doc.project, root);
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.screen?.usr]), [
      ['/catalog', 'src/screens.tsx#Catalog'],
      ['/catalog/{}', 'src/screens.tsx#Detail'],
      ['/closed', 'src/screens.tsx#Catalog'],
    ]);
    assert.ok(doc.facts.every((fact) => fact.dynamic === false));
    assert.ok(doc.facts.every((fact) => fact.kind === 'screen-route'));
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const ids = new Set(graph.nodes.map((node) => node.id));
    assert.ok(doc.facts.every((fact) => ids.has(fact.screen!.usr)));
  });
});

test('router model parser enforces closed bounded JSON and safe unique factories', () => {
  assert.deepEqual(parseRouterModels(JSON.stringify(model)), model);
  const bad = [
    '{',
    '{"format":"router-models","format":"router-models","version":1,"models":[]}',
    JSON.stringify({ ...model, extra: true }),
    JSON.stringify({ ...model, models: [{ ...baseModel, extra: true }] }),
    JSON.stringify({ ...model, models: [{ ...baseModel, factory: { ...baseModel.factory, extra: true } }] }),
    JSON.stringify({
      ...model,
      models: [{ ...baseModel, factory: { path: '../outside.ts', name: 'registerScreens' } }],
    }),
    JSON.stringify({ ...model, models: [{ ...baseModel, routesArgument: 65 }] }),
    JSON.stringify({ ...model, models: [baseModel, baseModel] }),
    '['.repeat(40) + '0' + ']'.repeat(40),
    'x'.repeat(1_048_577),
  ];
  for (const source of bad) assert.throws(() => parseRouterModels(source));
  const tooMany = Array.from({ length: MAX_ROUTER_MODELS + 1 }, (_, index) => ({
    ...baseModel,
    factory: { path: `src/factory-${index}.ts`, name: 'registerScreens' },
  }));
  assert.throws(() => parseRouterModels(JSON.stringify({ ...model, models: tooMany })));
  assert.throws(() => parseRouterModels('{"models":[{"factory":{"path":"a.ts","path":"b.ts"}}]}'));
});

test('router model scanner classifies malformed JSON boundaries and bounded collections', () => {
  const cases: ReadonlyArray<readonly [string, RouterModelError['code']]> = [
    [`\u00A0${JSON.stringify(model)}`, 'invalid-json'],
    ['{}', 'invalid-shape'],
    ['[]', 'invalid-shape'],
    ['!', 'invalid-json'],
    [`{"${'x'.repeat(2049)}":0}`, 'unsafe-value'],
    ['{"value":"\\uZZZZ"}', 'invalid-json'],
    ['{"value":"unterminated}', 'invalid-json'],
    ['truX', 'invalid-json'],
    [`[${'0,'.repeat(100_000)}0]`, 'too-many-nodes'],
  ];
  for (const [source, code] of cases) {
    assert.throws(
      () => parseRouterModels(source),
      (error: unknown) => error instanceof RouterModelError && error.code === code,
      code,
    );
  }
  const { childrenProperty: _children, ...withoutChildren } = baseModel;
  const parsed = parseRouterModels(JSON.stringify({
    ...model,
    models: [{ ...withoutChildren, pathProperty: 'route-path', screenProperty: 'route-screen' }],
  }));
  assert.equal(parsed.models[0]?.childrenProperty, undefined);
  assert.equal(parsed.models[0]?.pathProperty, 'route-path');
  assert.throws(() => parseRouterModels(JSON.stringify({
    ...model,
    models: [{ ...baseModel, screenProperty: baseModel.pathProperty }],
  })), (error: unknown) => error instanceof RouterModelError && error.code === 'unsafe-value');
  assert.throws(() => parseRouterModels(JSON.stringify({ ...model, models: [] })),
    (error: unknown) => error instanceof RouterModelError && error.code === 'invalid-shape');
});

test('missing, spread, hole and non-object registrations stay dynamic while a screen alias resolves', async () => {
  await fixture({
    'src/broken.ts': 'export function broken(',
    'src/router.ts': `import { registerScreens as routes } from './router-api';
import { Catalog } from './screens';
declare const unknown: unknown[];
routes();
routes(...unknown);
const CatalogAlias = Catalog;
routes([, 42, { path: '/alias', screen: CatalogAlias }]);`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.equal(doc.facts.length, 5);
    assert.equal(doc.facts.filter((fact) => fact.dynamic).length, 4);
    const alias = doc.facts.at(-1)!;
    assert.equal(alias.urlTemplate, '/alias');
    assert.equal(alias.dynamic, false);
    assert.equal(alias.location.path, 'src/router.ts');
    assert.equal(alias.screen?.usr, 'src/screens.tsx#Catalog');
    assert.ok(doc.limitations.some((entry) => entry.includes('route container: 2')));
    assert.ok(doc.limitations.some((entry) => entry.includes('route entry: 2')));
    assert.ok(doc.limitations.some((entry) => entry.includes('1 production source file(s) had parse errors')));
  });
});

test('exported and escaped arrays stay dynamic while a shared closed array is reusable', async () => {
  await fixture({
    'src/router.ts': `import { registerScreens as routes } from './router-api';
import { Catalog } from './screens';
export const exportedRoutes = [{ path: '/exported', screen: Catalog }];
const escapedRoutes = [{ path: '/escaped', screen: Catalog }];
inspect(escapedRoutes);
const sharedRoutes = [{ path: '/shared', screen: Catalog }];
routes(exportedRoutes);
routes(escapedRoutes);
routes(sharedRoutes);
routes(sharedRoutes);
declare function inspect(value: unknown): void;`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.dynamic]), [
      [null, true],
      [null, true],
      ['/shared', false],
      ['/shared', false],
    ]);
    assert.ok(doc.limitations.some((entry) => entry.includes('unproven route container: 2')),
      JSON.stringify(doc.limitations));
    assert.ok(!doc.facts.some((fact) => fact.urlTemplate === '/exported'
      || fact.urlTemplate === '/escaped'));
  });
});

test('a parse-error global script mutation still opens a clean registration', async () => {
  await fixture({
    'src/router-api.ts': 'function registerScreens(input: unknown) { return input; }',
    'src/screens.tsx': 'function Catalog() { return null; }',
    'src/globals.ts': "const sharedRoutes = [{ path: '/before', screen: Catalog }];",
    'src/broken.ts': `sharedRoutes.push({ path: '/after', screen: Catalog });
function broken(`,
    'src/router.ts': 'registerScreens(sharedRoutes);',
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.dynamic]), [[null, true]]);
    assert.ok(doc.limitations.some((entry) => entry.includes('mutated route container: 1')));
    assert.ok(doc.limitations.some((entry) => entry.includes('1 production source file(s) had parse errors')));
  });
});

test('shared children remain conservatively dynamic without being called mutated', async () => {
  await fixture({
    'src/router.ts': `import { registerScreens } from './router-api';
import { Catalog } from './screens';
const children = [{ path: 'child', screen: Catalog }];
registerScreens([
  { path: '/first', screen: Catalog, children: children },
  { path: '/second', screen: Catalog, children: children },
]);`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.dynamic]), [
      ['/first', false],
      [null, true],
      ['/second', false],
      [null, true],
    ]);
    assert.ok(doc.limitations.some((entry) => entry.includes('unproven route container: 2')));
    assert.ok(!doc.limitations.some((entry) => entry.includes('mutated route container')));
  });
});

test('binding analysis exhaustion fails instead of returning an empty successful document', async () => {
  await fixture({
    'src/large.ts': '0;\n'.repeat(500_100),
    'src/router.ts': `import { registerScreens } from './router-api';
import { Catalog } from './screens';
registerScreens([{ path: '/unreachable', screen: Catalog }]);`,
  }, (root) => {
    assert.throws(
      () => extractNavigationRoutes(root, model, 'test', new Date(0)),
      (error: unknown) => error instanceof Error
        && error.name === 'NavigationBindingLimitError'
        && error.message.includes('binding analysis'),
    );
  });
});

test('anonymous default classes are emitted only when their shared graph id exists', async () => {
  await fixture({
    'src/screens.ts': `export { default as Screen } from './screen';
export { default as Empty } from './empty';`,
    'src/screen.ts': 'export default class { render() {} }',
    'src/empty.ts': 'export default class {}',
    'src/router.ts': `import { registerScreens } from './router-api';
import { Screen, Empty } from './screens';
registerScreens([
  { path: '/screen', screen: Screen },
  { path: '/empty', screen: Empty },
]);`,
  }, async (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.equal(doc.facts[0]?.screen?.usr, 'src/screen.ts#default');
    assert.equal(doc.facts[0]?.dynamic, false);
    assert.equal(doc.facts[1]?.screen, undefined);
    assert.equal(doc.facts[1]?.dynamic, true);
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const ids = new Set(graph.nodes.map((node) => node.id));
    assert.ok(ids.has(doc.facts[0]!.screen!.usr));
  });
});

test('test-source and intrinsic JSX screens cannot become project graph identities', async () => {
  await fixture({
    'src/Hidden.test.tsx': 'export function Hidden() { return null; }',
    'src/router.tsx': `import { registerScreens } from './router-api';
import { Hidden } from './Hidden.test';
registerScreens([
  { path: '/test-screen', screen: Hidden },
  { path: '/intrinsic', screen: <div /> },
]);`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.dynamic, fact.screen]), [
      ['/test-screen', true, undefined],
      ['/intrinsic', true, undefined],
    ]);
    assert.ok(doc.limitations.some((entry) => entry.includes('screen: 2')));
  });
});

test('mutation, spreads and unknown values emit measured dynamic facts without guesses', async () => {
  await fixture({
    'src/router.tsx': `import { registerScreens as routes } from './router-api';
import { Catalog, Detail } from './screens';
const changed = [{ path: '/changed', screen: Catalog }];
changed.push({ path: '/later', screen: Detail });
routes(changed);
const extra = [{ path: '/spread', screen: Catalog }];
const routeExtra = { title: 'not a route key' };
const runtimePath = Math.random() ? '/a' : '/b';
const unknownChildren = getChildren();
routes([
  { path: '/known', screen: Catalog },
  ...extra,
  { path: runtimePath, screen: Catalog, children: [
    { path: 'relative-child', screen: Detail },
    { path: '/absolute-child', screen: Detail },
  ] },
  { path: '/ambiguous', screen: Math.random() ? Catalog : Detail },
  { path: '/no-screen' },
  { path: '/object-spread', screen: Catalog, ...routeExtra },
  { path: '/parent', screen: Catalog, children: unknownChildren },
]);
declare function getChildren(): unknown[];
`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.deepEqual(doc.facts.filter((fact) => !fact.dynamic).map((fact) => fact.urlTemplate), [
      '/known',
      '/absolute-child',
      '/parent',
    ]);
    assert.ok(doc.facts.some((fact) => fact.dynamic
      && fact.urlTemplate === null && fact.screen === undefined));
    assert.ok(doc.facts.some((fact) => fact.dynamic
      && fact.urlTemplate === null && fact.screen?.usr === 'src/screens.tsx#Catalog'));
    assert.ok(doc.facts.some((fact) => fact.dynamic
      && fact.urlTemplate === null && fact.screen?.usr === 'src/screens.tsx#Detail'));
    assert.ok(doc.facts.some((fact) => fact.dynamic
      && fact.urlTemplate === '/ambiguous' && fact.screen === undefined));
    assert.equal(doc.facts.filter((fact) => fact.dynamic
      && fact.urlTemplate === '/no-screen' && fact.screen === undefined).length, 1);
    assert.ok(doc.limitations.some((entry) => entry.includes('mutated route container: 1')));
    assert.ok(doc.limitations.some((entry) => entry.includes('array spread: 1')));
    assert.ok(doc.limitations.some((entry) => entry.includes('object shape: 1')));
    assert.ok(doc.limitations.some((entry) => entry.includes('path: 2')));
    assert.ok(doc.limitations.some((entry) => entry.includes('screen: 2')));
    assert.ok(doc.limitations.some((entry) => entry.includes('children: 1')));
    assert.ok(!doc.facts.some((fact) => fact.urlTemplate === '/changed'
      || fact.urlTemplate === '/later' || fact.urlTemplate === '/spread'
      || fact.urlTemplate === '/object-spread'));
    const parentIndex = doc.facts.findIndex((fact) => fact.urlTemplate === '/parent');
    assert.ok(parentIndex >= 0);
    assert.equal(doc.facts[parentIndex + 1]?.dynamic, true);
    assert.equal(doc.facts[parentIndex + 1]?.urlTemplate, null);
  });
});

test('template paths join nested routes, reset absolute children, and report UTF-8 locations', async () => {
  const prefix = 'const 한글 = 1; ';
  const registration = `routes([{ path: '/root', screen: Catalog, children: [
  { path: childPath, screen: Arrow },
  { path: '/reset', screen: <Settings /> },
  { path: '/설정 space', screen: Catalog },
] }, { path: '/empty/', screen: Catalog, children: [] }]);`;
  await fixture({
    'src/router.tsx': `import { registerScreens as routes } from './router-api';
import { Catalog, Arrow, Settings } from './screens';
const childPath = '{id}' as const;
${prefix}${registration}
`,
    'src/ignored.test.tsx': `import { registerScreens } from './router-api';
import { Catalog } from './screens';
registerScreens([{ path: '/test-only', screen: Catalog }]);`,
  }, (root) => {
    const templateModel: RouterModels = {
      ...model,
      models: [
        { ...baseModel, pathSyntax: 'template' },
        {
          ...baseModel,
          factory: { path: 'src/stale-router.ts', name: 'registerScreens' },
          pathSyntax: 'template',
        },
      ],
    };
    const doc = extractNavigationRoutes(root, templateModel, 'test', new Date(0));
    assert.ok(doc.facts.every((fact) => fact.urlTemplate === null
      || isCanonicalTemplate(fact.urlTemplate)));
    assert.deepEqual(doc.facts.map((fact) => [fact.urlTemplate, fact.screen?.usr]), [
      ['/root', 'src/screens.tsx#Catalog'],
      ['/root/{}', 'src/screens.tsx#Arrow'],
      ['/reset', 'src/screens.tsx#Settings'],
      ['/%EC%84%A4%EC%A0%95%20space', 'src/screens.tsx#Catalog'],
      ['/empty/', 'src/screens.tsx#Catalog'],
    ]);
    const rootFact = doc.facts[0]!;
    assert.equal(rootFact.location.path, 'src/router.tsx');
    assert.equal(rootFact.location.line, 4);
    assert.equal(rootFact.location.column, Buffer.byteLength(`${prefix}routes([`) + 1);
    assert.ok(!doc.facts.some((fact) => fact.urlTemplate === '/test-only'));
    assert.ok(!doc.limitations.some((entry) => entry.startsWith('navigation-coverage:')));
    assert.ok(doc.limitations.some((entry) => entry.includes('1 configured router model(s) matched no exact')));
  });
});

test('mutable factory, path and component bindings never become static identities', async () => {
  await fixture({
    'src/router-api.ts': `export function registerScreens(input: unknown) { return input; }
export let mutableFactory = (input: unknown) => input;`,
    'src/screens.tsx': `export function Catalog() { return null; }
export let Mutable = () => null;`,
    'src/router.ts': `import { registerScreens, mutableFactory } from './router-api';
import { Catalog, Mutable } from './screens';
let mutablePath = '/before';
mutablePath = '/after';
registerScreens([
  { path: mutablePath, screen: Catalog },
  { path: '/mutable-screen', screen: Mutable },
]);
mutableFactory([{ path: '/mutable-factory', screen: Catalog }]);`,
  }, (root) => {
    const models: RouterModels = {
      ...model,
      models: [
        baseModel,
        { ...baseModel, factory: { path: 'src/router-api.ts', name: 'mutableFactory' } },
      ],
    };
    const doc = extractNavigationRoutes(root, models, 'test', new Date(0));
    assert.equal(doc.facts.length, 2);
    assert.ok(doc.facts.every((fact) => fact.dynamic));
    assert.ok(doc.facts.some((fact) => fact.urlTemplate === null
      && fact.screen?.usr === 'src/screens.tsx#Catalog'));
    assert.ok(doc.facts.some((fact) => fact.urlTemplate === '/mutable-screen'
      && fact.screen === undefined));
    assert.ok(!doc.facts.some((fact) => fact.urlTemplate === '/mutable-factory'));
    assert.ok(doc.limitations.some((entry) => entry.includes('1 configured router model(s) matched no exact')));
  });
});

test('navigation recursion is bounded and becomes a measured dynamic fact', async () => {
  let entry = "{ path: 'leaf', screen: Catalog }";
  for (let index = 0; index < 66; index++) {
    entry = `{ path: 'p${index}', screen: Catalog, children: [${entry}] }`;
  }
  await fixture({
    'src/router.ts': `import { registerScreens } from './router-api';
import { Catalog } from './screens';
registerScreens([${entry}]);`,
  }, (root) => {
    const doc = extractNavigationRoutes(root, model, 'test', new Date(0));
    assert.ok(doc.facts.some((fact) => fact.dynamic));
    assert.ok(doc.limitations.some((entry) => entry.includes('nesting depth: 1')));
    assert.ok(doc.facts.length <= 65);
  });
});
