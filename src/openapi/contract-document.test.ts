import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RouteContractDocument } from '../exchange/bridge-facts.ts';
import { createContractDocument, FactLimitError, MAX_FACTS, MAX_OPERATION_ID_LENGTH } from './contract-document.ts';
import { MAX_PATH_ITEM_REFERENCE_HOPS } from './operations.ts';
import { MAX_DYNAMIC_CHANNEL_LENGTH, MAX_TEMPLATE_LENGTH } from './path-template.ts';
import { parseSpecTree, SpecParseError } from './spec-tree.ts';

/** 합성 스펙 텍스트로 문서를 만든다. 시각·경로는 고정값이다. */
function documentFor(source: string, sourceModifiedAt?: Date): RouteContractDocument {
  return createContractDocument({
    tree: parseSpecTree(source),
    specPath: 'api/openapi.yaml',
    project: '/work/project',
    service: 'orders-api',
    toolVersion: '0.0.0-test',
    generatedAt: new Date('2026-09-27T01:02:03.004Z'),
    sourceModifiedAt,
  });
}

/** 사실을 비교하기 쉬운 `METHOD anchor channel` 문자열로 줄인다. */
function routes(document: RouteContractDocument): string[] {
  return document.facts.map((fact) => `${fact.method} ${fact.pathAnchor}${fact.dynamic ? '*' : ''} ${fact.channel}`);
}

test('문서 봉투는 openapi·http·server 역할과 service·project·시각을 싣는다', () => {
  const document = documentFor('openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n', new Date('2026-01-02T03:04:05Z'));
  const { facts, ...envelope } = document;
  assert.deepEqual(envelope, {
    format: 'bridge-facts',
    version: 1,
    tool: { name: 'tsograph', version: '0.0.0-test' },
    generatedAt: '2026-09-27T01:02:03.004Z',
    sourceModifiedAt: '2026-01-02T03:04:05.000Z',
    platform: 'openapi',
    target: 'http',
    roles: ['server'],
    service: 'orders-api',
    project: '/work/project',
    limitations: [],
  });
  assert.deepEqual(facts, [{
    kind: 'route-contract',
    method: 'GET',
    channel: '/a',
    dynamic: false,
    pathAnchor: 'root',
    service: 'orders-api',
    location: { path: 'api/openapi.yaml', line: 4, column: 5 },
  }]);
});

test('operationId는 symbol.qualifiedName과 operationId 증거로 싣는다', () => {
  const document = documentFor('openapi: 3.0.0\npaths:\n  /a:\n    get: {operationId: listA}\n');
  assert.deepEqual(document.facts[0]?.symbol, { qualifiedName: 'listA' });
  assert.equal(document.facts[0]?.operationId, 'listA');
});

test('안전하지 않은 operationId는 빼고 정보용 limitation으로 센다', () => {
  const long = 'o'.repeat(MAX_OPERATION_ID_LENGTH + 1);
  const document = documentFor(`openapi: 3.0.0\npaths:\n  /a:\n    get: {operationId: "bad\\u0007id"}\n    post: {operationId: ${long}}\n`);
  assert.equal(document.facts[0]?.symbol, undefined);
  assert.equal(document.facts[0]?.operationId, undefined);
  assert.equal(document.facts[1]?.operationId, undefined);
  assert.deepEqual(document.limitations, [`unsafe-operation-ids: 2 operationId values contain characters the exchange format forbids or exceed ${MAX_OPERATION_ID_LENGTH} characters and were omitted`]);
});

test('사실 0건 스펙도 target http와 server 역할을 유지한다', () => {
  const document = documentFor('openapi: 3.1.0\nwebhooks:\n  hook:\n    post: {}\n');
  assert.deepEqual(document.facts, []);
  assert.equal(document.target, 'http');
  assert.equal(document.sourceModifiedAt, undefined);
});

test('3.0 여러 서버의 서로 다른 경로 접두사마다 사실을 내고 같은 접두사는 합친다', () => {
  const document = documentFor([
    'openapi: 3.0.0',
    'servers:',
    '  - url: https://a.test/v1',
    '  - url: https://b.test/v1/',
    '  - url: /v2',
    'paths:',
    '  /items/{id}:',
    '    get: {}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET root /v1/items/{}', 'GET root /v2/items/{}']);
});

