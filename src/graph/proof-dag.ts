/** AST 증명을 문맥에 묶고 비순환 DAG의 동일한 논리 비용으로 재생한다. */

/** 소비자별 권한이다. legacy를 effects/confinement로 승격하지 않는다. */
export type ProofCapability = 'legacy' | 'instance-family' | 'exact-bag' | 'descriptor' | 'concrete-dispatch' | 'primitive-effects' | 'sterile-confinement';
/** checker가 속한 Program과 선택 view·manifest·policy·proof version의 정체성이다. */
export interface ProofBinding {
  readonly program: object;
  readonly checker: object;
  readonly view: string;
  readonly manifest: object | undefined;
  readonly policy: object;
  readonly version: number;
  /** extended 권한의 현재 authoritative coverage를 조회한다. */
  readonly coverage?: () => boolean;
}
/** 미완료·자원·순환을 semantic rejection과 구분한다. */
export type ProofResult<T> = { readonly kind: 'proved'; readonly value: T }
  | { readonly kind: 'rejected' | 'incomplete'; readonly reason: string }
  | { readonly kind: 'cycle' | 'exhausted' };
/** opaque certificate의 발행 근거다. 실제 권한은 발행 DAG 내부에서 확인한다. */
export interface ProofCertificate {
  readonly mode: 'legacy' | 'extended';
  readonly nodeId: string;
  readonly binding: ProofBinding;
  readonly capability: ProofCapability;
  readonly identity: object;
  readonly dependencies: readonly ProofCertificate[];
}
/** 완료 성공에만 certificate를 제공한다. */
export type ProofOutcome<T> = (ProofResult<T> & { readonly kind: 'proved'; readonly certificate: ProofCertificate })
  | Exclude<ProofResult<T>, { readonly kind: 'proved' }>;
