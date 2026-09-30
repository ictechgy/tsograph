/** 실행 없이 불변 상수와 요청 설정을 읽는다. 심볼로 스코프·import를 구분한다. */
import ts from 'typescript';
import { declarationOf, resolveAlias, symbolAt, unwrap } from '../node/symbols.ts';
import { isNodeTestPath, type NodeProject } from '../node/node-project.ts';
import type { UrlPart } from './url-compose.ts';

/** null은 전개·변경으로 전체 설정을 알 수 없다는 뜻이다. */
export type ClientConfig = ReadonlyMap<string, ts.Expression> | null;
/** 속성 없음(undefined)과 값 미상(null)을 구분한다. */
export type ConfigValue = ts.Expression | undefined | null;

/** 분석 중인 프로젝트의 변경 가능 심볼과 상수 해석기를 소유한다. */
export class ClientValues {
  readonly project: NodeProject;
  readonly mutated = new Set<ts.Symbol>();

  /** 직접 대입·증감·Object.assign·interceptor 등록의 루트 심볼을 모은다. */
  constructor(project: NodeProject, includeTests = false) {
    this.project = project;
    for (const [path, source] of project.files) {
      if (!includeTests && isNodeTestPath(path)) continue;
      const visit = (node: ts.Node): void => {
        let target: ts.Expression | undefined;
        if (ts.isDeleteExpression(node)) target = node.expression;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === 'assign' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object') target = node.arguments[0];
          if (hasInterceptorAccess(node.expression)) target = node.expression.expression;
        }
        if (target !== undefined) this.markMutated(target);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  /** 속성 접근의 루트 식별자에 붙은 심볼이다. */
  rootSymbol(expression: ts.Expression): ts.Symbol | undefined {
    let node = unwrap(expression);
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = unwrap(node.expression);
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = symbolAt(this.project.checker, node);
    const declaration = declarationOf(this.project.checker, node);
    return declaration !== undefined && this.project.pathOf(declaration.getSourceFile()) !== undefined && ts.isVariableDeclaration(declaration)
      ? symbolAt(this.project.checker, declaration.name) : symbol;
  }

  /** 같은 객체를 가리키는 상수 별칭도 변경 대상으로 기록한다. */
  markMutated(expression: ts.Expression, depth = 0): void {
    if (depth > 16) return;
    const node = unwrap(expression);
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) if (!ts.isOmittedExpression(element)) this.markMutated(ts.isSpreadElement(element) ? element.expression : element, depth + 1);
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) this.markMutated(property.initializer, depth + 1);
        if (ts.isShorthandPropertyAssignment(property)) this.markMutated(property.name, depth + 1);
        if (ts.isSpreadAssignment(property)) this.markMutated(property.expression, depth + 1);
      }
    }
    const symbol = this.rootSymbol(expression);
    if (symbol === undefined || this.mutated.has(symbol)) return;
    this.mutated.add(symbol);
    const declaration = symbol.declarations?.[0];
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && ts.isIdentifier(unwrap(declaration.initializer))) {
      this.markMutated(declaration.initializer, depth + 1);
    }
  }

  /** 변경되지 않은 const 초기값만 따라간다. 분석 대상 밖의 선언은 읽지 않는다. */
  resolve(expression: ts.Expression, depth = 0): ts.Expression | undefined {
    if (depth > 16) return undefined;
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) return node;
    const shorthand = ts.isShorthandPropertyAssignment(node.parent) ? this.project.checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const declaration = shorthand === undefined ? declarationOf(this.project.checker, node) : resolveAlias(this.project.checker, shorthand).declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0 || this.project.pathOf(declaration.getSourceFile()) === undefined) return undefined;
    const symbol = shorthand ?? symbolAt(this.project.checker, node);
    const declaredSymbol = symbolAt(this.project.checker, declaration.name);
    if ((symbol !== undefined && this.mutated.has(symbol)) || (declaredSymbol !== undefined && this.mutated.has(declaredSymbol))) return undefined;
    return this.resolve(declaration.initializer, depth + 1);
  }

  /** 문자열 리터럴로 확정된 설정 값이다. */
  string(expression: ConfigValue): string | undefined {
    if (expression == null) return undefined;
    const node = this.resolve(expression);
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  }

  /** 객체 속성을 읽는다. 전개·계산된 이름·메서드가 있으면 추측하지 않는다. */
  config(expression: ts.Expression | undefined): ClientConfig {
    if (expression === undefined) return new Map();
    const node = this.resolve(expression);
    if (node === undefined || !ts.isObjectLiteralExpression(node)) return null;
    const properties = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) properties.set(property.name.text, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) properties.set(property.name.text, property.name);
      else return null;
    }
    return properties;
  }

  /** URL 보간을 값·쿼리 꼬리로 구분한다. 깊이와 순환에는 상한을 둔다. */
  parts(expression: ts.Expression | undefined, depth = 0): UrlPart[] {
    if (expression === undefined || depth > 16) return [{ value: true }];
    const node = this.resolve(expression);
    if (node === undefined) return [{ value: true }];
    if (ts.isStringLiteralLike(node)) return [{ literal: node.text }];
    if (ts.isTemplateExpression(node)) return [{ literal: node.head.text }, ...node.templateSpans.flatMap((span) => [
      ...this.parts(span.expression, depth + 1), { literal: span.literal.text },
    ])];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [
      ...this.parts(node.left, depth + 1), ...this.parts(node.right, depth + 1),
    ];
    if (ts.isConditionalExpression(node) && this.isQuerySuffix(node.whenTrue, depth + 1) && this.isQuerySuffix(node.whenFalse, depth + 1)) return [{ queryTail: true }];
    return [{ value: true }];
  }

  /** 조건식 가지가 빈 문자열 또는 고정된 '?' 접두사인지 증명한다. */
  private isQuerySuffix(expression: ts.Expression, depth: number): boolean {
    if (depth > 16) return false;
    const node = this.resolve(expression);
    if (node === undefined) return false;
    if (ts.isConditionalExpression(node)) return this.isQuerySuffix(node.whenTrue, depth + 1) && this.isQuerySuffix(node.whenFalse, depth + 1);
    const head = this.parts(node, depth + 1)[0];
    return head !== undefined && 'literal' in head && (head.literal.startsWith('?') || (head.literal === '' && ts.isStringLiteralLike(node)));
  }
}

/** 소스 trivia에 영향받지 않고 interceptor 속성 접근 사슬을 찾는다. */
function hasInterceptorAccess(expression: ts.Expression): boolean {
  let node = unwrap(expression);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if ((ts.isPropertyAccessExpression(node) && node.name.text === 'interceptors')
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'interceptors')) return true;
    node = unwrap(node.expression);
  }
  return false;
}

/** 뒤쪽 override부터 속성을 찾는다. 미상 설정은 앞 설정의 부재 증명을 가린다. */
export function configValue(configs: readonly ClientConfig[], name: string): ConfigValue {
  for (const config of configs.toReversed()) {
    if (config === null) return null;
    if (config.has(name)) return config.get(name)!;
  }
  return undefined;
}
