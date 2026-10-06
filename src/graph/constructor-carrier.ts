/**
 * 좁은 생성자 DI carrier를 AST만으로 증명한다.
 *
 * 이 모듈은 값 흐름을 재귀 호출하지 않는다. 정확히 한 번 생성되는 닫힌 클래스가
 * private readonly parameter-property bag의 정적 own-data projection만 읽고, 그
 * 생성 결과가 알려진 인스턴스 메서드 호출로만 소비되는 경우에만 증명을 내놓는다.
 * 불완전한 참조·mutation·prototype 정보는 모두 증명 실패로 처리한다.
 */

import ts from 'typescript';

import { climbWrappers, type FlowIndex, referenceSite, type MutationRecord } from './flow-index.ts';
import { isMutationCleanView, type MutationSafetyContext } from './mutation-safety.ts';
import { skipWrappers } from './node-collector.ts';
import { hasPrimitiveHelperCandidates } from './effect-inventory.ts';
import { collectPrimitivePlan, type PrimitivePlan } from './primitive-helper-sites.ts';
import { PrimitiveHelpers, primitiveChildren, primitiveLiteral, type PrimitiveSummary } from './primitive-helpers.ts';
import { auditSingletonCarrier, coversSingletonEffects, certifiesSingletonWrite,
  type SingletonEffectModel, type SingletonWitness } from './singleton-carrier.ts';
import type { FlowPolicy } from './value-flow.ts';
import { ProofDag, ProofQuery, type ProofCaller, type ProofCertificate, type ProofOutcome, type ProofRecipe, type ProofEdge, type ProofGuard, type ProofWork } from './proof-dag.ts';

/** 생성자 carrier 증명에 필요한 공개 분석 문맥이다. */
export interface ConstructorCarrierContext {
  /** 확장 권한에 필요한 checker의 실제 Program이다. 독립 legacy AST는 checker로 scope를 고정한다. */
  readonly program?: ts.Program;
  /** ValueFlow caller의 step/depth/frame 예산이다. */
  readonly caller?: ProofCaller;
  /** TypeScript checker */
  readonly checker: ts.TypeChecker;
  /** 전체 프로그램 AST 색인 */
  readonly index: FlowIndex;
  /** 열린 자리와 genuine intrinsic을 정하는 정책 */
  readonly policy: FlowPolicy;
}

/** 한 생성자 carrier가 읽는 정적 service 호출 근거다. */
export interface ConstructorServiceUse {
  /** bag projection의 own-data key */
  readonly propertyName: string;
  /** 호출한 service method 이름 */
  readonly methodName: string;
  /** checker가 해석한 호출 */
  readonly call: ts.CallExpression;
}

/** factory·memo·one-level wrapper가 만든 projection binding의 전체 근거다. */
export interface ConstructorProjectionBinding {
  /** projection own-data key */
  readonly key: string;
  /** 원본 projection/member binding node */
  readonly source: ts.Node;
  /** 구조 분해 binding이면 해당 요소 */
  readonly bindingElement?: ts.BindingElement;
  /** bound variable symbol */
  readonly symbol?: ts.Symbol;
  /** 반환 factory */
  readonly factory?: ts.FunctionDeclaration;
  /** factory invocation */
  readonly invocation?: ts.CallExpression;
  /** inline callback parameter */
  readonly callbackParameter?: ts.ParameterDeclaration;
}

/** 증명된 생성자 carrier의 AST 근거다. */
export interface ConstructorCarrierProof {
  /** repaired legacy 소비자에게만 발급한 문맥 certificate다. */
  readonly certificate?: ProofCertificate;
  /** 증명한 클래스 */
  readonly declaration: ts.ClassLikeDeclaration;
  /** 유일한 생성자 */
  readonly constructor: ts.ConstructorDeclaration;
  /** private readonly parameter-property bag */
  readonly bagParameter: ts.ParameterDeclaration;
  /** bag 타입의 own-data key */
  readonly bagKeys: ReadonlySet<string>;
  /** 생성자 호출에서 확인한 정확한 inner object literal */
  readonly innerLiteral: ts.ObjectLiteralExpression;
  /** service projection 호출들 */
  readonly serviceUses: readonly ConstructorServiceUse[];
  /** 모든 factory/memo/one-level wrapper projection 근거 */
  readonly projectionBindings: readonly ConstructorProjectionBinding[];
  /** clean-view에서 허용할 audited constructor own-field site */
  readonly allowedMutationSites: ReadonlySet<ts.Node>;
}

/** source-derived legacy obligation의 정적 노드 종류다. */
type CarrierOperation = 'proof' | 'role' | 'lineage' | 'instance' | 'identity' | 'consumption' | 'receiver' | 'construction' | 'field' | 'extended-selection' | 'dependency-selection';

/** 생성자 carrier 분석기다. 완료한 AST 결과만 메모하고 재진입은 실패시킨다. */
export class ConstructorCarrierAnalyzer {
  private readonly context: ConstructorCarrierContext;
  /** 늦게 생성한 recipe도 analyzer 생성 당시의 동일한 문맥·manifest에 묶는다. */
  private readonly origin: {
    readonly program: ts.Program | undefined;
    readonly checker: ts.TypeChecker;
    readonly index: FlowIndex;
    readonly policy: FlowPolicy;
    readonly inventory: FlowIndex['effectInventory'];
    readonly manifest: object | undefined;
  };
  private readonly dag: ProofDag;
  private readonly recipes = new Map<ts.ClassLikeDeclaration, Map<CarrierOperation, ProofRecipe<unknown>>>();
  private readonly bagRecipes = new Map<ts.ObjectLiteralExpression, Map<ts.ClassLikeDeclaration, ProofRecipe<ConstructorCarrierProof>>>();
  /** source/allocation별 정적 extended proof DAG recipe다. */
  private readonly singletonRecipes = new Map<ts.Node, Map<string, ProofRecipe<SingletonWitness>>>();
  /** borrowed endpoint의 자기 singleton family를 root-scoped witness로 확인한다. */
  private readonly dependencyRecipes = new Map<ts.ClassLikeDeclaration, ProofRecipe<SingletonWitness>>();
  private readonly issuedProofs = new WeakMap<ProofCertificate, ConstructorCarrierProof>();
  private readonly helpers: PrimitiveHelpers;
  private readonly helperInventories = new Map<ts.ClassLikeDeclaration, ProofRecipe<PrimitiveSummary>>();
  private query: ProofQuery | undefined;
  private work: ProofWork | undefined;
  private walkDepth = 0;
  private readonly files: ReadonlySet<ts.SourceFile>;
  /** 독립 build inventory를 받은 순간의 모든 dependency source revision이다. */
  private readonly sourceTexts: ReadonlyMap<ts.SourceFile, string>;
  private readonly policyGuards = new Map<string, WeakMap<object, ProofGuard>>();

  constructor(context: ConstructorCarrierContext) {
    this.context = context;
    this.origin = { program: context.program, checker: context.checker, index: context.index,
      policy: context.policy, inventory: context.index.effectInventory, manifest: context.index.effectInventory?.manifest };
    this.files = new Set(context.index.files);
    this.sourceTexts = new Map(context.index.files.map((file) => [file, file.text]));
    this.dag = new ProofDag({ program: context.program ?? context.checker, checker: context.checker,
      view: context.index.effectInventory?.manifest.view ?? 'whole', manifest: context.index.effectInventory?.manifest,
      policy: context.policy, version: 4, coverage: () => {
        const inventory = context.index.effectInventory;
        return inventory?.enumeration === 'complete' && inventory.referenceAliases === 'complete'
          && inventory.initialization === 'complete';
      } });
    this.helpers = new PrimitiveHelpers(context, {
      project: (source) => this.policyGuard('project', source),
      open: (node) => this.policyGuard('callable', node),
      intrinsic: (source) => this.policyGuard('default-library', source),
      valid: () => this.validContext(),
    });
  }

  /** 호출자 질의 경계마다 local-work 방문 집합을 새로 만든다. */
  beginQuery(): void { this.query = new ProofQuery({}, this.context.caller); }
  /** 중단된 질의의 자원 상태를 다음 질의로 넘기지 않는다. */
  endQuery(): void { this.query = undefined; }

  /** repaired legacy 증명의 명시적 outcome이다. later-stage capability를 발급하지 않는다. */
  outcome(declaration: ts.ClassLikeDeclaration): ProofOutcome<ConstructorCarrierProof> {
    const result = this.resolve<ConstructorCarrierProof>(declaration, 'proof');
    if (result.kind === 'rejected' || result.kind === 'incomplete') {
      this.context.index.proofDiagnostics?.add(`carrier-proof: ${result.kind}(${result.reason}); carrier isolation was not certified.`);
    }
    if (result.kind !== 'proved') return result;
    let proof = this.issuedProofs.get(result.certificate);
    if (proof === undefined) {
      proof = Object.freeze({ ...result.value, certificate: result.certificate });
      this.issuedProofs.set(result.certificate, proof);
    }
    return { ...result, value: proof };
  }

  /** 기존 API는 legacy 성공만 투영한다. extended 실패에서 이 API로 fallback하지 않는다. */
  prove(declaration: ts.ClassLikeDeclaration): ConstructorCarrierProof | undefined {
    const result = this.outcome(declaration);
    return result.kind === 'proved' ? result.value : undefined;
  }

  /** 기존 unknown-reflection 격리는 이름이 명시된 legacy 전용 소비자다. */
  allowsLegacyUnknownReflectionIsolation(declaration: ts.ClassLikeDeclaration): boolean {
    const proof = this.prove(declaration);
    return proof !== undefined && this.accepts(proof, declaration);
  }

  /** current allocation과 repaired legacy 권한을 모두 확인한다. */
  accepts(proof: ConstructorCarrierProof, declaration: ts.ClassLikeDeclaration, literal?: ts.ObjectLiteralExpression): boolean {
    const issued = proof.certificate === undefined ? undefined : this.issuedProofs.get(proof.certificate);
    if (!(issued !== undefined && proof.certificate !== undefined && proof.declaration === declaration
      && issued.innerLiteral === proof.innerLiteral && issued.constructor === proof.constructor
      && issued.bagParameter === proof.bagParameter && issued.allowedMutationSites === proof.allowedMutationSites
      && (literal === undefined || proof.innerLiteral === literal))) return false;
    const query = this.query ?? new ProofQuery({}, this.context.caller);
    const previous = this.query;
    this.query = query;
    try {
      return this.dag.accepts(proof.certificate, 'legacy', declaration, query)
        && this.context.index.hasOpaqueMutation !== true;
    }
    finally { if (previous === undefined) this.query = undefined; }
  }

  /** exact allocation bag 소비자는 class/family 또는 effect 권한을 빌리지 않는다. */
  isolatesBag(declaration: ts.ClassLikeDeclaration, literal: ts.ObjectLiteralExpression): boolean {
    let byDeclaration = this.bagRecipes.get(literal);
    if (byDeclaration === undefined) {
      byDeclaration = new Map();
      this.bagRecipes.set(literal, byDeclaration);
    }
    let recipe = byDeclaration.get(declaration);
    if (recipe === undefined) {
      const proofRecipe = this.recipe(declaration, 'proof');
      recipe = {
        id: `${literal.getSourceFile().fileName}:${literal.pos}:exact-bag:${declaration.pos}`, capability: 'exact-bag', identity: literal,
        valid: () => proofRecipe.valid() && literal.getSourceFile() === declaration.getSourceFile(),
        dependencies: () => [{ recipe: proofRecipe, capability: 'legacy', depth: 1, frames: 0 }],
        evaluate: (work, children) => {
          work();
          const child = children[0];
          const proof = child?.kind === 'proved' ? child.value as ConstructorCarrierProof : undefined;
          return proof?.declaration === declaration && proof.innerLiteral === literal
            ? { kind: 'proved', value: proof } : { kind: 'rejected', reason: 'allocation' };
        },
      };
      byDeclaration.set(declaration, recipe);
    }
    const query = this.query ?? new ProofQuery({}, this.context.caller);
    const result = this.resolveRecipe(recipe, query);
    return result.kind === 'proved' && result.value.declaration === declaration
      && this.dag.accepts(result.certificate, 'exact-bag', literal, query);
  }

  /** unknown reflection에는 completed singleton family capability만 소비한다. */
  allowsExtendedInstanceIsolation(declaration: ts.ClassLikeDeclaration): boolean {
    return this.extendedAuthority(declaration, 'instance-family', declaration);
  }

  /** exact allocation의 bag authority는 descriptor/effects/confinement를 모두 의존한다. */
  isolatesExtendedBag(declaration: ts.ClassLikeDeclaration, literal: ts.ObjectLiteralExpression): boolean {
    return this.extendedAuthority(declaration, 'exact-bag', literal);
  }

  /** root/dependency/legacy 모드를 증명 전에 선택한다. extended negative에서 legacy로 fallback하지 않는다. */
  allowsUnknownReflectionIsolation(declaration: ts.ClassLikeDeclaration): boolean {
    if (this.selectsExtendedFlow(declaration)) return this.allowsExtendedInstanceIsolation(declaration);
    const selection = this.resolve<boolean>(declaration, 'dependency-selection');
    if (selection.kind !== 'proved') return false;
    return selection.value ? this.allowsExtendedDependencyIsolation(declaration)
      : this.allowsLegacyUnknownReflectionIsolation(declaration);
  }

