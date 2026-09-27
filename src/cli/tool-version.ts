/**
 * 설치된 패키지의 버전을 읽는다.
 *
 * `src/cli/`(타입 제거 실행)와 `dist/cli/`(빌드 산출물)는 모두 저장소 루트에서
 * 두 단계 아래라 같은 상대 경로로 package.json에 닿는다. 버전을 소스에
 * 복제하면 발행 때 어긋나므로 package.json 하나만 정본으로 둔다.
 */

import { readFileSync } from 'node:fs';

/**
 * package.json의 `version`을 돌려준다.
 *
 * @param packageUrl package.json 위치(테스트 주입용). 기본은 저장소 루트.
 * @returns 버전 문자열
 * @throws package.json이 없거나 version이 문자열이 아니면 설치가 깨진 것이므로 던진다
 */
export function readToolVersion(
  packageUrl: URL = new URL('../../package.json', import.meta.url),
): string {
  const parsed: unknown = JSON.parse(readFileSync(packageUrl, 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null
    ? (parsed as { version?: unknown }).version
    : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('tsograph package.json has no version; reinstall the package.');
  }
  return version;
}