/** 간선마다 현재 caller에 더할 깊이와 expression frame이다. */
export interface ProofEdge {
  readonly recipe: ProofRecipe<unknown>;
  /** 소비자가 요구한 정확한 권한이다. 생략하면 recipe의 권한과 같다. */
  readonly capability?: ProofCapability;
  readonly depth: number;
  readonly frames: number;
}
/** dependencies는 AST만 읽는다. evaluate는 dependency 결과만 소비하고 ValueFlow를 호출하지 않는다. */
export interface ProofRecipe<T> {
  readonly id: string;
  readonly capability: ProofCapability;
  readonly identity: object;
  readonly mode?: 'legacy' | 'extended';
  readonly valid: () => boolean;
  readonly dependencies: (work: ProofWork) => readonly ProofEdge[];
  readonly evaluate: (work: ProofWork, children: readonly ProofOutcome<unknown>[]) => ProofResult<T>;
}
/** caller 자원과 동일한 고정 상한이다. */
export interface ProofLimits { readonly steps?: number; readonly depth?: number; readonly frames?: number }
/** caller step 및 edge 위치를 함께 검증한다. */
export interface ProofCaller { readonly step: () => void; readonly check: (depth: number, frames: number) => void }
/** 현재 값이 proof entry에 포함되는 policy/default-library 또는 재감사 가능한 열거 사실 조회다. */
export interface ProofGuard {
  readonly read: () => boolean;
  /** 불일치한 현재 열거를 같은 bounded recipe로 다시 감사해도 되는 guard만 opt-in한다. */
  readonly reconstruct?: boolean;
}
/** 순서가 보존된 proof work다. guard 조회는 callback 전에 청구하고 같은 edge 위치에서 재생한다. */
export type ProofWork = ((depth?: number, frames?: number) => void) & {
  observe: (guard: ProofGuard, depth?: number, frames?: number) => boolean;
  require: (guard: ProofGuard, required: boolean, depth?: number, frames?: number) => void;
};
/** 외부에 semantic negative로 전달하지 않는 내부 중단이다. */
class ProofExhausted extends Error {}
/** 현재 질의의 guard 불일치는 semantic rejection이 아니라 entry 무효화다. */
class ProofEntryInvalid extends Error {
  readonly guard: ProofGuard;
  constructor(guard: ProofGuard) { super(); this.guard = guard; }
}
/** 낮은 테스트 예산만 허용하고 잘못된 수치는 보수적으로 즉시 중단한다. */
function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}
/** 질의마다 새로 만드는 local-work 방문 집합과 자원 계수다. */
export class ProofQuery {
  readonly visited = new Set<object>();
  steps = 0;
  maxDepth = 0;
  maxFrames = 0;
  private readonly limits: Required<ProofLimits>;
  private readonly caller: ProofCaller | undefined;
  private readonly guards = new Map<ProofGuard, boolean>();
  constructor(limits: ProofLimits = {}, caller?: ProofCaller) {
    this.limits = { steps: boundedLimit(limits.steps, 20_000), depth: boundedLimit(limits.depth, 256), frames: boundedLimit(limits.frames, 400) };
    this.caller = caller;
  }
  /** cold construction과 warm replay가 같은 논리 연산을 청구한다. */
  step(): void {
    this.caller?.step();
    if (++this.steps > this.limits.steps) throw new ProofExhausted();
  }
  /** shared edge도 건너뛰지 않고 현재 위치에서 검증한다. */
  check(depth: number, frames: number): void {
    this.caller?.check(depth, frames);
    this.maxDepth = Math.max(this.maxDepth, depth);
    this.maxFrames = Math.max(this.maxFrames, frames);
    if (depth > this.limits.depth || frames > this.limits.frames) throw new ProofExhausted();
  }
  /** guard 조회 위치를 먼저 청구하고 현재 질의 snapshot을 읽는다. */
  observeGuard(guard: ProofGuard, depth: number, frames: number): boolean {
    this.step();
    this.check(depth, frames);
    const known = this.guards.get(guard);
    if (known !== undefined) return known;
    const value = guard.read();
    this.guards.set(guard, value);
    return value;
  }
}
/** 동일한 위치의 연속 local work를 압축한다. */
interface LogicalWork { cost: number; readonly depth: number; readonly frames: number }
/** callback 결과와 원래 실행 위치를 재생할 guard 연산이다. */
interface GuardWork { readonly guard: ProofGuard; readonly expected: boolean; readonly depth: number; readonly frames: number }
/** 일반 작업과 guard의 순서를 보존하는 완료 trace다. */
type ProofOperation = { readonly kind: 'work'; readonly work: LogicalWork } | { readonly kind: 'guard'; readonly guard: GuardWork };
/** 완성된 정적 node의 pre/post local cost와 canonical dependency다. */
interface Completed {
  readonly recipe: ProofRecipe<unknown>;
  readonly before: readonly ProofOperation[];
  readonly after: readonly ProofOperation[];
  readonly localDepth: number;
  readonly localFrames: number;
  readonly edges: readonly ProofEdge[];
  /** evaluate가 실제 소비한 child outcome이다. 재검증 결과가 바뀌면 parent도 다시 구성한다. */
  readonly children: readonly ProofOutcome<unknown>[];
  readonly outcome: ProofOutcome<unknown>;
}
/** scoped identity에 한 번만 local work를 청구하며 완성된 AST 증명만 저장한다. */
export class ProofDag {
  private readonly completed = new Map<string, Completed>();
  private readonly pending = new Set<string>();
  private readonly issued = new WeakMap<ProofCertificate, ProofRecipe<unknown>>();
  private readonly binding: ProofBinding;
  constructor(binding: ProofBinding) { this.binding = Object.freeze({ ...binding }); }
  /** 위조·다른 view·다른 capability·다른 allocation certificate를 소비하지 않는다. */
  accepts(certificate: ProofCertificate, capability: ProofCapability, identity: object, query = new ProofQuery(), mode: 'legacy' | 'extended' = 'legacy'): boolean {
    const recipe = this.issued.get(certificate);
    if (recipe === undefined || certificate.binding !== this.binding
      || certificate.capability !== capability || certificate.identity !== identity || certificate.mode !== mode) return false;
    const current = this.resolve(recipe, query);
    return current.kind === 'proved' && current.certificate === certificate;
  }
  /** 자원 중단만 outcome으로 바꾸며 예상 밖 예외는 finally 정리 뒤 전파한다. */
  resolve<T>(recipe: ProofRecipe<T>, query: ProofQuery): ProofOutcome<T> {
    try { return this.visit(recipe, query, 0, 0) as ProofOutcome<T>; }
    catch (error) {
      if (error instanceof ProofExhausted) return { kind: 'exhausted' };
      if (error instanceof ProofEntryInvalid) return { kind: 'incomplete', reason: 'entry' };
      throw error;
    }
  }
  /** cold AST 작업과 같은 순서로 위치와 비용을 재생한다. */
  private replay(operations: readonly ProofOperation[], query: ProofQuery, depth: number, frames: number): void {
    for (const operation of operations) {
      if (operation.kind === 'guard') {
        const current = query.observeGuard(operation.guard.guard, depth + operation.guard.depth, frames + operation.guard.frames);
        if (current !== operation.guard.expected) throw new ProofEntryInvalid(operation.guard.guard);
        continue;
      }
      for (let i = 0; i < operation.work.cost; i++) {
        query.step(); query.check(depth + operation.work.depth, frames + operation.work.frames);
      }
    }
  }
  /** 권한과 모드를 child 실행 전에 결정해 다른 증명의 결과를 소비하지 않는다. */
  private mismatched(recipe: ProofRecipe<unknown>, edges: readonly ProofEdge[]): boolean {
    return edges.some((edge) => edge.capability !== undefined && edge.capability !== edge.recipe.capability
      || (recipe.mode ?? 'legacy') !== (edge.recipe.mode ?? 'legacy'));
  }
  /** stale 완료 node만 버리고 이미 청구한 replay 뒤에 현재 entry를 한 번 다시 구성한다. */
  private reconstruct(recipe: ProofRecipe<unknown>, cached: Completed, query: ProofQuery,
    depth: number, frames: number): ProofOutcome<unknown> {
    if (this.completed.get(recipe.id) === cached) this.completed.delete(recipe.id);
    query.visited.delete(cached);
    // pending ownership은 유지하되 새 node lookup의 step/depth/frame은 cold visit과 같이 청구한다.
    query.step(); query.check(depth, frames);
    try { return this.visitBody(recipe, query, depth, frames); }
    catch (error) {
      if (error instanceof ProofEntryInvalid) return { kind: 'incomplete', reason: 'entry' };
      throw error;
    }
  }
  /** depth/frame 검증은 lookup마다, local cost는 질의 내 identity마다 한 번 수행한다. */
  private visit(recipe: ProofRecipe<unknown>, query: ProofQuery, depth: number, frames: number): ProofOutcome<unknown> {
    query.step();
    query.check(depth, frames);
    if (this.pending.has(recipe.id)) return { kind: 'cycle' };
    this.pending.add(recipe.id);
    try { return this.visitBody(recipe, query, depth, frames); }
    finally { this.pending.delete(recipe.id); }
  }
  /** pending은 entry validation과 cache replay까지 포함해 예외에도 제거한다. */
  private visitBody(recipe: ProofRecipe<unknown>, query: ProofQuery, depth: number, frames: number): ProofOutcome<unknown> {
    if (!recipe.valid()) return { kind: 'incomplete', reason: 'entry' };
    if (recipe.mode === 'extended' && this.binding.coverage?.() !== true) return { kind: 'incomplete', reason: 'coverage' };
    if (recipe.capability === 'legacy' && recipe.mode === 'extended'
      || (recipe.capability === 'primitive-effects' || recipe.capability === 'sterile-confinement' || recipe.capability === 'instance-family')
        && recipe.mode !== 'extended') return { kind: 'rejected', reason: 'capability' };
    const cached = this.completed.get(recipe.id);
    if (cached !== undefined && (cached.recipe.identity !== recipe.identity || cached.recipe.capability !== recipe.capability || cached.recipe.mode !== recipe.mode)) {
      return { kind: 'incomplete', reason: 'identity' };
    }
    if (cached !== undefined) {
      if (this.mismatched(recipe, cached.edges)) return { kind: 'rejected', reason: 'capability' };
      const fresh = !query.visited.has(cached);
      if (!fresh) query.check(depth + cached.localDepth, frames + cached.localFrames);
      if (fresh) {
        try { this.replay(cached.before, query, depth, frames); }
        catch (error) {
          if (error instanceof ProofEntryInvalid && error.guard.reconstruct === true) {
            return this.reconstruct(recipe, cached, query, depth, frames);
          }
          throw error;
        }
      }
      const children = cached.edges.map((edge) => this.visit(edge.recipe, query, depth + edge.depth, frames + edge.frames));
      const unstable = children.find((child) => child.kind === 'incomplete' || child.kind === 'cycle' || child.kind === 'exhausted');
      if (unstable !== undefined) return unstable;
      if (children.length !== cached.children.length || children.some((child, index) => child !== cached.children[index])) {
        return this.reconstruct(recipe, cached, query, depth, frames);
      }
      if (fresh) {
        try { this.replay(cached.after, query, depth, frames); }
        catch (error) {
          if (error instanceof ProofEntryInvalid && error.guard.reconstruct === true) {
            return this.reconstruct(recipe, cached, query, depth, frames);
          }
          throw error;
        }
      }
      // guard·의존성 중단은 완료 방문이 아니므로 다음 확인에서 trace를 건너뛰지 않는다.
      query.visited.add(cached);
      return cached.outcome;
    }
    const before: ProofOperation[] = [];
    const after: ProofOperation[] = [];
    let localDepth = 0;
    let localFrames = 0;
    const localCheck = (relativeDepth = 0, relativeFrames = 0): void => {
      query.check(depth + relativeDepth, frames + relativeFrames);
      localDepth = Math.max(localDepth, relativeDepth); localFrames = Math.max(localFrames, relativeFrames);
    };
    const record = (operations: ProofOperation[], d = 0, f = 0): void => {
      query.step(); localCheck(d, f);
      const last = operations.at(-1);
      if (last?.kind === 'work' && last.work.depth === d && last.work.frames === f) {
        operations[operations.length - 1] = { kind: 'work', work: { ...last.work, cost: last.work.cost + 1 } };
      }
      else operations.push({ kind: 'work', work: { cost: 1, depth: d, frames: f } });
    };
    const makeWork = (operations: ProofOperation[]): ProofWork => {
      const work = ((d?: number, f?: number) => record(operations, d, f)) as ProofWork;
      work.observe = (guard, d = 0, f = 0) => {
        const value = query.observeGuard(guard, depth + d, frames + f);
        operations.push({ kind: 'guard', guard: { guard, expected: value, depth: d, frames: f } });
        localDepth = Math.max(localDepth, d); localFrames = Math.max(localFrames, f);
        return value;
      };
      work.require = (guard, required, d = 0, f = 0) => {
        if (work.observe(guard, d, f) !== required) throw new ProofEntryInvalid(guard);
      };
      return work;
    };
    {
      const supplied = recipe.dependencies(makeWork(before));
      if (supplied.length > 20_000) throw new ProofExhausted();
      const edges = [...supplied].sort((a, b) =>
        (a.recipe.id < b.recipe.id ? -1 : a.recipe.id > b.recipe.id ? 1 : 0) || a.depth - b.depth || a.frames - b.frames);
      if (this.mismatched(recipe, edges)) return { kind: 'rejected', reason: 'capability' };
      const children = edges.map((edge) => this.visit(edge.recipe, query, depth + edge.depth, frames + edge.frames));
      const unstable = children.find((child) => child.kind === 'incomplete' || child.kind === 'cycle' || child.kind === 'exhausted');
      if (unstable !== undefined) return unstable;
      const negative = children.find((child) => child.kind === 'rejected');
      const result = negative ?? recipe.evaluate(makeWork(after), children);
      if (result.kind !== 'proved' && result.kind !== 'rejected') return result;
      const outcome: ProofOutcome<unknown> = result.kind === 'proved' ? {
        ...result, certificate: Object.freeze({ mode: recipe.mode ?? 'legacy', nodeId: recipe.id, binding: this.binding, capability: recipe.capability, identity: recipe.identity,
          dependencies: Object.freeze(children.flatMap((child) => child.kind === 'proved' ? [child.certificate] : [])) }),
      } : result;
      if (outcome.kind === 'proved') this.issued.set(outcome.certificate, recipe);
      const node = { recipe, before: Object.freeze(before), after: Object.freeze(after), localDepth, localFrames,
        edges: Object.freeze(edges), children: Object.freeze(children), outcome };
      this.completed.set(recipe.id, node);
      query.visited.add(node);
      return outcome;
    }
  }
}