  /** dependency의 class 값·prototype ownership을 빌리지 않고 자기 singleton census만 소비한다. */
  allowsExtendedDependencyIsolation(declaration: ts.ClassLikeDeclaration): boolean {
    let recipe = this.dependencyRecipes.get(declaration);
    if (recipe === undefined) {
      const entry = this.recipe(declaration, 'proof');
      recipe = {
        id: `${declaration.getSourceFile().fileName}:${declaration.pos}:stage3:dependency-family`,
        capability: 'instance-family', identity: declaration, mode: 'extended',
        valid: () => entry.valid() && this.context.program !== undefined
          && this.context.program.getTypeChecker() === this.context.checker,
        dependencies: (work) => this.withWork(work, () => {
          work.require(this.policyGuard('project', declaration.getSourceFile()), true);
          work.require(this.policyGuard('callable', declaration), false);
          const owner = this.singletonDependencyOwner(declaration);
          return owner === undefined ? [] : [{ recipe: this.singletonRecipe(owner, 'sterile-confinement'),
            capability: 'sterile-confinement', depth: 1, frames: 0 }];
        }),
        evaluate: (work, children) => {
          work();
          const child = children[0];
          const witness = child?.kind === 'proved' ? child.value as SingletonWitness : undefined;
          return witness?.dependencies.has(declaration) === true
            ? { kind: 'proved', value: witness } : { kind: 'rejected', reason: 'dependency-family' };
        },
      };
      this.dependencyRecipes.set(declaration, recipe);
    }
    const query = this.query ?? new ProofQuery({}, this.context.caller);
    const result = this.resolveRecipe(recipe, query);
    return result.kind === 'proved' && this.dag.accepts(result.certificate, 'instance-family', declaration, query, 'extended');
  }

