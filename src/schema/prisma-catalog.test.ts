import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPrismaCatalog, compareCodePoints, defaultTableName, lowerFirst, type PrismaCatalog } from './prisma-catalog.ts';
import { parsePrismaSchema } from './prisma-schema.ts';
import { ALL_NAMING_RULES, type NamingRuleId } from './prisma-version.ts';
import { SourceText } from './source-text.ts';

/**
 * 스키마 텍스트 하나로 이름 표를 만든다.
 *
 * @param text 스키마 텍스트
 * @param rules 이름 규칙 후보
 * @returns 이름 표
 */
function catalogOf(text: string, rules: readonly NamingRuleId[] = ['prisma-7']): PrismaCatalog {
  return buildPrismaCatalog([{ path: 'schema.prisma', text: new SourceText(text), parsed: parsePrismaSchema(text) }], rules);
}

/**
 * 모델 이름 → 테이블 채널(dynamic이면 `~` 접두사)과 컬럼 목록이다.
 *
 * @param catalog 이름 표
 * @returns 요약
 */
function tables(catalog: PrismaCatalog): Record<string, string> {
  return Object.fromEntries(catalog.models.map((model) => [
    model.name,
    `${model.table.dynamic ? '~' : ''}${model.table.channel}(${model.columns.map((column) => column.column).join(',')})`,
  ]));
}

// 이름 규칙 벡터: Prisma 7(prisma-engines `database_name()`), 8.0.0-rc.1–11(`lowerFirst`),
// 8.0.0-rc.12(`defaultTableName` = 모델 이름 그대로). 컬럼은 모든 버전에서 `@map` 또는 필드 이름이다.
test('버전별 기본 테이블 이름 벡터', () => {
  const vectors: [string, NamingRuleId, string][] = [
    ['UserProfile', 'prisma-7', 'UserProfile'],
    ['UserProfile', 'prisma-8-lower-first', 'userProfile'],
    ['UserProfile', 'prisma-8-verbatim', 'UserProfile'],
    ['URL', 'prisma-8-lower-first', 'uRL'],
    ['user', 'prisma-8-lower-first', 'user'],
  ];
  for (const [model, rule, expected] of vectors) assert.equal(defaultTableName(model, rule), expected, `${model} ${rule}`);
  assert.equal(lowerFirst('Äpfel'), 'äpfel');
});

