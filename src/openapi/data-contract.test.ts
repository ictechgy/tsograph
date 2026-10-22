/** 고정된 데이터 근거와 미지원 구역·예산 및 기존 출력 호환을 검증한다. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runOpenApiCommand } from '../cli/openapi-command.ts';
import { createContractDocument } from './contract-document.ts';
import { extractDataContract } from './data-contract.ts';
import { parseSpecTree } from './spec-tree.ts';

/** operation 하나를 YAML 트리로 만든다. */
function extract(operation: unknown) {
  const tree = parseSpecTree(JSON.stringify(operation));
  return extractDataContract(tree, tree.root!);
}
test('primitive body/query/header fields retain only explicit evidence', () => {
  const result = extract({ requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', nullable: false }, label: { type: 'string', nullable: true } } } } } }, responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { active: { type: 'boolean' } } } } } } }, parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' }, required: true }, { in: 'header', name: 'X-Version', type: 'string', required: false }] });
  assert.deepEqual(result.fields[0], { in: 'request-body', path: '/application~1json/id', type: 'integer', nullable: false, required: true });
  assert.equal(result.fields[1]?.required, false);
  assert.equal(result.fields[2]?.path, '/200/application~1json/active');
  assert.equal(result.fields[3]?.in, 'query'); assert.equal(result.fields[4]?.in, 'header');
  assert.ok(result.limitations.some((line) => line.includes('compatibility is not established')));
});
test('references, combinators, nested/union types and malformed sections remain unknown', () => {
  const result = extract({ requestBody: { content: { 'application/json': { schema: { type: 'object', required: 'bad', properties: { ref: { $ref: '#/components/schemas/X' }, nested: { type: 'object' }, union: { type: ['string', 'null'] }, composed: { allOf: [] }, missing: {} } } } } }, responses: { '200': { content: { 'application/json': { schema: { $ref: 'external.json' } } } }, '400': {} }, parameters: [{ $ref: '#/parameters/p' }, { in: 'cookie', name: 'x' }, { in: 'query', name: 'x', schema: { type: 'array' } }] });
  assert.equal(result.fields.length, 0);
  assert.ok(result.limitations.some((line) => line.startsWith('required:')));
  assert.ok(result.limitations.some((line) => line.startsWith('schema:')));
  assert.ok(result.limitations.some((line) => line.startsWith('parameters:')));
  assert.ok(extract({ parameters: {} }).limitations.some((line) => line.includes('malformed')));
});
test('field budget and UTF-16 path budget are explicit, no unbounded recursive schemas', () => {
  const properties = Object.fromEntries(Array.from({ length: 514 }, (_, index) => [`key${index}`, { type: 'string' }]));
  const result = extract({ requestBody: { content: { json: { schema: { properties, required: [1] } } } }, parameters: [{ in: 'query', name: '😀'.repeat(513), type: 'string' }] });
  assert.equal(result.fields.length, 512);
  assert.ok(result.limitations.some((line) => line.startsWith('field-budget:')));
  assert.ok(result.limitations.some((line) => line.startsWith('field-path:')));
  assert.ok(result.limitations.some((line) => line.startsWith('required:')));
});
test('non-string keys and unsupported body schemas are recorded', () => {
  const tree = parseSpecTree('requestBody:\n  content:\n    1: {}\n    json:\n      schema:\n        properties:\n          1: {type: string}\nresponses:\n  200: {}\n');
  const result = extractDataContract(tree, tree.root!);
  assert.ok(result.limitations.some((line) => line.startsWith('field-name:')));
  assert.ok(result.limitations.some((line) => line.startsWith('responses:')));
  assert.ok(result.limitations.some((line) => line.startsWith('body-content:')));
  assert.ok(extract({ requestBody: { content: { json: { schema: { type: 'string' } } } } }).limitations.some((line) => line.startsWith('body-schema:')));
});
test('default bridge-facts output stays compatible; opt-in emits bounded contract through CLI', async () => {
  const spec = JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: { parameters: [{ in: 'query', name: 'id', schema: { type: 'integer' } }], responses: {} } } } });
  const input = { tree: parseSpecTree(spec), specPath: 'api.json', project: '.', service: 'test', toolVersion: 'test', generatedAt: new Date(0), sourceModifiedAt: undefined };
  assert.equal(createContractDocument(input).facts[0]?.dataContract, undefined);
  assert.equal(createContractDocument({ ...input, dataContracts: true }).facts[0]?.dataContract?.fields[0]?.in, 'query');
  const root = mkdtempSync(join(tmpdir(), 'tsograph-contract-test-'));
  try {
    writeFileSync(join(root, 'api.json'), spec);
    const result = await runOpenApiCommand([join(root, 'api.json'), '--service', 'test', '--data-contracts'], { toolVersion: 'test', now: () => new Date(0), fileSystem: createNodeFileSystem() });
    assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.standardOutput).facts[0].dataContract.version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
