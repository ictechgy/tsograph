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
import type { FlowPolicy } from './value-flow.ts';

/** 생성자 carrier 증명에 필요한 공개 분석 문맥이다. */
export interface ConstructorCarrierContext {
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

/** 생성자 carrier 분석기다. 완료한 AST 결과만 메모하고 재진입은 실패시킨다. */
export class ConstructorCarrierAnalyzer {
  private readonly completed = new Map<ts.ClassLikeDeclaration, ConstructorCarrierProof | undefined>();
  private readonly pending = new Set<ts.ClassLikeDeclaration>();
  private steps = 0;

  /**
   * @param context checker·flow index·policy
   */
  private readonly context: ConstructorCarrierContext;

  constructor(context: ConstructorCarrierContext) {
    this.context = context;
  }

  /**
   * 클래스가 bounded constructor carrier인지 증명한다.
   *
   * @param declaration 클래스 선언·식
   * @returns 증명 근거, 실패하면 undefined
   */
  prove(declaration: ts.ClassLikeDeclaration): ConstructorCarrierProof | undefined {
    const cached = this.completed.get(declaration);
    if (cached !== undefined || this.completed.has(declaration)) return cached;
    if (this.pending.has(declaration)) return undefined;
    this.pending.add(declaration);
    this.steps = 0;
    let result: ConstructorCarrierProof | undefined;
    try {
      result = this.proveClass(declaration);
      if (result !== undefined && !this.cleanMutations(result)) result = undefined;
    } catch (error) {
      if (!(error instanceof CarrierBudgetExceeded) && !(error instanceof RangeError)) throw error;
      result = undefined;
    } finally {
      this.pending.delete(declaration);
    }
    this.completed.set(declaration, result);
    return result;
  }

