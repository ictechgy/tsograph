import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { extractPersistenceFacts, type ExtractionResult } from './extract.ts';

/**
 * 합성 파일들로 임시 프로젝트를 만들고 콜백을 실행한 뒤 지운다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @param run 프로젝트 realpath를 받는 콜백
 * @returns 콜백 결과
 */
export function withProject<T>(files: Record<string, string>, run: (root: string) => T): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-schema-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 임시 프로젝트를 추출한다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @returns 추출 결과
 */
export function extractProject(files: Record<string, string>): ExtractionResult {
  return withProject(files, (root) => extractPersistenceFacts(root));
}

/**
 * 사실을 비교하기 쉬운 한 줄 문자열로 바꾼다: `path:line:column channel[.method][ dyn] @symbol`.
 *
 * @param result 추출 결과
 * @returns 문자열 목록
 */
export function factLines(result: ExtractionResult): string[] {
  return result.facts.map((fact) => {
    const where = `${fact.location.path}:${fact.location.line}:${fact.location.column}`;
    const what = fact.method === undefined ? fact.channel : `${fact.channel}.${fact.method}`;
    const symbol = fact.symbol === undefined ? '' : ` @${fact.symbol.qualifiedName}`;
    return `${where} ${what}${fact.dynamic ? ' dyn' : ''}${symbol}`;
  });
}

/** Prisma 7.8을 쓰는 최소 프로젝트 파일이다. */
export const prismaBase: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { '@prisma/client': '7.8.0' }, devDependencies: { prisma: '7.8.0' } }),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/prisma': { version: '7.8.0' }, 'node_modules/@prisma/client': { version: '7.8.0' } },
  }),
  'prisma/schema.prisma': [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    'datasource db {',
    '  provider = "postgresql"',
    '}',
    'model User {',
    '  id    Int    @id',
    '  email String @map("email_address")',
    '  posts Post[]',
    '  @@map("users")',
    '}',
    'model Post {',
    '  id       Int  @id',
    '  title    String',
    '  authorId Int',
    '  author   User @relation(fields: [authorId], references: [id])',
    '}',
    '',
  ].join('\n'),
};

test('임시 프로젝트 도우미는 파일을 만들고 지운다', () => {
  let seen = '';
  withProject({ 'a/b.txt': 'x' }, (root) => {
    seen = root;
  });
  assert.notEqual(seen, '');
  assert.deepEqual(factLines(extractProject({})), []);
});
