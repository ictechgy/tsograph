import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attributeNameArgument, findAttribute, parsePrismaSchema } from './prisma-schema.ts';

test('블록·필드·수식자·속성 인자를 읽고 주석은 버린다', () => {
  const text = [
    '// 주석 { model Fake {} }',
    'generator client {',
    '  provider        = "prisma-client" // 뒤 주석',
    '  previewFeatures = ["typedSql", "views"]',
    '  output          = env("OUT")',
    '}',
    '/// 문서 주석',
    'model Order {',
    '  id    Int      @id @default(autoincrement())',
    '  total Decimal? @db.Decimal(10, 2)',
    '  items Item[]',
    '  note  String   @map("note\\"s")',
    '  @@map(name: "orders")',
    '  @@index([total], map: "idx")',
    '}',
    '',
  ].join('\n');
  const parsed = parsePrismaSchema(text);
  assert.equal(parsed.unparsedLines, 0);
  const [generator, model] = parsed.blocks;
  assert.equal(generator!.kind, 'generator');
  assert.deepEqual(generator!.properties.get('provider'), { kind: 'string', value: 'prisma-client' });
  assert.deepEqual(generator!.properties.get('previewFeatures'), {
    kind: 'list', items: [{ kind: 'string', value: 'typedSql' }, { kind: 'string', value: 'views' }],
  });
  assert.equal(generator!.properties.get('output')?.kind, 'call');
  assert.equal(model!.name, 'Order');
  assert.equal(text.slice(model!.nameOffset, model!.nameOffset + 5), 'Order');
  const fields = model!.fields.map((field) => `${field.name}:${field.typeName}${field.isList ? '[]' : ''}${field.isOptional ? '?' : ''}`);
  assert.deepEqual(fields, ['id:Int', 'total:Decimal?', 'items:Item[]', 'note:String']);
  assert.deepEqual(model!.fields[1]!.attributes.map((attribute) => attribute.name), ['db.Decimal']);
  assert.deepEqual(attributeNameArgument(findAttribute(model!.fields[3]!.attributes, 'map')!), { kind: 'string', value: 'note"s' });
  assert.deepEqual(attributeNameArgument(findAttribute(model!.blockAttributes, 'map')!), { kind: 'string', value: 'orders' });
  assert.equal(findAttribute(model!.blockAttributes, 'ignore'), undefined);
});

test('읽지 못한 줄은 세고 블록 밖 줄은 건너뛴다', () => {
  const parsed = parsePrismaSchema([
    'stray line',
    'model A {',
    '  id Int @id',
    '  = broken',
    '  x Int[ ]?',
    '  y Int garbage',
    '  z Int @',
    '}',
    'enum E {',
    '  ONE',
    '  "bad"',
    '}',
    'datasource db {',
    '  provider "x"',
    '  url = "a" "b"',
    '}',
    '',
  ].join('\n'));
  assert.equal(parsed.blocks.length, 3);
  assert.deepEqual(parsed.blocks[0]!.fields.map((field) => field.name), ['id', 'x']);
  assert.equal(parsed.unparsedLines, 6);
});

test('escape·유니코드 이름·닫히지 않은 문자열·중첩 인자를 견딘다', () => {
  const parsed = parsePrismaSchema([
    'model Café {',
    '  naïve String @map("a\\tb\\nc\\rd\\\\e")',
    '  tags  String[] @default([])',
    '  meta  Json @default("{\\"k\\": [1, 2]}")',
    '  open  String @map("unterminated',
    '  odd   Int @default(dbgenerated("x", [1, (2)]), -1)',
    '  weird Int @relation(fields: [a b], references: [id])',
    '}',
    '',
  ].join('\n'));
  const fields = parsed.blocks[0]!.fields;
  assert.equal(parsed.blocks[0]!.name, 'Café');
  assert.deepEqual(attributeNameArgument(fields[0]!.attributes[0]!), { kind: 'string', value: 'a\tb\nc\rd\\e' });
  // 닫히지 않은 괄호가 뒤 줄을 삼킨 줄은 읽지 않고 센다.
  assert.deepEqual(fields.map((field) => field.name), ['naïve', 'tags', 'meta']);
  assert.equal(parsed.unparsedLines, 1);
  const multiline = parsePrismaSchema('model M {\n  id Int @id\n  @@index([\n    id,\n  ], map: "m")\n}\n');
  assert.equal(multiline.unparsedLines, 0);
  assert.deepEqual(multiline.blocks[0]!.blockAttributes.map((attribute) => attribute.name), ['index']);
  assert.equal(attributeNameArgument({ name: 'x', arguments: [] }), undefined);
});
