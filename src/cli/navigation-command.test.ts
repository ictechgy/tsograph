import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_GRAPH_CONFIG_BYTES } from '../graph/bounded-config-reader.ts';
import { MAX_ROUTER_MODEL_BYTES } from '../routes/navigation-routes.ts';
import {
  navigationUsage,
  runNavigationCommand,
  type NavigationEnvironment,
} from './navigation-command.ts';
import {
  createNodeFileSystem,
  type CommandFileSystem,
} from './file-system.ts';

const fixedNow = () => new Date('2026-10-09T01:02:03.456Z');
const routerModel = {
  format: 'router-models',
  version: 1,
  models: [{
    factory: { path: 'src/router-api.ts', name: 'registerScreens' },
    routesArgument: 0,
    pathProperty: 'path',
    screenProperty: 'screen',
    childrenProperty: 'children',
    pathSyntax: 'colon',
  }],
};

interface Fixture {
  readonly root: string;
  readonly modelPath: string;
}

async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-navigation-cli-')));
  mkdirSync(join(root, 'src'));
  const modelPath = join(root, 'router-model.json');
  writeFileSync(modelPath, JSON.stringify(routerModel));
  writeFileSync(
    join(root, 'src/router-api.ts'),
    'export function registerScreens(input: unknown) { return input; }',
  );
  writeFileSync(
    join(root, 'src/screens.tsx'),
    'export function Catalog() { return null; }',
  );
  writeFileSync(
    join(root, 'src/router.tsx'),
    `import { registerScreens } from './router-api';
import { Catalog } from './screens';
registerScreens([{ path: '/catalog', screen: Catalog }]);`,
  );
  try {
    await run({ root, modelPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function environment(fileSystem: CommandFileSystem = createNodeFileSystem()): NavigationEnvironment {
  return { fileSystem, toolVersion: '0.0.0-test', now: fixedNow };
}

test('actual project produces sorted navigation JSON with a fixed UTC timestamp', async () => {
  await fixture(async ({ root }) => {
    const result = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--generated-at', '2026-01-02T03:04:05Z',
      '--format', 'json',
    ], environment());
    assert.equal(result.exitCode, 0, result.standardError);
    assert.equal(result.standardError, '');
    assert.ok(result.standardOutput.endsWith('\n'));
    assert.match(result.standardOutput, /^\{\n  "facts":/u);
    const document = JSON.parse(result.standardOutput) as {
      generatedAt: string;
      platform: string;
      project: string;
      facts: Array<Record<string, unknown>>;
    };
    assert.equal(document.generatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(document.platform, 'js');
    assert.equal(document.project, root);
    assert.equal(document.facts.length, 1);
    assert.deepEqual(document.facts[0]?.screen, {
      qualifiedName: 'src/screens.tsx#Catalog',
      usr: 'src/screens.tsx#Catalog',
    });
    assert.equal(document.facts[0]?.urlTemplate, '/catalog');
    for (const forbidden of ['method', 'service', 'authority']) {
      assert.ok(!Object.hasOwn(document.facts[0]!, forbidden));
    }
  });
});

test('--help succeeds while unknown options, positionals, modes and missing inputs are usage errors', async () => {
  const help = await runNavigationCommand(['--help'], environment());
  assert.equal(help.exitCode, 0);
  assert.equal(help.standardOutput, navigationUsage);
  const cases = [
    [],
    ['--project', '.'],
    ['--router-model', 'router-model.json'],
    ['--project', '.', '--router-model', 'router-model.json', '--format', 'yaml'],
    ['--project', '.', '--router-model', 'router-model.json', '--unknown'],
    ['--project', '.', '--router-model', 'router-model.json', 'extra'],
    ['--project', '.', '--project', '.', '--router-model', 'router-model.json'],
    ['--project', '.', '--router-model', 'router-model.json', '--generated-at', '2026-01-02'],
  ];
  for (const arguments_ of cases) {
    const result = await runNavigationCommand(arguments_, environment());
    assert.equal(result.exitCode, 64, arguments_.join(' '));
    assert.equal(result.standardOutput, '');
    assert.match(result.standardError, /Usage: tsograph navigation/u);
  }
});

test('model read, containment, JSON and UTF-8 failures are code 2 with safe remediation', async () => {
  await fixture(async ({ root, modelPath }) => {
    const marker = 'PRIVATE_MODEL_CONTENT';
    writeFileSync(modelPath, `{"secret":"${marker}"}`);
    const invalid = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment());
    assertSafeInputFailure(invalid, root, marker);
    assert.match(invalid.standardError, /fix the router model/u);

    writeFileSync(modelPath, new Uint8Array([0xc3, 0x28]));
    const utf8 = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment());
    assertSafeInputFailure(utf8, root);
    assert.match(utf8.standardError, /UTF-8/u);

    const actual = createNodeFileSystem();
    const unreadable: CommandFileSystem = {
      ...actual,
      readBytes: async () => { throw new Error('PRIVATE_READ_ERROR'); },
    };
    writeFileSync(modelPath, JSON.stringify(routerModel));
    const read = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment(unreadable));
    assertSafeInputFailure(read, root, 'PRIVATE_READ_ERROR');
    assert.match(read.standardError, /permissions|readable/u);

    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-navigation-outside-')));
    try {
      const outside = join(outsideRoot, 'outside-model.json');
      writeFileSync(outside, JSON.stringify(routerModel));
      const escaped = await runNavigationCommand([
        '--project', root,
        '--router-model', outside,
      ], environment());
      assertSafeInputFailure(escaped, root, outsideRoot);
      assert.match(escaped.standardError, /inside --project/u);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('project and model status races fail safely without leaking underlying errors', async () => {
  await fixture(async ({ root, modelPath }) => {
    const actual = createNodeFileSystem();
    const projectUnreadable: CommandFileSystem = {
      ...actual,
      realPath: async (path) => {
        if (path === root) throw new Error('PRIVATE_PROJECT_ERROR');
        return actual.realPath(path);
      },
    };
    const missingProject = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment(projectUnreadable));
    assertSafeInputFailure(missingProject, root, 'PRIVATE_PROJECT_ERROR');
    assert.match(missingProject.standardError, /project root/u);

    const unsafeProject: CommandFileSystem = {
      ...actual,
      realPath: async () => '/tmp/unsafe\u0001project',
      status: async () => ({ kind: 'directory', size: 0, modifiedAt: new Date(0) }),
    };
    const unsafe = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment(unsafeProject));
    assertSafeInputFailure(unsafe, root);
    assert.match(unsafe.standardError, /exchange format forbids/u);

    let modelStatuses = 0;
    const disappearingModel: CommandFileSystem = {
      ...actual,
      status: async (path) => {
        if (path === modelPath && ++modelStatuses === 2) throw new Error('PRIVATE_MODEL_STATUS');
        return actual.status(path);
      },
    };
    const raced = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment(disappearingModel));
    assertSafeInputFailure(raced, root, 'PRIVATE_MODEL_STATUS');
    assert.match(raced.standardError, /existing readable JSON/u);
  });
});

test('router model bounded read accepts the exact byte cap and rejects cap plus one', async () => {
  await fixture(async ({ root, modelPath }) => {
    const encoded = JSON.stringify(routerModel);
    writeFileSync(modelPath, `${' '.repeat(MAX_ROUTER_MODEL_BYTES - encoded.length)}${encoded}`);
    const actual = createNodeFileSystem();
    let observedLimit: number | undefined;
    const bounded: CommandFileSystem = {
      ...actual,
      readBytes: (path, maximumBytes) => {
        observedLimit = maximumBytes;
        return actual.readBytes(path, maximumBytes);
      },
    };
    const exact = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment(bounded));
    assert.equal(exact.exitCode, 0, exact.standardError);
    assert.equal(observedLimit, MAX_ROUTER_MODEL_BYTES);

    appendFileSync(modelPath, ' ');
    const oversized = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment());
    assertSafeInputFailure(oversized, root);
    assert.match(oversized.standardError, new RegExp(`exceeds ${MAX_ROUTER_MODEL_BYTES} bytes`, 'u'));
  });
});