  /** 클래스 carrier의 모든 구조·소비·mutation 조건을 검사한다. */
  private proveClass(declaration: ts.ClassLikeDeclaration): ConstructorCarrierProof | undefined {
    this.step();
    if (!this.context.policy.isProjectFile(declaration.getSourceFile()) || this.context.policy.isOpenCallable(declaration)) return undefined;
    if (hasDecorators(declaration) || declaration.heritageClauses !== undefined || this.context.index.newThisClasses.has(declaration)) return undefined;
    if ((this.context.index.subclasses.get(declaration)?.length ?? 0) > 0) return undefined;
    if (isExportedDeclaration(this.context, declaration)) return undefined;

    const constructor = declaration.members.filter(ts.isConstructorDeclaration);
    if (constructor.length !== 1 || constructor[0]!.body === undefined) return undefined;
    const owner = constructor[0]!;
    if (hasDecorators(owner) || hasExplicitConstructorReturn(owner)) return undefined;
    const parameters = owner.parameters.filter((parameter) => !isThisParameter(parameter));
    if (parameters.length !== 1) return undefined;
    const bagParameter = parameters[0]!;
    if (!isPrivateReadonlyParameterProperty(bagParameter, owner)) return undefined;
    if (!ts.isIdentifier(bagParameter.name) || bagParameter.initializer !== undefined || bagParameter.dotDotDotToken !== undefined) return undefined;

    const bagShape = this.bagShape(bagParameter);
    if (bagShape === undefined) return undefined;
    const construction = this.singleConstruction(declaration);
    if (construction === undefined) return undefined;
    const argumentsList = construction.arguments ?? [];
    if (argumentsList.length !== 1 || ts.isSpreadElement(argumentsList[0]!)) return undefined;
    const innerLiteral = skipWrappers(argumentsList[0]!);
    if (!ts.isObjectLiteralExpression(innerLiteral) || !this.innerLiteralShape(innerLiteral, bagShape)) return undefined;

    const fields = this.instanceFields(declaration, bagParameter);
    if (fields === undefined) return undefined;
    const allowedMutationSites = new Set<ts.Node>();
    const serviceUses: ConstructorServiceUse[] = [];
    const audit = this.scanConstructor(owner, bagParameter, bagShape, fields, allowedMutationSites);
    if (audit === undefined) return undefined;
    for (const member of declaration.members) {
      this.step();
      if (!ts.isMethodDeclaration(member)) continue;
      if (hasDecorators(member) || member.body === undefined || hasStaticModifier(member)) return undefined;
      if (!this.scanMethod(member, bagParameter, bagShape, fields, audit.dateFieldName, serviceUses)) return undefined;
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

  /** 유일한 생성자 호출 참조를 찾는다. 클래스 값은 정확히 한 `new`에서만 쓰여야 한다. */
  private singleConstruction(declaration: ts.ClassLikeDeclaration): ts.NewExpression | undefined {
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
    return sites.length === 1 ? sites[0] : undefined;
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
      if (member.questionToken !== undefined && !isDateFactoryType(this.context, member.type)) return undefined;
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
    if (declaration === undefined || !this.context.policy.isProjectFile(declaration.getSourceFile())) return undefined;
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
  private innerLiteralShape(literal: ts.ObjectLiteralExpression, shape: BagShape): boolean {
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
    for (const key of shape.keys) if (!shape.optional.has(key) && !seen.has(key)) return false;
    return true;
  }

  /** optional Date factory 공급값은 inert 값 또는 exact pure intrinsic arrow만 허용한다. */
  private isInertOrPureDateProperty(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
    if (!ts.isPropertyAssignment(property)) return false;
    const value = skipWrappers(property.initializer);
    return value.kind === ts.SyntaxKind.NullKeyword || isGlobalUndefined(this.context, value) || this.isPureDefaultDate(value);
  }

  /** instance field와 parameter-property의 허용된 정적 이름을 수집한다. */
  private instanceFields(
    declaration: ts.ClassLikeDeclaration,
    bagParameter: ts.ParameterDeclaration,
  ): ReadonlyMap<string, ts.PropertyDeclaration | ts.ParameterDeclaration> | undefined {
    const fields = new Map<string, ts.PropertyDeclaration | ts.ParameterDeclaration>();
    fields.set(bagParameter.name.getText(), bagParameter);
    for (const member of declaration.members) {
      this.step();
      if (ts.isConstructorDeclaration(member)) continue;
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isAccessor(member)
        || ts.isClassStaticBlockDeclaration(member)) return undefined;
      if (ts.isMethodDeclaration(member)) {
        if (member.name === undefined || ts.isComputedPropertyName(member.name) || hasDecorators(member)) return undefined;
        continue;
      }
      if (!ts.isPropertyDeclaration(member) || hasDecorators(member) || hasStaticModifier(member)) return undefined;
      const key = staticPropertyName(member.name);
      if (key === undefined || key === '__proto__' || key === 'then' || fields.has(key)) return undefined;
      if (member.initializer !== undefined) return undefined;
      const modifiers = ts.getModifiers(member) ?? [];
      if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) return undefined;
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
  ): boolean {
    let valid = true;
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (node !== method.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
        valid = false;
        return;
      }
      if (ts.isCallExpression(node)) {
        if (!this.scanCall(node, bagParameter, bagShape, fields, dateFieldName, serviceUses)) valid = false;
        return;
      }
      if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        valid = false;
        return;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (!this.scanRead(node, bagParameter, bagShape, fields, dateFieldName, serviceUses)) valid = false;
      }
      ts.forEachChild(node, visit);
    };
    if (method.body === undefined) return false;
    visit(method.body);
    return valid;
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
    const callee = skipWrappers(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || ts.isPrivateIdentifier(callee.name)) return false;
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
    return declarations.length > 0 && declarations.every((declaration) => defaultLibraryFile(this.context.policy, declaration.getSourceFile()))
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
      && parent.parent.expression === parent && this.knownClassMethod(declaration, parent.name.text)) return true;
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
      if (rhs === literal || rhs.kind === ts.SyntaxKind.NullKeyword || isGlobalUndefined(this.context, rhs)) continue;
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
    if (initializer !== undefined && initializer.kind !== ts.SyntaxKind.NullKeyword && !isGlobalUndefined(this.context, initializer)) return undefined;
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
      && isNullOrUndefinedExpression(parent.left === expression ? parent.right : parent.left, this.context)
      && isConditionExpression(parent);
  }

