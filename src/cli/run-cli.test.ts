import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { SYNTAX_DEPTH_CAUSE } from '../schema/syntax-depth.ts';
import { createNodeFileSystem } from './file-system.ts';
import { ambientTypesFreeConfig } from './testing.test.ts';
import { fileURLToPath } from 'node:url';

import { rootHelp, runCli, runCliSafely } from './run-cli.ts';

/** 테스트용 고정 실행 환경이다. */
const environment = {
  toolVersion: '9.9.9',
  fileSystem: createNodeFileSystem(),
  now: () => new Date('2026-09-27T00:00:00.000Z'),
};

test('인자가 없으면 사용법 오류 64와 도움말을 낸다', async () => {
  const result = await runCli([], environment);
  assert.equal(result.exitCode, 64);
  assert.equal(result.standardError, rootHelp);
});

test('--help와 help는 도움말을 성공으로 낸다', async () => {
  for (const argument of ['--help', '-h', 'help']) {
    const result = await runCli([argument], environment);
    assert.equal(result.exitCode, 0);
    assert.equal(result.standardOutput, rootHelp);
  }
});

test('--version은 주입된 도구 버전을 낸다', async () => {
  const result = await runCli(['--version'], environment);
  assert.deepEqual(result, { standardOutput: '9.9.9\n', standardError: '', exitCode: 0 });
});

test('모르는 명령과 모르는 help 대상은 사용법 오류다', async () => {
  const unknown = await runCli(['nope'], environment);
  assert.equal(unknown.exitCode, 64);
  assert.match(unknown.standardError, /unknown command/);
  const unknownHelp = await runCli(['help', 'nope'], environment);
  assert.equal(unknownHelp.exitCode, 64);
});

test('help openapi는 명령 사용법을 내고 openapi는 명령으로 분배된다', async () => {
  const help = await runCli(['help', 'openapi'], environment);
  assert.equal(help.exitCode, 0);
  assert.match(help.standardOutput, /^Usage: tsograph openapi/);
  const tooMany = await runCli(['help', 'openapi', 'extra'], environment);
  assert.equal(tooMany.exitCode, 64);
  const missingService = await runCli(['openapi', 'spec.yaml'], environment);
  assert.equal(missingService.exitCode, 64);
});

test('help routes는 명령 사용법을 내고 routes는 명령으로 분배된다', async () => {
  const help = await runCli(['help', 'routes'], environment);
  assert.equal(help.exitCode, 0);
  assert.match(help.standardOutput, /^Usage: tsograph routes/);
  assert.match(rootHelp, /routes {7}Extract server route-decl or web\/React Native client route-call facts/);
  const missingRole = await runCli(['routes', '--project', '.'], environment);
  assert.equal(missingRole.exitCode, 64);
  assert.match(missingRole.standardError, /--role server\|client is required/);
});

test('예상하지 못한 내부 예외도 종료 코드 계약(2)과 원인 없는 문구로 바꾼다', async () => {
  const throwing = { ...environment, now: (): Date => { throw new Error('secret /abs/path detail'); } };
  const result = await runCliSafely(['openapi', fileURLToPath(new URL('../../fixtures/openapi/swagger-2.0.json', import.meta.url)), '--service', 'x'], throwing);
  assert.equal(result.exitCode, 2);
  assert.match(result.standardError, /^tsograph: internal error/);
  assert.equal(result.standardOutput, '');
  assert.doesNotMatch(result.standardError, /secret|abs\/path/);
  const ok = await runCliSafely(['--version'], environment);
  assert.equal(ok.exitCode, 0);
});

/**
 * 깊이 중첩된 생성 파일 하나와 다섯 명령이 각각 분석할 소스(Express 앱·fetch 호출·navigation 등록)를 둔 합성 프로젝트를 만든다.
 *
 * tsconfig.json은 저장소의 @types/node를 읽지 않는 설정이다. Program을 만드는 명령마다 그 선언을 다시 파싱하는 비용이
 * 커버리지 실행에서 이 검사 시간의 8할을 넘었고, 깊이 격리와는 무관하다.
 *
 * @param root 프로젝트 루트
 * @param generated `src/generated.ts` 내용
 */