  /** 직접 new→const→exact bag→new 경로만 따라가며 ValueFlow나 타입으로 owner를 추측하지 않는다. */
  private singletonDependencyOwner(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
    const construction = this.singleConstruction(declaration);
    if (construction === undefined) return undefined;
    const binding = climbWrappers(construction).parent;
    if (!ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name)) return undefined;
    const symbol = this.context.checker.getSymbolAtLocation(binding.name);
    if (symbol === undefined) return undefined;
    let owner: ts.ClassLikeDeclaration | undefined;
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      this.step();
      const site = referenceSite(reference);
      const property = site.parent;
      if (!ts.isPropertyAssignment(property) || property.initializer !== site || !ts.isObjectLiteralExpression(property.parent)) return undefined;
      const allocation = climbWrappers(property.parent).parent;
      if (!ts.isNewExpression(allocation)) return undefined;
      this.step();
      if (allocation.arguments?.length !== 1 || allocation.arguments[0] !== property.parent) return undefined;
      const target = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(skipWrappers(allocation.expression)));
      const candidate = target?.valueDeclaration;
      if (candidate === undefined || !ts.isClassDeclaration(candidate) || owner !== undefined && owner !== candidate) return undefined;
      owner = candidate;
    }
    return owner;
  }

  /** 선택한 extended flow는 실패 후 legacy 문법으로 재시도하지 않는다. */
  selectsExtendedFlow(declaration: ts.ClassLikeDeclaration): boolean {
    const outcome = this.resolve<boolean>(declaration, 'extended-selection');
    return outcome.kind !== 'proved' || outcome.value;
  }

  /** 반복 allocation은 ordinary union에 남기고 exact own bag singleton만 확장 모드를 선택한다. */
  private selectExtendedClass(declaration: ts.ClassLikeDeclaration): boolean {
    this.step();
    if (this.context.index.effectInventory === undefined) return false;
    let constructor: ts.ConstructorDeclaration | undefined;
    for (const member of declaration.members) {
      this.step();
      if (ts.isConstructorDeclaration(member)) { constructor = member; break; }
    }
    let bag: ts.ParameterDeclaration | undefined;
    if (constructor !== undefined) {
      for (const parameter of constructor.parameters) {
        this.step();
        if (isPrivateReadonlyParameterProperty(parameter, constructor, () => this.step())) { bag = parameter; break; }
      }
    }
    if (bag === undefined) return false;
    const shape = this.bagShape(bag);
    if (shape === undefined) return false;
    const symbol = classSymbol(this.context.checker, declaration);
    if (symbol === undefined) return false;
    let allocation: ts.NewExpression | undefined;
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      this.step();
      const site = climbWrappers(referenceSite(reference));
      if (!ts.isNewExpression(site.parent) || site.parent.expression !== site) continue;
      if (allocation !== undefined) return false;
      allocation = site.parent;
    }
    if (allocation === undefined || allocation.arguments?.length !== 1) return false;
    const binding = climbWrappers(allocation).parent;
    if (!ts.isVariableDeclaration(binding) || !ts.isVariableDeclarationList(binding.parent)
      || (binding.parent.flags & ts.NodeFlags.Const) === 0 || !ts.isVariableStatement(binding.parent.parent)
      || binding.parent.parent.parent !== declaration.getSourceFile()) return false;
    const literal = skipWrappers(allocation.arguments[0]!);
    return ts.isObjectLiteralExpression(literal) && this.innerLiteralShape(literal, shape, true);
  }

  /** consumer별 opaque capability는 동일한 정적 witness DAG에 묶인다. */
  private extendedAuthority(declaration: ts.ClassLikeDeclaration,
    capability: 'instance-family' | 'exact-bag' | 'concrete-dispatch' | 'descriptor', identity: ts.Node): boolean {
    const recipe = this.singletonRecipe(declaration, capability, identity);
    const query = this.query ?? new ProofQuery({}, this.context.caller);
    const result = this.resolveRecipe(recipe, query);
    if (result.kind === 'rejected' || result.kind === 'incomplete') {
      this.context.index.proofDiagnostics?.add(`carrier-proof: ${result.kind}(${result.reason}); extended isolation was not certified.`);
    }
    return result.kind === 'proved' && this.dag.accepts(result.certificate, capability, identity, query, 'extended');
  }

  /** descriptor→named effects→confinement→consumer의 단방향 DAG다. legacy 성공은 의존에 포함하지 않는다. */
  private singletonRecipe(declaration: ts.ClassLikeDeclaration,
    capability: 'descriptor' | 'primitive-effects' | 'sterile-confinement' | 'instance-family' | 'exact-bag' | 'concrete-dispatch',
    identity: ts.Node = declaration): ProofRecipe<SingletonWitness> {
    let recipes = this.singletonRecipes.get(identity);
    if (recipes === undefined) { recipes = new Map(); this.singletonRecipes.set(identity, recipes); }
    const key = `${declaration.pos}:${capability}`;
    const known = recipes.get(key); if (known !== undefined) return known;
    const source = declaration.getSourceFile();
    const program = this.context.program;
    const checker = this.context.checker;
    const baseEntry = this.recipe(declaration, 'proof');
    const recipe: ProofRecipe<SingletonWitness> = {
      id: `${source.fileName}:${identity.pos}:stage3:${key}`, identity, capability, mode: 'extended',
      valid: () => baseEntry.valid() && program !== undefined && program.getTypeChecker() === checker
        && program.getSourceFile(source.fileName) === source
        && identity.getSourceFile() === source,
      dependencies: (work) => {
        work.require(this.policyGuard('project', source), true);
        work.require(this.policyGuard('callable', declaration), false);
        if (capability === 'descriptor') {
          for (const file of this.files) {
            work(); work.require(this.policyGuard('source-entry', file), true);
          }
        }
        const child = capability === 'descriptor' ? undefined : capability === 'primitive-effects' ? 'descriptor'
          : capability === 'sterile-confinement' ? 'primitive-effects' : 'sterile-confinement';
        const edges: ProofEdge[] = child === undefined ? [] : [{ recipe: this.singletonRecipe(declaration, child), capability: child, depth: 1, frames: 0 }];
        if (capability === 'descriptor' && hasPrimitiveHelperCandidates(this.context.index.effectInventory)) edges.push({ recipe: this.helperInventory(declaration), capability: 'primitive-effects', depth: 1, frames: 0 });
        return edges;
      },
      evaluate: (work, children) => this.withWork(work, () => {
        work();
        if (this.context.index.hasIncompleteMutations === true || this.context.index.mutationComplete === false) {
          return { kind: 'incomplete', reason: 'coverage' };
        }
        let witness: SingletonWitness | undefined;
        if (capability === 'descriptor') {
          const proof = this.proveClass(declaration, true, true);
          if (proof !== undefined) witness = auditSingletonCarrier(this.context, proof, work, {
            project: (file) => this.policyIsProjectFile(file), open: (node) => this.policyIsOpenCallable(node),
            intrinsic: (file) => this.policyIsDefaultLibraryFile(file),
          });
        } else {
          const child = children.find((child) => child.kind === 'proved' && child.certificate.capability === (capability === 'primitive-effects' ? 'descriptor'
            : capability === 'sterile-confinement' ? 'primitive-effects' : 'sterile-confinement'));
          witness = child?.kind === 'proved' ? child.value as SingletonWitness : undefined;
        }
        if (witness === undefined) return { kind: 'rejected', reason: 'singleton-descriptor' };
        if (capability === 'descriptor') {
          const helper = children.find((child) => child.kind === 'proved' && child.certificate.identity === declaration
            && child.certificate.nodeId.endsWith(':stage4-inventory'));
          if (helper?.kind === 'proved') {
            const models = new Map<ts.Node, SingletonEffectModel>();
            for (const [site, model] of witness.models) { work(); models.set(site, model); }
            for (const site of (helper.value as PrimitiveSummary).sites) { work(); models.set(site, 'primitive-helper'); }
            witness = { ...witness, models };
          } else if (hasPrimitiveHelperCandidates(this.context.index.effectInventory)) {
            return { kind: 'rejected', reason: 'primitive-helper' };
          }
        }
        if (capability === 'primitive-effects' && !coversSingletonEffects(this.context, witness, work)) {
          return { kind: 'rejected', reason: 'unmodeled-effect' };
        }
        if (capability === 'sterile-confinement') {
          const safety: MutationSafetyContext = { checker, index: this.context.index,
            isDefaultLibraryFile: (file) => this.policyIsDefaultLibraryFile(file),
            openProgram: this.context.policy.openProperties, openProperties: this.context.policy.openProperties,
            budgetStep: () => this.step() };
          if (!isMutationCleanView(safety, { certifiedWrite: (record) => certifiesSingletonWrite(witness!, record) })) {
            return { kind: 'rejected', reason: 'mutation' };
          }
        }
        if (capability === 'exact-bag' && witness.proof.innerLiteral !== identity) return { kind: 'rejected', reason: 'allocation' };
        return { kind: 'proved', value: witness };
      }),
    };
    recipes.set(key, recipe); return recipe;
  }

  /** 열거 완료와 helper purity를 분리하고 각 실제 entry의 초기화 의무를 DAG 결과에 적용한다. */
  private helperInventory(declaration: ts.ClassLikeDeclaration): ProofRecipe<PrimitiveSummary> {
    const known = this.helperInventories.get(declaration);
    if (known !== undefined) return known;
    const entry = this.recipe(declaration, 'proof');
    let plan: PrimitivePlan = { roots: [] };
    const recipe: ProofRecipe<PrimitiveSummary> = {
      id: `${declaration.getSourceFile().fileName}:${declaration.pos}:stage4-inventory`,
      identity: declaration, capability: 'primitive-effects', mode: 'extended', valid: entry.valid,
      dependencies: (work) => {
        plan = collectPrimitivePlan(this.context, declaration, work);
        return plan.roots.map((root) => { work(); return { recipe: this.helpers.recipe(root.node), capability: 'primitive-effects', depth: 1, frames: 1 }; });
      },
      evaluate: (work, children) => {
        const summaries = new Map<object, PrimitiveSummary>();
        for (const child of children) { work(); if (child.kind === 'proved') summaries.set(child.certificate.identity, child.value as PrimitiveSummary); }
        for (const root of plan.roots) {
          work(); const summary = summaries.get(root.node);
          if (summary === undefined || root.entry !== undefined && !this.helpers.initialized(summary, root.entry, work)) {
            return { kind: 'rejected', reason: 'helper-initialization' };
          }
        }
        const summary = primitiveChildren(children, work);
        return { kind: 'proved', value: summary };
      },
    };
    this.helperInventories.set(declaration, recipe); return recipe;
  }

  /** 선택한 flow 모드의 concrete-dispatch 권한을 소비하며 repeated allocation의 ordinary union을 보존한다. */
  allowsInstanceFlow(declaration: ts.ClassLikeDeclaration): boolean {
    return this.selectsExtendedFlow(declaration) && this.hasCarrierFlowObligation(declaration)
      ? this.extendedAuthority(declaration, 'concrete-dispatch', declaration) : this.boolean(declaration, 'instance');
  }
  /** source-derived 역할은 효과나 ownership 증명으로 쓰지 않는다. */
  hasCarrierFlowObligation(declaration: ts.ClassLikeDeclaration): boolean {
    const result = this.resolve<boolean>(declaration, 'role');
    return result.kind !== 'proved' || result.value;
  }
  /** 기반 class의 역할도 자원 실패를 ordinary class로 바꾸지 않는다. */
  hasCarrierFlowLineage(declaration: ts.ClassLikeDeclaration): boolean {
    const result = this.resolve<boolean>(declaration, 'lineage');
    return result.kind !== 'proved' || result.value;
  }
  /** identity는 독립적인 constructor/storage만 검사하고 effect·isolation 권한을 부여하지 않는다. */
  allowsConstructedInstanceIdentity(declaration: ts.ClassLikeDeclaration): boolean { return this.boolean(declaration, 'identity'); }

  /** 독립 service identity로 optional fallback field의 own-data 증명을 대신하지 않는다. */
  allowsCarrierFieldFlow(declaration: ts.ClassLikeDeclaration): boolean {
    return this.selectsExtendedFlow(declaration)
      ? this.extendedAuthority(declaration, 'descriptor', declaration) : this.boolean(declaration, 'field');
  }

  /** method recovery는 관찰된 consumption과 receiver 안정성만 소비한다. */
  allowsDeclaredMethodReceiver(declaration: ts.ClassLikeDeclaration): boolean { return this.boolean(declaration, 'receiver'); }
  /** method body effect를 승인하지 않는 construction/consumption 판정이다. */
  allowsDeclaredMethodConsumption(declaration: ts.ClassLikeDeclaration): boolean { return this.boolean(declaration, 'consumption'); }
  /** stable boolean negative도 완료된 semantic 결과로만 메모한다. */
  private boolean(declaration: ts.ClassLikeDeclaration, kind: CarrierOperation): boolean {
    const result = this.resolve<boolean>(declaration, kind);
    if (result.kind === 'rejected') {
      this.context.index.proofDiagnostics?.add(`carrier-proof: rejected(${result.reason}); carrier dispatch was not certified.`);
    } else if (result.kind === 'incomplete') {
      this.context.index.proofDiagnostics?.add(`carrier-proof: incomplete(${result.reason}); carrier dispatch was not certified.`);
    }
    return result.kind === 'proved' && result.value;
  }
  /** entry는 cache hit에도 현재 source/view/manifest/policy에 대조한다. */
  private validEntry(declaration: ts.ClassLikeDeclaration): boolean {
    return this.validContext() && this.files.has(declaration.getSourceFile());
  }
  /** recipe 생성 순서와 무관하게 DAG issuer의 초기 결합을 대조한다. */
  private validContext(): boolean {
    return this.context.program === this.origin.program && this.context.checker === this.origin.checker
      && this.context.index === this.origin.index && this.context.policy === this.origin.policy
      && this.context.index.effectInventory === this.origin.inventory
      && this.context.index.effectInventory?.manifest === this.origin.manifest;
  }
  /** 서로 공유하는 AST-only obligation을 정적 recipe로 나눈다. */
  private recipe(declaration: ts.ClassLikeDeclaration, kind: CarrierOperation): ProofRecipe<unknown> {
    let byKind = this.recipes.get(declaration);
    if (byKind === undefined) { byKind = new Map(); this.recipes.set(declaration, byKind); }
    const existing = byKind.get(kind);
    if (existing !== undefined) return existing;
    const source = declaration.getSourceFile();
    const text = source.text;
    const inventory = this.context.index.effectInventory;
    const policy = this.context.policy;
    const open = policy.openProperties;
    const mutations = this.context.index.mutations;
    const mutationCount = mutations.length;
    const references = this.context.index.references;
    const referenceCount = references.size;
    const opaque = this.context.index.hasOpaqueMutation;
    const incompleteMutations = this.context.index.hasIncompleteMutations;
    const mutationComplete = this.context.index.mutationComplete;
    const project = policy.isProjectFile;
    const callable = policy.isOpenCallable;
    const intrinsic = policy.isDefaultLibraryFile;
    const program = this.context.program;
    const checker = this.context.checker;
    const recipe: ProofRecipe<unknown> = {
      id: `${source.fileName}:${declaration.pos}:${kind}`,
        capability: kind === 'construction' || kind === 'field' ? 'descriptor'
        : kind === 'identity' || kind === 'instance' || kind === 'consumption' || kind === 'receiver' ? 'concrete-dispatch' : 'legacy',
      identity: declaration,
      valid: () => this.validContext() && (this.validEntry(declaration)
        || (kind === 'role' || kind === 'lineage') && !this.files.has(source)) && source.text === text
        && this.context.program === program && this.context.checker === checker
        && (this.context.program === undefined || this.context.program.getTypeChecker() === this.context.checker)
        && this.context.index.effectInventory === inventory && this.context.policy === policy
        && policy.openProperties === open && policy.isProjectFile === project && policy.isOpenCallable === callable
        && policy.isDefaultLibraryFile === intrinsic && this.context.index.hasOpaqueMutation === opaque
        && this.context.index.hasIncompleteMutations === incompleteMutations && this.context.index.mutationComplete === mutationComplete
        && this.context.index.references === references && references.size === referenceCount
        && this.context.index.mutations === mutations && mutations.length === mutationCount,
      dependencies: (work) => this.withWork(work, () => {
        if (kind !== 'role' && kind !== 'lineage') {
          work.require(this.policyGuard('project', source), true);
          work.require(this.policyGuard('callable', declaration), false);
        } else {
          work.require(this.policyGuard('project', source), this.files.has(source));
        }
        const edge = (owner: ts.ClassLikeDeclaration, operation: CarrierOperation): ProofEdge => ({ recipe: this.recipe(owner, operation), depth: 1, frames: 0 });
        if (kind === 'role' || kind === 'construction' || kind === 'extended-selection' || kind === 'dependency-selection') return [];
        if (kind === 'proof' || kind === 'field') return [edge(declaration, 'construction')];
        if (kind === 'receiver') return [edge(declaration, 'consumption')];
        const role = edge(declaration, 'role');
        if (kind === 'lineage' || kind === 'identity') {
          const base = this.directBaseClass(declaration);
          const dependencies = base === undefined ? [role] : [role, edge(base, 'lineage')];
          if (kind === 'identity' && this.isCarrierFlowCandidate(declaration)) dependencies.push(edge(declaration, 'construction'));
          return dependencies;
        }
        const dependencies = kind === 'instance' ? [role, edge(declaration, 'lineage')] : [role];
        if (this.isCarrierFlowCandidate(declaration)) dependencies.push(edge(declaration, 'construction'));
        return dependencies;
      }),
      evaluate: (work, children) => {
        try {
          return this.withWork(work, () => {
          // dependency는 canonical id 순서로 주어진다. 결과를 id로 매핑하므로 호출 순서를 권한으로 쓰지 않는다.
          const role = children.length === 0 ? undefined : this.dependencyValue(declaration, 'role', children);
          let value: unknown;
          if (kind === 'dependency-selection') value = !declaration.members.some((member) => {
            this.step();
            return ts.isConstructorDeclaration(member) && member.parameters.some((parameter) => {
              this.step();
              return isPrivateReadonlyParameterProperty(parameter, member, () => this.step());
            });
          });
          else if (kind === 'extended-selection') value = this.selectExtendedClass(declaration);
          else if (kind === 'role') value = this.isCarrierFlowCandidate(declaration);
          else if (kind === 'construction') value = this.proveReceiverConstruction(declaration);
          else if (kind === 'field') {
            const receiver = this.dependencyValue(declaration, 'construction', children) as ConstructorReceiverProof | undefined;
            value = receiver !== undefined && receiver.constructions.every((construction) => {
              this.step();
              const literal = construction.arguments?.[0];
              return literal !== undefined && ts.isObjectLiteralExpression(skipWrappers(literal))
                && this.innerLiteralShape(skipWrappers(literal) as ts.ObjectLiteralExpression, receiver.bagShape, true);
            });
          }
          else if (kind === 'proof') {
            const proof = this.proveClass(declaration);
            value = proof !== undefined && this.cleanMutations(proof) ? proof : undefined;
          }
          else if (kind === 'lineage') value = role === true || children.some((child) => child.kind === 'proved' && child.value === true);
          else if (kind === 'identity') value = role === true ? this.dependencyValue(declaration, 'construction', children) !== undefined
            : !children.some((child) => child.kind === 'proved' && child.value === true);
          else if (kind === 'instance') value = role === true ? this.proveInstanceFlow(declaration, this.dependencyValue(declaration, 'construction', children) as ConstructorReceiverProof)
            : this.dependencyValue(declaration, 'lineage', children) === false;
          else if (kind === 'consumption') {
            const proof = role === true ? this.dependencyValue(declaration, 'construction', children) as ConstructorReceiverProof : undefined;
            value = proof !== undefined && this.scanDeclaredReceiverUses(declaration, proof.constructions);
          } else value = this.dependencyValue(declaration, 'consumption', children) === true && this.scanDeclaredMethodInstanceSafety(declaration);
          const result = value === undefined || value === false && kind !== 'role' && kind !== 'lineage' && kind !== 'extended-selection' && kind !== 'dependency-selection'
            ? { kind: 'rejected' as const, reason: 'syntax' } : { kind: 'proved' as const, value };
            return result;
          });
        } catch (error) {
          if (error instanceof CarrierIncomplete) return { kind: 'incomplete', reason: 'coverage' };
          throw error;
        }
      },
    };
    byKind.set(kind, recipe);
    return recipe;
  }
  /** recipe별 certificate identity를 함께 비교해 같은 class의 다른 권한을 혼합하지 않는다. */
  private dependencyValue(declaration: ts.ClassLikeDeclaration, kind: CarrierOperation, children: readonly ProofOutcome<unknown>[]): unknown {
    const id = this.recipe(declaration, kind).id;
    const child = children.find((result) => result.kind === 'proved' && result.certificate.nodeId === id);
    return child?.kind === 'proved' ? child.value : undefined;
  }
  /** 현재 recipe의 ordered proof work만 설치하고 예외에도 이전 문맥을 복원한다. */
  private withWork<T>(work: ProofWork, run: () => T): T {
    const previous = this.work; this.work = work;
    try { return run(); } finally { this.work = previous; }
  }
  /** policy 대상별 guard를 analyzer 안에서 intern한다. */
  private policyGuard(kind: string, target: object): ProofGuard {
    let guards = this.policyGuards.get(kind);
    if (guards === undefined) { guards = new WeakMap(); this.policyGuards.set(kind, guards); }
    const existing = guards.get(target);
    if (existing !== undefined) return existing;
    const policy = this.context.policy;
    const read = (): boolean => kind === 'source-entry'
      ? this.context.program?.getSourceFile((target as ts.SourceFile).fileName) === target
        && (target as ts.SourceFile).text === this.sourceTexts.get(target as ts.SourceFile)
      : kind === 'project'
      ? policy.isProjectFile.call(policy, target as ts.SourceFile)
      : kind === 'callable'
        ? policy.isOpenCallable.call(policy, target as ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration)
        : policy.isDefaultLibraryFile?.call(policy, target as ts.SourceFile) === true;
    const guard: ProofGuard = { read };
    guards.set(target, guard);
    return guard;
  }
  /** policy 조회는 active ordered work가 없으면 uncharged internal use로 취급한다. */
  private policyWork(): ProofWork {
    if (this.work === undefined) throw new Error('carrier policy read without active ProofWork');
    return this.work;
  }
  private policyIsProjectFile(sourceFile: ts.SourceFile): boolean {
    return this.policyWork().observe(this.policyGuard('project', sourceFile), this.walkDepth, this.walkDepth);
  }
  private policyIsOpenCallable(declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): boolean {
    return this.policyWork().observe(this.policyGuard('callable', declaration), this.walkDepth, this.walkDepth);
  }
  private policyIsDefaultLibraryFile(sourceFile: ts.SourceFile): boolean {
    return this.policyWork().observe(this.policyGuard('default-library', sourceFile), this.walkDepth, this.walkDepth);
  }
  /** static AST node는 ValueFlow를 재귀 호출하지 않는다. */
  private resolve<T>(declaration: ts.ClassLikeDeclaration, kind: CarrierOperation): ProofOutcome<T> {
    const query = this.query ?? new ProofQuery({}, this.context.caller);
    return this.resolveRecipe<T>(this.recipe(declaration, kind) as ProofRecipe<T>, query);
  }
  private resolveRecipe<T>(recipe: ProofRecipe<T>, query: ProofQuery): ProofOutcome<T> {
    const previous = this.query;
    this.query = query;
    try {
      const result = this.dag.resolve(recipe, query) as ProofOutcome<T>;
      if (result.kind === 'cycle' || result.kind === 'exhausted') {
        this.context.index.proofDiagnostics?.add(`carrier-proof: ${result.kind}; carrier proof was not completed.`);
      }
      return result;
    }
    finally { if (previous === undefined) this.query = undefined; }
  }

  /** 클래스 carrier의 모든 구조·소비·mutation 조건을 검사한다. */
  private proveClass(declaration: ts.ClassLikeDeclaration, requireOptionalOwn = true, extended = false): ConstructorCarrierProof | undefined {
    this.step();
    const decorated = (node: ts.Node): boolean => extended
      ? hasDecorators(node, () => this.step()) : hasDecorators(node);
    if (!this.policyIsProjectFile(declaration.getSourceFile()) || this.policyIsOpenCallable(declaration)) return undefined;
    if (decorated(declaration) || declaration.heritageClauses !== undefined || this.context.index.newThisClasses.has(declaration)) return undefined;
    if ((this.context.index.subclasses.get(declaration)?.length ?? 0) > 0) return undefined;
    if (!extended && isExportedDeclaration(this.context, declaration)) return undefined;

    const constructor: readonly ts.ConstructorDeclaration[] = extended
      ? (() => {
        const result: ts.ConstructorDeclaration[] = [];
        for (const member of declaration.members) {
          this.step();
          if (ts.isConstructorDeclaration(member)) result.push(member);
        }
        return result;
      })()
      : declaration.members.filter(ts.isConstructorDeclaration);
    if (constructor.length !== 1 || constructor[0]!.body === undefined) return undefined;
    const owner = constructor[0]!;
    if (decorated(owner) || hasExplicitConstructorReturn(owner, (depth) => this.work?.(depth, depth))) return undefined;
    const parameters: readonly ts.ParameterDeclaration[] = extended
      ? (() => {
        const result: ts.ParameterDeclaration[] = [];
        for (const parameter of owner.parameters) {
          this.step();
          if (!isThisParameter(parameter)) result.push(parameter);
        }
        return result;
      })()
      : owner.parameters.filter((parameter) => !isThisParameter(parameter));
    if (parameters.length !== 1) return undefined;
    const bagParameter = parameters[0]!;
    if (!isPrivateReadonlyParameterProperty(bagParameter, owner, extended ? () => this.step() : undefined)) return undefined;
    if (decorated(bagParameter) || bagParameter.questionToken !== undefined
      || !ts.isIdentifier(bagParameter.name) || bagParameter.initializer !== undefined
      || bagParameter.dotDotDotToken !== undefined || isPrototypeSensitiveSlotName(bagParameter.name.text)) return undefined;

    const bagShape = this.bagShape(bagParameter);
    if (bagShape === undefined) return undefined;
    const construction = this.singleConstruction(declaration);
    if (construction === undefined) return undefined;
    const argumentsList = construction.arguments ?? [];
    if (argumentsList.length !== 1 || ts.isSpreadElement(argumentsList[0]!)) return undefined;
    const innerLiteral = skipWrappers(argumentsList[0]!);
    if (!ts.isObjectLiteralExpression(innerLiteral)
      || !this.innerLiteralShape(innerLiteral, bagShape, requireOptionalOwn)) return undefined;

    const fields = this.instanceFields(declaration, bagParameter, extended);
    if (fields === undefined) return undefined;
    const allowedMutationSites = new Set<ts.Node>();
    const serviceUses: ConstructorServiceUse[] = [];
    const audit = this.scanConstructor(owner, bagParameter, bagShape, fields, allowedMutationSites);
    if (audit === undefined) return undefined;
    for (const member of declaration.members) {
      this.step();
      if (!ts.isMethodDeclaration(member)) continue;
      if (decorated(member) || member.body === undefined || hasStaticModifier(member, extended ? () => this.step() : undefined)) return undefined;
      if (!this.scanMethod(member, bagParameter, bagShape, fields, audit.dateFieldName, serviceUses, extended)) return undefined;
    }
    if (serviceUses.length === 0) return undefined;
    const projectionBindings: ConstructorProjectionBinding[] = [];
    if (!this.scanInstanceUses(declaration, construction, projectionBindings)) return undefined;
    return {
      declaration,
      constructor: owner,
      bagParameter,
      bagKeys: bagShape.keys,
      innerLiteral,
      serviceUses,
      projectionBindings,
      allowedMutationSites,
    };
  }

  /**
   * 일반 DI 클래스와 carrier를 구분하는 bounded 역할 판정이다. private readonly parameter property가 있는
   * constructor에서 direct genuine Date factory를 nullish fallback으로 선택하면, alias/storage proof와 무관하게
   * Stage 0 obligation에 들어간다. 명백한 nullish literal source는 bag-derived일 수 없어 제외한다.
   */
  private isCarrierFlowCandidate(declaration: ts.ClassLikeDeclaration): boolean {
    this.step();
    if (!this.policyIsProjectFile(declaration.getSourceFile())) return false;
    const constructors = declaration.members.filter(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (constructors.length !== 1) return false;
    const owner = constructors[0]!;
    const bagParameters = owner.parameters.filter((parameter) => !isThisParameter(parameter)
      && isPrivateReadonlyParameterProperty(parameter, owner) && ts.isIdentifier(parameter.name));
    if (bagParameters.length === 0) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      this.step();
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && !this.isDefinitelyIndependentFallbackSource(node.left) && this.isDirectDateFactory(node.right)) {
        found = true;
        return;
      }
      if (node !== owner.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      this.visitChildren(node, visit);
    };
    visit(owner.body!);
    return found;
  }

  /** literal/global nullish source는 private parameter bag에서 유래할 수 없으므로 역할 판정에서 제외한다. */
  private isDefinitelyIndependentFallbackSource(expression: ts.Expression): boolean {
    const inner = skipWrappers(expression);
    return inner.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(inner)
      || isGlobalUndefined(this.context, inner, (source) => this.policyIsDefaultLibraryFile(source));
  }

  /** nested callable을 제외한 direct return들이 모두 genuine intrinsic `new Date()`인지 본다. */
  private isDirectDateFactory(expression: ts.Expression): boolean {
    const factory = skipWrappers(expression);
    if ((!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))
      || factory.asteriskToken !== undefined || hasAsyncModifier(factory)) return false;
    if (!ts.isBlock(factory.body)) return this.isIntrinsicDateConstruction(factory.body);
    let returns = 0;
    let valid = true;
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (ts.isReturnStatement(node)) {
        returns++;
        if (node.expression === undefined || !this.isIntrinsicDateConstruction(node.expression)) valid = false;
        return;
      }
      if (node !== factory.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      this.visitChildren(node, visit);
    };
    visit(factory.body);
    return valid && returns > 0;
  }

  /** default-library Date constructor를 직접 zero-argument로 호출하는 식인지 확인한다. */
  private isIntrinsicDateConstruction(expression: ts.Expression): boolean {
    const value = skipWrappers(expression);
    if (!ts.isNewExpression(value) || (value.arguments ?? []).length !== 0) return false;
    const callee = skipWrappers(value.expression);
    if (!ts.isIdentifier(callee) || callee.text !== 'Date' || this.context.policy.isDefaultLibraryFile === undefined) return false;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(callee));
    const declarations = symbol?.declarations ?? [];
    return declarations.length > 0
      && declarations.every((declaration) => this.policyIsDefaultLibraryFile(declaration.getSourceFile()));
  }

  /**
   * carrier 역할의 method-instance flow에 필요한 Stage 0 경계만 검사한다. 여러 construction의 평범한 target
   * union은 유지하며 singleton·export·unknown-reflection isolation 자격은 기존 full proof 소비자에게 맡긴다.
   */
  private proveInstanceFlow(declaration: ts.ClassLikeDeclaration, receiver: ConstructorReceiverProof | undefined): boolean {
    if (receiver === undefined) return false;
    const { bagParameter, bagShape, fields, audit, constructions } = receiver;
    const serviceUses: ConstructorServiceUse[] = [];
    for (const member of declaration.members) {
      this.step();
      if (!ts.isMethodDeclaration(member)) continue;
      if (hasDecorators(member) || member.body === undefined || hasStaticModifier(member)
        || !this.scanMethod(member, bagParameter, bagShape, fields, audit.dateFieldName, serviceUses)) return false;
    }
    if (serviceUses.length === 0) return false;
    for (const construction of constructions) {
      if (!this.scanInstanceUses(declaration, construction, [])) return false;
    }
    return true;
  }

  /** method grammar와 분리한 exact receiver construction/storage certificate다. */
  private proveReceiverConstruction(declaration: ts.ClassLikeDeclaration): ConstructorReceiverProof | undefined {
    if (hasDecorators(declaration) || declaration.heritageClauses !== undefined || this.context.index.newThisClasses.has(declaration)) return undefined;
    const constructors = declaration.members.filter(ts.isConstructorDeclaration);
    if (constructors.length !== 1 || constructors[0]!.body === undefined) return undefined;
    const owner = constructors[0]!;
    if (hasDecorators(owner) || hasExplicitConstructorReturn(owner, (depth) => this.work?.(depth, depth))) return undefined;
    const parameters = owner.parameters.filter((parameter) => !isThisParameter(parameter));
    if (parameters.length !== 1) return undefined;
    const bagParameter = parameters[0]!;
    if (!isPrivateReadonlyParameterProperty(bagParameter, owner) || hasDecorators(bagParameter)
      || bagParameter.questionToken !== undefined || !ts.isIdentifier(bagParameter.name)
      || bagParameter.initializer !== undefined || bagParameter.dotDotDotToken !== undefined
      || isPrototypeSensitiveSlotName(bagParameter.name.text)) return undefined;
    const bagShape = this.bagShape(bagParameter);
    if (bagShape === undefined) return undefined;
    const constructions = this.constructions(declaration);
    if (constructions === undefined || constructions.length === 0) return undefined;
    for (const construction of constructions) {
      this.step();
      const argumentsList = construction.arguments ?? [];
      if (argumentsList.length !== 1 || ts.isSpreadElement(argumentsList[0]!)) return undefined;
      const innerLiteral = skipWrappers(argumentsList[0]!);
      if (!ts.isObjectLiteralExpression(innerLiteral) || !this.innerLiteralShape(innerLiteral, bagShape, false)) return undefined;
    }
    const fields = this.instanceFields(declaration, bagParameter, true);
    if (fields === undefined) return undefined;
    const audit = this.scanConstructor(owner, bagParameter, bagShape, fields, new Set<ts.Node>());
    if (audit === undefined) return undefined;
    return { bagParameter, bagShape, fields, audit, constructions };
  }

  /** declared-method recovery는 inert 인자의 direct method call 외 instance 소비를 허용하지 않는다. */
  private scanDeclaredReceiverUses(
    declaration: ts.ClassLikeDeclaration,
    constructions: readonly ts.NewExpression[],
  ): boolean {
    for (const construction of constructions) {
      const outer = climbWrappers(construction);
      const parent = outer.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        if (!this.directDeclaredMethodCall(parent.parent, declaration)) return false;
        continue;
      }
      if (ts.isPropertyAssignment(parent) && parent.initializer === outer && ts.isObjectLiteralExpression(parent.parent)) {
        if (!this.scanDeclaredOuterHolder(parent.parent, parent, declaration)) return false;
        continue;
      }
      if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return false;
      const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(parent.name));
      if (symbol === undefined || this.context.index.exportedSymbols.has(symbol) || hasExportedVariableStatement(parent)) return false;
      for (const reference of this.context.index.references.get(symbol) ?? []) {
        this.step();
        const site = climbWrappers(referenceSite(reference));
        const access = site.parent;
        const call = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
          && access.expression === site ? access.parent : undefined;
        if (call === undefined || !ts.isCallExpression(call) || call.expression !== access
          || !this.directDeclaredMethodCall(call, declaration)) return false;
      }
    }
    return true;
  }

  /** one-level const object holder의 exact static projection method call만 instance 소비로 허용한다. */
  private scanDeclaredOuterHolder(
    literal: ts.ObjectLiteralExpression,
    property: ts.PropertyAssignment,
    declaration: ts.ClassLikeDeclaration,
  ): boolean {
    const keys = literal.properties.map((candidate) => candidate.name === undefined ? undefined : staticPropertyName(candidate.name));
    const key = staticPropertyName(property.name);
    if (literal.properties.length !== 1 || key === undefined || keys.some((candidate) => candidate === undefined)
      || new Set(keys).size !== keys.length || keys.filter((candidate) => candidate === key).length !== 1) return false;
    const variable = literal.parent;
    if (!ts.isVariableDeclaration(variable) || variable.initializer !== literal || !ts.isIdentifier(variable.name)
      || (ts.getCombinedNodeFlags(variable) & ts.NodeFlags.Const) === 0 || hasExportedVariableStatement(variable)) return false;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(variable.name));
    if (symbol === undefined || this.context.index.exportedSymbols.has(symbol)) return false;
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      this.step();
      const holder = climbWrappers(referenceSite(reference));
      const projection = holder.parent;
      const projectedKey = ts.isPropertyAccessExpression(projection) && projection.expression === holder
        ? projection.name.text
        : ts.isElementAccessExpression(projection) && projection.expression === holder
          && ts.isStringLiteralLike(projection.argumentExpression) ? projection.argumentExpression.text : undefined;
      if (projectedKey !== key) return false;
      const access = projection.parent;
      const call = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
        && access.expression === projection ? access.parent : undefined;
      if (call === undefined || !ts.isCallExpression(call) || call.expression !== access
        || !this.directDeclaredMethodCall(call, declaration)) return false;
    }
    return true;
  }

  /** instance의 known class method를 inert argument로 직접 부르는 자리인지 본다. */
  private directDeclaredMethodCall(call: ts.CallExpression, declaration: ts.ClassLikeDeclaration): boolean {
    if (call.questionDotToken !== undefined || call.arguments.some((argument) => ts.isSpreadElement(argument)
      || !isInertDeclaredMethodArgument(argument))) return false;
    const callee = skipWrappers(call.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      return callee.questionDotToken === undefined && this.knownClassMethod(declaration, callee.name.text);
    }
    return ts.isElementAccessExpression(callee) && callee.questionDotToken === undefined
      && ts.isStringLiteralLike(callee.argumentExpression)
      && this.knownClassMethod(declaration, callee.argumentExpression.text);
  }

  /**
   * narrower declared-method capability에서는 모든 instance method의 `this`가 inert direct same-class method
   * receiver로만 쓰여야 한다. `this` escape/field access/unknown argument는 막되, this를 받지 않는 post-call
   * effect는 현재 method target을 바꾸지 않으므로 일반 effect engine처럼 추적하지 않는다.
   */
  private scanDeclaredMethodInstanceSafety(declaration: ts.ClassLikeDeclaration): boolean {
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member) || hasStaticModifier(member)) continue;
      if (member.body === undefined || hasDecorators(member)
        || member.parameters.filter((parameter) => !isThisParameter(parameter)).some((parameter) =>
          !isRequiredIdentifierParameter(parameter))) return false;
      let valid = true;
      const visit = (node: ts.Node): void => {
        if (!valid) return;
        this.step();
        if (node !== member.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
          valid = false;
          return;
        }
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
          const receiver = climbWrappers(node);
          const access = receiver.parent;
          const call = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
            && access.expression === receiver ? access.parent : undefined;
          if (call === undefined || !ts.isCallExpression(call) || call.expression !== access
            || !this.directDeclaredMethodCall(call, declaration)) valid = false;
          return;
        }
        if (ts.isIdentifier(node) && node.text === 'arguments'
          && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
          valid = false;
          return;
        }
        this.visitChildren(node, visit);
      };
      visit(member.body);
      if (!valid) return false;
    }
    return true;
  }

  /** extends 절의 direct project class를 한 단계 푼다. */
  private directBaseClass(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
    const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (base === undefined) return undefined;
    const expression = skipWrappers(base);
    if (ts.isClassExpression(expression)) return expression;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(expression));
    return symbol?.declarations?.find(ts.isClassLike);
  }

  /** 유일한 생성자 호출 참조를 찾는다. 클래스 값은 정확히 한 `new`에서만 쓰여야 한다. */
  private singleConstruction(declaration: ts.ClassLikeDeclaration): ts.NewExpression | undefined {
    const sites = this.constructions(declaration);
    return sites?.length === 1 ? sites[0] : undefined;
  }

  /** class value의 모든 직접 construction을 수집한다. 다른 runtime value use가 섞이면 증명하지 않는다. */
  private constructions(declaration: ts.ClassLikeDeclaration): readonly ts.NewExpression[] | undefined {
    const symbol = classSymbol(this.context.checker, declaration);
    if (symbol === undefined) return undefined;
    const sites: ts.NewExpression[] = [];
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      this.step();
      const site = climbWrappers(referenceSite(reference));
      const parent = site.parent;
      if (!ts.isNewExpression(parent) || parent.expression !== site) return undefined;
      sites.push(parent);
    }
    return sites;
  }

  /** parameter-property bag 타입이 same-project simple own-data interface/type literal인지 읽는다. */
  private bagShape(parameter: ts.ParameterDeclaration): BagShape | undefined {
    const typeNode = parameter.type === undefined ? undefined : skipTypeWrappers(parameter.type);
    if (typeNode === undefined) return undefined;
    const members = this.bagMembers(typeNode, new Set<ts.Node>());
    if (members === undefined || members.length === 0) return undefined;
    const keys = new Set<string>();
    const optional = new Set<string>();
    for (const member of members) {
      this.step();
      if (!ts.isPropertySignature(member) || member.type === undefined || hasDecorators(member)) return undefined;
      const key = staticPropertyName(member.name);
      if (key === undefined || key === '__proto__' || key === 'then' || keys.has(key)) return undefined;
      if (member.questionToken !== undefined && !isDateFactoryType(this.context, member.type,
        (source) => this.policyIsDefaultLibraryFile(source))) return undefined;
      keys.add(key);
      if (member.questionToken !== undefined) optional.add(key);
    }
    if (optional.size > 1) return undefined;
    return { keys, optional, members, optionalDateKey: [...optional][0] };
  }

  /** type literal 또는 interface/type alias를 한 단계씩 펼친다. */
  private bagMembers(typeNode: ts.TypeNode, seen: Set<ts.Node>): readonly ts.TypeElement[] | undefined {
    if (seen.has(typeNode)) return undefined;
    seen.add(typeNode);
    if (ts.isTypeLiteralNode(typeNode)) return [...typeNode.members];
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName) || (typeNode.typeArguments?.length ?? 0) !== 0) return undefined;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(typeNode.typeName));
    const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined;
    if (declaration === undefined || !this.policyIsProjectFile(declaration.getSourceFile())) return undefined;
    if (ts.isInterfaceDeclaration(declaration)) {
      if (declaration.heritageClauses !== undefined) return undefined;
      return [...declaration.members];
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return this.bagMembers(skipTypeWrappers(declaration.type), seen);
    }
    return undefined;
  }

  /** 생성자 인자의 inner object literal이 bag own-data projection과 일치하는지 확인한다. */
  private innerLiteralShape(literal: ts.ObjectLiteralExpression, shape: BagShape, requireOptionalOwn: boolean): boolean {
    const seen = new Set<string>();
    for (const property of literal.properties) {
      this.step();
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
      if (property.name === undefined || ts.isComputedPropertyName(property.name)) return false;
      const key = staticPropertyName(property.name);
      if (key === undefined || !shape.keys.has(key) || seen.has(key)) return false;
      seen.add(key);
      if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer !== undefined) return false;
      if (key === shape.optionalDateKey && !this.isInertOrPureDateProperty(property)) return false;
    }
    // optional projection도 prototype fallback 없이 정확한 own-data witness를 가져야 한다.
    for (const key of shape.keys) {
      if (!seen.has(key) && (requireOptionalOwn || !shape.optional.has(key))) return false;
    }
    return true;
  }

  /** optional Date factory 공급값은 inert 값 또는 exact pure intrinsic arrow만 허용한다. */
  private isInertOrPureDateProperty(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
    if (!ts.isPropertyAssignment(property)) return false;
    const value = skipWrappers(property.initializer);
    return value.kind === ts.SyntaxKind.NullKeyword
      || isGlobalUndefined(this.context, value, (source) => this.policyIsDefaultLibraryFile(source))
      || this.isPureDefaultDate(value);
  }

  /** instance field와 parameter-property의 허용된 정적 이름을 수집한다. */
  private instanceFields(
    declaration: ts.ClassLikeDeclaration,
    bagParameter: ts.ParameterDeclaration,
    extended = false,
  ): ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration> | undefined {
    const fields = new Map<string, ts.PropertyDeclaration | ts.ParameterDeclaration>();
    if (!ts.isIdentifier(bagParameter.name) || isPrototypeSensitiveSlotName(bagParameter.name.text)) return undefined;
    const slots = new Set<string>([bagParameter.name.text]);
    fields.set(bagParameter.name.text, bagParameter);
    for (const member of declaration.members) {
      this.step();
      if (ts.isConstructorDeclaration(member)) continue;
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isAccessor(member)
        || ts.isAutoAccessorPropertyDeclaration(member) || ts.isClassStaticBlockDeclaration(member)) return undefined;
      if (ts.isMethodDeclaration(member)) {
        const key = staticPropertyName(member.name);
        if (key === undefined || isPrototypeSensitiveSlotName(key)
          || hasDecorators(member, extended ? () => this.step() : undefined) || slots.has(key)) return undefined;
        slots.add(key);
        continue;
      }
      if (!ts.isPropertyDeclaration(member)
        || hasDecorators(member, extended ? () => this.step() : undefined)
        || hasStaticModifier(member, extended ? () => this.step() : undefined)) return undefined;
      const key = staticPropertyName(member.name);
      if (key === undefined || isPrototypeSensitiveSlotName(key) || slots.has(key)) return undefined;
      if (member.initializer !== undefined) return undefined;
      if (!extended && !(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) return undefined;
      slots.add(key);
      fields.set(key, member);
    }
    return fields;
  }

  /** 생성자 안에서는 audited own-field assignment와 bag projection만 허용한다. */
  private scanConstructor(
    declaration: ts.ConstructorDeclaration,
    bagParameter: ts.ParameterDeclaration,
    bagShape: BagShape,
    fields: ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration>,
    allowedSites: Set<ts.Node>,
  ): ConstructorAudit | undefined {
    const assigned = new Set<string>();
    let dateFieldName: string | undefined;
    for (const statement of declaration.body!.statements) {
      this.step();
      if (!ts.isExpressionStatement(statement)) return undefined;
      const expression = skipWrappers(statement.expression);
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
      const left = skipWrappers(expression.left);
      const field = thisField(left);
      if (field === undefined || !fields.has(field) || field === bagParameter.name.getText() || assigned.has(field)) return undefined;
      if (!this.isAuditedInitializer(expression.right, bagParameter, bagShape)) return undefined;
      const fallbackKey = this.dateFallbackProjection(expression.right, bagParameter, bagShape);
      if (fallbackKey !== undefined) {
        if (dateFieldName !== undefined) return undefined;
        dateFieldName = field;
      }
      assigned.add(field);
      allowedSites.add(expression);
    }
    for (const [key, field] of fields) {
      if (field === bagParameter) continue;
      if (ts.isPropertyDeclaration(field) && field.initializer === undefined && !assigned.has(key)) return undefined;
    }
    return { dateFieldName };
  }

  /** instance method가 bag projection과 known method 호출만 수행하는지 확인한다. */
  private scanMethod(
    method: ts.MethodDeclaration,
    bagParameter: ts.ParameterDeclaration,
    bagShape: BagShape,
    fields: ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration>,
    dateFieldName: string | undefined,
    serviceUses: ConstructorServiceUse[],
    primitiveHelpers = false,
  ): boolean {
    if (!this.isSynchronousZeroRuntimeParameterMethod(method)) return false;
    if (method.body === undefined) return false;
    for (const statement of method.body.statements) {
      this.step();
      if (primitiveHelpers && ts.isVariableStatement(statement)) {
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        for (const binding of statement.declarationList.declarations) {
          this.step();
          if (!ts.isIdentifier(binding.name) || binding.initializer === undefined) return false;
        }
        continue;
      }
      if (ts.isExpressionStatement(statement)) {
        const expression = parenthesizedCall(statement.expression);
        if (primitiveHelpers && expression !== undefined && ts.isIdentifier(skipWrappers(expression.expression))) continue;
        if (expression === undefined
          || !this.scanCall(expression, bagParameter, bagShape, fields, dateFieldName, serviceUses)) return false;
        continue;
      }
      if (ts.isReturnStatement(statement)) {
        if (statement.expression === undefined) continue;
        const value = skipWrappers(statement.expression);
        if (primitiveHelpers && (primitiveLiteral(value) || ts.isIdentifier(value)
          || ts.isCallExpression(value) && ts.isIdentifier(skipWrappers(value.expression)))) continue;
        const expression = parenthesizedCall(statement.expression);
        if (expression === undefined
          || !this.scanCall(expression, bagParameter, bagShape, fields, dateFieldName, serviceUses)) return false;
        continue;
      }
      return false;
    }
    return true;
  }

  /** call receiver를 분류해 service method 또는 audited Date fallback field 호출만 허용한다. */
  private scanCall(
    call: ts.CallExpression,
    bagParameter: ts.ParameterDeclaration,
    bagShape: BagShape,
    fields: ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration>,
    dateFieldName: string | undefined,
    serviceUses: ConstructorServiceUse[],
  ): boolean {
    if (!isDirectCarrierCall(call)) return false;
    const callee = skipWrappers(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || ts.isPrivateIdentifier(callee.name)
      || callee.questionDotToken !== undefined || call.questionDotToken !== undefined) return false;
    const methodName = callee.name.text;
    if (methodName === 'call' || methodName === 'apply' || methodName === 'bind') return false;
    const receiver = skipWrappers(callee.expression);
    const projection = this.projection(receiver, bagParameter, bagShape);
    if (projection !== undefined) {
      if (call.arguments.length !== 0 || !this.knownMethod(receiver, methodName)) return false;
      serviceUses.push({ propertyName: projection, methodName, call });
      return true;
    }
    const field = thisField(callee);
    if (field === undefined || field !== dateFieldName || !fields.has(field) || call.arguments.length !== 0) return false;
    return true;
  }

  /** bag read가 static one-level own projection인지 확인한다. */
  private scanRead(
    node: ts.Node,
    bagParameter: ts.ParameterDeclaration,
    bagShape: BagShape,
    fields: ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration>,
    dateFieldName: string | undefined,
    serviceUses: ConstructorServiceUse[] | undefined,
  ): boolean {
    if (node.kind === ts.SyntaxKind.ThisKeyword) return false;
    if (ts.isElementAccessExpression(node)) return false;
    if (!ts.isPropertyAccessExpression(node) || ts.isPrivateIdentifier(node.name)) return false;
    const expression = skipWrappers(node.expression);
    const name = node.name.text;
    const projection = this.projection(node, bagParameter, bagShape);
    if (projection !== undefined) {
      const parent = node.parent;
      if (serviceUses !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return true;
      // optional Date projection reads are only valid as audited initializer inputs; arbitrary bag values escape.
      return bagShape.optionalDateKey === name && (ts.isBinaryExpression(parent) || ts.isPropertyAccessExpression(parent));
    }
    const field = thisField(node);
    if (field !== undefined && fields.has(field)) {
      const parent = node.parent;
      return ts.isCallExpression(parent) && parent.expression === node && field === dateFieldName;
    }
    if (thisField(expression) !== undefined) return false;
    return false;
  }

  /** parameter-property bag 또는 `this.<bag>.key`의 static projection key를 돌려준다. */
  private projection(expression: ts.Expression, parameter: ts.ParameterDeclaration, shape: BagShape): string | undefined {
    const inner = skipWrappers(expression);
    if (!ts.isPropertyAccessExpression(inner) || ts.isPrivateIdentifier(inner.name)) return undefined;
    const owner = skipWrappers(inner.expression);
    const isParameter = ts.isIdentifier(owner) && this.isBagParameterReference(owner, parameter);
    const isThisParameterProperty = thisField(owner) === parameter.name.getText();
    if (!isParameter && !isThisParameterProperty) return undefined;
    const key = inner.name.text;
    return shape.keys.has(key) ? key : undefined;
  }

  /** parameter-property의 local value symbol과 property symbol을 함께 인정한다. */
  private isBagParameterReference(identifier: ts.Identifier, parameter: ts.ParameterDeclaration): boolean {
    const symbol = this.context.checker.getSymbolAtLocation(identifier);
    const parameterSymbol = this.context.checker.getSymbolAtLocation(parameter.name);
    return symbol === parameterSymbol || (symbol?.declarations ?? []).includes(parameter);
  }

  /** checker가 receiver 타입의 정적 method를 알고 있는지 확인한다. */
  private knownMethod(receiver: ts.Expression, method: string): boolean {
    const type = this.context.checker.getTypeAtLocation(receiver);
    const property = this.context.checker.getPropertyOfType(type, method);
    if (property === undefined) return false;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return declaration !== undefined && !isAmbient(declaration);
  }

  /** audited constructor initializer: closed bag projection 또는 exact Date fallback이다. */
  private isAuditedInitializer(expression: ts.Expression, parameter: ts.ParameterDeclaration, shape: BagShape): boolean {
    const inner = skipWrappers(expression);
    if (this.isPureDefaultDate(inner)) return true;
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return this.projection(inner.left, parameter, shape) === shape.optionalDateKey
        && shape.optionalDateKey !== undefined && this.isPureDefaultDate(inner.right);
    }
    return this.isBagProjection(inner, parameter, shape);
  }

  /** exact optional Date projection이 fallback의 왼쪽에 있는지 확인한다. */
  private dateFallbackProjection(expression: ts.Expression, parameter: ts.ParameterDeclaration, shape: BagShape): string | undefined {
    const inner = skipWrappers(expression);
    if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return undefined;
    const key = this.projection(inner.left, parameter, shape);
    return key === shape.optionalDateKey && shape.optionalDateKey !== undefined && this.isPureDefaultDate(inner.right) ? key : undefined;
  }

  /** projection 식이 parameter-property bag의 static own key인지 확인한다. */
  private isBagProjection(expression: ts.Expression, parameter: ts.ParameterDeclaration, shape: BagShape): boolean {
    return this.projection(expression, parameter, shape) !== undefined;
  }

  /** `() => new Date()`의 genuine default-library intrinsic whitelist다. */
  private isPureDefaultDate(expression: ts.Expression): boolean {
    const inner = skipWrappers(expression);
    if (!ts.isArrowFunction(inner) || inner.parameters.length !== 0 || hasAsyncModifier(inner)
      || inner.body === undefined || ts.isBlock(inner.body)) return false;
    const value = skipWrappers(inner.body);
    if (!ts.isNewExpression(value) || (value.arguments ?? []).length !== 0) return false;
    const callee = skipWrappers(value.expression);
    if (!ts.isIdentifier(callee) || callee.text !== 'Date') return false;
    const symbol = this.context.checker.getSymbolAtLocation(callee);
    if (symbol === undefined || this.context.policy.isDefaultLibraryFile === undefined) return false;
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.context.checker.getAliasedSymbol(symbol) : symbol;
    const declarations = target.declarations ?? [];
    return declarations.length > 0 && declarations.every((declaration) => this.policyIsDefaultLibraryFile(declaration.getSourceFile()))
      && (this.context.index.identifierWrites.get(dealias(this.context.checker, symbol)!)?.length ?? 0) === 0;
  }

  /** 생성 결과가 direct known method call 또는 닫힌 inline callback으로만 소비되는지 본다. */
  private scanInstanceUses(
    declaration: ts.ClassLikeDeclaration,
    construction: ts.NewExpression,
    projectionBindings: ConstructorProjectionBinding[],
  ): boolean {
    const outer = climbWrappers(construction);
    const parent = outer.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer && ts.isCallExpression(parent.parent)
      && parent.parent.expression === parent && parent.parent.arguments.length === 0
      && parent.questionDotToken === undefined && parent.parent.questionDotToken === undefined
      && this.knownClassMethod(declaration, parent.name.text)) return true;
    if (ts.isPropertyAssignment(parent) && parent.initializer === outer && ts.isObjectLiteralExpression(parent.parent)) {
      return this.scanOuterMemo(parent.parent, parent, declaration, projectionBindings);
    }
    if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return false;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(parent.name));
    if (symbol === undefined || this.context.index.exportedSymbols.has(symbol) || hasExportedVariableStatement(parent)) return false;
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      this.step();
      const site = climbWrappers(referenceSite(reference));
      if (this.directInstanceMethodUse(site, declaration)) continue;
      if (this.inlineWrapperUse(site, declaration)) continue;
      return false;
    }
    return true;
  }

  /** outer object literal이 private module memo에서 projection으로만 소비되는지 확인한다. */
  private scanOuterMemo(
    literal: ts.ObjectLiteralExpression,
    property: ts.PropertyAssignment,
    declaration: ts.ClassLikeDeclaration,
    bindings: ConstructorProjectionBinding[],
  ): boolean {
    if (literal.properties.some((candidate) => !ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate))) return false;
    if (literal.properties.some((candidate) => candidate.name === undefined || ts.isComputedPropertyName(candidate.name))) return false;
    const key = staticPropertyName(property.name);
    if (key === undefined || literal.properties.filter((candidate) => staticPropertyName(candidate.name) === key).length !== 1) return false;
    const memo = this.memoForLiteral(literal);
    if (memo === undefined) return false;
    if (!this.memoWritesSafe(memo, literal)) return false;
    let factoryCount = 0;
    for (const reference of this.context.index.references.get(memo) ?? []) {
      this.step();
      const site = referenceSite(reference);
      if (this.isMemoGuard(reference, site)) continue;
      const factory = this.memoReturnFactory(reference, site);
      if (factory === undefined || !this.scanFactory(factory, key, declaration, bindings)) return false;
      factoryCount++;
    }
    return factoryCount > 0;
  }

  /** memo slot은 audited literal과 null/undefined reset만 받을 수 있다. */
  private memoWritesSafe(symbol: ts.Symbol, literal: ts.ObjectLiteralExpression): boolean {
    for (const value of this.context.index.identifierWrites.get(symbol) ?? []) {
      this.step();
      if (value === undefined) return false;
      const rhs = skipWrappers(value);
      if (rhs === literal || rhs.kind === ts.SyntaxKind.NullKeyword
        || isGlobalUndefined(this.context, rhs, (source) => this.policyIsDefaultLibraryFile(source))) continue;
      return false;
    }
    return true;
  }

  /** discarded `memo = { ... }`의 top-level private let 심볼을 찾는다. */
  private memoForLiteral(literal: ts.ObjectLiteralExpression): ts.Symbol | undefined {
    const outer = climbWrappers(literal);
    const assignment = outer.parent;
    if (!ts.isBinaryExpression(assignment) || assignment.right !== outer
      || (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken && assignment.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken)
      || !ts.isIdentifier(assignment.left)) return undefined;
    const statement = climbWrappers(assignment).parent;
    if (!ts.isExpressionStatement(statement) || statement.expression !== assignment) return undefined;
    const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(assignment.left));
    if (symbol === undefined || this.context.index.exportedSymbols.has(symbol)) return undefined;
    const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
      || declaration.getSourceFile() !== literal.getSourceFile() || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Let) === 0 || declaration.parent.parent.parent !== declaration.getSourceFile()
      || hasExportedVariableStatement(declaration)) return undefined;
    const initializer = declaration.initializer === undefined ? undefined : skipWrappers(declaration.initializer);
    if (initializer !== undefined && initializer.kind !== ts.SyntaxKind.NullKeyword
      && !isGlobalUndefined(this.context, initializer, (source) => this.policyIsDefaultLibraryFile(source))) return undefined;
    return symbol;
  }

  /** memo direct read가 narrow guard인지 본다. */
  private isMemoGuard(reference: ts.Node, site: ts.Node): boolean {
    if (!ts.isIdentifier(reference)) return false;
    const expression = skipWrappers(site as ts.Expression);
    const parent = expression.parent;
    if (ts.isIfStatement(parent) && parent.expression === expression) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === expression) return true;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      const condition = parent.parent;
      return (ts.isIfStatement(condition) && condition.expression === parent)
        || (ts.isConditionalExpression(condition) && condition.condition === parent);
    }
    return ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      && (parent.left === expression || parent.right === expression)
      && isNullOrUndefinedExpression(parent.left === expression ? parent.right : parent.left, this.context,
        (source) => this.policyIsDefaultLibraryFile(source))
      && isConditionExpression(parent);
  }

  /** memo 식별자가 직접 return되는 stable named factory를 찾는다. */
  private memoReturnFactory(reference: ts.Node, site: ts.Node): ts.FunctionDeclaration | undefined {
    if (!ts.isIdentifier(reference) || !ts.isReturnStatement(site.parent) || site.parent.expression !== reference) return undefined;
    let current: ts.Node | undefined = site.parent.parent;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current)) {
        if (!ts.isFunctionDeclaration(current) || current.name === undefined || current.body === undefined
          || current.asteriskToken !== undefined || hasAsyncModifier(current) || hasDecorators(current)
          || !ts.isSourceFile(current.parent)
          || !this.isZeroRuntimeParameterFunction(current)) return undefined;
        const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(current.name));
        return symbol !== undefined && this.stableWrapper(symbol) === current ? current : undefined;
      }
      current = current.parent;
    }
    return undefined;
  }

  /** factory 모든 호출 결과가 같은 one-level object binding으로만 소비되는지 확인한다. */
  private scanFactory(
    factory: ts.FunctionDeclaration,
    key: string,
    declaration: ts.ClassLikeDeclaration,
    bindings: ConstructorProjectionBinding[],
  ): boolean {
    const symbol = factory.name === undefined ? undefined : dealias(this.context.checker, this.context.checker.getSymbolAtLocation(factory.name));
    if (symbol === undefined || (this.context.index.identifierWrites.get(symbol)?.length ?? 0) > 0) return false;
    const references = this.context.index.references.get(symbol) ?? [];
    if (references.length === 0) return false;
    for (const reference of references) {
      this.step();
      const site = climbWrappers(referenceSite(reference));
      const call = ts.isCallExpression(site) && site.expression === reference ? site
        : ts.isCallExpression(site.parent) && site.parent.expression === site ? site.parent : undefined;
      if (call !== undefined) {
        if (call.questionDotToken !== undefined || call.arguments.some(ts.isSpreadElement) || call.arguments.length !== 0) return false;
        const projected = this.objectBindingsForCall(call, key);
        if (projected === undefined) return false;
        for (const binding of projected) {
          if (!this.scanBindingUses(binding, declaration)) return false;
          bindings.push({ key, source: binding.element, bindingElement: binding.element, symbol: binding.symbol, factory, invocation: call });
        }
        continue;
      }
      if (!ts.isIdentifier(site) || !ts.isCallExpression(site.parent)
        || !this.scanFactoryArgumentUse(site.parent, factory, key, declaration, bindings)) return false;
    }
    return true;
  }

  /** factory가 one-level closed wrapper의 정확한 인자로 전달되는 소비를 확인한다. */
  private scanFactoryArgumentUse(
    call: ts.CallExpression,
    factory: ts.FunctionDeclaration,
    key: string,
    declaration: ts.ClassLikeDeclaration,
    bindings: ConstructorProjectionBinding[],
  ): boolean {
    const callee = skipWrappers(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const wrapperSymbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(callee));
    const wrapper = wrapperSymbol === undefined ? undefined : this.stableWrapper(wrapperSymbol);
    if (wrapper === undefined || !this.validWrapperCall(wrapper, call)) return false;
    const factorySymbol = factory.name === undefined ? undefined : this.context.checker.getSymbolAtLocation(factory.name);
    const factoryArguments = call.arguments.filter((argument) => ts.isIdentifier(argument)
      && factorySymbol !== undefined && this.context.checker.getSymbolAtLocation(argument) === factorySymbol);
    if (factoryArguments.length !== 1 || call.arguments.some(ts.isSpreadElement)) return false;
    const argumentPosition = call.arguments.indexOf(factoryArguments[0]!);
    const parameter = wrapper.parameters.filter((candidate) => !isThisParameter(candidate))[argumentPosition];
    if (parameter === undefined || !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined
      || parameter.dotDotDotToken !== undefined) return false;
    const callbacks = call.arguments.map((argument) => skipWrappers(argument))
      .filter((value): value is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(value) || ts.isFunctionExpression(value));
    if (callbacks.length !== 1) return false;
    const callback = callbacks[0]!;
    if (callback.name !== undefined || !this.validInlineCallback(callback, declaration)) return false;
    const callbackPosition = call.arguments.findIndex((argument) => skipWrappers(argument) === callback);
    const callbackParameter = wrapper.parameters.filter((candidate) => !isThisParameter(candidate))[callbackPosition];
    if (callbackParameter === undefined || !ts.isIdentifier(callbackParameter.name)
      || callbackParameter.initializer !== undefined || callbackParameter.dotDotDotToken !== undefined) return false;
    const factoryParameterSymbol = this.context.checker.getSymbolAtLocation(parameter.name);
    let uses = 0;
    let valid = true;
    const projected: Array<{ element: ts.BindingElement; symbol: ts.Symbol; invocation: ts.CallExpression }> = [];
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (ts.isIdentifier(node) && node.text === 'arguments') {
        valid = false;
        return;
      }
      if (ts.isIdentifier(node) && this.context.checker.getSymbolAtLocation(node) === factoryParameterSymbol) {
        uses++;
        const invocation = node.parent;
        if (!ts.isCallExpression(invocation) || invocation.expression !== node) {
          valid = false;
          return;
        }
        const invocationBindings = this.objectBindingsForCall(invocation, key);
        if (invocationBindings === undefined) valid = false;
        else for (const binding of invocationBindings) projected.push({ ...binding, invocation });
        return;
      }
      if (ts.isFunctionLike(node)) {
        valid = false;
        return;
      }
      this.visitChildren(node, visit);
    };
    if (wrapper.body === undefined) return false;
    visit(wrapper.body);
    if (!valid || uses === 0 || projected.length === 0) return false;
    const projectionSymbols = new Set(projected.map((binding) => binding.symbol));
    if (!this.closedCallbackFlow(wrapper, callbackParameter, projectionSymbols)) return false;
    for (const binding of projected) {
      if (!this.scanBindingUses(binding, declaration, callbackParameter)) return false;
      bindings.push({
        key,
        source: binding.element,
        bindingElement: binding.element,
        symbol: binding.symbol,
        factory,
        invocation: binding.invocation,
        callbackParameter,
      });
    }
    return true;
  }

  /** stable direct function wrapper를 찾는다. */
  private stableWrapper(symbol: ts.Symbol): ts.FunctionDeclaration | undefined {
    if ((this.context.index.identifierWrites.get(symbol)?.length ?? 0) > 0) return undefined;
    const declarations = symbol.declarations ?? [];
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined
      || declaration.asteriskToken !== undefined || hasAsyncModifier(declaration)) return undefined;
    return this.policyIsProjectFile(declaration.getSourceFile()) && !this.policyIsOpenCallable(declaration)
      ? declaration : undefined;
  }

  /** anonymous inline callback이 class known method 호출만 포함하는지 확인한다. */
  private validInlineCallback(callback: ts.ArrowFunction | ts.FunctionExpression, declaration: ts.ClassLikeDeclaration): boolean {
    if (callback.parameters.length !== 1 || hasAsyncModifier(callback) || hasDecorators(callback)
      || ts.isFunctionExpression(callback) && callback.asteriskToken !== undefined) return false;
    const parameter = callback.parameters[0]!;
    if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined
      || parameter.questionToken !== undefined || hasDecorators(parameter)) return false;
    const symbol = this.context.checker.getSymbolAtLocation(parameter.name);
    if (symbol === undefined) return false;
    let count = 0;
    let valid = true;
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (ts.isIdentifier(node) && node.text === 'arguments') {
        valid = false;
        return;
      }
      if (ts.isIdentifier(node) && this.context.checker.getSymbolAtLocation(node) === symbol) {
        count++;
    const access = node.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== node || ts.isPrivateIdentifier(access.name)
      || access.questionDotToken !== undefined || !ts.isCallExpression(access.parent) || access.parent.expression !== access
      || access.parent.questionDotToken !== undefined
      || access.parent.arguments.length !== 0
          || !this.knownCallbackMethod(access.parent, declaration)) valid = false;
        return;
      }
      if (ts.isFunctionLike(node) && node !== callback) {
        valid = false;
        return;
      }
      this.visitChildren(node, visit);
    };
    visit(callback.body);
    return valid && count > 0;
  }

  /** 호출 결과가 정확히 한 단계 객체 구조 분해에 쓰이는지 찾는다. */
  private objectBindingsForCall(call: ts.CallExpression, key: string): readonly { element: ts.BindingElement; symbol: ts.Symbol }[] | undefined {
    if (call.questionDotToken !== undefined || call.arguments.length !== 0 || call.arguments.some(ts.isSpreadElement)) return undefined;
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call || !ts.isObjectBindingPattern(declaration.name)) return undefined;
    const bindings: Array<{ element: ts.BindingElement; symbol: ts.Symbol }> = [];
    for (const element of declaration.name.elements) {
      if (element.dotDotDotToken !== undefined || element.initializer !== undefined || !ts.isIdentifier(element.name)
        || element.propertyName !== undefined && ts.isComputedPropertyName(element.propertyName)) return undefined;
      if (staticPropertyName(element.propertyName ?? element.name) !== key) continue;
      const symbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(element.name));
      if (symbol === undefined) return undefined;
      bindings.push({ element, symbol });
    }
    return bindings.length === 0 ? undefined : bindings;
  }

  /** projection binding이 direct known carrier method 호출로만 소비되는지 확인한다. */
  private scanBindingUses(
    binding: { element: ts.BindingElement; symbol: ts.Symbol },
    declaration: ts.ClassLikeDeclaration,
    callbackParameter?: ts.ParameterDeclaration,
  ): boolean {
    if (this.context.index.exportedSymbols.has(binding.symbol) || hasExportedBindingStatement(binding.element)) return false;
    for (const reference of this.context.index.references.get(binding.symbol) ?? []) {
      this.step();
      const site = climbWrappers(referenceSite(reference));
      if (this.directInstanceMethodUse(site, declaration)) continue;
      if (callbackParameter !== undefined && this.callbackArgumentUse(site, callbackParameter)) continue;
      return false;
    }
    return true;
  }

  /** 정확한 wrapper callback parameter에 projection binding을 넘기는 소비인지 확인한다. */
  private callbackArgumentUse(site: ts.Node, callback: ts.ParameterDeclaration): boolean {
    if (!ts.isIdentifier(site) || !ts.isCallExpression(site.parent) || !site.parent.arguments.includes(site)) return false;
    const callee = skipWrappers(site.parent.expression);
    if (!ts.isIdentifier(callee)) return false;
    const symbol = this.context.checker.getSymbolAtLocation(callee);
    return symbol !== undefined && ts.isIdentifier(callback.name)
      && symbol === this.context.checker.getSymbolAtLocation(callback.name)
      && site.parent.arguments.length === 1 && site.parent.arguments[0] === site;
  }

  /** 변수 instance를 떼어 내지 않은 direct method call인지 확인한다. */
  private directInstanceMethodUse(site: ts.Node, declaration: ts.ClassLikeDeclaration): boolean {
    if (!ts.isIdentifier(site)) return false;
    if (this.insideNamedFunction(site)) return false;
    const access = site.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== site || ts.isPrivateIdentifier(access.name)) return false;
    const call = access.parent;
    return ts.isCallExpression(call) && call.expression === access && call.arguments.length === 0
      && this.knownClassMethod(declaration, access.name.text);
  }

  /** named callback/function 안에서의 capture는 carrier escape로 닫는다. */
  private insideNamedFunction(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node.parent; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current))
        && (current as ts.FunctionExpression | ts.FunctionDeclaration).name !== undefined) return true;
    }
    return false;
  }

  /** anonymous inline callback parameter가 같은 class의 known method만 호출하는지 확인한다. */
  private inlineWrapperUse(site: ts.Node, declaration: ts.ClassLikeDeclaration): boolean {
    if (!ts.isIdentifier(site) || !ts.isCallExpression(site.parent)) return false;
    const call = site.parent;
    if (!call.arguments.includes(site as ts.Expression)) return false;
    const callee = skipWrappers(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const wrapperSymbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(callee));
    const wrapper = wrapperSymbol === undefined ? undefined : this.stableWrapper(wrapperSymbol);
    if (wrapper === undefined || !this.validWrapperCall(wrapper, call)) return false;
    const callbacks = call.arguments.map((argument) => skipWrappers(argument))
      .filter((value): value is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(value) || ts.isFunctionExpression(value));
    if (callbacks.length !== 1) return false;
    const callback = callbacks[0]!;
    if (callback.name !== undefined || !this.validInlineCallback(callback, declaration)) return false;
    const carrierPosition = call.arguments.indexOf(site as ts.Expression);
    const callbackPosition = call.arguments.findIndex((argument) => skipWrappers(argument) === callback);
    const runtimeParameters = wrapper.parameters.filter((candidate) => !isThisParameter(candidate));
    const wrapperCarrier = runtimeParameters[carrierPosition];
    const wrapperCallback = runtimeParameters[callbackPosition];
    if (wrapperCarrier === undefined || wrapperCallback === undefined
      || !ts.isIdentifier(wrapperCarrier.name) || !ts.isIdentifier(wrapperCallback.name)
      || wrapperCarrier.initializer !== undefined || wrapperCarrier.dotDotDotToken !== undefined
      || wrapperCallback.initializer !== undefined || wrapperCallback.dotDotDotToken !== undefined) return false;
    const carrierSymbol = this.context.checker.getSymbolAtLocation(wrapperCarrier.name);
    if (carrierSymbol === undefined || !this.closedCallbackFlow(wrapper, wrapperCallback, new Set([carrierSymbol]))) return false;
    return true;
  }

  /** wrapper 호출의 모든 runtime parameter가 실제로 안전하게 공급되는지 확인한다. */
  private validWrapperCall(wrapper: ts.FunctionDeclaration, call: ts.CallExpression): boolean {
    const parameters = wrapper.parameters.filter((parameter) => !isThisParameter(parameter));
    if (call.questionDotToken !== undefined || call.arguments.some(ts.isSpreadElement)
      || parameters.length !== call.arguments.length) return false;
    for (const parameter of parameters) {
      this.step();
      if (!isRequiredIdentifierParameter(parameter)) return false;
    }
    return !this.functionUsesArguments(wrapper.body);
  }

  /** carrier method의 동기 실행과 zero runtime parameter를 단계 예산 안에서 확인한다. */
  private isSynchronousZeroRuntimeParameterMethod(method: ts.MethodDeclaration): boolean {
    return method.asteriskToken === undefined && !hasAsyncModifier(method) && this.isZeroRuntimeParameterFunction(method);
  }

  /** zero-argument factory의 lexical `arguments` 우회를 단계 예산 안에서 감사한다. */
  private isZeroRuntimeParameterFunction(functionLike: ts.FunctionLikeDeclaration): boolean {
    if (hasDecorators(functionLike)) return false;
    for (const parameter of functionLike.parameters) {
      this.step();
      if (!isThisParameter(parameter) || hasDecorators(parameter)) return false;
    }
    return !this.functionUsesArguments(functionLike.body);
  }

  /** 함수 본문의 `arguments` 사용을 기존 carrier 단계 예산으로 센다. */
  private functionUsesArguments(body: ts.Node | undefined): boolean {
    if (body === undefined) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      this.step();
      if (ts.isIdentifier(node) && node.text === 'arguments') {
        found = true;
        return;
      }
      this.visitChildren(node, visit);
    };
    visit(body);
    return found;
  }

  /** wrapper callback과 carrier binding의 모든 참조가 exact one-argument flow인지 확인한다. */
  private closedCallbackFlow(
    wrapper: ts.FunctionDeclaration,
    callback: ts.ParameterDeclaration,
    carrierSymbols: ReadonlySet<ts.Symbol>,
  ): boolean {
    const symbol = this.context.checker.getSymbolAtLocation(callback.name);
    if (symbol === undefined || wrapper.body === undefined) return false;
    let called = false;
    let valid = true;
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (ts.isIdentifier(node) && node.text === 'arguments') {
        valid = false;
        return;
      }
      if (ts.isFunctionLike(node)) {
        valid = false;
        return;
      }
      if (ts.isIdentifier(node) && this.context.checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        const argument = ts.isCallExpression(parent) && parent.arguments.length === 1 ? parent.arguments[0] : undefined;
        const argumentSymbol = argument !== undefined && ts.isIdentifier(argument)
          ? this.context.checker.getSymbolAtLocation(argument) : undefined;
        if (!ts.isCallExpression(parent) || parent.expression !== node || parent.arguments.length !== 1
          || argument === undefined || !ts.isIdentifier(argument)
          || argumentSymbol === undefined || !carrierSymbols.has(argumentSymbol)) valid = false;
        else called = true;
        return;
      }
      const nodeSymbol = ts.isIdentifier(node) ? this.context.checker.getSymbolAtLocation(node) : undefined;
      if (ts.isIdentifier(node) && nodeSymbol !== undefined && carrierSymbols.has(nodeSymbol)) {
        if (ts.isBindingElement(node.parent) && node.parent.name === node) return;
        if (!this.callbackArgumentUse(node, callback)) valid = false;
        return;
      }
      this.visitChildren(node, visit);
    };
    visit(wrapper.body);
    return valid && called;
  }

  /** carrier 인스턴스 메서드 이름이 실제 class method인지 확인한다. */
  private knownClassMethod(declaration: ts.ClassLikeDeclaration, name: string): boolean {
    const member = declaration.members.find((candidate) => ts.isMethodDeclaration(candidate) && staticPropertyName(candidate.name) === name);
    return member !== undefined && ts.isMethodDeclaration(member) && member.body !== undefined;
  }

  /** callback receiver가 정확한 carrier class의 checker-resolved method를 부르는지 확인한다. */
  private knownCallbackMethod(call: ts.CallExpression, declaration: ts.ClassLikeDeclaration): boolean {
    const signature = this.context.checker.getResolvedSignature(call);
    const target = signature?.declaration;
    return target !== undefined && ts.isMethodDeclaration(target) && target.parent === declaration
      && this.knownClassMethod(declaration, target.name === undefined ? '' : staticPropertyName(target.name) ?? '');
  }

  /** clean-view worker에 audited constructor own-field site를 전달한다. */
  private cleanMutations(proof: ConstructorCarrierProof): boolean {
    const policy = this.context.policy;
    const safety: MutationSafetyContext = {
      checker: this.context.checker,
      index: this.context.index,
      isDefaultLibraryFile: (sourceFile) => this.policyIsDefaultLibraryFile(sourceFile),
      openProgram: policy.openProperties,
      openProperties: policy.openProperties,
      budgetStep: () => this.step(),
    };
    const completeness = this.context.index as FlowIndex & {
      readonly hasOpaqueMutation?: boolean;
      readonly hasIncompleteMutations?: boolean;
      readonly mutationComplete?: boolean;
    };
    if (completeness.hasIncompleteMutations === true || completeness.mutationComplete === false) throw new CarrierIncomplete();
    if (completeness.hasOpaqueMutation === true) return false;
    // prototype effect와 unknown operation은 key가 우연히 다르더라도 모두 남겨야 한다.
    for (const record of this.context.index.mutations) {
      this.step();
      if (isPrototypeOrUnknownMutation(record)) return false;
    }
    return isMutationCleanView(safety, { allowedSites: proof.allowedMutationSites });
  }

  /** recursive AST walk의 위치를 edge-relative local requirement로 기록한다. */
  private visitChildren(node: ts.Node, visit: (node: ts.Node) => void): void {
    this.walkDepth++;
    try { ts.forEachChild(node, visit); } finally { this.walkDepth--; }
  }

  /** 단계 예산을 넘으면 증명을 닫는다. */
  private step(): void {
    this.work?.(this.walkDepth, this.walkDepth);
  }
}

