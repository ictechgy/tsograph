# 명시적 HTTP client 모델

transport 구현을 일반적으로 추론할 수 없는 경우, `routes --role client --client-model`
JSON 파일로 프로젝트의 정확한 type/class 선언과 HTTP 메서드를 연결한다.

```json
{
  "format": "http-client-models",
  "version": 1,
  "models": [{
    "receiver": { "kind": "type", "path": "src/api/port.ts", "name": "CatalogPort" },
    "methods": [{ "name": "read", "method": "GET", "pathArgument": 0, "base": "/v2", "service": "catalog" }]
  }]
}
```

```sh
tsograph routes --role client --project . --client-model client-model.json > calls.json
tsograph routes --role client --project . --tsconfig apps/web/tsconfig.json --client-model client-model.json > calls.json
```

`kind: type`은 interface와 type alias를 포함하며, `kind: class`는 클래스 선언이다.
`path`는 프로젝트 상대 소스 경로, `name`은 정확한 선언 이름이다. 전역 이름이나
메서드 모양만으로 매칭하지 않는다. import alias와 선언된 타입 별칭을 따라가며
주입 매개변수와 named utility-type alias도 정확한 선언 identity를 확인해야 한다.
`any`·`unknown`·union·모호한 선언·수신자 변경은 확정된 HTTP 호출로 승격하지 않는다.

workspace를 `--project`로 쓰면 모든 소유 소스와 id가 그 기준이다. `--tsconfig` 파일도
그 루트에서 해석해 경로 별칭을 적용한다. graph에서 같은 workspace와 compiler 설정을
선택하면 client 호출의 USR과 그래프 id가 같은 기준을 사용한다.

`pathArgument`는 0 기반 호출 인자 위치다. `base`는 명시적인 URL 또는 경로 접두사다.
URL 결합은 base-URL 규칙을 사용하며 절대 HTTP 인자는 base를 대체한다.
`service`는 메서드별 선택 필드이며 CLI `--service`와 충돌하면 실패한다. 모델은
런타임 transport 구현이나 dispatch를 실행·검증하지 않으므로 작성자가 실제 호출
규칙과 일치하도록 유지해야 한다. 파일은 프로젝트 안의 JSON만 허용하며 1 MiB,
깊이·원소·모델·메서드 상한과 중복 key 검사를 적용한다.

경로의 불변 import 상수와 전체 세그먼트 보간은 기존 URL 규칙을 사용한다. 미상
선행 URL 값 뒤의 `/...` 꼬리를 복원하면 `dynamic: true`, `pathAnchor: base`로 남긴다.
이 경로는 완전히 해석된 송신 URL이 아니다. `{{NAME}}` 빌드 토큰도 dynamic으로
처리한다. 부분 세그먼트는 dynamic으로 남기고 userinfo·query·고엔트로피 값은 제거하거나 마스킹한다.