function writeDeeplyNestedProject(root: string, generated: string): void {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'deep-fixture', private: true, dependencies: { express: '4.21.2' } }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/ok', (req, res) => res.send('ok'));\nexport default app;\n",
    'src/client.ts': "export function load() { return fetch('/api/items'); }\n",
    'src/router-api.ts': 'export function registerScreens(input: unknown) { return input; }\n',
    'src/screens.tsx': 'export function Catalog() { return null; }\n',
    'src/router.tsx': "import { registerScreens } from './router-api';\nimport { Catalog } from './screens';\nregisterScreens([{ path: '/catalog', screen: Catalog }]);\n",
    'router-model.json': JSON.stringify({ format: 'router-models', version: 1, models: [{
      factory: { path: 'src/router-api.ts', name: 'registerScreens' }, routesArgument: 0,
      pathProperty: 'path', screenProperty: 'screen', childrenProperty: 'children', pathSyntax: 'colon',
    }] }),
    'src/generated.ts': generated,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * 구문 깊이 상한을 크게 넘는 생성 코드다. 격리 전에는 다섯 명령이 넘치기 시작한 깊이(macOS arm64·Node 22.20 실측: 사슬
 * 500~1,000단, 쉼표 1,500~2,000항)의 3배 이상이라, 플랫폼마다 프레임 크기가 조금 달라도 격리하지 않으면 넘친다.
 */
const deeplyNestedSources: Readonly<Record<string, string>> = {
  'method chain': `declare const builder: { step(): typeof builder };\nexport const built = builder${'.step()'.repeat(3_000)};\n`,
  'comma sequence': `declare function a(): number;\nexport const value = (${Array.from({ length: 6_000 }, () => 'a()').join(',')});\n`,
};

/** 깊은 파일 하나를 뺀 뒤에도 명령마다 남아야 하는 정상 파일의 흔적과, 그 파일을 알리는 limitation이다. */
const isolatedOutputs: readonly { readonly command: readonly string[]; readonly extra: readonly string[]; readonly fact: string; readonly limitation: string }[] = [
  { command: ['schema'], extra: [], fact: '',
    limitation: `parse-errors: 1 source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; files: ["src/generated.ts"]; omitted: 0` },
  { command: ['graph'], extra: [], fact: '"src/app.ts#',
    limitation: `parse-errors: 1 source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; they have no nodes and calls into them stay unlinked; `
      + 'files: ["src/generated.ts"]; omitted: 0' },
  { command: ['routes', '--role', 'server'], extra: [], fact: '"/ok"',
    limitation: `route-coverage: 1 source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; route registrations in them are missing` },
  { command: ['routes', '--role', 'client'], extra: [], fact: '"/api/items"',
    limitation: `route-call-coverage: 1 source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; requests in them are missing` },
  { command: ['navigation'], extra: ['--router-model', 'router-model.json'], fact: '"/catalog"',
    limitation: `navigation-source-coverage: 1 production source file(s) ${SYNTAX_DEPTH_CAUSE} and were not scanned` },
];

