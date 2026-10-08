import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTypedClientModels, TypedClientModelError } from './typed-client-model.ts';

const valid = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  format: 'http-client-models', version: 1,
  models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient' }, methods: [
    { name: 'getItem', method: 'GET', pathArgument: 0, base: 'https://api.example.test/v1', service: 'catalog' },
  ] }], ...overrides,
});

test('typed client model parser accepts the explicit machine contract', () => {
  const parsed = parseTypedClientModels(valid());
  assert.equal(parsed.format, 'http-client-models');
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.models[0], {
    receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient' },
    methods: [{ name: 'getItem', method: 'GET', pathArgument: 0, base: 'https://api.example.test/v1', service: 'catalog' }],
  });
});

test('typed client model parser rejects malformed, duplicate, deep and oversized input', () => {
  const cases = [
    '{',
    '{"format":"http-client-models","format":"http-client-models","version":1,"models":[]}',
    JSON.stringify({ format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'A' }, methods: [] }, { receiver: { kind: 'type', path: 'src/api.ts', name: 'A' }, methods: [] }] }),
    JSON.stringify({ format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'A' }, methods: [
      { name: 'get', method: 'GET', pathArgument: 0, base: '' }, { name: 'get', method: 'POST', pathArgument: 0, base: '' },
    ] }] }),
    JSON.stringify({ format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: '../api.ts', name: 'A' }, methods: [] }] }),
    JSON.stringify({ format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'A' }, methods: [{ name: 'get', method: 'GET', pathArgument: 0, base: 'https://user:pass@example.test' }] }] }),
  ];
  for (const source of cases) assert.throws(() => parseTypedClientModels(source));
  const deep = '['.repeat(40) + '0' + ']'.repeat(40);
  assert.throws(() => parseTypedClientModels(deep));
  assert.throws(() => parseTypedClientModels('x'.repeat(1_048_577)));
});

test('typed client model parser canonicalizes verbs and rejects invalid values', () => {
  const parsed = parseTypedClientModels(valid({ models: [{ receiver: { kind: 'class', path: 'src/api.ts', name: 'CatalogClient' }, methods: [
    { name: 'getItem', method: 'get', pathArgument: 2, base: '/v1' },
  ] }] }));
  assert.equal(parsed.models[0]?.methods[0]?.method, 'GET');
  assert.throws(() => parseTypedClientModels(valid({ models: [{ receiver: { kind: 'enum', path: 'src/api.ts', name: 'CatalogClient' }, methods: [] }] })));
  assert.throws(() => parseTypedClientModels(valid({ models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient' }, methods: [{ name: 'get', method: 'BREW', pathArgument: 0, base: '' }] }] })));
});

test('typed client model parser rejects unknown keys in every contract object', () => {
  assert.throws(() => parseTypedClientModels(valid({ extra: true })));
  assert.throws(() => parseTypedClientModels(valid({ models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient', extra: true }, methods: [] }] })));
  assert.throws(() => parseTypedClientModels(valid({ models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient' }, methods: [{ name: 'getItem', method: 'GET', pathArgument: 0, base: '', extra: true }] }] })));
});

test('typed model lexical errors have consistent codes and nested duplicate keys are rejected', () => {
  for (const source of ['{"\\uZZZZ":0}', '{"value":"\\uZZZZ"}', '{"value":"\\x"}', '{"value":01}', '{"value":1e+}', '{"value":1.}']) {
    assert.throws(() => parseTypedClientModels(source), (error: unknown) => error instanceof TypedClientModelError && error.code === 'invalid-json');
  }
  assert.throws(() => parseTypedClientModels('{"models":[{"same":1,"same":2}]}'),
    (error: unknown) => error instanceof TypedClientModelError && error.code === 'duplicate-key');
  assert.throws(() => parseTypedClientModels('[' + '0,'.repeat(99_999) + '0]'),
    (error: unknown) => error instanceof TypedClientModelError && error.code === 'too-many-nodes');
});