test('host만 있는 서버와 서버 없음은 root 루트 접두사다', () => {
  assert.deepEqual(routes(documentFor('openapi: 3.0.0\nservers: [{url: "https://h.test"}]\npaths: {/a: {get: {}}}\n')), ['GET root /a']);
  assert.deepEqual(routes(documentFor('openapi: 3.0.0\nservers: []\npaths: {/a: {get: {}}}\n')), ['GET root /a']);
});

test('path 수준 servers가 루트를, operation 수준 servers가 path 수준을 덮는다', () => {
  const document = documentFor([
    'openapi: 3.0.0',
    'servers: [{url: /root}]',
    'paths:',
    '  /a:',
    '    servers: [{url: /path}]',
    '    get: {}',
    '    post: {servers: [{url: /op}]}',
    '    put: {servers: []}',
    '  /b:',
    '    get: {}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['POST root /op/a', 'GET root /path/a', 'PUT root /path/a', 'GET root /root/b']);
});

test('경로의 열린 서버 변수는 base 앵커와 unresolved-contract-servers를 낸다', () => {
  const document = documentFor([
    'openapi: 3.0.0',
    'servers:',
    '  - url: https://h.test/{basePath}/api',
    '    variables: {basePath: {default: v2}}',
    '  - url: https://h.test/stable',
    'paths: {/a: {get: {}, post: {}}}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET base /api/a', 'POST base /api/a', 'GET root /stable/a', 'POST root /stable/a']);
  assert.equal(document.limitations.length, 1);
  assert.match(document.limitations[0]!, /^unresolved-contract-servers: 2 operations /);
});

test('경로의 enum 서버 변수는 값마다 root 사실을 낸다', () => {
  const document = documentFor([
    'openapi: 3.1.0',
    'servers:',
    '  - url: https://h.test/{v}',
    '    variables: {v: {default: v1, enum: [v1, v2]}, port: {default: 8443}}',
    'paths: {/a: {get: {}}}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET root /v1/a', 'GET root /v2/a']);
});

test('정수 enum·잘못된 서버 객체·배열이 아닌 servers를 fail-closed로 처리한다', () => {
  const integers = documentFor('openapi: 3.0.0\nservers: [{url: "/{n}", variables: {n: {enum: [1, 2]}}}]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(integers), ['GET root /1/a', 'GET root /2/a']);
  const surrogate = documentFor('openapi: 3.0.0\nservers: [{url: "/{n}", variables: {n: {enum: ["\\uD800"]}}}]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(surrogate), ['GET base /a']);
  const mixed = documentFor('openapi: 3.0.0\nservers: [{url: "/{n}", variables: {n: {enum: [1.5, x]}}}]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(mixed), ['GET base /a']);
  const noUrl = documentFor('openapi: 3.0.0\nservers: [{description: x}, "string"]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(noUrl), ['GET base /a']);
  const notList = documentFor('openapi: 3.0.0\nservers: {url: /x}\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(notList), ['GET base /a']);
  const variablesNotObject = documentFor('openapi: 3.0.0\nservers: [{url: "/{n}", variables: [1]}]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(variablesNotObject), ['GET base /a']);
  const nonStringVariableKey = documentFor('openapi: 3.0.0\nservers: [{url: "/x", variables: {1: {default: a}}}]\npaths: {/a: {get: {}}}\n');
  assert.deepEqual(routes(nonStringVariableKey), ['GET root /x/a']);
});

test('같은 servers 노드를 공유하는 operation은 한 번만 해석해도 같은 결과다', () => {
  const document = documentFor('openapi: 3.0.0\nx-s: &s [{url: /shared}]\npaths:\n  /a: {servers: *s, get: {}}\n  /b: {servers: *s, get: {}}\n');
  assert.deepEqual(routes(document), ['GET root /shared/a', 'GET root /shared/b']);
});

test('Swagger 2.0은 basePath를 합성하고 host·schemes를 버리며 trace는 operation이 아니다', () => {
  const document = documentFor(JSON.stringify({
    swagger: '2.0',
    host: 'h.test',
    schemes: ['https'],
    basePath: '/v2',
    paths: { '/a': { get: {}, trace: {}, parameters: [], servers: [] } },
  }));
  assert.deepEqual(routes(document), ['GET root /v2/a']);
  assert.deepEqual(document.limitations, ['contract-coverage: 2 path item fields are neither operations for this OpenAPI version nor known fields and were skipped']);
});

test('Swagger 2.0의 잘못된 basePath는 base다', () => {
  const document = documentFor(JSON.stringify({ swagger: '2.0', basePath: 'v2', paths: { '/a': { get: {} } } }));
  assert.deepEqual(routes(document), ['GET base /a']);
  const noBase = documentFor(JSON.stringify({ swagger: '2.0', paths: { '/a': { get: {} } } }));
  assert.deepEqual(routes(noBase), ['GET root /a']);
});

test('3.0 trace는 operation이다', () => {
  assert.deepEqual(routes(documentFor('openapi: 3.0.0\npaths: {/a: {trace: {}}}\n')), ['TRACE root /a']);
});

test('부분 세그먼트는 골격, 여러 파라미터 세그먼트는 dynamic과 contract-coverage다', () => {
  const document = documentFor('openapi: 3.0.0\nservers: [{url: /v1}]\npaths:\n  /f/{n}.json: {get: {}}\n  /r/{y}-{m}: {get: {}}\n');
  assert.deepEqual(routes(document), ['GET root /v1/f/{}.json', 'GET root* /v1/r/{y}-{m}']);
  assert.match(document.limitations[0]!, /^contract-coverage: 1 operation path templates /);
});

test('합친 템플릿이 길이 상한을 넘으면 dynamic과 contract-coverage로 낸다', () => {
  const long = `/${'a'.repeat(MAX_TEMPLATE_LENGTH)}`;
  // YAML 암시 키는 1024자 상한이 있어 명시 키(`?`)로 긴 경로를 쓴다.
  const document = documentFor(`openapi: 3.0.0\nservers: [{url: /v1}]\npaths:\n  ? ${long}\n  : {get: {}, post: {}}\n  /ok: {get: {}}\n`);
  assert.deepEqual(document.facts.map((fact) => [fact.method, fact.dynamic, fact.channel.length]), [
    ['GET', true, MAX_DYNAMIC_CHANNEL_LENGTH],
    ['POST', true, MAX_DYNAMIC_CHANNEL_LENGTH],
    ['GET', false, 6],
  ]);
  assert.match(document.limitations[0]!, /^contract-coverage: 2 operation path templates /);
});

test('긴 서버 접두사와 합친 dynamic 원문도 길이 상한을 넘지 않는다', () => {
  const prefix = `/${'s'.repeat(MAX_TEMPLATE_LENGTH)}`;
  const document = documentFor(`openapi: 3.0.0\nservers: [{url: "${prefix}"}]\npaths:\n  /r/{y}-{m}: {get: {}}\n`);
  assert.equal(document.facts[0]?.dynamic, true);
  assert.equal(document.facts[0]?.channel.length, MAX_DYNAMIC_CHANNEL_LENGTH);
});

test('path item $ref(3.1 components.pathItems)를 따라가고 형제 필드도 남긴다', () => {
  const document = documentFor([
    'openapi: 3.1.0',
    'paths:',
    '  /a:',
    '    $ref: "#/components/pathItems/A"',
    '    delete: {}',
    'components:',
    '  pathItems:',
    '    A:',
    '      get: {operationId: getA}',
    '      servers: [{url: /from-ref}]',
  ].join('\n'));
  assert.deepEqual(routes(document), ['DELETE root /from-ref/a', 'GET root /from-ref/a']);
  const getFact = document.facts.find((fact) => fact.method === 'GET');
  assert.deepEqual(getFact?.location, { path: 'api/openapi.yaml', line: 9, column: 7 });
});

test('읽지 못한 path item은 이유별 개수로 contract-coverage에 싣는다', () => {
  const document = documentFor([
    'openapi: 3.1.0',
    'paths:',
    '  /remote: {$ref: "other.yaml#/paths/x"}',
    '  /broken: {$ref: "#/nope"}',
    '  /badref: {$ref: 1}',
    '  /cycle: {$ref: "#/paths/~1cycle"}',
    '  /scalar: 3',
    '  /empty:',
    '  /opnotobject: {get: 1}',
    '  nope: {get: {}}',
    '  x-ext: {get: {}}',
    '  /ok: {get: {}, GET: {}, x-note: 1, summary: s}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET root /ok']);
  assert.deepEqual(document.limitations, [
    'contract-coverage: 1 operations are not objects and were skipped',
    'contract-coverage: 1 path item fields are neither operations for this OpenAPI version nor known fields and were skipped',
    'contract-coverage: 1 paths keys do not start with "/" and were skipped',
    'contract-coverage: 5 path items could not be read (1 non-local $ref, 2 broken $ref, 1 cyclic $ref, 1 non-object) and were skipped',
  ]);
});

test('path item $ref 사슬이 단계 상한을 넘으면 순환으로 센다', () => {
  const chain = Array.from({ length: MAX_PATH_ITEM_REFERENCE_HOPS + 2 }, (_, index) => `    p${index}: {$ref: "#/components/pathItems/p${index + 1}"}`);
  const document = documentFor([
    'openapi: 3.1.0',
    'paths:',
    '  /deep: {$ref: "#/components/pathItems/p0"}',
    'components:',
    '  pathItems:',
    ...chain,
    `    p${MAX_PATH_ITEM_REFERENCE_HOPS + 2}: {get: {}}`,
  ].join('\n'));
  assert.deepEqual(document.facts, []);
  assert.match(document.limitations[0]!, /1 cyclic \$ref/);
});

test('사실은 channel·method·앵커·위치 순으로 결정적이고 두 번 만들어도 같다', () => {
  const source = 'openapi: 3.0.0\npaths:\n  /b: {post: {}, get: {}}\n  /a: {get: {}}\n';
  assert.deepEqual(routes(documentFor(source)), ['GET root /a', 'GET root /b', 'POST root /b']);
  assert.deepEqual(documentFor(source), documentFor(source));
});

test('같은 정규 키를 가진 서로 다른 경로 키는 위치마다 사실로 남는다', () => {
  const document = documentFor('openapi: 3.0.0\npaths:\n  /u/{id}: {get: {operationId: b}}\n  /u/{name}: {get: {operationId: a}}\n');
  assert.deepEqual(document.facts.map((fact) => [fact.channel, fact.location.line]), [['/u/{}', 3], ['/u/{}', 4]]);
});

test('같은 위치·같은 키의 완전 중복 사실은 하나로 줄인다', () => {
  const document = documentFor('openapi: 3.1.0\npaths:\n  /a: {$ref: "#/components/pathItems/A", get: {}}\ncomponents: {pathItems: {A: {}}}\n');
  assert.equal(document.facts.length, 1);
});

test('authority가 리터럴이 아닌 서버 URL 앞의 변수는 root로 확정하지 않는다', () => {
  const document = documentFor('openapi: 3.0.0\nservers: [{url: "{base}/v1"}]\npaths: {/users: {get: {}}}\n');
  assert.deepEqual(routes(document), ['GET base /v1/users']);
  assert.match(document.limitations[0]!, /^unresolved-contract-servers: 1 /);
});

test('큰 매핑을 여러 번 가리켜도 한 번만 훑고 모르는 필드는 한 번만 센다', { timeout: 20_000 }, () => {
  const keys = Array.from({ length: 40_000 }, (_, index) => `k${index}: 1`).join(', ');
  const refs = Array.from({ length: 4000 }, (_, index) => `  /r${index}: {$ref: "#/x-big"}`);
  const aliases = Array.from({ length: 4000 }, (_, index) => `  /a${index}: {get: *o}`);
  const document = documentFor(['openapi: 3.0.0', `x-big: {${keys}}`, `x-o: &o {operationId: shared, ${keys}}`, 'paths:', ...refs, ...aliases].join('\n'));
  assert.equal(document.facts.length, 4000);
  assert.deepEqual(document.limitations, ['contract-coverage: 40000 path item fields are neither operations for this OpenAPI version nor known fields and were skipped']);
});

/** 문서 생성이 중복 키 실패(줄 포함)로 끝나는지 확인한다. */
function expectDuplicateKeyFailure(source: string, line: number): void {
  assert.throws(() => documentFor(source), (error: unknown) =>
    error instanceof SpecParseError && error.reason === 'duplicate-key' && error.line === line);
}

test('route와 무관한 곳(components.schemas·operation 설명)의 중복은 limitation으로만 알린다', () => {
  const document = documentFor([
    'openapi: 3.0.0',
    'paths:',
    '  /a:',
    '    get:',
    '      operationId: getA',
    '      description: one',
    '      description: two',
    'components:',
    '  schemas:',
    '    Item: {type: object, description: first}',
    '    Item: {type: object, description: second}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET root /a']);
  assert.deepEqual(document.limitations, ['duplicate-mapping-keys: 2 duplicate key(s) outside route-bearing sections were ignored (first at line 7)']);
});

test('사실을 정하는 구역의 중복 키는 줄 번호와 함께 거부한다', () => {
  expectDuplicateKeyFailure('openapi: 3.0.0\npaths:\n  /a: {get: {}}\n  /a: {post: {}}\n', 4);
  expectDuplicateKeyFailure('openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n    get: {}\n', 5);
  expectDuplicateKeyFailure('openapi: 3.0.0\nservers:\n  - url: "/{v}"\n    variables:\n      v: {default: a}\n      v: {default: b}\npaths: {}\n', 6);
  expectDuplicateKeyFailure('openapi: 3.0.0\nservers:\n  - url: /a\n    url: /b\npaths: {}\n', 4);
  expectDuplicateKeyFailure('openapi: 3.0.0\nservers: [{url: "/{v}", variables: {v: {default: a, default: b}}}]\npaths: {}\n', 2);
  expectDuplicateKeyFailure('swagger: "2.0"\nhost: a\nhost: b\npaths: {}\n', 3);
  expectDuplicateKeyFailure('openapi: 3.0.0\npaths:\n  /a:\n    get: {operationId: x, operationId: y}\n', 4);
  expectDuplicateKeyFailure('openapi: 3.0.0\npaths:\n  /a:\n    get:\n      servers: []\n      servers: [{url: /v1}]\n', 6);
});

test('$ref로 따라간 path item의 중복은 거부하고, 포인터가 지나가지 않는 형제 키의 중복은 알리기만 한다', () => {
  expectDuplicateKeyFailure([
    'openapi: 3.1.0',
    'paths:',
    '  /a: {$ref: "#/components/pathItems/A"}',
    'components:',
    '  pathItems:',
    '    A:',
    '      get: {}',
    '      get: {}',
  ].join('\n'), 8);
  const document = documentFor([
    'openapi: 3.1.0',
    'paths:',
    '  /a: {$ref: "#/components/pathItems/A"}',
    'components:',
    '  pathItems:',
    '    A: {get: {}}',
    '  schemas: {}',
    '  schemas: {}',
  ].join('\n'));
  assert.deepEqual(routes(document), ['GET root /a']);
  assert.match(document.limitations[0]!, /^duplicate-mapping-keys: 1 duplicate key\(s\) .*\(first at line 8\)$/);
});

test('사실 수가 상한을 넘으면 부분 문서 대신 실패한다', () => {
  const variants = Array.from({ length: 256 }, (_, index) => `v${index}`).join(', ');
  const paths = Array.from({ length: Math.ceil(MAX_FACTS / 256 / 8) + 1 }, (_, index) =>
    `  /p${index}: {get: {}, put: {}, post: {}, delete: {}, options: {}, head: {}, patch: {}, trace: {}}`);
  const source = [
    'openapi: 3.0.0',
    'servers:',
    '  - url: "/{v}"',
    `    variables: {v: {default: v0, enum: [${variants}]}}`,
    'paths:',
    ...paths,
  ].join('\n');
  assert.throws(() => documentFor(source), FactLimitError);
});
