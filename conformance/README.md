# isthmus 공유 적합성 벡터

isthmus(`76b6141e71c84e0ab1026ad1f18f910b9d966dc8`)의 `conformance/`를 그대로 가져온 사본이다. 정본은 isthmus가 소유하며, 이 디렉터리 파일을 직접 고치지 않는다. 갱신할 때는 isthmus main의 파일과 `SHA256SUMS`를 함께 다시 복사하고(새 suite 파일 포함) `npm run verify`로 확인한다. `src/exchange/http-limitation-scope.test.ts`가 모든 벡터 파일을 `SHA256SUMS`와 대조한다.

`http-dispatch.json`은 해시만 대조하고 사례를 실행하지 않는다. tsograph의 서버 문서는 항상 `dispatch: "specificity"`이고
`order`를 내지 않으므로 `dispatch.validate`(생산자도 적용)의 대상 필드가 없고, `dispatch.match`·`dispatch.shadow`는 소비자
전용이다. `url-compose.json`도 해시만 대조한다(tsograph는 아직 클라이언트 `route-call`을 내지 않는다).
