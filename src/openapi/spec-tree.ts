/**
 * 스펙 텍스트(JSON 또는 YAML)를 위치 정보가 있는 읽기 전용 트리로 만든다.
 *
 * JSON은 YAML 1.2의 부분집합이라 하나의 파서(`yaml` 패키지)로 두 형식을 읽고,
 * 모든 노드의 원문 오프셋을 얻는다. 보안 경계:
 * - 여러 문서·구문 오류·깊이 초과는 파서 오류로 거부한다.
 * - 중복 키는 파싱 때 선형 시간에 모두 기록하고, 사실을 만드는 조회가 그 키에 닿을 때만
 *   거부한다(전체 순회하는 매핑에 중복이 있거나, 키로 조회한 키가 중복됐을 때). 스키마·예시
 *   같은 route와 무관한 곳의 중복은 거부하지 않고 첫 번째 값을 쓰며, 호출자가 개수를
 *   limitation으로 알린다. `yaml`의 `uniqueKeys` 검사는 매핑 크기에 대해 제곱 시간(4만
 *   키에 5초 이상)이라 쓰지 않는다.
 * - JS 객체로 변환(toJS)하지 않는다. 그래서 alias 확장 폭탄과 `__proto__` 키가
 *   객체를 만들지 않고, 사용자 태그도 실행되지 않는다(`yaml`은 태그를 실행하지 않는다).
 * - alias는 한 번 만든 색인으로 O(1)에 따라가고, 따라간 횟수에 상한을 둔다.
 * - merge key(`<<`)는 펼치지 않고 문서째 거부한다. 다른 도구는 펼치므로, 일반 키로
 *   남기면 servers 같은 필드가 조용히 사라져 잘못된 root 접두사가 된다.
 * - alias·컬렉션 키는 거부한다. 중복 키 판정과 조회가 스칼라 키만 비교하기 때문이다.
 * - 파싱 전에 선형 사전 검사로 노드 수 추정치와 flow 중첩 깊이를 제한한다. `yaml`은
 *   노드마다 약 1 KB를 쓰고 깊이 검사도 CST를 다 만든 뒤라, 상한 안의 파일로도 메모리가
 *   바닥날 수 있다(원소 200만 개 flow 배열에 RSS 약 2 GB 실측).
 */

import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type ParsedNode,
  parseDocument,
  visit,
  type YAMLError,
} from 'yaml';

import { ByteColumnIndex } from './byte-columns.ts';

/** 한 번의 추출에서 alias를 따라갈 수 있는 최대 횟수다. 정상 스펙은 수백 회를 넘지 않는다. */
export const MAX_ALIAS_DEREFERENCES = 100_000;

/**
 * 파싱 전 노드 수 추정치(쉼표 + 콜론 + 줄바꿈 수) 상한이다.
 *
 * 추정치는 flow 배열·block 시퀀스에서 스칼라 수와 같고, 보기 좋게 정렬한 JSON에서는
 * 약 1.5배로 넉넉하게 센다. 상한에서 파서 메모리는 약 1.5 GB 이하다.
 */
export const MAX_ESTIMATED_NODES = 1_500_000;

/** flow 컬렉션(`[`·`{`) 중첩 깊이 상한이다. 문자열 안 괄호도 세므로 넉넉하게 둔다. */
export const MAX_FLOW_DEPTH = 1000;

/** 스펙을 트리로 만들 수 없는 이유다. CLI가 원인·해결 방향 문구로 바꾼다. */
export type SpecParseFailureReason =
  | 'syntax'
  | 'duplicate-key'
  | 'multiple-documents'
  | 'resource-exhaustion'
  | 'too-many-nodes'
  | 'merge-key'
  | 'complex-key'
  | 'alias-budget';

/**
 * 스펙 파싱 실패다. 메시지에 원문을 싣지 않고 이유와 줄 번호만 담는다.
 */
export class SpecParseError extends Error {
  /** 실패 분류다. */
  readonly reason: SpecParseFailureReason;
  /** 원인 위치의 1부터 시작하는 줄이다. 알 수 없으면 undefined다. */
  readonly line: number | undefined;

  /**
   * @param reason 실패 분류
   * @param line 원인 위치의 줄(알 수 없으면 생략)
   */
  constructor(reason: SpecParseFailureReason, line?: number) {
    super(`spec parse failure: ${reason}${line === undefined ? '' : ` at line ${line}`}`);
    this.name = 'SpecParseError';
    this.reason = reason;
    this.line = line;
  }
}