  /** memo 식별자가 직접 return되는 stable named factory를 찾는다. */
  private memoReturnFactory(reference: ts.Node, site: ts.Node): ts.FunctionDeclaration | undefined {
    if (!ts.isIdentifier(reference) || !ts.isReturnStatement(site.parent) || site.parent.expression !== reference) return undefined;
    let current: ts.Node | undefined = site.parent.parent;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current)) {
        if (!ts.isFunctionDeclaration(current) || current.name === undefined || current.body === undefined
          || current.asteriskToken !== undefined || hasAsyncModifier(current) || !ts.isSourceFile(current.parent)) return undefined;
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
        if (call.arguments.some(ts.isSpreadElement) || call.arguments.length !== 0) return false;
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
    const factorySymbol = factory.name === undefined ? undefined : this.context.checker.getSymbolAtLocation(factory.name);
    const factoryArguments = call.arguments.filter((argument) => ts.isIdentifier(argument)
      && factorySymbol !== undefined && this.context.checker.getSymbolAtLocation(argument) === factorySymbol);
    if (factoryArguments.length !== 1 || call.arguments.some(ts.isSpreadElement)) return false;
    const argumentPosition = call.arguments.indexOf(factoryArguments[0]!);
    const callee = skipWrappers(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const wrapperSymbol = dealias(this.context.checker, this.context.checker.getSymbolAtLocation(callee));
    const wrapper = wrapperSymbol === undefined ? undefined : this.stableWrapper(wrapperSymbol);
    if (wrapper === undefined) return false;
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
      ts.forEachChild(node, visit);
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
    return this.context.policy.isProjectFile(declaration.getSourceFile()) && !this.context.policy.isOpenCallable(declaration)
      ? declaration : undefined;
  }

  /** anonymous inline callback이 class known method 호출만 포함하는지 확인한다. */
  private validInlineCallback(callback: ts.ArrowFunction | ts.FunctionExpression, declaration: ts.ClassLikeDeclaration): boolean {
    if (callback.parameters.length !== 1 || hasAsyncModifier(callback)
      || ts.isFunctionExpression(callback) && callback.asteriskToken !== undefined) return false;
    const parameter = callback.parameters[0]!;
    if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) return false;
    const symbol = this.context.checker.getSymbolAtLocation(parameter.name);
    if (symbol === undefined) return false;
    let count = 0;
    let valid = true;
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      this.step();
      if (ts.isIdentifier(node) && this.context.checker.getSymbolAtLocation(node) === symbol) {
        count++;
        const access = node.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== node || ts.isPrivateIdentifier(access.name)
          || !ts.isCallExpression(access.parent) || access.parent.expression !== access
          || !this.knownCallbackMethod(access.parent, declaration)) valid = false;
        return;
      }
      if (ts.isFunctionLike(node) && node !== callback) {
        valid = false;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(callback.body);
    return valid && count > 0;
  }

  /** 호출 결과가 정확히 한 단계 객체 구조 분해에 쓰이는지 찾는다. */
  private objectBindingsForCall(call: ts.CallExpression, key: string): readonly { element: ts.BindingElement; symbol: ts.Symbol }[] | undefined {
    if (call.arguments.length !== 0 || call.arguments.some(ts.isSpreadElement)) return undefined;
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
    return ts.isCallExpression(call) && call.expression === access && this.knownClassMethod(declaration, access.name.text);
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
    if (wrapper === undefined) return false;
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
      ts.forEachChild(node, visit);
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
      isDefaultLibraryFile: (sourceFile) => defaultLibraryFile(policy, sourceFile),
      openProgram: policy.openProperties,
      openProperties: policy.openProperties,
    };
    const completeness = this.context.index as FlowIndex & {
      readonly hasOpaqueMutation?: boolean;
      readonly hasIncompleteMutations?: boolean;
      readonly mutationComplete?: boolean;
    };
    if (completeness.hasOpaqueMutation === true || completeness.hasIncompleteMutations === true || completeness.mutationComplete === false) return false;
    // prototype effect와 unknown operation은 key가 우연히 다르더라도 모두 남겨야 한다.
    if (this.context.index.mutations.some((record) => isPrototypeOrUnknownMutation(record))) return false;
    return isMutationCleanView(safety, { allowedSites: proof.allowedMutationSites });
  }

  /** 단계 예산을 넘으면 증명을 닫는다. */
  private step(): void {
    if (++this.steps > 20_000) throw new CarrierBudgetExceeded();
  }
}