/** 편의 함수: 분석기를 한 번 만들어 클래스 carrier를 증명한다. */
export function proveConstructorCarrier(
  context: ConstructorCarrierContext,
  declaration: ts.ClassLikeDeclaration,
): ConstructorCarrierProof | undefined {
  return new ConstructorCarrierAnalyzer(context).prove(declaration);
}

/** missing mutation coverage는 syntax negative로 캐시하지 않는다. */
class CarrierIncomplete extends Error {}

interface BagShape {
  readonly keys: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
  readonly members: readonly ts.TypeElement[];
  readonly optionalDateKey: string | undefined;
}

/** 생성자 own-field audited assignment의 파생 정보다. */
interface ConstructorAudit {
  readonly dateFieldName: string | undefined;
}

/** declared-method recovery가 공유하는 constructor/storage 근거다. */
interface ConstructorReceiverProof {
  readonly bagParameter: ts.ParameterDeclaration;
  readonly bagShape: BagShape;
  readonly fields: ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration>;
  readonly audit: ConstructorAudit;
  readonly constructions: readonly ts.NewExpression[];
}


/** parameter-property인지 확인한다. */
function isPrivateReadonlyParameterProperty(parameter: ts.ParameterDeclaration, constructor: ts.ConstructorDeclaration,
  step?: () => void): boolean {
  if (step !== undefined) {
    if (parameter.parent !== constructor || !ts.isIdentifier(parameter.name)) return false;
    let privateModifier = false;
    let readonlyModifier = false;
    for (const modifier of parameter.modifiers ?? []) {
      step();
      const kind = modifier.kind;
      if (kind === ts.SyntaxKind.PrivateKeyword) privateModifier = true;
      if (kind === ts.SyntaxKind.ReadonlyKeyword) readonlyModifier = true;
    }
    return privateModifier && readonlyModifier;
  }
  if (!ts.isParameterPropertyDeclaration(parameter, constructor)) return false;
  const modifiers = ts.getModifiers(parameter) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
}

