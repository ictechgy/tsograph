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
`any`·`unknown`·union·모호한 선언은 모델에 추측해 연결하지 않는다.
설정 변경 분석이 고정 상한이나 지원하지 않는 출처 때문에 미완이면, 모델 호출은 사라지지 않고 모델의 동사·`service`와
`channel: null`·`dynamic: true`·`pathAnchor: "base"`로 남는다. escape·재대입·method 변경된 수신자도 같은 방식으로
알려진 호출 위치를 남기고 `client-receiver-uncertainty:`에 위치·개수를 싣는다. 모델의 동사는 선언 근거이며 교체된 메서드가
HTTP를 수행하거나 같은 경로로 전송한다는 보장이 아니다. 무관한 primitive 반환값의 저장은 클라이언트 전체를 오염시키지
않지만, 출처를 모르는 객체 변경은 전체 미완으로 남긴다.

workspace를 `--project`로 쓰면 모든 소유 소스와 id가 그 기준이다. `--tsconfig` 파일도
그 루트에서 해석해 경로 별칭을 적용한다. graph에서 같은 workspace와 compiler 설정을
선택하면 client 호출의 USR과 그래프 id가 같은 기준을 사용한다.

`pathArgument`는 0 기반 호출 인자 위치다. `base`는 URL 또는 경로 접두사이며 생략하면 `""`이다.
`null`·숫자·위험 URL은 기본값으로 바꾸지 않고 `/models/0/methods/0/base` 같은 JSON pointer를 가진 코드 2 오류다.
URL 결합은 base-URL 규칙을 사용하며 절대 HTTP 인자는 base를 대체한다.
`service`는 메서드별 선택 필드이며 CLI `--service`와 충돌하면 실패한다. 모델은
런타임 transport 구현이나 dispatch를 실행·검증하지 않으므로 작성자가 실제 호출
규칙과 일치하도록 유지해야 한다. 파일은 프로젝트 안의 JSON만 허용하며 1 MiB,
깊이·원소·모델·메서드 상한과 중복 key 검사를 적용한다. 모델 파일과 `--tsconfig`는 realpath가 `--project` 안인
일반 파일이어야 한다(절대 경로도 안이면 받는다). 직접이든 symlink로든 밖이면 사용법 오류(코드 64), 없거나 읽지
못하면 코드 2다.

경로의 불변 import 상수와 전체 세그먼트 보간은 기존 URL 규칙을 사용한다. 미상
선행 URL 값 뒤의 `/...` 꼬리를 복원하면 `dynamic: true`, `pathAnchor: base`로 남긴다.
이 경로는 완전히 해석된 송신 URL이 아니다. `{{NAME}}` 빌드 토큰도 dynamic으로
처리한다. 부분 세그먼트는 dynamic으로 남기고 userinfo·query·고엔트로피 값은 제거하거나 마스킹한다.

axios를 감싼 클래스의 arrow field나 DI 포트는 자동 wrapper 추론과 다른 모델이다. 소유 클래스 또는 주입 포트의 정확한
선언을 지정하고 실제 호출에 맞게 method·인자·base를 기록한다. 모델은 mutation 안전성을 선언하지 않는다.
PnP loader는 실행하지 않는다. `.pnp.data.json` 정적 읽기와 zip 타입 조회에는 크기·압축 해제 예산, 경로 검증,
TypeScript compiler host 통합이 필요하며 이번 릴리스 범위 밖이다. 이 비용은 아직 실측하지 않았고 PnP 전체 해석을 주장하지 않는다.
