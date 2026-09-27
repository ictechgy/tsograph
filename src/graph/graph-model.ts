/**
 * 호출 그래프의 타입과, 노드·간선을 모으는 가변 저장소다.
 *
 * 노드 id는 `symbol-ids.ts` 규칙을 따른다. 같은 id가 되는 선언(오버로드, getter/setter 쌍 등)은 한
 * 노드로 합친다 — 먼저 등록한 선언의 종류·위치를 남긴다. 간선은 (from, to, 근거) 셋마다 종류 집합을 둔다.
 * 같은 쌍이 여러 근거로 관찰되면 근거마다 한 간선이다(더 강한 근거가 종류를 모두 덮으면 약한 쪽은 버린다).
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

/**
 * 간선 근거의 강도다(강한 것부터).
 *
 * - `direct`: 호출 대상을 checker 심볼(또는 수신자의 고정 초기값)로 증명했다.
 * - `bound`: 인터페이스·구조 타입 수신자로 부른 호출이고, 프로젝트 안에서 그 수신자 자리로 흘러드는 값을
 *   전부 관찰했으며 모두 프로젝트 구현이었다(`dispatch.ts`의 전제 참고).
 * - `candidate`: 흐름을 다 증명하지 못해 수신자 타입을 구현(`implements`)하거나 그 타입에 대입 가능한
 *   프로젝트 클래스·객체의 메서드 전부로 이은 과대 근사다.
 */
export type EdgeEvidence = 'direct' | 'bound' | 'candidate';

/** 근거 강도 순서다(인덱스가 작을수록 강하다). */
export const EDGE_EVIDENCE_ORDER: readonly EdgeEvidence[] = ['direct', 'bound', 'candidate'];

/**
 * reach·impact가 따라가는 간선 범위다: `direct`는 direct만, `bound`는 direct+bound, `candidates`는 전부.
 */
export type DispatchMode = 'direct' | 'bound' | 'candidates';

/** 모드 목록(좁은 것부터)이다. */
export const DISPATCH_MODES: readonly DispatchMode[] = ['direct', 'bound', 'candidates'];

/**
 * 모드가 허용하는 가장 약한 근거다.
 *
 * @param mode 디스패치 모드
 * @returns 허용하는 가장 약한 근거
 */
export function weakestEvidence(mode: DispatchMode): EdgeEvidence {
  return mode === 'direct' ? 'direct' : mode === 'bound' ? 'bound' : 'candidate';
}

/**
 * 근거가 모드 안에 드는지 본다.
 *
 * @param evidence 간선 근거
 * @param mode 디스패치 모드
 * @returns 모드가 따라가는 근거면 true
 */
export function evidenceAllowed(evidence: EdgeEvidence, mode: DispatchMode): boolean {
  return EDGE_EVIDENCE_ORDER.indexOf(evidence) <= EDGE_EVIDENCE_ORDER.indexOf(weakestEvidence(mode));
}

/**
 * 노드 자신의 호출 위치 중 모드별로 잇지 못한 수다. 0인 모드는 생략한다(direct ≥ bound ≥ candidates).
 */
export type UnresolvedCallCounts = Partial<Record<DispatchMode, number>>;

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
  /** 이 노드의 호출 위치 중 모드별로 잇지 못한 수. 모두 0이면 생략한다. */
  readonly unresolvedCalls?: UnresolvedCallCounts;
}

/** 출력 간선이다. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** 간선 종류(정렬) */
  readonly kinds: readonly EdgeKind[];
  /** 간선 근거 */
  readonly evidence: EdgeEvidence;
}

/** 호출 해석 통계다. */
export interface CallStatistics {
  /** 프로젝트 노드로 이은 호출 수 */
  resolved: number;
  /** 의존성·lib·생성 코드로 가는 호출 수(간선을 만들지 않는다) */
  external: number;
  /** 그중 타입 선언을 찾지 못한 패키지(의존성 미설치 등)를 거친 호출 수 */
  missingDependencies: number;
  /** 잇지 못한 호출 수(이유별, direct 기준) */
  readonly unresolved: Record<UnresolvedReason, number>;
  /** 인터페이스 공백 호출 중 bound·candidate 간선으로 이은 수 */
  readonly dispatch: DispatchStatistics;
}

/**
 * 인터페이스 공백 호출(`unresolved.interface`와 인터페이스 부분 해석)을 디스패치로 이은 수다.
 * `*Partial`은 direct로 일부만 이었던 호출(`partial-dispatch:`)의 나머지를 이은 수다.
 */
export interface DispatchStatistics {
  bound: number;
  boundPartial: number;
  candidate: number;
  candidatePartial: number;
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

/** 그래프 전체다. 노드는 id 순, 간선은 (from, to, 근거 강도) 순이다. */
export interface CallGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** 스냅샷 limitation(호출 계수는 direct 기준, 디스패치 계수 줄 포함) */
  readonly limitations: readonly string[];
  /** reach·impact 문서가 모드별로 싣는 limitation. 없으면 `limitations`를 쓴다. */
  readonly limitationsByMode?: Readonly<Record<DispatchMode, readonly string[]>>;
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
  /** 모드별로 잇지 못한 호출 위치 수 */
  readonly unresolved: Record<DispatchMode, number>;
}