/** this parameter를 구별한다. */
function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'this';
}

/** explicit constructor return expression은 carrier를 닫는다. */
function hasExplicitConstructorReturn(constructor: ts.ConstructorDeclaration, step: (depth: number) => void): boolean {
  const stack: { node: ts.Node; depth: number }[] = [{ node: constructor.body!, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    step(depth);
    if (node !== constructor.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) continue;
    if (ts.isReturnStatement(node) && node.expression !== undefined) return true;
    ts.forEachChild(node, (child) => { stack.push({ node: child, depth: depth + 1 }); });
  }
  return false;
}

/** genuine decorator 유무를 확인한다. */
function hasDecorators(node: ts.Node, step?: () => void): boolean {
  if (step !== undefined) {
    for (const modifier of ts.canHaveModifiers(node) ? node.modifiers ?? [] : []) {
      step();
      if (modifier.kind === ts.SyntaxKind.Decorator) return true;
    }
    return false;
  }
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

/** static modifier 유무를 확인한다. */
function hasStaticModifier(node: ts.Node, step?: () => void): boolean {
  if (step !== undefined) {
    for (const modifier of ts.canHaveModifiers(node) ? node.modifiers ?? [] : []) {
      step();
      if (modifier.kind === ts.SyntaxKind.StaticKeyword) return true;
    }
    return false;
  }
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/** async modifier 유무를 확인한다. */
function hasAsyncModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

/** runtime 인자가 실제 식별자 하나로만 전달되는 required parameter인지 확인한다. */
function isRequiredIdentifierParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.initializer === undefined
    && parameter.dotDotDotToken === undefined && parameter.questionToken === undefined && !hasDecorators(parameter);
}

/** declared-method instance 소비에서 평가 자체가 effect-free인 argument 문법이다. */
function isInertDeclaredMethodArgument(expression: ts.Expression): boolean {
  const inner = skipWrappers(expression);
  return ts.isIdentifier(inner) && inner.text !== 'arguments' || ts.isStringLiteralLike(inner)
    || ts.isNumericLiteral(inner) || ts.isBigIntLiteral(inner) || inner.kind === ts.SyntaxKind.TrueKeyword
    || inner.kind === ts.SyntaxKind.FalseKeyword || inner.kind === ts.SyntaxKind.NullKeyword;
}

/** carrier method call이 결과 coercion·인자 평가 없이 직접 실행되는지 확인한다. */
function isDirectCarrierCall(call: ts.CallExpression): boolean {
  const outer = climbWrappers(call);
  const parent = outer.parent;
  return (ts.isExpressionStatement(parent) && parent.expression === outer)
    || (ts.isReturnStatement(parent) && parent.expression === outer);
}

/** inert parentheses만 벗기고 타입·값 래퍼가 붙은 호출은 남긴다. */
function parenthesizedCall(expression: ts.Expression): ts.CallExpression | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return ts.isCallExpression(current) ? current : undefined;
}

/** parameter-property·field·method가 prototype-sensitive runtime slot을 차지하지 않는지 확인한다. */
function isPrototypeSensitiveSlotName(name: string): boolean {
  return name === '__proto__' || name === 'prototype' || name === 'constructor' || name === 'then';
}

/** variable declaration을 감싼 statement가 직접 export되는지 확인한다. */
function hasExportedVariableStatement(declaration: ts.VariableDeclaration): boolean {
  if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent)) return false;
  return declaration.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/** object binding element가 직접 exported variable statement에 속하는지 확인한다. */
