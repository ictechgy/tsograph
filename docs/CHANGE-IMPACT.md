# 실제 변경 분석

`tsograph change-impact --project . --base main`은 Git 커밋과 현재 작업 트리(추적 파일·무시하지 않은 미추적 파일)를
비교한다. `--head HEAD`를 함께 주면 두 커밋만 비교한다. 프로젝트 루트는 Git 저장소 루트여야 한다.
Git 2.45 이상과 이미 로컬에 있는 객체가 필요하다. fetch·checkout·패키지 설치·대상 코드 실행은 하지 않는다.

```sh
tsograph change-impact --project . --base HEAD~1 --head HEAD > change.json
tsograph change-impact --project . --base HEAD --max-depth 8 --max-reached 500 > working-change.json
```

출력 `tsograph-change-impact` v1은 `before`와 `after`에 각각 입력 출처, 실제 파일 바이트의 SHA-256,
변경 파일의 seed 이유, 미매핑 파일, 기존 `language-traversal` 문서와 검토 후보를 담는다. 삭제·이름 변경의
이전 호출자는 before에 남는다. 경로의 `via`는 해당 시점 안에서만 잇는다. 두 그래프의 간선을 합치지 않는다.
정확히 같은 바이트의 삭제/추가 파일은 rename 후보로 연결한다. 줄바꿈 필터로 바이트가 바뀐 파일도 변경으로 본다.

현재 정밀도는 파일 단위다. 변경 파일의 모든 선언을 seed로 선택하며 tsconfig/package 설정 변경은 전체 그래프를
선택할 수 있다. 따라서 같은 파일의 무관한 선언·테스트가 과하게 포함될 수 있다. seed·도달 경로·기존 진입점 표식은
검토 근거이며 실제 실패 예측이나 테스트 생략 허가가 아니다. `status`는 항상 `incomplete`다. 빈 결과도 안전 판정이 아니다.

깊이·출력 행 제한과 기존 미해석 호출/한계는 각 순회 문서에 유지한다. 캡처는 20,000파일, 파일당 4 MiB, 총 128 MiB
상한이며 초과 시 부분 문서를 내지 않고 종료 코드 2다. 보고서 상한은 16 Mi 문자다. `cost`는 캡처 준비와 전체 분석 시간을
포함한다. 이 비용과 fixture의 누락/과잉 후보를 실제 앱 전체의 정확도로 일반화하지 않는다.

무시된 파일·symlink·submodule은 캡처하지 않는다. 이전 시점의 외부 의존성을 설치하지 않으므로 compiler의 외부 타입
입력은 이전 빌드를 재현한 증거가 아니다. 각 snapshot의 `limitations`를 읽어야 한다. 선언 없는 설정/API/DB 계약 변경은
`unmappedFiles`에 남을 수 있고 그 런타임 영향은 알 수 없다. 작업 트리는 두 번 읽어 내용이 같을 때만 분석하지만
파일 시스템의 원자적 snapshot은 아니다. 분석 뒤 새 편집은 새로 분석해야 한다.

기존 `impact <id> --project ...`와 `--graph-file`은 한쪽 그래프 탐색 형식 그대로다. 새 보고서를 기존 Isthmus
`language-traversal` 입력으로 직접 보내지 않는다. 필요한 시점의 `before.traversal` 또는 `after.traversal`을
해당 시점의 bridge facts와 함께 사용해야 한다. 이 도구는 자체 MCP 서버를 제공하지 않으며 CLI JSON을 소비하는
adapter는 전체 보고서의 출처·한계를 보존해야 한다.

## 선택적 HTTP 데이터 계약

`tsograph openapi api.yaml --service api --data-contracts`는 각 route-contract에 `dataContract` v1을 추가한다.
기본 출력은 그대로여서 기존 strict 소비자와 호환된다. 새 옵션은 호환되는 Isthmus의 `diff --http --contracts`와 쓴다.
inline body의 최상위 primitive 속성과 operation 수준 query/header의 명시적 type/nullable/required만 관찰한다.
body 경로는 `/[상태코드/]media-type/property` 형식의 JSON Pointer escaping을 쓴다. 필드는 최대 512개,
경로는 UTF-16 1,024자로 제한한다. `$ref`, 중첩 object, array, 조합/union 타입, path-level parameter, 직렬화 및
validation 조건은 limitation에 남긴다. 미지원 부분을 호환이라고 판정하지 않는다.