/** 편의 함수: 분석기를 한 번 만들어 클래스 carrier를 증명한다. */
export function proveConstructorCarrier(
  context: ConstructorCarrierContext,
  declaration: ts.ClassLikeDeclaration,
): ConstructorCarrierProof | undefined {
  return new ConstructorCarrierAnalyzer(context).prove(declaration);
}

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

class CarrierBudgetExceeded extends Error {}

/** parameter-property인지 확인한다. */
function isPrivateReadonlyParameterProperty(parameter: ts.ParameterDeclaration, constructor: ts.ConstructorDeclaration): boolean {
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
function hasExplicitConstructorReturn(constructor: ts.ConstructorDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node !== constructor.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) found = true;
    ts.forEachChild(node, visit);
  };
  visit(constructor.body!);
  return found;
}

/** genuine decorator 유무를 확인한다. */
function hasDecorators(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

/** static modifier 유무를 확인한다. */
function hasStaticModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/** async modifier 유무를 확인한다. */
function hasAsyncModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
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
function isGlobalUndefined(context: ConstructorCarrierContext, expression: ts.Expression): boolean {
  const inner = skipWrappers(expression);
  if (!ts.isIdentifier(inner) || inner.text !== 'undefined') return false;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined) return (context.checker.getTypeAtLocation(inner).flags & ts.TypeFlags.Undefined) !== 0;
  const declarations = symbol.declarations ?? [];
  return declarations.length === 0 || declarations.every((declaration) => defaultLibraryFile(context.policy, declaration.getSourceFile()));
}

/** null 또는 genuine global undefined 비교값인지 확인한다. */
function isNullOrUndefinedExpression(expression: ts.Expression, context: ConstructorCarrierContext): boolean {
  const inner = skipWrappers(expression);
  return inner.kind === ts.SyntaxKind.NullKeyword || isGlobalUndefined(context, inner);
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
function isDateFactoryType(context: ConstructorCarrierContext, type: ts.TypeNode): boolean {
  if (!ts.isFunctionTypeNode(type) || type.parameters.length !== 0 || type.typeParameters !== undefined) return false;
  const result = skipTypeWrappers(type.type);
  if (!ts.isTypeReferenceNode(result) || !ts.isIdentifier(result.typeName) || result.typeName.text !== 'Date'
    || (result.typeArguments?.length ?? 0) !== 0 || context.policy.isDefaultLibraryFile === undefined) return false;
  const symbol = context.checker.getSymbolAtLocation(result.typeName);
  const declarations = symbol === undefined ? [] : (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol).declarations ?? [] : symbol.declarations ?? [];
  const known = declarations.filter((declaration): declaration is ts.Declaration => declaration !== undefined);
  return known.length > 0 && known.length === declarations.length
    && known.every((declaration) => defaultLibraryFile(context.policy, declaration.getSourceFile()));
}

/** FlowPolicy method 구현의 receiver를 보존한 genuine default-library 판정이다. */
function defaultLibraryFile(policy: FlowPolicy, sourceFile: ts.SourceFile): boolean {
  return policy.isDefaultLibraryFile?.call(policy, sourceFile) === true;
}

/** mutation effect가 prototype 또는 unknown이면 key 비교로 제거하지 않는다. */
function isPrototypeOrUnknownMutation(record: MutationRecord): boolean {
  return record.effect === 'prototype' || record.effect === 'unknown' || record.confidence === 'unknown';
}