function hasExportedBindingStatement(binding: ts.BindingElement): boolean {
  const pattern = binding.parent;
  return ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(pattern.parent)
    && hasExportedVariableStatement(pattern.parent);
}

/** property name을 computed 없이 정적으로 읽는다. */
function staticPropertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined || ts.isComputedPropertyName(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** this.<field>의 정적 field 이름을 돌려준다. */
function thisField(expression: ts.Expression): string | undefined {
  const inner = skipWrappers(expression);
  return ts.isPropertyAccessExpression(inner) && inner.expression.kind === ts.SyntaxKind.ThisKeyword
    && !ts.isPrivateIdentifier(inner.name) ? inner.name.text : undefined;
}

/** type wrapper를 제한적으로 벗긴다. */
function skipTypeWrappers(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current) || ts.isTypeOperatorNode(current) && current.operator === ts.SyntaxKind.ReadonlyKeyword) {
    current = current.type;
  }
  return current;
}

/** 별칭 심볼을 한 번 풀어 실제 선언 심볼을 얻는다. */
function dealias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  const target = checker.getAliasedSymbol(symbol);
  return (target.declarations ?? []).length === 0 ? undefined : target;
}

/** 클래스 선언·식의 값 심볼을 구한다. */
function classSymbol(checker: ts.TypeChecker, declaration: ts.ClassLikeDeclaration): ts.Symbol | undefined {
  if (ts.isClassDeclaration(declaration)) return declaration.name === undefined ? undefined : checker.getSymbolAtLocation(declaration.name);
  const holder = climbWrappers(declaration).parent;
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
    ? checker.getSymbolAtLocation(holder.name) : undefined;
}

