# 선택적 .gitignore 진입 범위

`--respect-gitignore`는 `graph`, live-project `reach`/`impact`, `routes`, `schema`,
`navigation`, `change-impact`의 **진입 선택**에 프로젝트 내부 `.gitignore` 규칙을 적용한다.
기본값은 off이며 기존 탐색·compiler 설정 선택·출력은 그대로다.

```sh
tsograph graph --project . --respect-gitignore
tsograph routes --project . --role client --respect-gitignore
tsograph change-impact --project . --base HEAD~1 --respect-gitignore
```

루트와 방문하는 하위 디렉터리의 `.gitignore`를 각각 그 디렉터리에 상대적으로 해석한다.
가까운 규칙이 먼저 규칙을 덮어쓰며 `!` 재포함·`**`·anchor·escaped `#`/`!`/공백을 지원한다.
제외된 부모 디렉터리는 내려가지 않으므로 그 안의 negation만으로 부모를 다시 포함할 수 없다.
기존 점 디렉터리·생성물·의존성 디렉터리 제외 및 symlink 비추적 정책도 유지한다.

Git 저장소와 실행 파일이 없어도 동작한다. Git 설정·hooks·filters·소스 코드를 실행하지 않으며,
루트 위의 `.gitignore`, 전역 excludes, `.git/info/exclude`, Git index의 tracked-file 우선권은
읽거나 적용하지 않는다. 따라서 이미 추적된 파일도 프로젝트 내부 규칙과 일치하면 진입에서 빠진다.
모노레포 전체 규칙을 적용하려면 그 루트를 `--project` 또는 지원하는 명령의 `--workspace`로 고른다.
하위 앱만 루트로 고르면 그 앱 아래 규칙만 적용한다. 파일 이름 비교는 대소문자를 구분한다.

`tsconfig`의 명시 `files`/`include`로 고른 소스도 이 선택을 따른다. 명시 `--tsconfig`,
`--client-model`, `--router-model` 같은 **입력 설정 파일 자체**를 무시하지는 않는다.
import 의존성 읽기는 진입 선택과 별개여서 제외된 파일·타입이 bounded compiler host를 통해
필요한 의존성으로 읽힐 수 있다. 제외는 런타임 미사용·완전성·테스트 생략의 증거가 아니다.
문서는 `gitignore-selection:` limitation으로 이 계약을 보존한다. 이 옵션의 선택 범위는 완전한 닫힌 프로그램 증거가 아니므로 exported callable/interface 흐름을 unseen caller에 대해 확정하지 않는다. direct 관찰 간선은 유지한다.

`change-impact`는 before/after를 합치지 않고 각 동결 캡처의 `.gitignore`로 진입을 고른다.
변경 파일 목록과 내용 해시는 그대로이므로 진입에서 제외한 변경도 보고서에서 사라지지 않는다.
`--graph-file` 순회에는 적용할 수 없으며 해당 조합은 사용 오류 64다.

일반 분석은 안정된 입력을 전제로 하며 파일시스템 전체의 원자적 snapshot을 만들지는 않는다.
규칙 파일은 symlink를 따르지 않는 일반 UTF-8 파일이어야 한다. FIFO·장치·읽기 실패·잘못된
UTF-8/NUL·예산 초과는 부분 선택으로 계속하지 않고 출력 없이 입력 오류 2로 끝난다.
파일당 64 KiB, 총 1 MiB, 실제 규칙 파일 2,048개, 규칙 8,192줄, 줄 4,096자,
경로 4,096자/64성분과 누적 비교 작업 100,000,000 단위의 상한을 둔다. 지원 밖 입력은
규칙을 단순화하거나 더 좁은 프로젝트로 나눠 분석한다.

문법 파서는 고정된 MIT `ignore` 7.0.14다. 합성 fixture를 실제 Git `check-ignore --no-index`와
차등 대조했으며, 일반 Git 전체 동작(추적 신원·전역 설정 포함)을 구현했다고 주장하지 않는다.
