# tsograph

[English](README.md)

TypeScript/JavaScript(Node) 서비스의 정적 사실을
[isthmus](https://github.com/ictechgy/isthmus) bridge-facts 교환 형식으로 낸다.

tsograph는 정적 분석 CLI 가족(Swift의 cartograph, Kotlin의 kartograph, Dart의 dartograph,
Go의 gartograph, Rust의 rustograph, SQL의 schemagraph)의 TypeScript/JavaScript 생산자다. 각 도구는
자기 언어에서 본 것만 보고하고, 조인은 isthmus가 한다.

## 상태

저장소 골격이다. 아직 구현된 명령이 없다.

## 요구 사항

- Node.js 22.18.0 이상

## 개발

```sh
npm ci
npm run verify   # 타입 검사, 커버리지 90% 게이트 테스트, clean build, CLI 계약
```

## 라이선스

MIT. 영구 무료, 텔레메트리 없음.
