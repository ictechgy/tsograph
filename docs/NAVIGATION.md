# 선언된 등록 구조의 화면 URL

tsograph 0.10.0부터 지원하며 연결 소비자는 isthmus-cli 0.13.0 이상이다.

임의 라우터 구현을 추측하는 대신 source-owned 등록 함수와 객체 필드를 JSON으로 지정한다.

```json
{
  "format": "router-models", "version": 1,
  "models": [{
    "factory": {"path": "src/router-api.ts", "name": "registerScreens"},
    "routesArgument": 0, "pathProperty": "path", "screenProperty": "screen",
    "childrenProperty": "children", "pathSyntax": "colon"
  }]
}
```

```sh
tsograph navigation --project . --router-model router-model.json > screens.json
tsograph graph --project . > graph.json
tsograph reach --graph-file graph.json src/screens.tsx#Catalog > screen-reach.json
```

등록 함수를 정확한 선언 경로·이름과 checker 심볼로 대조한다. 같은 이름의 다른 함수는
매칭하지 않는다. import·증명된 불변 별칭을 따라가며 변경·탈출한 등록 배열과 미상
객체·spread는 동적 사실과 계수로 남긴다. 상대 자식 경로는 부모 뒤에 붙이고 절대 경로는
시작점을 새로 정한다. `colon`은 `:id`, `template`은 `{id}`를 `{}`로 정규화한다.

route 배열 binding에 직접 대입이나 표준 mutator 호출을 관찰하면 `mutated route container`로
센다. export·다른 호출로의 escape·여러 children 자리 재사용처럼 변경되지 않았음을 끝까지
증명할 수 없는 값은 `unproven route container`로 구분한다. 두 경우 모두 배열 내용을 추측하지
않고 dynamic 사실을 낸다. binding AST 분석이 1,000,000 node 상한을 넘으면 alias·mutation
완전성을 주장할 수 없으므로 부분 navigation 문서를 내지 않고 명령이 코드 2로 실패한다.
구문 중첩이 400단을 넘거나 파싱이 호출 스택을 넘긴 소스(생성·압축 코드 등)는 그 파일만 Program에서 빼고
`navigation-source-coverage:`로 센다(production 소스만). 그래도 분석이 호출 스택을 넘기면 부분 문서 없이 코드 2이며,
`schema`·`routes`·`graph`와 같은 원인 문구를 낸다.

screen은 프로젝트 function/class/불변 arrow 선언 또는 JSX 태그로 증명해야 한다.
USR은 graph와 같은 규칙이며 source 위치는 1 기반 UTF-8 열이다. 테스트와 구문 오류
소스는 제외한다. 라이브러리 전용 redirect·guard·lazy loader 등의 런타임 의미는 추론하지 않는다.
소스는 `tsograph schema`와 같은 걷기 규칙으로 모으고, 따라가지 않은 symlink·목록을 읽지 못한
디렉터리·크기 초과 파일·잘린 스캔·교환 형식이 금지하는 문자가 든 이름·컴파일러가 읽지 못한 소스는
`navigation-project-coverage:` 한 줄의 계수로 알린다. 설정을 해석하지 못해 기본 옵션을 쓴 경우(경로 별칭이 풀리지
않을 수 있음), 프로젝트 밖을 가리키거나 건너뛰는 디렉터리·symlink 경로를 이름으로 적어 compiler 루트 파일로 쓰지 않은 설정
`include`·`files` 항목(걷기와 같은 정책), 4 MiB를 넘어 읽지 않은 compiler 입력도 graph와 같은 원인 문구로
`navigation-project-coverage:`에 싣는다.

설정은 project 안의 1 MiB JSON이며 중복 key·닫힌 schema·깊이·모델 상한을 검사한다.
`--router-model`과 `--tsconfig`는 realpath가 `--project` 안인 일반 파일이어야 한다(상대 경로는 `--project` 기준, 절대 경로도
안이면 받는다). 직접이든 symlink로든 밖이면 openapi 스펙·routes client 모델과 같은 사용법 오류(코드 64)이고, 없거나 읽지
못하거나 크기 상한(모델 1 MiB, `--tsconfig` 1 MiB)을 넘으면 코드 2다. `--tsconfig`의 상대 옵션(`baseUrl`·`paths`·`include`·
`extends`)은 받은 경로의 디렉터리를 기준으로 해석한다(`tsc -p`·graph·routes client와 같다). symlink로 고른 설정도 링크를
풀지 않으므로 링크가 있는 디렉터리가 기준이고, limitation의 설정 이름도 링크 이름이다. 0.10.0은 링크 대상의 디렉터리를
기준으로 썼다. 대상 디렉터리 기준으로 적은 설정은 실제 경로를 `--tsconfig`로 준다.
등록 깊이는 64, 사실은 100,000개로 제한하며 상한 뒤를 조용히 버리지 않는다. 출력은
`navigation-facts` v1이고 HTTP method/service/authority를 갖지 않는다. 실제 HTTP 요청은
`routes --role client`로 따로 추출한다. isthmus의 `trace-navigation`이 같은 project의 정방향
분석과 HTTP 조인을 사용해 화면→API를 연결한다. 모호하거나 dynamic인 URL/화면은 정적
진입점으로 추측하지 않는다.
