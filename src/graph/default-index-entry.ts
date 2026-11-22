/**
 * 공개 진입점 필드가 없는 게시 가능한 패키지의 기본 index 진입점을 판정한다.
 *
 * Node는 `main`이 없는 패키지를 패키지 디렉터리의 `index.js`로 불러오고, TypeScript는 `types`·`main`이 없는 패키지를
 * `index.ts`·`index.tsx`·`index.js`·`index.jsx`로 해석한다. 그래서 `{"name":"lib"}`와 그 옆의 `index.js`는
 * `{"name":"lib","main":"index.js"}`와 똑같이 스캔 밖 소비자가 가져다 쓸 수 있다(express 4, `@nestjs/core`·`@nestjs/common` 10이
 * 이렇게 게시된다). 이 모양을 닫힌 프로그램으로 보면 소비자가 넘기는 값을 보지 못한 채 bound 간선을 낸다.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** 진입점 필드가 없는 패키지 디렉터리에서 Node(`index.js`)나 TypeScript가 패키지 진입점으로 고르는 기본 파일 이름이다. */
export const DEFAULT_INDEX_ENTRY_NAMES: readonly string[] = ['index.js', 'index.jsx', 'index.ts', 'index.tsx'];

/**
 * manifest가 이름으로 설치될 수 있는 패키지인지 본다. 문자열 `name`이 있고 `"private": true`가 아니면 게시할 수 있다
 * (npm은 `private: true`인 패키지를 게시하지 않고, 이름 없는 패키지는 의존성으로 이름 해석되지 않는다). 공개 진입점 필드
 * 규칙처럼 boolean `true`만 private로 보고, 다른 값은 판단하지 않고 열린 쪽(게시 가능)에 둔다.
 *
 * @param manifest JSON 객체로 읽은 `package.json`
 * @returns 게시할 수 있으면 true
 */
export function isPublishableManifest(manifest: object): boolean {
  const { name, private: isPrivate } = manifest as { name?: unknown; private?: unknown };
  return typeof name === 'string' && isPrivate !== true;
}

/**
 * 공개 진입점 필드가 없는 manifest의 디렉터리에 기본 index 파일이 있어, 게시된 패키지의 진입점이 되는지 본다.
 * 진입점 필드 확인은 호출자가 먼저 한다. 디렉터리가 아닌 항목(일반 파일, Node가 따라가는 symlink 포함)은 있는 것으로 보고,
 * 상태를 읽지 못하면 판단할 수 없으므로 열린 쪽(있음)으로 본다.
 *
 * @param directory 패키지 디렉터리 절대 경로
 * @param manifest JSON 객체로 읽은 그 디렉터리의 `package.json`
 * @returns 게시할 수 있고 기본 index 파일이 있으면 true
 */
export function hasDefaultIndexEntry(directory: string, manifest: object): boolean {
  if (!isPublishableManifest(manifest)) return false;
  return DEFAULT_INDEX_ENTRY_NAMES.some((name) => indexEntryPresent(join(directory, name)));
}

/**
 * 기본 index 후보 경로에 디렉터리가 아닌 항목이 있는지 본다. 링크는 따라가지 않는다.
 *
 * @param path 후보 절대 경로
 * @returns 있거나 판단할 수 없으면 true
 */
function indexEntryPresent(path: string): boolean {
  try {
    const status = lstatSync(path, { throwIfNoEntry: false });
    return status !== undefined && !status.isDirectory();
  } catch {
    // 권한 오류처럼 상태를 읽지 못하면 진입점이 없다고 단정하지 않는다.
    return true;
  }
}
