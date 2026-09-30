# isthmus 공유 적합성 벡터

isthmus(`2954375ceffb335780a08e2e245baad833d5d636`)의 `conformance/`를 그대로 가져온 사본이다. 정본은 isthmus가 소유하며, 이 디렉터리 파일을 직접 고치지 않는다. 갱신할 때는 isthmus main의 파일과 `SHA256SUMS`를 함께 다시 복사하고(새 suite 파일 포함) `npm run verify`로 확인한다. `src/exchange/http-limitation-scope.test.ts`가 모든 벡터 파일을 `SHA256SUMS`와 대조한다.

`http-dispatch.json`의 `dispatch.validate` 사례(생산자도 적용)는 `src/exchange/dispatch-order.test.ts`가 실행한다 — Node 백엔드
문서가 `registration-order`와 `order`를 낸다. `dispatch.match`·`dispatch.shadow`는 소비자 전용이라 실행하지 않는다.
`http-limitation-scope.json`의 `scope.dynamic-validate`는 `src/exchange/dynamic-scope.test.ts`가 실행하고 `scope.dynamic-applies`는
routes가 기대는 사례만 고정한다. `url-compose.json`은 해시만 대조한다(tsograph는 아직 클라이언트 `route-call`을 내지 않는다).
