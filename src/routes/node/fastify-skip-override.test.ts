/**
 * skip-override census가 등록 수에 선형인지(같은 이름의 바인딩을 등록마다 다시 분류하지 않는지) 분류 횟수로 본다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ambientTypesFreeConfig } from '../../cli/testing.test.ts';
import { skipOverrideWork } from './fastify-skip-override.ts';
import { packageJson, scanNodeProject } from './testing.test.ts';

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