/** 문자열 키를 가진 매핑 항목이다. 문자열이 아닌 키는 `key`가 undefined다. */
export interface MapEntry {
  readonly key: string | undefined;
  readonly keyNode: ParsedNode;
  readonly value: ParsedNode | null;
}

/** 매핑 하나에서 발견한 중복 키 정보다. */
interface MapDuplicates {
  /** 두 번 이상 나온 키의 식별자(`타입:값`) → 그 키가 처음 다시 나온 줄이다. */
  readonly lines: ReadonlyMap<string, number>;
  /** 이 매핑에서 처음 다시 나온 중복 키의 줄이다. */
  readonly firstLine: number;
}

/** 문서 전체의 중복 키 색인이다. */
interface DuplicateIndex {
  /** 매핑 노드 → 중복 정보다. */
  readonly byMap: ReadonlyMap<object, MapDuplicates>;
  /** 중복 발생 수(두 번째 이후 출현 수)다. */
  readonly count: number;
  /** 문서에서 가장 앞선 중복 키의 줄이다. 중복이 없으면 0이다. */
  readonly firstLine: number;
}

/** 무시한 중복 키의 요약이다. */
export interface IgnoredDuplicateKeys {
  readonly count: number;
  readonly firstLine: number;
}

/** 소스 위치(1부터 시작하는 줄, UTF-8 바이트 열)다. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * 파싱한 스펙 트리와 조회 도우미다.
 *
 * 모든 조회는 alias를 투명하게 따라가며, 따라간 횟수가 상한을 넘으면
 * `SpecParseError('alias-budget')`을 던진다.
 */
export class SpecTree {
  /** 문서 최상위 노드다. */
  readonly root: ParsedNode | null;
  /** alias → 그 alias 앞의 마지막 같은 이름 anchor 노드다. */
  private readonly aliasTargets: ReadonlyMap<Alias, ParsedNode>;
  /** 줄 안 UTF-8 바이트 열 색인이다. */
  private readonly byteColumns: ByteColumnIndex;
  /** 줄 시작 오프셋 색인이다. */
  private readonly lineCounter: LineCounter;
  /** 문서 전체의 중복 키 색인이다. */
  private readonly duplicates: DuplicateIndex;
  /** 지금까지 alias를 따라간 횟수다. */
  private dereferenceCount = 0;
  /**
   * 매핑 노드별 문자열 키 색인이다. 큰 매핑(`components.pathItems` 등)을 가리키는 `$ref`가
   * 많을 때 조회마다 전체 항목을 훑는 제곱 시간을 피한다. 중복 키는 첫 번째 값을 쓴다.
   */
  private readonly keyIndexes = new WeakMap<object, ReadonlyMap<string, ParsedNode | null>>();

  /**
   * @param root 문서 최상위 노드
   * @param aliasTargets alias 대상 색인
   * @param text 파싱한 텍스트
   * @param lineCounter 줄 색인
   * @param duplicates 중복 키 색인
   */
  constructor(
    root: ParsedNode | null,
    aliasTargets: ReadonlyMap<Alias, ParsedNode>,
    text: string,
    lineCounter: LineCounter,
    duplicates: DuplicateIndex,
  ) {
    this.root = root;
    this.aliasTargets = aliasTargets;
    this.byteColumns = new ByteColumnIndex(text);
    this.lineCounter = lineCounter;
    this.duplicates = duplicates;
  }

  /**
   * 조회가 거부하지 않고 지나간 중복 키의 요약을 돌려준다.
   *
   * 사실에 쓰는 조회는 중복에 닿으면 이미 거부했으므로, 문서 생성까지 온 경우 남은
   * 중복은 모두 사실과 무관한 곳에 있다.
   *
   * @returns 중복 수와 첫 줄. 중복이 없으면 undefined
   */
  ignoredDuplicateKeys(): IgnoredDuplicateKeys | undefined {
    const { count, firstLine } = this.duplicates;
    return count === 0 ? undefined : { count, firstLine };
  }

  /**
   * alias면 대상 노드로 바꾼다.
   *
   * @param node 조회할 노드
   * @returns 실제 노드. 대상 없는 alias·null이면 undefined
   */
  resolve(node: ParsedNode | null | undefined): ParsedNode | undefined {
    if (node === null || node === undefined) return undefined;
    if (!isAlias(node)) return node;
    this.dereferenceCount += 1;
    if (this.dereferenceCount > MAX_ALIAS_DEREFERENCES) throw new SpecParseError('alias-budget');
    return this.aliasTargets.get(node);
  }

