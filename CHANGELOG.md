# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [Unreleased]

### Added

- `tsograph openapi <spec> --service <name> [--project <root>] [--format json]`:
  Swagger 2.0·OpenAPI 3.0.x/3.1.x(JSON·YAML)를 isthmus bridge-facts v1 http 문서
  (`platform: "openapi"`, `target: "http"`, `roles: ["server"]`, `route-contract` 사실)로 바꾼다.
  isthmus http 절은 아직 초안이며, 이 출력은 개발 중인 isthmus 소비자로 왕복 검증했다.
- 서버 경로 접두사 합성(3.x servers·path/operation 수준 재정의, 2.0 basePath), 정규 경로 템플릿
  (세그먼트 전체 `{}`, 부분 세그먼트 골격, RFC 3986 percent-encoding), UTF-8 바이트 열 위치.
- fail-closed 규칙: 열린 서버 변수·상대 서버 URL·잘못된 basePath는 `pathAnchor: "base"`와
  `unresolved-contract-servers:`, 다중 파라미터 세그먼트·읽지 못한 path item·모르는 필드는
  `contract-coverage:`로 알린다.
- 입력 안전: 16 MiB 상한, 엄격한 UTF-8, 단일 YAML 문서, 파싱 전 노드 수·flow 깊이 사전 검사,
  선형 시간 중복 키 검사, merge key·alias 키 거부, alias 역참조 상한, 로컬 `$ref`만, 사실
  100,000개(생성 전 계수)·출력 16 Mi 문자 상한, operationId 1,024자 상한.
- isthmus `conformance/http-template.json` 공유 벡터 훅(벡터가 없으면 건너뜀).
- 저장소 골격: TypeScript ESM CLI, `node --test` 타입 제거 실행, 커버리지 90% 게이트,
  clean build와 CLI 계약 검증, CI(ubuntu·macos).