/** 노드·간선 저장소다. */
export class GraphStore {
  /** id → 노드다. */
  private readonly records = new Map<string, NodeRecord>();
  /** from → (to → (근거 → 종류 집합))이다. */
  private readonly adjacency = new Map<string, Map<string, Map<EdgeEvidence, Set<EdgeKind>>>>();

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
    this.records.set(id, { id, kind, path, sourceFile, offset, entries: new Set(), unresolved: { direct: 0, bound: 0, candidates: 0 } });
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
   * 진입점 표식이 있는 노드의 id와 파일 경로다(디스패치의 열린 자리 판정용).
   *
   * @returns 진입점 노드 목록
   */
  entryRecords(): { readonly id: string; readonly path: string }[] {
    return [...this.records.values()].filter((record) => record.entries.size > 0).map((record) => ({ id: record.id, path: record.path }));
  }

  /**
   * 노드의 호출 위치 하나를 잇지 못했다고 센다. `linkedFrom`보다 좁은 모드에서만 센다
   * (예: bound로 이었으면 direct 모드에서만, 끝내 잇지 못했으면 모든 모드에서).
   *
   * @param id 노드 id(등록된 노드)
   * @param linkedFrom 이 호출을 잇는 가장 좁은 모드, 어느 모드로도 잇지 못했으면 undefined
   */
  countUnresolved(id: string, linkedFrom: DispatchMode | undefined): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    for (const mode of DISPATCH_MODES) {
      if (mode === linkedFrom) break;
      record.unresolved[mode]++;
    }
  }

  /**
   * 출발 노드의 간선 도착 id와 종류를 돌려준다(디스패치의 진입점 별칭 추적용).
   *
   * @param from 출발 노드 id
   * @returns 도착 id → 종류 집합(모든 근거 합집합)
   */
  targetsOf(from: string): Map<string, Set<EdgeKind>> {
    const result = new Map<string, Set<EdgeKind>>();
    for (const [to, byEvidence] of this.adjacency.get(from) ?? []) {
      result.set(to, new Set([...byEvidence.values()].flatMap((kinds) => [...kinds])));
    }
    return result;
  }

  /**
   * 간선을 더한다.
   *
   * @param from 출발 노드 id
   * @param to 도착 노드 id
   * @param kind 간선 종류
   * @param evidence 근거(기본 direct)
   */
  addEdge(from: string, to: string, kind: EdgeKind, evidence: EdgeEvidence = 'direct'): void {
    let targets = this.adjacency.get(from);
    if (targets === undefined) {
      targets = new Map();
      this.adjacency.set(from, targets);
    }
    let byEvidence = targets.get(to);
    if (byEvidence === undefined) {
      byEvidence = new Map();
      targets.set(to, byEvidence);
    }
    let kinds = byEvidence.get(evidence);
    if (kinds === undefined) {
      kinds = new Set();
      byEvidence.set(evidence, kinds);
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
      const unresolvedCalls = nonZeroCounts(record.unresolved);
      return {
        id: record.id,
        kind: record.kind,
        location: { path: record.path, ...text.locate(record.offset) },
        ...(entries.length === 0 ? {} : { entries }),
        ...(unresolvedCalls === undefined ? {} : { unresolvedCalls }),
      };
    });
  }

  /**
   * 정렬한 출력 간선을 만든다. 같은 쌍의 더 강한 근거 간선들이 종류를 모두 덮는 약한 근거 간선은 버린다
   * (어느 모드에서도 순회 결과를 바꾸지 않기 때문이다).
   *
   * @returns (from, to, 근거 강도) 순 간선
   */
  edges(): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const [from, targets] of this.adjacency) {
      for (const [to, byEvidence] of targets) result.push(...pairEdges(from, to, byEvidence));
    }
    return result.sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to)
      || EDGE_EVIDENCE_ORDER.indexOf(left.evidence) - EDGE_EVIDENCE_ORDER.indexOf(right.evidence));
  }
}

/**
 * 한 (from, to) 쌍의 근거별 간선을 만든다. 더 강한 근거가 이미 덮은 종류만 가진 간선은 뺀다.
 *
 * @param from 출발 id
 * @param to 도착 id
 * @param byEvidence 근거 → 종류 집합
 * @returns 강한 근거부터의 간선
 */
function pairEdges(from: string, to: string, byEvidence: ReadonlyMap<EdgeEvidence, ReadonlySet<EdgeKind>>): GraphEdge[] {
  const covered = new Set<EdgeKind>();
  const result: GraphEdge[] = [];
  for (const evidence of EDGE_EVIDENCE_ORDER) {
    const kinds = byEvidence.get(evidence);
    if (kinds === undefined || [...kinds].every((kind) => covered.has(kind))) continue;
    kinds.forEach((kind) => covered.add(kind));
    result.push({ from, to, kinds: [...kinds].sort(compareStrings), evidence });
  }
  return result;
}

/**
 * 0이 아닌 모드별 계수만 남긴다.
 *
 * @param counts 모드별 계수
 * @returns 0이 아닌 계수, 모두 0이면 undefined
 */
function nonZeroCounts(counts: Readonly<Record<DispatchMode, number>>): UnresolvedCallCounts | undefined {
  const entries = DISPATCH_MODES.filter((mode) => counts[mode] > 0).map((mode) => [mode, counts[mode]] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
