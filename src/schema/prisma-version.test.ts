import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_NAMING_RULES,
  decideNamingRules,
  parseVersion,
  ruleForVersion,
  versionFromSpecifier,
  versionsFromLockfile,
} from './prisma-version.ts';

test('패키지 버전별 이름 규칙 벡터', () => {
  const vectors: [Parameters<typeof ruleForVersion>[0], string, string][] = [
    ['prisma', '7.8.0', 'prisma-7'],
    ['@prisma/client', '2.0.0', 'prisma-7'],
    ['@prisma/client', '6.19.0', 'prisma-7'],
    ['prisma', '7.10.0-dev.3', 'prisma-7'],
    ['prisma', '8.0.0-rc.17', 'ignored'],
    ['prisma', '1.34.0', 'unknown'],
    ['@prisma/client', '8.0.0', 'unknown'],
    ['@prisma/orm-family-sql', '8.0.0-rc.1', 'prisma-8-lower-first'],
    ['@prisma/orm-family-sql', '8.0.0-rc.11', 'prisma-8-lower-first'],
    ['@prisma/orm-family-sql', '8.0.0-rc.12', 'prisma-8-verbatim'],
    ['@prisma/orm-family-sql', '8.0.0-rc.13', 'unknown'],
    ['@prisma/orm-family-sql', '8.0.0-rc.15-dev.111', 'unknown'],
    ['@prisma/orm-family-sql', '8.0.0', 'unknown'],
    ['@prisma/orm-family-sql', '0.17.0', 'unknown'],
    ['prisma', 'latest', 'unknown'],
  ];
  for (const [name, version, expected] of vectors) assert.equal(ruleForVersion(name, version), expected, `${name}@${version}`);
});

test('관찰 버전으로 규칙 후보를 정한다', () => {
  const at = (packageName: 'prisma' | '@prisma/client' | '@prisma/orm-family-sql', version: string) => ({ packageName, version, source: 'x' });
  assert.deepEqual(decideNamingRules([at('prisma', '7.8.0'), at('@prisma/client', '7.8.0')]).rules, ['prisma-7']);
  assert.equal(decideNamingRules([at('prisma', '7.8.0')]).unverifiedReason, undefined);
  const mixed = decideNamingRules([at('prisma', '7.8.0'), at('@prisma/orm-family-sql', '8.0.0-rc.12')]);
  assert.deepEqual(mixed.rules, ['prisma-7', 'prisma-8-verbatim']);
  assert.match(mixed.unverifiedReason!, /different naming rules/u);
  const unknown = decideNamingRules([at('prisma', '7.8.0'), at('@prisma/client', 'workspace:*')]);
  assert.deepEqual(unknown.rules, ALL_NAMING_RULES);
  assert.match(unknown.unverifiedReason!, /@prisma\/client@workspace:\*/u);
  assert.match(decideNamingRules([]).unverifiedReason!, /no Prisma package version/u);
  assert.match(decideNamingRules([at('prisma', '8.0.0-rc.17')]).unverifiedReason!, /no Prisma ORM package/u);
});

test('잠금 파일 형식별로 추적 패키지 버전을 읽는다', () => {
  const pnpm = [
    'packages:',
    "  '@prisma/client@7.8.0':",
    '  prisma@7.8.0(typescript@5.9.3):',
    '  /prisma/4.16.2_typescript@4.9.5:',
    '  @prisma/client-runtime-utils@7.8.0:',
    '  prisma-foo@1.0.0:',
    "  '@prisma/orm-family-sql@8.0.0-rc.12':",
  ].join('\n');
  assert.deepEqual(versionsFromLockfile('pnpm-lock.yaml', pnpm).map((entry) => `${entry.packageName}@${entry.version}`), [
    '@prisma/client@7.8.0', 'prisma@7.8.0', 'prisma@4.16.2', '@prisma/orm-family-sql@8.0.0-rc.12',
  ]);
  const npm = JSON.stringify({
    packages: { '': {}, 'node_modules/prisma': { version: '7.8.0' }, 'node_modules/a/node_modules/@prisma/client': { version: '7.7.0' }, 'node_modules/x': 1 },
    dependencies: { prisma: { version: '7.8.0' }, other: {} },
  });
  assert.deepEqual(versionsFromLockfile('package-lock.json', npm).map((entry) => entry.version), ['7.8.0', '7.7.0', '7.8.0']);
  assert.deepEqual(versionsFromLockfile('npm-shrinkwrap.json', '{not json'), []);
  assert.deepEqual(versionsFromLockfile('package-lock.json', '[]'), []);
  const yarnClassic = '# yarn\n"@prisma/client@^7.8.0":\n  version "7.8.0"\n\nprisma@^7.8.0, prisma@7.8.0:\n  version "7.8.0"\nother@1:\n  version "1.0.0"\n';
  assert.deepEqual(versionsFromLockfile('yarn.lock', yarnClassic).map((entry) => `${entry.packageName}@${entry.version}`), ['@prisma/client@7.8.0', 'prisma@7.8.0']);
  const berry = '"prisma@npm:^7.8.0":\n  version: 7.8.0\n  resolution: "prisma@npm:7.8.0"\n';
  assert.deepEqual(versionsFromLockfile('yarn.lock', berry).map((entry) => entry.version), ['7.8.0']);
  const bun = '{ "packages": { "prisma": ["prisma@7.8.0", "", {}], "@prisma/client": ["@prisma/client@7.8.0", ""] } }';
  assert.deepEqual(versionsFromLockfile('bun.lock', bun).map((entry) => entry.packageName), ['prisma', '@prisma/client']);
  assert.deepEqual(versionsFromLockfile('Cargo.lock', 'prisma@7.8.0'), []);
});

test('semver와 package.json 명세를 읽는다', () => {
  assert.deepEqual(parseVersion('v8.0.0-rc.12+build.5'), { major: 8, minor: 0, patch: 0, prerelease: ['rc', '12'] });
  assert.equal(parseVersion('7.8'), undefined);
  assert.equal(versionFromSpecifier('^7.8.0'), '7.8.0');
  assert.equal(versionFromSpecifier('~6.1.2'), '6.1.2');
  assert.equal(versionFromSpecifier('8.0.0-rc.12'), '8.0.0-rc.12');
  assert.equal(versionFromSpecifier('^8.0.0-rc.3'), undefined);
  assert.equal(versionFromSpecifier('>=7 <8'), undefined);
});
