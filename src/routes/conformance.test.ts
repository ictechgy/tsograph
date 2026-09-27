/**
 * Next.js 경로 변환의 적합성 검사다.
 *
 * 1. 벤더링한 isthmus `conformance/http-template.json`의 `template.grammar` 사례로 테스트용 문법
 *    검사기를 먼저 검증한 뒤, 합성 fixture가 내는 모든 정적 channel이 그 문법을 지키는지 본다.
 *    같은 파일의 `template.normalize` 사례(리터럴 정규화)는 정적 세그먼트 변환에 적용한다.
 * 2. Next.js 변환표는 아직 isthmus 벡터에 없다. 확인한 출처(next@16.2.7 패키지의 소스·번들 문서)를
 *    적은 사례를 isthmus 벡터와 같은 모양으로 두어, 나중에 `producer:nextjs` 사례로 올릴 수 있게 한다.
 */

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { classifySegment, toRoutePath } from './next-path.ts';

/** 저장소 루트다. */
const repositoryRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

/** 벡터 사례 중 이 검사가 읽는 모양이다. */
interface VectorCase {
  readonly id: string;
  readonly ruleId: string;
  readonly appliesTo: readonly string[];
  readonly input: { readonly template?: string; readonly path?: string; readonly framework?: string };
  readonly expect: { readonly valid?: boolean; readonly template?: string };
}

/** 벤더링한 http-template 사례다. */
const vectorCases = (JSON.parse(readFileSync(join(repositoryRoot, 'conformance/http-template.json'), 'utf8')) as { cases: VectorCase[] }).cases;

/** pchar 리터럴 문자(퍼센트 제외)다. */
const literalCharacter = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/u;

/**
 * 계약의 정규 템플릿 문법을 검사한다(테스트 전용 참조 구현).
 *
 * @param template 템플릿
 * @returns 유효하면 true
 */
function isCanonicalTemplate(template: string): boolean {
  if (!template.startsWith('/') || template.length > 2048) return false;
  const segments = template.slice(1).split('/');
  return segments.every((segment, index) => isCanonicalSegment(segment, index === segments.length - 1));
}

/**
 * 세그먼트 하나의 문법을 검사한다.
 *
 * @param segment 세그먼트
 * @param isLast 마지막 세그먼트인지
 * @returns 유효하면 true
 */
function isCanonicalSegment(segment: string, isLast: boolean): boolean {
  if (segment === '{**}') return isLast;
  const parts = segment.split('{}');
  if (parts.length > 2) return false;
  return parts.every(isCanonicalLiteral);
}

/**
 * 리터럴 조각의 문법(pchar, 대문자 `%XX`, unreserved 비인코딩)을 검사한다.
 *
 * @param literal 리터럴 조각
 * @returns 유효하면 true
 */
function isCanonicalLiteral(literal: string): boolean {
  for (let index = 0; index < literal.length; index++) {
    const character = literal[index]!;
    if (character !== '%') {
      if (!literalCharacter.test(character)) return false;
      continue;
    }
    const pair = literal.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/u.test(pair)) return false;
    if (/^[A-Za-z0-9\-._~]$/u.test(String.fromCharCode(Number.parseInt(pair, 16)))) return false;
    index += 2;
  }
  return true;
}

test('테스트용 문법 검사기는 isthmus template.grammar 사례를 모두 통과한다', () => {
  const grammar = vectorCases.filter((entry) => entry.ruleId === 'template.grammar');
  assert.ok(grammar.length > 0);
  const failures = grammar.filter((entry) => isCanonicalTemplate(entry.input.template!) !== entry.expect.valid);
  assert.deepEqual(failures.map((entry) => entry.id), []);
});

test('isthmus template.normalize 사례: 정적 Next 세그먼트도 같은 리터럴 정규화를 쓴다', () => {
  const normalize = vectorCases.filter((entry) => entry.ruleId === 'template.normalize' && entry.input.framework === undefined);
  assert.ok(normalize.length > 0);
  const failures = normalize.filter((entry) => {
    // 세그먼트마다 정적 분류로 바꾼다. 중괄호는 Next 동적 문법이 아니라 리터럴이다.
    const converted = entry.input.path!.split('/').map((segment) => {
      const segmentClass = classifySegment(segment, 'pages');
      return segmentClass.kind === 'static' ? segmentClass.literal : undefined;
    });
    return converted.includes(undefined) || converted.join('/') !== entry.expect.template;
  });
  assert.deepEqual(failures.map((entry) => entry.id), []);
});

