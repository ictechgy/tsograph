/**
 * 공개 진입점 필드가 없는 `package.json`이 스캔 밖 소비자에게 열린 패키지인지 판정한다.
 *
 * 게시할 수 있는 패키지에 `exports`가 없으면 Node·TypeScript는 패키지 안 모든 파일을 경로로 가져다 쓰게 한다
 * (`import { run } from 'lib/src/main.js'`). `main`이 없으면 패키지 이름 자체도 기본 index 파일(`index.js` 등)로 해석된다
 * (express 4, `@nestjs/core`·`@nestjs/common` 10의 게시 모양). 그래서 진입점 필드가 하나도 없어도 게시할 수 있는 패키지는
 * 소비자가 내보낸 함수를 자기 콜백으로 부를 수 있고, 닫힌 프로그램으로 보면 그 값을 보지 못한 bound 간선을 낸다.
 */

/**
 * manifest가 `"private": true`로 게시를 막았는지 본다. 모든 주요 게시 도구가 거절하는 값인 boolean `true`만 본다.
 * npm 10(`libnpmpublish` 10 `lib/publish.js`의 `if (manifest.private)`, `npm publish`의 workspace 검사)은 truthy 값을 모두
 * 거절하지만, Yarn 4(`@yarnpkg/core` `Manifest.load`는 `typeof data.private === 'boolean'`일 때만 `private`를 읽고,
 * `yarn npm publish`는 그 값만 검사한다)는 `"true"` 같은 문자열을 private로 보지 않고 게시한다. 게시될 수 있는 패키지를
 * 닫힌 쪽으로 두면 거짓 bound 간선이 나므로, 도구마다 다른 값은 판단하지 않고 열린 쪽(게시 가능)에 둔다.
 *
 * @param manifest JSON 객체로 읽은 `package.json`
 * @returns `"private": true`이면 true
 */
export function isMarkedPrivate(manifest: object): boolean {
  return (manifest as { private?: unknown }).private === true;
}

/**
 * manifest가 이름으로 설치될 수 있는 패키지인지 본다. 문자열 `name`이 있고 {@link isMarkedPrivate}가 아니면 게시할 수 있다
 * (이름 없는 패키지는 의존성으로 이름 해석되지 않는다). 진입점 필드 확인은 호출자가 한다.
 *
 * @param manifest JSON 객체로 읽은 `package.json`
 * @returns 게시할 수 있으면 true
 */
export function isPublishableManifest(manifest: object): boolean {
  return typeof (manifest as { name?: unknown }).name === 'string' && !isMarkedPrivate(manifest);
}
