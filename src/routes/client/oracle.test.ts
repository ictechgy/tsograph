/** 실제 라이브러리가 로컬 HTTP 서버에 보낸 요청을 추출 사실과 대조한다. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import axios from 'axios';
import ky from 'ky';
import legacy from 'ky-v1';
import { canonicalizeLiteralTemplate } from '../../openapi/path-template.ts';
import { extractClientRoutes } from './client-routes.ts';

test('fetch, axios 1.20.0 and ky 1.10.0/2.1.0 match real HTTP requests', async () => {
  const observed: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    observed.push({method: request.method!, path: request.url!.split(/[?#]/u)[0]!});
    response.setHeader('Connection', 'close'); response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-http-oracle-')));
  try {
    for (const major of [1, 2]) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies:{ky: major === 1 ? '1.10.0' : '2.1.0'}}));
      const calls: string[] = [];
      observed.length = 0;
      for (const path of ['items','/items','items/../users','items//recent/','café?query=value']) {
        const options = {baseURL:`${origin}/api///`, proxy:false as const};
        calls.push(`axios.get(${JSON.stringify(path)}, ${JSON.stringify(options)});`);
        await axios.get(path, {...options, timeout:3000});
        if (major === 1 && path.startsWith('/')) continue;
        const prefix = `${origin}/api${major === 1 ? '//' : '///'}`;
        const key = major === 1 ? 'prefixUrl' : 'prefix';
        calls.push(`ky.get(${JSON.stringify(path)}, {${key}:${JSON.stringify(prefix)}});`);
        if (major === 1) await legacy.get(path, {prefixUrl:prefix, retry:0});
        else await ky.get(path, {prefix, retry:0});
      }
      if (major === 2) {
        for (const base of [`${origin}/api`,`${origin}/api/`]) {
          for (const path of ['items','/items','../items']) {
            calls.push(`ky.post(${JSON.stringify(path)}, {baseUrl:${JSON.stringify(base)}});`);
            await ky.post(path, {baseUrl:base, retry:0});
          }
        }
        calls.push(`axios.request({url:${JSON.stringify(`${origin}/plain?query=value`)}, method:'delete'});`);
        await axios.request({url:`${origin}/plain?query=value`, method:'delete', proxy:false});
        calls.push(`fetch(${JSON.stringify(`${origin}/fetch/items?query=value`)}, {method:'POST'});`);
        const response = await fetch(`${origin}/fetch/items?query=value`, {method:'POST'}); await response.text();
      }
      writeFileSync(join(root, 'client.ts'), `import axios from 'axios'; import ky from 'ky'; export function load(){${calls.join('\n')}}`);
      const facts = extractClientRoutes(root, undefined, false, 'test', new Date()).facts;
      assert.equal(facts.length, observed.length);
      assert.deepEqual(facts.map((f) => ({method:f.method, path:f.channel})), observed.map((r) => ({method:r.method, path:canonicalizeLiteralTemplate(r.path)})));
      assert.ok(facts.every((f) => !f.dynamic && f.pathAnchor === 'root'));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, {recursive:true, force:true});
  }
});
