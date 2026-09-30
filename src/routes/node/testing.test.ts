/**
 * Node 백엔드 라우트 테스트가 함께 쓰는 도우미다: 합성 임시 프로젝트를 만들어 `routes` 명령을 실행하고 문서를 줄인다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';

/** 테스트가 보는 문서 모양이다. */
export interface NodeDocumentView {
  readonly dispatch: string;
  readonly facts: readonly {
    readonly method: string;
    readonly channel: string;
    readonly dynamic: boolean;
    readonly pathAnchor: string;
    readonly trailingSlash?: string;
    readonly caseInsensitive?: boolean;
    readonly narrowed?: boolean;
    readonly catchAllPrefix?: boolean;
    readonly testSource?: boolean;
    readonly order?: { readonly group: string; readonly index: number };
    readonly dynamicScope?: Record<string, unknown>;
    readonly paramConstraints?: readonly { readonly segment: number; readonly kind: string; readonly pattern?: string }[];
    readonly location: { readonly path: string; readonly line: number; readonly column: number };
    readonly symbol: { readonly qualifiedName: string; readonly usr?: string };
  }[];
  readonly limitations: readonly string[];
  readonly limitationScopes?: readonly { readonly limitationIndex: number; readonly templates?: string[]; readonly templatePrefixes?: string[]; readonly templateSuffixes?: string[]; readonly methods?: string[] }[];
}

/**
 * 합성 파일로 임시 프로젝트를 만들어 routes 명령을 실행한다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @param extra 추가 인자
 * @returns 문서
 */
export async function scanNodeProject(files: Record<string, string>, extra: readonly string[] = []): Promise<NodeDocumentView> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-routes-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const result = await runRoutesCommand(['--role', 'server', '--project', root, ...extra], {
      fileSystem: createNodeFileSystem(),
      toolVersion: '0.0.0-test',
      now: () => new Date(0),
    });
    assert.equal(result.exitCode, 0, result.standardError);
    return JSON.parse(result.standardOutput) as NodeDocumentView;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 사실을 `METHOD anchor channel trailingSlash 표식…` 문자열로 줄인다(정렬).
 *
 * @param document 문서
 * @returns 줄 목록
 */
export function factLines(document: NodeDocumentView): string[] {
  return document.facts.map((fact) => [
    fact.method,
    fact.pathAnchor,
    fact.channel,
    fact.trailingSlash ?? '-',
    ...(fact.dynamic ? [`dynamic${fact.dynamicScope === undefined ? '' : JSON.stringify(fact.dynamicScope)}`] : []),
    ...(fact.order === undefined ? [] : [`#${fact.order.index}`]),
    ...(fact.caseInsensitive === true ? ['ci'] : []),
    ...(fact.narrowed === true ? ['narrowed'] : []),
    ...(fact.catchAllPrefix === true ? ['prefix'] : []),
  ].join(' ')).sort();
}

/**
 * 접두사로 시작하는 limitation과 그 스코프를 고른다.
 *
 * @param document 문서
 * @param prefix 접두사
 * @returns (문장, 스코프) 목록
 */
export function limitationsWith(document: NodeDocumentView, prefix: string): { text: string; scope: Record<string, unknown> | undefined }[] {
  return document.limitations.flatMap((text, index): { text: string; scope: Record<string, unknown> | undefined }[] => {
    if (!text.startsWith(prefix)) return [];
    const scope = document.limitationScopes?.find((entry) => entry.limitationIndex === index);
    if (scope === undefined) return [{ text, scope: undefined }];
    const { limitationIndex: _index, ...rest } = scope;
    return [{ text, scope: rest }];
  });
}

/**
 * package.json 텍스트를 만든다.
 *
 * @param dependencies 의존성
 * @returns JSON 텍스트
 */
export function packageJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'fixture', private: true, dependencies });
}
