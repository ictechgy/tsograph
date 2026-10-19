import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { stackExhaustionFailure } from './command-result.ts';
import { createNodeFileSystem } from './file-system.ts';
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
 * 분석 기본 옵션(graph program.ts의 defaultOptions)에 `types: []`만 더한 compiler 설정이다.
 *
 * tsconfig가 없으면 TypeScript 자동 타입 포함(typeRoots 기본값)이 현재 디렉터리(npm test·CI에서는 저장소 루트)의
 * `node_modules/@types`를 읽어, Program을 만드는 명령마다 저장소 자신의 @types/node(선언 67개)를 다시 파싱한다. 커버리지
 * 실행에서 그 비용이 이 검사 시간의 8할을 넘었다. 스택 초과 분류와 무관하므로 설정으로 끈다.
 */
const deepFixtureConfig = JSON.stringify({ compilerOptions: {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', esModuleInterop: true, resolveJsonModule: true, types: [],
} });

/**
 * 깊이 중첩된 생성 파일 하나와 다섯 명령이 각각 분석할 소스(Express 앱·fetch 호출·navigation 등록)를 둔 합성 프로젝트를 만든다.
 *
 * @param root 프로젝트 루트
 * @param generated `src/generated.ts` 내용
 */
function writeDeeplyNestedProject(root: string, generated: string): void {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'deep-fixture', private: true, dependencies: { express: '4.21.2' } }),
    'tsconfig.json': deepFixtureConfig,
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
 * 분석기 스택을 넘기는 생성 코드다. 다섯 명령이 넘치기 시작한 깊이(macOS arm64·Node 22.20 실측: 사슬 500~1,000단,
 * 쉼표 1,500~2,000항)의 3배 이상으로 잡아 플랫폼마다 프레임 크기가 조금 달라도 넘치게 한다.
 */
const deeplyNestedSources: Readonly<Record<string, string>> = {
  'method chain': `declare const builder: { step(): typeof builder };\nexport const built = builder${'.step()'.repeat(3_000)};\n`,
  'comma sequence': `declare function a(): number;\nexport const value = (${Array.from({ length: 6_000 }, () => 'a()').join(',')});\n`,
};

test('분석 중 스택 초과는 다섯 명령 모두 같은 원인 문구와 코드 2로 끝나고 출력 초과로 오진하지 않는다', async () => {
  const expected = stackExhaustionFailure().standardError;
  for (const [label, generated] of Object.entries(deeplyNestedSources)) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-deep-nesting-')));
    try {
      writeDeeplyNestedProject(root, generated);
      for (const arguments_ of [
        ['schema', '--project', root],
        ['graph', '--project', root],
        ['routes', '--role', 'server', '--project', root],
        ['routes', '--role', 'client', '--project', root],
        ['navigation', '--project', root, '--router-model', 'router-model.json'],
      ]) {
        const result = await runCli(arguments_, environment);
        const name = `${label}: ${arguments_.slice(0, arguments_.indexOf('--project')).join(' ')}`;
        assert.equal(result.exitCode, 2, name);
        assert.equal(result.standardOutput, '', name);
        assert.equal(result.standardError, expected, name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