test('깊이 중첩된 생성 파일 하나는 다섯 명령 모두 그 파일만 빼고 정상 파일 사실과 원인 limitation을 낸다', async () => {
  for (const [label, generated] of Object.entries(deeplyNestedSources)) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-deep-nesting-')));
    try {
      writeDeeplyNestedProject(root, generated);
      for (const expected of isolatedOutputs) {
        const result = await runCli([...expected.command, '--project', root, ...expected.extra], environment);
        const name = `${label}: ${expected.command.join(' ')}`;
        assert.equal(result.exitCode, 0, `${name}: ${result.standardError}`);
        const document = JSON.parse(result.standardOutput) as { facts?: unknown[]; nodes?: unknown[]; limitations: string[] };
        assert.ok(JSON.stringify(document.facts ?? document.nodes).includes(expected.fact), name);
        assert.ok(document.limitations.includes(expected.limitation), `${name}: ${document.limitations.join('\n')}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
 * 입력 파일 검증 검사용 배치를 만든다. `project/`에는 다섯 명령이 분석할 작은 소스와 입력 파일을 두고, 그 형제
 * `outside/`에 같은 입력 파일을 둔다.
 *
 * @param root 임시 디렉터리 realpath
 */
function writeContainmentLayout(root: string): void {
  const routerModel = JSON.stringify({ format: 'router-models', version: 1, models: [{
    factory: { path: 'src/router-api.ts', name: 'registerScreens' }, routesArgument: 0,
    pathProperty: 'path', screenProperty: 'screen', pathSyntax: 'colon',
  }] });
  const clientModel = JSON.stringify({ format: 'http-client-models', version: 1, models: [{
    receiver: { kind: 'type', path: 'src/api.ts', name: 'Api' }, methods: [{ name: 'get', method: 'GET', pathArgument: 0 }],
  }] });
  const files: Record<string, string> = {
    'project/package.json': '{}',
    'project/tsconfig.json': ambientTypesFreeConfig,
    'project/src/api.ts': 'export interface Api { get(path: string): unknown }\n',
    'project/src/router-api.ts': 'export function registerScreens(input: unknown) { return input; }\n',
    'project/src/screens.ts': 'export function Catalog() { return null; }\n',
    'project/src/router.ts': "import { registerScreens } from './router-api';\nimport { Catalog } from './screens';\n"
      + "registerScreens([{ path: '/catalog', screen: Catalog }]);\n",
    'project/router-model.json': routerModel,
    'project/client-model.json': clientModel,
    'outside/tsconfig.json': ambientTypesFreeConfig,
    'outside/router-model.json': routerModel,
    'outside/client-model.json': clientModel,
    'outside/spec.json': JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: { '/a': { get: {} } } }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * 명령별 입력 파일 인자다. `file`은 입력 파일 자리에 넣을 값을 받는다(밖·없는 파일 경로).
 * openapi 스펙만 실행 위치 기준 위치 인자라 절대 경로를 받고, 나머지는 `--project` 기준 상대 경로를 받는다.
 */
const inputFileArguments: readonly { readonly name: string; readonly build: (project: string, file: (name: string) => string) => string[] }[] = [
  { name: 'openapi spec', build: (project, file) => ['openapi', file('spec.json'), '--service', 'x', '--project', project] },
  { name: 'routes client model', build: (project, file) => ['routes', '--role', 'client', '--project', project, '--client-model', file('client-model.json')] },
  { name: 'routes tsconfig', build: (project, file) => ['routes', '--role', 'client', '--project', project, '--tsconfig', file('tsconfig.json')] },
  { name: 'navigation router model', build: (project, file) => ['navigation', '--project', project, '--router-model', file('router-model.json')] },
  { name: 'navigation tsconfig', build: (project, file) => ['navigation', '--project', project, '--router-model', 'router-model.json', '--tsconfig', file('tsconfig.json')] },
  { name: 'graph tsconfig', build: (project, file) => ['graph', '--project', project, '--tsconfig', file('tsconfig.json')] },
  { name: 'reach tsconfig', build: (project, file) => ['reach', '--project', project, '--tsconfig', file('tsconfig.json'), 'src/screens.ts#Catalog'] },
  { name: 'impact tsconfig', build: (project, file) => ['impact', '--project', project, '--tsconfig', file('tsconfig.json'), 'src/screens.ts#Catalog'] },
];

test('realpath가 --project 밖인 입력 파일은 다섯 명령 모두 같은 형식의 사용 오류(64)이고 없는 입력 파일은 입력 실패(2)다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-input-files-')));
  try {
    writeContainmentLayout(root);
    const project = join(root, 'project');
    for (const { name, build } of inputFileArguments) {
      const arguments_ = build(project, (file) => (file === 'spec.json' ? join(root, 'outside', file) : `../outside/${file}`));
      const outside = await runCli(arguments_, environment);
      assert.equal(outside.exitCode, 64, `${name}: ${outside.standardError}`);
      assert.equal(outside.standardOutput, '', name);
      assert.match(outside.standardError, new RegExp(`^tsograph: the [^\\n]+ is outside --project; [^\\n]+\\nUsage: tsograph ${arguments_[0]} `, 'u'), name);
      assert.ok(!outside.standardError.includes(root), name);

      const missing = await runCli(build(project, (file) => join(project, `missing-${file}`)), environment);
      assert.equal(missing.exitCode, 2, `${name}: ${missing.standardError}`);
      assert.equal(missing.standardOutput, '', name);
      assert.match(missing.standardError, /^tsograph: /u, name);
      assert.doesNotMatch(missing.standardError, /Usage:/u, name);
      assert.ok(!missing.standardError.includes(root), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--tsconfig는 graph·routes client·navigation 모두 realpath가 --project 안이면 절대 경로도 받는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-input-files-')));
  try {
    writeContainmentLayout(root);
    const project = join(root, 'project');
    for (const { name, build } of inputFileArguments.filter((entry) => entry.name.endsWith('tsconfig'))) {
      const absolute = await runCli(build(project, (file) => join(project, file)), environment);
      assert.equal(absolute.exitCode, 0, `${name}: ${absolute.standardError}`);
      const relative = await runCli(build(project, (file) => file), environment);
      assert.equal(absolute.standardOutput, relative.standardOutput, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
