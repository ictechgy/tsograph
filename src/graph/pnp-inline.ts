/** Yarn loader에서 한 개의 정적 RAW_RUNTIME_STATE literal만 추출한다. loader를 실행하지 않는다. */
import ts from 'typescript';
import { parseWithinSyntaxDepth, TOO_DEEP } from '../schema/syntax-depth.ts';
import { parsePnpJson } from './pnp-json.ts';

/** 불변 const 문자열 이외의 initializer·중복 선언·구문 오류는 거부한다. */
export function parseInlinePnp(text: string): unknown {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  let tokens = 0;
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) if (++tokens > 200_000) throw new Error('static PnP loader exceeds its token budget');
  const source = parseWithinSyntaxDepth(() => ts.createSourceFile('.pnp.cjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  if (source === TOO_DEEP || (source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length !== 0) throw new Error('unsupported static PnP initializer');
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations.map(declaration => ({ statement, declaration })))
    .filter(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'RAW_RUNTIME_STATE');
  if (declarations.length !== 1) throw new Error('unsupported static PnP initializer');
  const { statement, declaration } = declarations[0]!;
  const initializer = declaration.initializer;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0 || initializer === undefined) throw new Error('unsupported static PnP initializer');
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return parsePnpJson(initializer.text);
  throw new Error('unsupported static PnP initializer');
}
