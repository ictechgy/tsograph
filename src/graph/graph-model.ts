/**
 * 호출 그래프의 타입과, 노드·간선을 모으는 가변 저장소다.
 *
 * 노드 id는 `symbol-ids.ts` 규칙을 따른다. 같은 id가 되는 선언(오버로드, getter/setter 쌍 등)은 한
 * 노드로 합친다 — 먼저 등록한 선언의 종류·위치를 남긴다. 간선은 (from, to) 쌍마다 종류 집합을 둔다.
 */

import ts from 'typescript';

import type { BridgeLocation } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { SourceText } from '../schema/source-text.ts';

/** 노드 종류다. `export`는 선언이 아닌 내보내기(별칭·재내보내기·구조 분해)의 노드다. */
export type NodeKind =
  | 'module' | 'function' | 'method' | 'constructor' | 'accessor' | 'class' | 'variable' | 'field' | 'export';

/**
 * 간선 종류다.
 *
 * - `call`: 직접 호출. `new`: 생성자 호출(생성자가 없으면 클래스 노드).
 * - `callback`: 함수 값을 인자로 넘김. `reference`: 그 밖의 함수 값 참조(`export default h`, `{ onClick: h }`).
 * - `jsx`: JSX 컴포넌트 참조. `alias`: export 노드 → 해석한 대상.
 * - `initializer`: 생성자·클래스 → 인스턴스 필드 초기값, 파생 클래스 → 기반 생성자(암묵 `super()`),
 *   모듈 스코프 → 모듈 최상위 변수·static 필드 초기값.
 */
export type EdgeKind = 'call' | 'new' | 'callback' | 'reference' | 'jsx' | 'alias' | 'initializer';

/** 진입점 종류다. `route-handler`만 HTTP route-decl과 이어진다. */
export type EntryKind =
  | 'route-handler' | 'scheduled' | 'server-action' | 'page' | 'metadata-route' | 'middleware' | 'instrumentation';

/** 출력 노드다. */
export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly location: BridgeLocation;
  /** 진입점 표식(정렬). 없으면 생략한다. */
  readonly entries?: readonly EntryKind[];
}

/** 출력 간선이다. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** 간선 종류(정렬) */
  readonly kinds: readonly EdgeKind[];
}

/** 호출 해석 통계다. */
export interface CallStatistics {
  /** 프로젝트 노드로 이은 호출 수 */
  resolved: number;
  /** 의존성·lib·생성 코드로 가는 호출 수(간선을 만들지 않는다) */
  external: number;
  /** 그중 타입 선언을 찾지 못한 패키지(의존성 미설치 등)를 거친 호출 수 */
  missingDependencies: number;
  /** 잇지 못한 호출 수(이유별) */
  readonly unresolved: Record<UnresolvedReason, number>;
}

/**
 * 호출을 잇지 못한 이유다.
 *
 * - `parameter`: 매개변수·구조 분해 값 호출(콜백 실행). 호출자 쪽 `callback` 간선이 연결을 대신한다.
 * - `interface`: 인터페이스·타입 리터럴 시그니처이고 구현을 증명하지 못함.
 * - `untyped`: checker가 심볼을 주지 못함(`any` 등).
 * - `computed`: 호출 대상이 식별자·속성 접근이 아님(`f()()`, 계산된 키).
 * - `indirect`: 함수가 아닌 값(지역 변수·필드·CommonJS 할당)을 거친 호출.
 * - `unresolved-import`: import가 풀리지 않음.
 */
export type UnresolvedReason = 'parameter' | 'interface' | 'untyped' | 'computed' | 'indirect' | 'unresolved-import';

/** 이유 목록(출력 순서)이다. */
export const UNRESOLVED_REASONS: readonly UnresolvedReason[] = ['parameter', 'interface', 'untyped', 'computed', 'indirect', 'unresolved-import'];

/** 그래프 전체다. 노드는 id 순, 간선은 (from, to) 순이다. */
export interface CallGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly limitations: readonly string[];
  readonly statistics: GraphStatistics;
}

/** 그래프 통계다. */
export interface GraphStatistics {
  readonly files: number;
  readonly calls: CallStatistics;
}

/** 등록 중인 노드다. 위치는 마지막에 한 번에 계산한다. */
interface NodeRecord {
  readonly id: string;
  readonly kind: NodeKind;
  readonly path: string;
  readonly sourceFile: ts.SourceFile;
  readonly offset: number;
  readonly entries: Set<EntryKind>;
}

/** 노드·간선 저장소다. */
export class GraphStore {
  /** id → 노드다. */
  private readonly records = new Map<string, NodeRecord>();
  /** from → (to → 종류 집합)이다. */
  private readonly adjacency = new Map<string, Map<string, Set<EdgeKind>>>();

  /**
   * 노드를 등록한다. 이미 있으면 그대로 둔다(먼저 등록한 선언이 대표다).
   *
   * @param id 노드 id
   * @param kind 종류
   * @param path 프로젝트 기준 경로
   * @param at 위치 노드(이름 토큰 등)
   */
  addNode(id: string, kind: NodeKind, path: string, at: ts.Node): void {
    if (this.records.has(id)) return;
    const sourceFile = at.getSourceFile();
    const offset = ts.isSourceFile(at) ? 0 : at.getStart(sourceFile);
    this.records.set(id, { id, kind, path, sourceFile, offset, entries: new Set() });
  }

  /**
   * 노드가 있는지 본다.
   *
   * @param id 노드 id
   * @returns 있으면 true
   */
  hasNode(id: string): boolean {
    return this.records.has(id);
  }

  /**
   * 진입점 표식을 단다. 없는 노드면 무시하고 false다.
   *
   * @param id 노드 id
   * @param entry 진입점 종류
   * @returns 달았으면 true
   */
  markEntry(id: string, entry: EntryKind): boolean {
    const record = this.records.get(id);
    record?.entries.add(entry);
    return record !== undefined;
  }

  /**
   * 간선을 더한다.
   *
   * @param from 출발 노드 id
   * @param to 도착 노드 id
   * @param kind 간선 종류
   */
  addEdge(from: string, to: string, kind: EdgeKind): void {
    let targets = this.adjacency.get(from);
    if (targets === undefined) {
      targets = new Map();
      this.adjacency.set(from, targets);
    }
    let kinds = targets.get(to);
    if (kinds === undefined) {
      kinds = new Set();
      targets.set(to, kinds);
    }
    kinds.add(kind);
  }

  /**
   * 정렬한 출력 노드를 만든다.
   *
   * @returns id 순 노드
   */
  nodes(): GraphNode[] {
    const texts = new Map<ts.SourceFile, SourceText>();
    return [...this.records.values()].sort((left, right) => compareStrings(left.id, right.id)).map((record) => {
      let text = texts.get(record.sourceFile);
      if (text === undefined) {
        text = new SourceText(record.sourceFile.text);
        texts.set(record.sourceFile, text);
      }
      const entries = [...record.entries].sort(compareStrings);
      return {
        id: record.id,
        kind: record.kind,
        location: { path: record.path, ...text.locate(record.offset) },
        ...(entries.length === 0 ? {} : { entries }),
      };
    });
  }

  /**
   * 정렬한 출력 간선을 만든다.
   *
   * @returns (from, to) 순 간선
   */
  edges(): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const [from, targets] of this.adjacency) {
      for (const [to, kinds] of targets) result.push({ from, to, kinds: [...kinds].sort(compareStrings) });
    }
    return result.sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to));
  }
}
