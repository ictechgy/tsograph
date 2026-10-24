import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createGraphProgram } from './program.ts';
import { StaticPnp } from './static-pnp.ts';

const fixture = fileURLToPath(new URL('../../fixtures/pnp/yarn-generated/', import.meta.url));

/** r2 코드에 같은 실제 PnP fixture를 공급해 새 별칭 조합만 독립 대조한다. */
async function withFixture(run: (root: string) => void): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-review-r3-')));
  try { cpSync(fixture, root, { recursive: true }); run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** compiler가 프로젝트 alias의 선언을 실제 읽었는지 리터럴 타입으로 확인한다. */
function valueType(root: string): string {
  const { program, checker } = createGraphProgram(root, [join(root, 'src/main.ts'), join(root, 'src/local.ts')]);
  const statement = program.getSourceFile(join(root, 'src/main.ts'))!.statements.find(ts.isVariableStatement)!;
  return checker.typeToString(checker.getTypeAtLocation(statement.declarationList.declarations[0]!));
}

for (const prefix of ['@', '~', '$lib']) test(`PnP의 ${prefix}/* 별칭은 package-name 문법과 독립적으로 local 파일을 해석한다`, async () => {
  for (const metadata of ['valid', 'invalid', 'unsupported-ignore']) await withFixture(root => {
    writeFileSync(join(root, 'src/main.ts'), `import {local} from "${prefix}/local"; export const value = local;`);
    writeFileSync(join(root, 'src/local.ts'), 'export const local = 23 as const;');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], baseUrl: '.', paths: { [`${prefix}/*`]: ['src/*'] } }, include: ['src'] }));
    if (metadata === 'invalid') writeFileSync(join(root, '.pnp.data.json'), '{invalid');
    if (metadata === 'unsupported-ignore') {
      const data = JSON.parse(readFileSync(join(root, '.pnp.data.json'), 'utf8')) as Record<string, unknown>;
      data['ignorePatternData'] = '(a+)+$'; writeFileSync(join(root, '.pnp.data.json'), JSON.stringify(data));
    }
    assert.equal(valueType(root), '23', metadata);
  });
});

test('local alias 후보 뒤의 다른 node_modules 패키지를 채택하지 않는다', async () => {
  await withFixture(root => {
    const rival = join(root, 'node_modules/$lib'); mkdirSync(rival, { recursive: true });
    writeFileSync(join(rival, 'local.d.ts'), 'export declare const local: "WRONG_PACKAGE";');
    const options = { baseUrl: root, paths: { '$lib/*': ['missing/*'] }, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const issuer = join(root, 'src/main.ts');
    const classic = ts.resolveModuleName('$lib/local', issuer, options, ts.sys).resolvedModule;
    assert.equal(classic?.isExternalLibraryImport, true, 'positive control: classic resolver can see the rival');
    assert.equal(new StaticPnp(root).resolveModule('$lib/local', issuer, options, ts.sys), undefined);
  });
});

test('SDK 읽기 예외가 local alias의 프로젝트 밖 결과를 허용하지 않는다', async () => {
  await withFixture(root => {
    const sdk = ts.getDefaultLibFilePath({}), issuer = join(root, 'src/main.ts');
    for (const name of ['@/sdk', 'sdk-alias']) {
      const options = { baseUrl: root, paths: { [name]: [sdk] }, moduleResolution: ts.ModuleResolutionKind.Bundler };
      assert.ok(ts.resolveModuleName(name, issuer, options, ts.sys).resolvedModule, 'positive control: classic resolver sees the SDK candidate');
      assert.equal(new StaticPnp(root).resolveModule(name, issuer, options, ts.sys), undefined, name);
    }
  });
});
