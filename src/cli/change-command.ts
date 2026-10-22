/** 기존 심볼 기반 impact와 구별되는 실제 Git 변경 명령이다. */
import { analyzeChange } from '../change/impact.ts';
import { DISPATCH_MODES, type DispatchMode } from '../graph/graph-model.ts';
import { encodeSortedJsonWithinLimit } from '../exchange/sorted-json.ts';
import { inputFailure, success, usageFailure, type CommandResult } from './command-result.ts';
import { parseArguments } from './parse-arguments.ts';
import type { CliEnvironment } from './run-cli.ts';

/** 독립 캡처와 정적 결과의 범위를 설명한다. */
export const changeUsage = `Usage: tsograph change-impact --project <repository-root> --base <commit> [--head <commit>] [--max-depth <1-128>] [--max-reached <1-100000>] [--dispatch direct|bound|candidates]

Compare frozen Git base/head sources, or base against tracked and nonignored untracked working-tree
files when --head is omitted. Analyze before/after independently; preserve deleted callers and
content digests. Seeds cover whole changed files. Output is review evidence and always incomplete,
never a safety verdict or permission to skip tests. Existing impact <id> remains one-snapshot traversal.
Git >=2.45 and locally available objects are required. No target code or package install is run.
Exit codes: 0 report produced, 2 input/capture/output failure, 64 usage error.
`;

/** bounded 양의 정수 옵션을 읽는다. */
function bounded(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined) return maximum;
  return /^[1-9]\d{0,5}$/u.test(value) && Number(value) <= maximum ? Number(value) : undefined;
}

/** 인자를 검증하고 변경 보고서를 출력한다. */
export async function runChangeCommand(args: readonly string[], environment: CliEnvironment): Promise<CommandResult> {
  const parsed = parseArguments(args, ['--project', '--base', '--head', '--max-depth', '--max-reached', '--dispatch'], ['--help']);
  if (parsed?.booleanFlags.has('--help')) return success(changeUsage);
  const project = parsed?.valueFlags.get('--project'), base = parsed?.valueFlags.get('--base');
  const maxDepth = bounded(parsed?.valueFlags.get('--max-depth'), 128), maxReached = bounded(parsed?.valueFlags.get('--max-reached'), 100_000);
  const dispatch = parsed?.valueFlags.get('--dispatch') ?? 'bound';
  if (parsed === undefined || parsed.positionals.length > 0 || project === undefined || base === undefined || maxDepth === undefined || maxReached === undefined || !(DISPATCH_MODES as readonly string[]).includes(dispatch)) return usageFailure(changeUsage);
  try {
    const head = parsed.valueFlags.get('--head');
    const report = await analyzeChange({ project, base, ...(head === undefined ? {} : { head }), maxDepth, maxReached, dispatch: dispatch as DispatchMode, toolVersion: environment.toolVersion, generatedAt: environment.now() });
    const encoded = encodeSortedJsonWithinLimit(report, 16 * 1024 * 1024);
    return encoded === undefined ? inputFailure('change report exceeds output budget; lower --max-reached') : success(encoded);
  } catch { return inputFailure('change capture or analysis failed; check Git 2.45+, local revisions, repository root, stable sources and capture budgets'); }
}
