/**
 * Node 백엔드 오라클 기록(`experiments/node-routes-oracle/recorded/*.json`)을 오프라인으로 다시 검사한다.
 *
 * 기록은 합성 fixture를 스크래치 사본에 설치해 실제 프레임워크(Hono 4.13.12, Express 4.22.3·5.2.1, @koa/router 15.7.0·13.1.1,
 * Fastify 5.12.5·4.29.1, NestJS 12.1.2)로 불러오고, tsograph 문서가 예측한 핸들러와 실제 응답을 대조한 결과다(`run-oracle.mjs`).
 * 이 검사는 네트워크 없이 (1) 지금 tsograph가 같은 fixture에서 기록 때와 같은 문서를 내는지, (2) 기록의 모든 탐침이 통과했고
 * 정밀도·재현율이 100%인지를 본다. 규칙이 바뀌어 문서가 달라지면 오라클을 다시 돌려 기록을 갱신해야 한다.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';
import { dispatchOrderProblem } from '../../exchange/dispatch-order.ts';
import { dynamicScopeProblem } from '../../exchange/dynamic-scope.ts';
import { isCanonicalTemplate } from '../../exchange/route-template-grammar.ts';

/** 저장소 루트다. */
const repositoryRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

/** 기록 디렉터리다. */
const recordedDirectory = join(repositoryRoot, 'experiments/node-routes-oracle/recorded');

/** 기록 하나의 모양이다. */
interface Recording {
  readonly fixture: string;
  readonly framework: string;
  readonly versions: Record<string, string>;
  readonly dispatch: string;
  readonly facts: readonly Record<string, unknown>[];
  readonly limitations: readonly string[];
  readonly records: readonly { readonly kind: string; readonly ok: boolean; readonly actual: string }[];
  readonly summary: { readonly staticFacts: number; readonly verifiedFacts: number; readonly servedRoutes: number; readonly coveredRoutes: number; readonly failedProbes: number };
}

/** 기록 목록이다. */
const recordings = readdirSync(recordedDirectory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(recordedDirectory, name), 'utf8')) as Recording);

/**
 * fixture에 routes 명령을 실행한다.
 *
 * @param fixture fixture 이름
 * @returns 문서
 */
async function scanFixture(fixture: string): Promise<{ dispatch: string; facts: Record<string, unknown>[]; limitations: string[]; limitationScopes?: unknown[] }> {
  const result = await runRoutesCommand(['--role', 'server', '--project', join(repositoryRoot, 'fixtures/node', fixture)], {
    fileSystem: createNodeFileSystem(),
    toolVersion: '0.0.0-test',
    now: () => new Date(0),
  });
  assert.equal(result.exitCode, 0, result.standardError);
  return JSON.parse(result.standardOutput);
}

test('오라클 기록은 다섯 프레임워크와 아홉 fixture를 덮는다', () => {
  assert.deepEqual(recordings.map((entry) => entry.fixture), ['express4-app', 'express5-app', 'fastify4-app', 'fastify5-app', 'hono-app', 'hono-loose-app', 'koa-app', 'koa13-app', 'nest-app']);
  assert.deepEqual([...new Set(recordings.map((entry) => entry.framework))].sort(), ['express', 'fastify', 'hono', 'koa', 'nest']);
});

for (const recording of recordings) {
  // 고정 fixture의 최종 문서만 공유한다. 두 검사는 출력을 읽기만 하며 입력·Program을 캐시하지 않는다.
  let document: ReturnType<typeof scanFixture> | undefined;
  const recordedDocument = () => document ??= scanFixture(recording.fixture);

  test(`${recording.fixture}: 모든 탐침이 통과했고 정밀도·재현율이 100%다`, () => {
    assert.equal(recording.summary.failedProbes, 0);
    assert.ok(recording.records.every((record) => record.ok));
    assert.equal(recording.summary.verifiedFacts, recording.summary.staticFacts);
    assert.equal(recording.summary.coveredRoutes, recording.summary.servedRoutes);
    assert.ok(recording.summary.staticFacts > 0 && recording.summary.servedRoutes > 0);
    assert.ok(recording.records.some((record) => record.kind === 'recall'));
  });

  test(`${recording.fixture}: 지금 tsograph 문서가 기록한 문서와 같다`, async () => {
    const document = await recordedDocument();
    assert.equal(document.dispatch, recording.dispatch);
    assert.deepEqual(document.facts, recording.facts);
    assert.deepEqual(document.limitations, recording.limitations);
  });

  test(`${recording.fixture}: 문서가 isthmus 계약 검사(템플릿·order·dynamicScope)를 통과한다`, async () => {
    const document = await recordedDocument();
    assert.equal(dispatchOrderProblem(document), undefined);
    for (const fact of document.facts) {
      if (fact['dynamic'] !== true) assert.ok(isCanonicalTemplate(fact['channel'] as string), String(fact['channel']));
      assert.equal(dynamicScopeProblem(fact), undefined);
    }
  });
}