/** Next.js 16.2.7에서 확인한 폴더 → 템플릿 사례다(isthmus 벡터와 같은 모양). */
const nextCases: readonly { id: string; provenance: 'verified-source' | 'verified-doc'; source: string; router: 'app' | 'pages'; segments: string[]; expect: string | 'dynamic' | 'skipped' }[] = [
  { id: 'nextjs/app-static', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/app-paths.js#normalizeAppPath', router: 'app', segments: ['api', 'items'], expect: '/api/items' },
  { id: 'nextjs/app-root', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/app-paths.js#normalizeAppPath', router: 'app', segments: [], expect: '/' },
  { id: 'nextjs/app-group-omitted', provenance: 'verified-source', source: 'next/dist/shared/lib/segment.js#isGroupSegment', router: 'app', segments: ['(admin)', 'api'], expect: '/api' },
  { id: 'nextjs/dynamic', provenance: 'verified-doc', source: 'next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md', router: 'app', segments: ['items', '[id]'], expect: '/items/{}' },
  { id: 'nextjs/catch-all', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/route-regex.js (repeat → /(.+?))', router: 'app', segments: ['files', '[...path]'], expect: '/files/{**}' },
  { id: 'nextjs/optional-catch-all', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/route-regex.js (optional repeat → (?:/(.+?))?)', router: 'pages', segments: ['docs', '[[...slug]]'], expect: '/docs/{**} + /docs' },
  { id: 'nextjs/pages-api-optional-catch-all', provenance: 'verified-doc', source: 'next/dist/docs/02-pages/03-building-your-application/01-routing/07-api-routes.md (Optional catch all API routes); server/route-matchers/pages-api-route-matcher.js extends RouteMatcher (getRouteRegex)', router: 'pages', segments: ['api', 'post', '[[...slug]]'], expect: '/api/post/{**} + /api/post' },
  { id: 'nextjs/private-folder', provenance: 'verified-source', source: 'next/dist/build/route-discovery.js#collectAppFiles (ignorePartFilter)', router: 'app', segments: ['_lib', 'api'], expect: 'skipped' },
  { id: 'nextjs/pages-underscore-literal', provenance: 'verified-source', source: 'next/dist/build/route-discovery.js#collectPagesFiles (no ignorePartFilter)', router: 'pages', segments: ['api', '_x'], expect: '/api/_x' },
  { id: 'nextjs/encoded-underscore', provenance: 'verified-doc', source: 'next/dist/docs/01-app/01-getting-started/02-project-structure.md (%5FfolderName)', router: 'app', segments: ['%5Fx'], expect: '/_x' },
  { id: 'nextjs/optional-single-rejected', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/sorted-routes.js (E435)', router: 'app', segments: ['[[id]]'], expect: 'skipped' },
  { id: 'nextjs/catch-all-not-last-rejected', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/sorted-routes.js (E392)', router: 'app', segments: ['[...a]', 'b'], expect: 'skipped' },
  { id: 'nextjs/partial-segment', provenance: 'verified-source', source: 'next/dist/shared/lib/router/utils/sorted-routes.js vs route-regex.js disagree on prefix/suffix', router: 'app', segments: ['v[id]'], expect: 'dynamic' },
  { id: 'nextjs/slot-unmodeled', provenance: 'verified-doc', source: 'next/dist/docs/01-app/03-api-reference/03-file-conventions/parallel-routes.md (pages only)', router: 'app', segments: ['@modal', 'api'], expect: 'skipped' },
  { id: 'nextjs/interception-unmodeled', provenance: 'verified-doc', source: 'next/dist/docs/01-app/03-api-reference/03-file-conventions/intercepting-routes.md (pages only)', router: 'app', segments: ['(.)photo'], expect: 'skipped' },
];

/**
 * 사례 하나의 변환 결과를 문자열로 만든다.
 *
 * @param segments 세그먼트
 * @param router 라우터
 * @returns 템플릿(optional catch-all이면 접두사 포함), 'dynamic', 'skipped'
 */
function convert(segments: readonly string[], router: 'app' | 'pages'): string {
  const path = toRoutePath(segments, router);
  if (path.kind === 'dynamic') return 'dynamic';
  if (path.kind !== 'template') return 'skipped';
  const template = `/${path.segments.join('/')}`;
  return path.optionalCatchAll ? `${template} + /${path.segments.slice(0, -1).join('/')}` : template;
}

test('Next.js 변환표(확인한 출처 포함)를 통과한다', () => {
  const failures = nextCases.filter((entry) => convert(entry.segments, entry.router) !== entry.expect);
  assert.deepEqual(failures.map((entry) => `${entry.id}: ${convert(entry.segments, entry.router)}`), []);
  assert.ok(nextCases.every((entry) => entry.source.startsWith('next/dist/')));
});

test('합성 fixture가 내는 정적 channel은 모두 정규 템플릿 문법을 지킨다', async () => {
  for (const name of ['app-router', 'pages-api']) {
    const result = await runRoutesCommand(['--role', 'server', '--project', join(repositoryRoot, 'fixtures/next', name), '--include-tests'], {
      fileSystem: createNodeFileSystem(),
      toolVersion: '0.0.0-test',
      now: () => new Date(0),
    });
    const document = JSON.parse(result.standardOutput) as { facts: { channel: string; dynamic: boolean }[] };
    const invalid = document.facts.filter((fact) => !fact.dynamic && !isCanonicalTemplate(fact.channel));
    assert.deepEqual(invalid, [], name);
    assert.ok(document.facts.length > 0, name);
  }
});
