/** URL 조립의 공유 벡터와 개인정보 제거 경계를 검사한다. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeUrl, type UrlJoin, type UrlPart } from './url-compose.ts';

/** 벡터의 관찰 가능한 필드만 읽는다. */
interface Vector {
  id: string; ruleId: string; appliesTo: string[]; expectDynamic?: boolean;
  input: { join?: UrlJoin; base?: string | null; path?: string; parts?: ({literal: string} | {value: string} | {queryTail: string})[] };
  expect?: { template?: string; channelPrefix?: string; authority?: string; pathAnchor?: string; queryTailStripped?: true };
}
const vectors = (JSON.parse(readFileSync(new URL('../../../conformance/url-compose.json', import.meta.url), 'utf8')) as { cases: Vector[] }).cases;
test('shared compose/base-join vectors describe producer behavior', () => {
  let checked = 0;
  for (const v of vectors) {
    const generic = v.appliesTo.includes('producer') && v.input.parts !== undefined;
    if (!generic && !v.appliesTo.includes('producer:tsograph')) continue;
    const parts: UrlPart[] = v.input.parts?.map((p) => 'literal' in p ? p : 'value' in p ? {value: true} : {queryTail: true}) ?? [{literal: v.input.path!}];
    const actual = composeUrl(parts, v.input.join, v.input.base);
    assert.equal(actual.dynamic, v.expectDynamic === true, v.id);
    for (const [key, expected] of Object.entries(v.expect ?? {})) {
      assert.equal(actual[key === 'template' ? 'channel' : key as keyof typeof actual], expected, `${v.id}: ${key}`);
    }
    checked++;
  }
  assert.ok(checked >= 24);
});

test('full segment at template end, relative URLs, absolute override and invalid inputs', () => {
  assert.equal(composeUrl([{literal:'/items/'},{value:true},{literal:''}]).channel, '/items/{}');
  assert.equal(composeUrl([{literal:'items'}]).pathAnchor, 'base');
  assert.equal(composeUrl([{literal:'https://other.example.com/items'}], 'axios-base-url', null).authority, 'other.example.com');
  assert.equal(composeUrl([{literal:'https://other.example.com/items'}], 'axios-base-url', 'https://api.example.com/v1', false).channel, '/v1/https://other.example.com/items');
  for (const path of ['data:text/plain,hello','http:/missing-host','/bad\u0000path','/bad\uD800path','/'.repeat(2050)]) assert.equal(composeUrl([{literal:path}]).dynamic, true);
  assert.equal(composeUrl([{literal:'https://hooks.slack.com/services/synthetic/fixture/path'}]).maskedSegments, 4);
  assert.equal(composeUrl([{literal:'https://discord.com/api/webhooks/synthetic/fixture'}]).channel, '/api/webhooks/{}/{}');
});

test('unsupported or malformed protocol cannot become an unknown-base HTTP fact', () => {
  for (const join of ['axios-base-url','ky-prefix','ky-prefix-url','ky-base-url'] as const) {
    for (const path of ['data:payload','http:/missing-host','ftp://other.example.com/items']) {
      assert.equal(composeUrl([{literal:path}], join, null).dynamic, true, `${join}: ${path}`);
    }
  }
  assert.equal(composeUrl([{literal:'http:/missing-host'}], 'axios-base-url', 'https://api.example.com').dynamic, true);
  assert.equal(composeUrl([{literal:'ftp://other.example.com/items'}], 'axios-base-url', 'https://api.example.com').dynamic, true);
});