  /**
   * 매핑 노드의 항목을 원문 순서로 돌려준다.
   *
   * 전체 순회는 모든 키를 사실에 쓴다는 뜻이라, 매핑에 중복 키가 하나라도 있으면 거부한다.
   *
   * @param node 매핑이어야 하는 노드
   * @returns 항목 목록. 매핑이 아니면 undefined
   * @throws SpecParseError 매핑에 중복 키가 있으면 duplicate-key
   */
  entries(node: ParsedNode | null | undefined): readonly MapEntry[] | undefined {
    const resolved = this.resolve(node);
    if (!isMap(resolved)) return undefined;
    const duplicates = this.duplicates.byMap.get(resolved);
    if (duplicates !== undefined) throw new SpecParseError('duplicate-key', duplicates.firstLine);
    return this.rawEntries(resolved);
  }

  /**
   * 중복 검사 없이 매핑 항목을 만든다. 키 색인 생성에만 쓴다.
   *
   * @param map 매핑 노드
   * @returns 항목 목록
   */
  private rawEntries(map: ParsedNode): readonly MapEntry[] {
    if (!isMap(map)) return [];
    return map.items.map((pair) => {
      const keyNode = this.resolve(pair.key as ParsedNode) ?? (pair.key as ParsedNode);
      return { key: scalarString(keyNode), keyNode: pair.key as ParsedNode, value: pair.value };
    });
  }

  /**
   * 매핑에서 문자열 키로 첫 값을 찾는다.
   *
   * @param node 매핑이어야 하는 노드
   * @param key 찾을 키
   * @returns 값 노드. 없거나 매핑이 아니면 undefined
   * @throws SpecParseError 조회한 키가 이 매핑에서 중복됐으면 duplicate-key
   */
  get(node: ParsedNode | null | undefined, key: string): ParsedNode | undefined {
    const resolved = this.resolve(node);
    if (!isMap(resolved)) return undefined;
    const duplicateLine = this.duplicates.byMap.get(resolved)?.lines.get(`string:${key}`);
    if (duplicateLine !== undefined) throw new SpecParseError('duplicate-key', duplicateLine);
    let index = this.keyIndexes.get(resolved);
    if (index === undefined) {
      index = this.buildKeyIndex(resolved);
      this.keyIndexes.set(resolved, index);
    }
    const value = index.get(key);
    return value === undefined ? undefined : this.resolve(value);
  }

  /**
   * 매핑의 문자열 키 → 값 색인을 만든다. 문자열이 아닌 키는 조회 대상이 아니라 뺀다.
   *
   * @param map 매핑 노드
   * @returns 키 색인
   */
  private buildKeyIndex(map: ParsedNode): ReadonlyMap<string, ParsedNode | null> {
    const index = new Map<string, ParsedNode | null>();
    for (const entry of this.rawEntries(map)) {
      if (entry.key !== undefined && !index.has(entry.key)) index.set(entry.key, entry.value);
    }
    return index;
  }

  /**
   * 매핑 전체가 사실에 영향을 주는 구역이면, 어느 키든 중복이 있을 때 거부한다.
   *
   * 루트·서버 객체·서버 변수처럼 읽지 않는 키(예: `host`)까지 엄격하게 볼 구역에 쓴다.
   *
   * @param node 확인할 노드(매핑이 아니면 아무것도 하지 않는다)
   * @throws SpecParseError 매핑에 중복 키가 있으면 duplicate-key
   */
  requireUniqueKeys(node: ParsedNode | null | undefined): void {
    this.entries(node);
  }

  /**
   * 노드가 매핑인지 항목을 만들지 않고 확인한다. 큰 매핑에서 `entries`를 부르지 않기 위해서다.
   *
   * @param node 조회할 노드
   * @returns 매핑이면 true
   */
  isMapping(node: ParsedNode | null | undefined): boolean {
    return isMap(this.resolve(node));
  }

  /**
   * 시퀀스 노드의 원소를 돌려준다.
   *
   * @param node 시퀀스여야 하는 노드
   * @returns 원소 목록. 시퀀스가 아니면 undefined
   */
  items(node: ParsedNode | null | undefined): readonly (ParsedNode | undefined)[] | undefined {
    const resolved = this.resolve(node);
    if (!isSeq(resolved)) return undefined;
    return resolved.items.map((item) => this.resolve(item as ParsedNode | null));
  }