/** exported declaration은 외부에서 새 instance를 만들 수 있으므로 닫는다. */
function isExportedDeclaration(context: ConstructorCarrierContext, declaration: ts.ClassLikeDeclaration): boolean {
  const symbol = classSymbol(context.checker, declaration);
  if (symbol !== undefined && context.index.exportedSymbols.has(dealias(context.checker, symbol)!)) return true;
  const holder = ts.isClassDeclaration(declaration) ? declaration : climbWrappers(declaration).parent;
  if (ts.isClassDeclaration(holder) || ts.isVariableDeclaration(holder)) {
    const declarationNode = ts.isVariableDeclaration(holder) ? holder.parent.parent : holder;
    const modifiers = ts.canHaveModifiers(declarationNode) ? ts.getModifiers(declarationNode) ?? [] : [];
    return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword);
  }
  return false;
}

/** ambient declaration은 실제 method body를 보장하지 않는다. */
function isAmbient(node: ts.Node): boolean {
  return node.getSourceFile().isDeclarationFile;
}

/** shadow되지 않은 global undefined 식인지 확인한다. */
function isGlobalUndefined(
  context: ConstructorCarrierContext,
  expression: ts.Expression,
  isDefaultLibrary: (sourceFile: ts.SourceFile) => boolean = (sourceFile) => defaultLibraryFile(context.policy, sourceFile),
): boolean {
  const inner = skipWrappers(expression);
  if (!ts.isIdentifier(inner) || inner.text !== 'undefined') return false;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined) return (context.checker.getTypeAtLocation(inner).flags & ts.TypeFlags.Undefined) !== 0;
  const declarations = symbol.declarations ?? [];
  return declarations.length === 0 || declarations.every((declaration) => isDefaultLibrary(declaration.getSourceFile()));
}

