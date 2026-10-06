/** 완료된 descriptor/primitive DAG 결과를 세 mutation 소비자에게 같은 문맥으로 전달한다. */
import ts from 'typescript';
import type { MutationRecord } from './flow-index.ts';
import type { MutationSafetyContext } from './mutation-safety.ts';
import type { ProofWork } from './proof-dag.ts';
import { certifiesSingletonWrite, type SingletonWitness } from './singleton-carrier.ts';
import { primitiveErasedReference } from './primitive-helpers.ts';
import { matchesSterileWrite, type SterileLiteralWitness } from './sterile-literals.ts';

/** 발급 객체의 private runtime state로 raw callback/site 집합을 권한으로 받지 않는다. */
export class SterileConfinementCertificate {
  readonly #context: MutationSafetyContext;
  readonly #witness: SingletonWitness;
  readonly #work: ProofWork;
  readonly #writes = new Map<ts.Node, SterileLiteralWitness>();
  readonly #arrays = new Map<ts.VariableDeclaration, SterileLiteralWitness>();

  /** 원 witness의 모든 literal/map copy를 caller work로 청구한다. */
  private constructor(context: MutationSafetyContext, witness: SingletonWitness, work: ProofWork) {
    this.#context = context; this.#witness = witness; this.#work = work;
    for (const literal of witness.literals?.values() ?? []) {
      work();
      for (const site of literal.writes.keys()) { work(); this.#writes.set(site, literal); }
      if (ts.isArrayLiteralExpression(literal.literal)) {
        for (const binding of literal.bindings) { work(); this.#arrays.set(binding, literal); }
      }
    }
    Object.freeze(this);
  }

  /** primitive-effects 완료 뒤 동일 witness의 exact writes·reference closure를 결합한다. */
  static complete(context: MutationSafetyContext, witness: SingletonWitness, work: ProofWork): SterileConfinementCertificate {
    return new SterileConfinementCertificate(context, witness, work);
  }

  /** prototype만 복제한 객체와 callback interface는 발급 객체가 아니다. */
  static isIssued(candidate: unknown): candidate is SterileConfinementCertificate {
    return typeof candidate === 'object' && candidate !== null && #context in candidate;
  }

  /** undefined는 인증 영역 밖이다. 영역 안 mismatch는 legacy 허용으로 복구하지 않는다. */
  write(candidate: MutationSafetyContext, record: MutationRecord): boolean | undefined {
    this.#work();
    if (!this.matchesContext(candidate)) return false;
    if (this.#witness.writes.has(record.site)) return certifiesSingletonWrite(this.#witness, record);
    const literal = this.#writes.get(record.site);
    return literal === undefined ? undefined : matchesSterileWrite(literal, record);
  }

  /** mutation 없는 alias/reference도 같은 완료 witness의 전체 closure에 대조한다. */
  array(candidate: MutationSafetyContext, binding: ts.VariableDeclaration): boolean | undefined {
    this.#work();
    if (!this.matchesContext(candidate)) return false;
    const literal = this.#arrays.get(binding);
    if (literal === undefined) return undefined;
    for (const alias of literal.bindings) {
      this.#work(); const symbol = candidate.checker.getSymbolAtLocation(alias.name);
      if (symbol === undefined || candidate.index.exportedSymbols.has(symbol)
        || (candidate.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return false;
      for (const token of candidate.index.references.get(symbol) ?? []) {
        this.#work(); if (!literal.references.has(token) && !primitiveErasedReference(token, this.#work)) return false;
      }
    }
    return true;
  }

  /** 다른 root/index/checker/inventory에 완료된 literal 긍정을 옮기지 않는다. */
  private matchesContext(candidate: MutationSafetyContext): boolean {
    const context = this.#context, origin = this.#witness.origin;
    return context.index === origin.index && context.checker === origin.checker
      && context.index.effectInventory === origin.inventory && candidate.index === context.index
      && candidate.checker === context.checker && candidate.openProgram === context.openProgram
      && candidate.openProperties === context.openProperties;
  }
}

/** 발급 경로는 완료된 primitive-effects 소비자에서만 호출한다. 전역 긍정 cache를 만들지 않는다. */
export function completeSterileConfinement(context: MutationSafetyContext, witness: SingletonWitness,
  work: ProofWork): SterileConfinementCertificate {
  return SterileConfinementCertificate.complete(context, witness, work);
}