test('@@map·@map·@@schema·Unsupported·enum을 반영하고 관계·ignore·composite 필드는 뺀다', () => {
  const catalog = catalogOf([
    'model Member {',
    '  id      Int      @id',
    '  email   String   @map(name: "email_address")',
    '  role    Role',
    '  vector  Unsupported("vector")?',
    '  secret  String   @ignore',
    '  profile Profile?',
    '  address Address',
    '  mystery Mystery',
    '  @@map("members")',
    '  @@schema("auth")',
    '}',
    'model Profile {',
    '  id        Int     @id',
    '  memberId Int     @unique',
    '  member    Member @relation(fields: [memberId], references: [id])',
    '}',
    'model Hidden {',
    '  id Int @id',
    '  @@ignore',
    '}',
    'view Summary {',
    '  total Int',
    '  @@map("summary.v1")',
    '}',
    'type Address {',
    '  street String',
    '}',
    'enum Role {',
    '  ADMIN',
    '  MEMBER @map("member")',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(tables(catalog), {
    Member: 'auth.members(id,email_address,role,vector)',
    Profile: 'Profile(id,memberId)',
    Summary: 'summary%2Ev1(total)',
  });
  assert.equal(catalog.counts.ignoredModels, 1);
  assert.equal(catalog.counts.ignoredFields, 1);
  assert.equal(catalog.counts.unresolvedFieldTypes, 1);
  assert.equal(catalog.delegates.get('member')?.name, 'Member');
  assert.equal(catalog.delegates.get('Member')?.name, 'Member');
  assert.equal(catalog.delegates.get('hidden'), undefined);
});

test('버전을 확정하지 못하면 규칙마다 갈리는 테이블만 dynamic이고 컬럼을 싣지 않는다', () => {
  const catalog = catalogOf('model Order {\n  id Int @id\n}\nmodel lineItem {\n  id Int @id\n}\nmodel Mapped {\n  id Int @id\n  @@map("mapped")\n}\n', ALL_NAMING_RULES);
  assert.deepEqual(tables(catalog), { Order: '~Order()', lineItem: 'lineItem(id)', Mapped: 'mapped(id)' });
  assert.equal(catalog.counts.dynamicTables, 1);
});

test('8.0.0-rc.1–11 규칙은 @@map 없는 모델 이름의 첫 글자를 소문자로 한다', () => {
  const catalog = catalogOf('model OrderLine {\n  id Int @id\n}\n', ['prisma-8-lower-first']);
  assert.deepEqual(tables(catalog), { OrderLine: 'orderLine(id)' });
});

test('암시적 다대다 조인 테이블: 코드 포인트 순 기본 이름, 명시 이름, 자기 참조, 스키마', () => {
  const catalog = catalogOf([
    'model apple {',
    '  id   Int   @id',
    '  zoos Zoo[]',
    '}',
    'model Zoo {',
    '  id     Int     @id',
    '  apples apple[]',
    '  @@schema("park")',
    '}',
    'model Post {',
    '  id   Int   @id',
    '  tags Tag[] @relation("PostTags")',
    '}',
    'model Tag {',
    '  id    Int    @id',
    '  posts Post[] @relation(name: "PostTags")',
    '}',
    'model Person {',
    '  id        Int      @id',
    '  followers Person[] @relation("Follows")',
    '  following Person[] @relation("Follows")',
    '}',
    'model Author {',
    '  id    Int    @id',
    '  books Book[]',
    '}',
    'model Book {',
    '  id       Int    @id',
    '  authorId Int',
    '  author   Author @relation(fields: [authorId], references: [id])',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(catalog.joinTables.map((join) => `${join.table.channel}@${join.symbol}`), [
    'park._ZooToapple@apple.zoos',
    '_PostTags@Post.tags',
    '_Follows@Person.followers',
  ]);
});

test('조인 테이블은 Prisma 7 규칙에서만 확정하고 긴 이름은 추측하지 않는다', () => {
  const schema = (name: string): string => `model A {\n  id Int @id\n  bs B[] @relation("${name}")\n}\nmodel B {\n  id Int @id\n  as A[] @relation("${name}")\n}\n`;
  assert.equal(catalogOf(schema('AB'), ALL_NAMING_RULES).joinTables[0]!.table.dynamic, true);
  assert.equal(catalogOf(schema('x'.repeat(63))).joinTables[0]!.table.dynamic, true);
  assert.equal(catalogOf(schema('x'.repeat(62))).joinTables[0]!.table.dynamic, false);
  assert.equal(catalogOf(schema('AB')).counts.dynamicJoinTables, 0);
});

test('datasource provider를 모으고 겹치는 delegate는 정하지 않는다', () => {
  const catalog = catalogOf('datasource db {\n  provider = "mongodb"\n}\nmodel user {\n  id Int @id\n}\nmodel User {\n  id Int @id\n}\n');
  assert.deepEqual(catalog.providers, ['mongodb']);
  assert.equal(catalog.delegates.has('user'), true);
  assert.equal(catalog.delegates.get('user'), undefined);
});

test('코드 포인트 비교는 대문자를 소문자보다 앞에 둔다', () => {
  assert.ok(compareCodePoints('Zoo', 'apple') < 0);
  assert.ok(compareCodePoints('a', 'ab') < 0);
  assert.equal(compareCodePoints('same', 'same'), 0);
  assert.ok(compareCodePoints('\u{1F600}', '￿') > 0);
});