/** null 또는 genuine global undefined 비교값인지 확인한다. */
function isNullOrUndefinedExpression(
  expression: ts.Expression,
  context: ConstructorCarrierContext,
  isDefaultLibrary?: (sourceFile: ts.SourceFile) => boolean,
): boolean {
  const inner = skipWrappers(expression);
  return inner.kind === ts.SyntaxKind.NullKeyword || isGlobalUndefined(context, inner, isDefaultLibrary);
}

/** memo equality가 실제 control-flow condition 자리인지 확인한다. */
function isConditionExpression(expression: ts.Expression): boolean {
  const parent = expression.parent;
  return (ts.isIfStatement(parent) && parent.expression === expression)
    || (ts.isWhileStatement(parent) && parent.expression === expression)
    || (ts.isDoStatement(parent) && parent.expression === expression)
    || (ts.isForStatement(parent) && parent.condition === expression)
    || (ts.isConditionalExpression(parent) && parent.condition === expression);
}

/** optional bag member가 genuine `() => Date` 타입인지 확인한다. */
function isDateFactoryType(
  context: ConstructorCarrierContext,
  type: ts.TypeNode,
  isDefaultLibrary: (sourceFile: ts.SourceFile) => boolean = (sourceFile) => defaultLibraryFile(context.policy, sourceFile),
): boolean {
  if (!ts.isFunctionTypeNode(type) || type.parameters.length !== 0 || type.typeParameters !== undefined) return false;
  const result = skipTypeWrappers(type.type);
  if (!ts.isTypeReferenceNode(result) || !ts.isIdentifier(result.typeName) || result.typeName.text !== 'Date'
    || (result.typeArguments?.length ?? 0) !== 0 || context.policy.isDefaultLibraryFile === undefined) return false;
  const symbol = context.checker.getSymbolAtLocation(result.typeName);
  const declarations = symbol === undefined ? [] : (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol).declarations ?? [] : symbol.declarations ?? [];
  const known = declarations.filter((declaration): declaration is ts.Declaration => declaration !== undefined);
  return known.length > 0 && known.length === declarations.length
    && known.every((declaration) => isDefaultLibrary(declaration.getSourceFile()));
}

/** FlowPolicy method 구현의 receiver를 보존한 genuine default-library 판정이다. */
function defaultLibraryFile(policy: FlowPolicy, sourceFile: ts.SourceFile): boolean {
  return policy.isDefaultLibraryFile?.call(policy, sourceFile) === true;
}

/** mutation effect가 prototype 또는 unknown이면 key 비교로 제거하지 않는다. */
function isPrototypeOrUnknownMutation(record: MutationRecord): boolean {
  return record.effect === 'prototype' || record.effect === 'unknown' || record.confidence === 'unknown';
}
