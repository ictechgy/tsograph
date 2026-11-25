/**
 * skip-override census가 등록 수에 선형인지(같은 이름의 바인딩을 등록마다 다시 분류하지 않는지) 분류 횟수로 본다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ambientTypesFreeConfig } from '../../cli/testing.test.ts';
import { skipOverrideWork } from './fastify-skip-override.ts';
import { factLines, packageJson, scanNodeProject } from './testing.test.ts';

/**
 * 모두 `plugin`이라는 이름의 플러그인 N개를 파일마다 두고, 각 바인딩을 `escapes`번 흘려보낸 뒤 접두사로 등록하는 프로젝트다.
 *
 * @param count 플러그인 수
 * @param escapes 바인딩마다 흘려보내는 수
 * @returns 파일
 */
function sameNamedPlugins(count: number, escapes: number): Record<string, string> {
  const files: Record<string, string> = { 'package.json': packageJson({ fastify: '5.2.0' }), 'tsconfig.json': ambientTypesFreeConfig };
  const imports: string[] = [];
  const registrations: string[] = [];
  for (let index = 0; index < count; index++) {
    const kept = Array.from({ length: escapes }, () => 'kept.push(plugin);').join('\n');
    files[`src/p${index}.ts`] = `const kept: unknown[] = [];\nexport default async function plugin(f: any) { f.get('/a', async () => 'a'); }\n${kept}\n`;
    imports.push(`import p${index} from './p${index}.ts';`);
    registrations.push(`app.register(p${index}, { prefix: '/r${index}' });`, `app.register(p${index}, { prefix: '/s${index}' });`);
  }
  files['src/app.ts'] = `import Fastify from 'fastify';\n${imports.join('\n')}\nconst app = Fastify();\n${registrations.join('\n')}\nexport default app;\n`;
  return files;
}

test('같은 이름의 플러그인 바인딩이 많아도 사용 자리를 이름마다 한 번 묶고 바인딩마다 한 번 분류한다', async () => {
  const work = async (count: number): Promise<number> => {
    const before = skipOverrideWork();
    const document = await scanNodeProject(sameNamedPlugins(count, 8));
    // 흘려보낸 바인딩이라 등록이 모두 dynamic이고, 같은 위치의 두 등록은 같은 사실 하나로 합쳐진다.
    assert.equal(document.facts.length, count);
    return skipOverrideWork() - before;
  };
  // `plugin` 이름의 사용 count×8개를 한 번 묶고(count×8) 바인딩마다 자기 사용 8개를 한 번 분류한다(count×8). 등록이 둘씩이어도 다시 보지
  // 않는다. 등록마다 같은 이름의 사용을 모두 훑으면 count²에 비례한다(60553ce: 플러그인 3,000개에서 6.7초 → 48.6초).
  assert.equal(await work(20), 20 * 16);
  assert.equal(await work(60), 60 * 16);
});

/**
 * 플러그인 하나를 서로 모두 부르는 도우미 k개에 넘긴 뒤 접두사로 등록하는 프로젝트다(도우미는 받은 값을 서로에게 넘기기만 한다).
 *
 * @param size 도우미 수
 * @returns 파일
 */
function helperClique(size: number): Record<string, string> {
  const helpers = Array.from({ length: size }, (_, index) => {
    const calls = Array.from({ length: size }, (__, other) => other).filter((other) => other !== index).map((other) => `h${other}(p, n - 1);`);
    return `function h${index}(p: any, n: number): void { if (n <= 0) return; ${calls.join(' ')} }`;
  });
  return {
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "async function users(f: any) { f.get('/x', async () => 'x'); }",
      ...helpers,
      'h0(users, 1);',
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  };
}

test('서로 부르는 도우미의 매개변수는 순환을 한 번에 묶어 바인딩마다 한 번만 분류한다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 `/u/x`(아무도 심볼을 쓰지 않는다). db64014는 순환을 메모하지 않아 경로마다 다시 분류했다(도우미 9개 5.3초,
  // 10개 41.9초).
  const work = async (size: number): Promise<number> => {
    const before = skipOverrideWork();
    assert.deepEqual(factLines(await scanNodeProject(helperClique(size))), ['GET root /u/x strict']);
    return skipOverrideWork() - before;
  };
  // 도우미마다 `p`의 사용이 size-1개다: 이름별 묶기 size×(size-1)번과 바인딩별 분류 size×(size-1)번, 그리고 `users`의 사용 둘(묶기·분류).
  assert.equal(await work(6), 2 * 6 * 5 + 2);
  assert.equal(await work(8), 2 * 8 * 7 + 2);
});

test('매개변수를 넘기기만 하는 도우미 사슬이 길어도 호출 스택을 쓰지 않고 끝까지 따라간다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 `/u/x`. db64014는 사슬 4,500개쯤에서 재귀 깊이를 넘겨 분석이 실패했다.
  const length = 6000;
  const helpers = Array.from({ length }, (_, index) => `function h${index}(p: any): void { ${index + 1 < length ? `h${index + 1}(p);` : ''} }`);
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "async function users(f: any) { f.get('/x', async () => 'x'); }",
      ...helpers,
      'h0(users);',
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), ['GET root /u/x strict']);
});

test('순환 안의 한 도우미가 받은 값을 흘려보내면 순환의 모든 도우미가 모른다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 모두 `/x`다: 순환 어디로 들어가든 받은 플러그인이 흘려보내는 도우미에 닿는다.
  const project = (helpers: readonly string[], entries: readonly string[], plugins: readonly string[]): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      ...plugins.map((name) => `async function ${name}(f: any) { f.get('/${name}', async () => 'x'); }`),
      ...helpers,
      ...entries,
      'const app = Fastify();',
      ...plugins.map((name) => `app.register(${name}, { prefix: '/p' });`),
      'export default app;',
    ].join('\n'),
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  // 흘려보내는 도우미가 순환의 뿌리가 아니다.
  const pair = project([
    'function a(p: any, n: number): void { if (n > 0) b(p, n - 1); }',
    'function b(p: any, n: number): void { if (n > 0) a(p, n - 1); markAll({ p }); }',
  ], ['a(users, 2);'], ['users']);
  assert.deepEqual(factLines(await scanNodeProject(pair)), [unproven]);
  // 세 도우미 순환에 뿌리로 들어간 뒤, 다른 플러그인이 순환 가운데로 들어간다(가운데 도우미의 메모도 순환 전체의 근거여야 한다).
  const triple = project([
    'function a(p: any, n: number): void { if (n > 0) b(p, n - 1); markAll({ p }); }',
    'function b(p: any, n: number): void { if (n > 0) c(p, n - 1); }',
    'function c(p: any, n: number): void { if (n > 0) a(p, n - 1); }',
  ], ['a(users, 3);', 'b(items, 3);'], ['users', 'items']);
  assert.deepEqual(factLines(await scanNodeProject(triple)), [unproven, unproven]);
});