test('tsconfig must be a readable project-relative file and parse failures are code 2', async () => {
  await fixture(async ({ root }) => {
    const config = join(root, 'tsconfig.json');
    writeFileSync(config, '{');
    const malformed = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--tsconfig', 'tsconfig.json',
    ], environment());
    assertSafeInputFailure(malformed, root);
    assert.match(malformed.standardError, /compiler config/u);

    const absolute = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--tsconfig', config,
    ], environment());
    assertSafeInputFailure(absolute, root);
    assert.match(absolute.standardError, /relative to --project/u);

    const missing = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--tsconfig', 'missing.json',
    ], environment());
    assertSafeInputFailure(missing, root, 'missing.json');
    assert.match(missing.standardError, /readable compiler config/u);
  });
});

test('compiler config size and status races retain specific safe failures', async () => {
  await fixture(async ({ root }) => {
    const config = join(root, 'tsconfig.json');
    writeFileSync(config, Buffer.alloc(MAX_GRAPH_CONFIG_BYTES + 1, 0x20));
    const oversized = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--tsconfig', 'tsconfig.json',
    ], environment());
    assertSafeInputFailure(oversized, root);
    assert.match(oversized.standardError, new RegExp(`exceeds ${MAX_GRAPH_CONFIG_BYTES} bytes`, 'u'));

    writeFileSync(config, '{}');
    const actual = createNodeFileSystem();
    let configStatuses = 0;
    const disappearingConfig: CommandFileSystem = {
      ...actual,
      status: async (path) => {
        if (path === config && ++configStatuses === 2) throw new Error('PRIVATE_CONFIG_STATUS');
        return actual.status(path);
      },
    };
    const raced = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
      '--tsconfig', 'tsconfig.json',
    ], environment(disappearingConfig));
    assertSafeInputFailure(raced, root, 'PRIVATE_CONFIG_STATUS');
    assert.match(raced.standardError, /readable compiler config/u);
  });
});

test('invalid injected clock becomes a safe analysis failure', async () => {
  await fixture(async ({ root }) => {
    const result = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], { ...environment(), now: () => new Date(Number.NaN) });
    assertSafeInputFailure(result, root);
    assert.match(result.standardError, /navigation analysis failed/u);
  });
});

test('binding analysis exhaustion is a distinct code 2 failure without a partial document', async () => {
  await fixture(async ({ root }) => {
    writeFileSync(join(root, 'src/large.ts'), '0;\n'.repeat(500_100));
    const result = await runNavigationCommand([
      '--project', root,
      '--router-model', 'router-model.json',
    ], environment());
    assertSafeInputFailure(result, root);
    assert.match(result.standardError, /binding analysis exceeds its 1000000-node limit/u);
    assert.match(result.standardError, /narrower project/u);
  });
});

function assertSafeInputFailure(
  result: Awaited<ReturnType<typeof runNavigationCommand>>,
  ...privateText: readonly string[]
): void {
  assert.equal(result.exitCode, 2);
  assert.equal(result.standardOutput, '');
  assert.match(result.standardError, /^tsograph: /u);
  assert.ok(!result.standardError.includes('\n    at '));
  for (const text of privateText) assert.ok(!result.standardError.includes(text));
}