  /**
   * 스칼라 문자열 값을 돌려준다.
   *
   * @param node 조회할 노드
   * @returns 문자열 스칼라면 그 값, 아니면 undefined
   */
  string(node: ParsedNode | null | undefined): string | undefined {
    return scalarString(this.resolve(node));
  }

  /**
   * 노드 시작 위치를 1부터 시작하는 줄과 UTF-8 바이트 열로 바꾼다.
   *
   * 열은 계약대로 "그 줄의 UTF-8 바이트 오프셋 + 1"이다. 런타임의 UTF-16 열을
   * 그대로 내면 비ASCII 줄에서 다른 생산자와 어긋난다.
   *
   * @param node 위치를 구할 노드(원문 노드 — alias면 alias 자리)
   * @returns 소스 위치
   */
  position(node: ParsedNode): SourcePosition {
    const offset = node.range?.[0] ?? 0;
    const { line } = this.lineCounter.linePos(offset);
    const lineStart = this.lineCounter.lineStarts[line - 1] ?? 0;
    return { line: Math.max(line, 1), column: this.byteColumns.column(lineStart, offset) };
  }
}

/**
 * 스칼라의 문자열 값을 꺼낸다.
 *
 * @param node 노드
 * @returns 문자열 스칼라 값 또는 undefined
 */
function scalarString(node: ParsedNode | null | undefined): string | undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
}

/**
 * 텍스트를 스펙 트리로 파싱한다.
 *
 * 앞의 BOM(U+FEFF)은 텍스트 편집기 관점의 열과 맞추기 위해 떼고 파싱한다.
 *
 * @param source UTF-8로 디코드한 파일 텍스트
 * @returns 스펙 트리
 * @throws SpecParseError 구문 오류·중복 키·여러 문서·깊이 초과
 */
export function parseSpecTree(source: string): SpecTree {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  precheckSpecText(text);
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: false,
    merge: false,
    version: '1.2',
  });
  const firstError = document.errors[0];
  if (firstError !== undefined) throw toParseError(firstError, lineCounter);
  const index = indexDocument(document, lineCounter);
  return new SpecTree(document.contents, index.aliasTargets, text, lineCounter, index.duplicates);
}

/**
 * 파싱 전에 노드 수 추정치와 flow 중첩 깊이를 한 번의 선형 스캔으로 확인한다.
 *
 * 문자열 안의 문자도 세므로 실제보다 크게 센다(안전한 방향).
 *
 * @param text 파싱할 텍스트
 * @throws SpecParseError 추정치가 상한을 넘으면 too-many-nodes, 깊이가 넘으면 resource-exhaustion
 */
export function precheckSpecText(text: string): void {
  let estimatedNodes = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x2c || code === 0x3a || code === 0x0a) estimatedNodes += 1;
    else if (code === 0x5b || code === 0x7b) depth += 1;
    else if ((code === 0x5d || code === 0x7d) && depth > 0) depth -= 1;
    if (depth > MAX_FLOW_DEPTH) throw new SpecParseError('resource-exhaustion');
  }
  if (estimatedNodes > MAX_ESTIMATED_NODES) throw new SpecParseError('too-many-nodes');
}

/**
 * 파서 오류를 원문 없는 실패로 바꾼다.
 *
 * @param error `yaml`의 오류
 * @param lineCounter 줄 색인
 * @returns 분류된 실패
 */
function toParseError(error: YAMLError, lineCounter: LineCounter): SpecParseError {
  const { line } = lineCounter.linePos(error.pos[0]);
  const lineNumber = line > 0 ? line : undefined;
  switch (error.code) {
    case 'MULTIPLE_DOCS': return new SpecParseError('multiple-documents', lineNumber);
    case 'RESOURCE_EXHAUSTION': return new SpecParseError('resource-exhaustion', lineNumber);
    default: return new SpecParseError('syntax', lineNumber);
  }
}

/**
 * 문서를 한 번 순회하며 alias 대상을 색인하고 중복 키를 찾는다.
 *
 * alias는 YAML 의미대로 앞에 나온 마지막 같은 이름 anchor를 가리킨다. `yaml`의
 * `Alias.resolve`는 호출마다 문서 전체를 순회해 alias가 많은 입력에서 제곱 시간이
 * 되므로 쓰지 않는다. 중복 키 판정은 `yaml`의 기본 비교(스칼라 값의 `===`)와 같다.
 *
 * @param document 파싱한 문서
 * @param lineCounter 줄 색인(중복 키 위치 보고용)
 * @returns alias → 대상 노드
 * @throws SpecParseError 중복 키, 또는 순회 중 스택이 넘치면 resource-exhaustion
 */
function indexDocument(
  document: Document.Parsed,
  lineCounter: LineCounter,
): { aliasTargets: ReadonlyMap<Alias, ParsedNode>; duplicates: DuplicateIndex } {
  const latestAnchors = new Map<string, ParsedNode>();
  const targets = new Map<Alias, ParsedNode>();
  const byMap = new Map<object, MapDuplicates>();
  let count = 0;
  let firstLine = 0;
  try {
    // `yaml`의 visit은 가장 구체적인 방문자 하나만 부르므로 Map 방문자를 따로 두면
    // anchor가 달린 매핑이 Node 방문자를 건너뛴다. 한 방문자에서 모두 처리한다.
    visit(document, {
      Node(_key, node) {
        const duplicates = isMap(node) ? checkMapKeys(node.items.map((pair) => pair.key), lineCounter) : undefined;
        if (duplicates !== undefined) {
          byMap.set(node, duplicates.map);
          count += duplicates.count;
          firstLine = firstLine === 0 ? duplicates.map.firstLine : Math.min(firstLine, duplicates.map.firstLine);
        }
        if (isAlias(node)) {
          const target = latestAnchors.get(node.source);
          if (target !== undefined) targets.set(node, target);
        } else if (typeof node.anchor === 'string') {
          latestAnchors.set(node.anchor, node as ParsedNode);
        }
      },
    });
  } catch (error) {
    if (error instanceof SpecParseError) throw error;
    // 방어: 파서가 받아들인 깊이는 순회도 감당하지만, 스택 한계가 다른 환경을 대비한다.
    /* node:coverage ignore next 2 */
    if (error instanceof RangeError) throw new SpecParseError('resource-exhaustion');
    throw error;
  }
  return { aliasTargets: targets, duplicates: { byMap, count, firstLine } };
}

/**
 * 매핑 키 목록을 확인한다: 스칼라 키만, merge key 없음. 중복 키는 거부하지 않고 기록한다.
 *
 * 중복 판정은 `yaml`의 기본 비교(스칼라 값의 `===`)와 같다. `%YAML 1.1` 지시문이
 * 있으면 `yaml`이 merge key를 심볼 값으로 읽으므로 그 표기도 merge key로 본다.
 *
 * @param keys 매핑 키 노드 목록
 * @param lineCounter 줄 색인(위치 보고용)
 * @returns 중복 정보와 중복 발생 수. 중복이 없으면 undefined
 * @throws SpecParseError complex-key·merge-key
 */
function checkMapKeys(
  keys: readonly unknown[],
  lineCounter: LineCounter,
): { map: MapDuplicates; count: number } | undefined {
  const seen = new Set<string>();
  const lines = new Map<string, number>();
  let count = 0;
  let firstLine = 0;
  for (const key of keys) {
    if (!isScalar(key)) throw keyError('complex-key', key, lineCounter);
    const isMergeKey = typeof key.value === 'symbol' || (key.value === '<<' && key.type === 'PLAIN');
    if (isMergeKey) throw keyError('merge-key', key, lineCounter);
    const identity = `${typeof key.value}:${String(key.value)}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      continue;
    }
    const line = lineOf(key, lineCounter);
    count += 1;
    if (!lines.has(identity)) lines.set(identity, line);
    firstLine = firstLine === 0 ? line : Math.min(firstLine, line);
  }
  return count === 0 ? undefined : { map: { lines, firstLine }, count };
}

/**
 * 노드 시작 위치의 1부터 시작하는 줄을 구한다.
 *
 * @param node 노드
 * @param lineCounter 줄 색인
 * @returns 줄 번호(구할 수 없으면 1)
 */
function lineOf(node: unknown, lineCounter: LineCounter): number {
  const offset = (node as { range?: [number, number, number] } | null)?.range?.[0];
  return Math.max(offset === undefined ? 1 : lineCounter.linePos(offset).line, 1);
}

/**
 * 키 위치를 줄 번호로 바꾼 실패를 만든다.
 *
 * @param reason 실패 분류
 * @param key 문제의 키 노드
 * @param lineCounter 줄 색인
 * @returns 실패
 */
function keyError(reason: SpecParseFailureReason, key: unknown, lineCounter: LineCounter): SpecParseError {
  return new SpecParseError(reason, lineOf(key, lineCounter));
}
