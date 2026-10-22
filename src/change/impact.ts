/** 실제 변경 파일을 각 revision의 심볼과 연결한다. 두 그래프를 합쳐 순회하지 않는다. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from '../graph/build-graph.ts';
import { computeGraphRevision } from '../graph/graph-document.ts';
import { withFrozenInputs } from '../graph/frozen-inputs.ts';
import type { DispatchMode } from '../graph/graph-model.ts';
import { resolveRoots } from '../graph/root-resolution.ts';
import { createTraversalDocument } from '../graph/traversal-document.ts';
import { traverse } from '../graph/traversal.ts';
import { CAPTURE_LIMITS, capture, CaptureError, materialize, type Capture } from './capture.ts';

/** 변경 분석의 명시적 입력이다. head 생략은 작업 트리다. */
export interface ChangeOptions { readonly project: string; readonly base: string; readonly head?: string; readonly maxDepth: number; readonly maxReached: number; readonly dispatch: DispatchMode; readonly toolVersion: string; readonly generatedAt: Date }

/** 전체 파일 내용으로 변경을 찾는다. 이름 변경은 양쪽 경로를 남기며 동일 바이트만 rename으로 연결한다. */
export function changedFiles(before: Capture, after: Capture): { path: string; status: 'added' | 'deleted' | 'modified'; renamedFrom?: string }[] {
  const rows: { path: string; status: 'added' | 'deleted' | 'modified'; renamedFrom?: string }[] = [];
  for (const path of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const old = before.files.get(path), current = after.files.get(path);
    if (old?.equals(current ?? Buffer.alloc(0)) && current !== undefined) continue;
    rows.push({ path, status: old === undefined ? 'added' : current === undefined ? 'deleted' : 'modified' });
  }
  for (const row of rows.filter((entry) => entry.status === 'added')) {
    const old = rows.find((entry) => entry.status === 'deleted' && before.files.get(entry.path)!.equals(after.files.get(row.path)!));
    if (old !== undefined) row.renamedFrom = old.path;
  }
  return rows;
}

/** 캡처의 공개 신선도 근거다. revision 라벨을 내용 증명으로 대체하지 않는다. */
function provenance(input: Capture) {
  return { kind: input.kind, revision: input.revision ?? null, contentDigest: input.digest, freshness: 'captured-content', files: input.files.size, omittedFiles: input.omitted };
}

/** 한 시점만으로 seed와 witness를 계산한다. */
async function analyze(input: Capture, directory: string, paths: readonly string[], configuration: boolean, options: ChangeOptions) {
  materialize(input, directory);
  const graph = await withFrozenInputs(directory, () => buildCallGraph(directory, createNodeFileSystem()));
  const changed = new Set(paths);
  const selected = graph.nodes.filter((node) => configuration || changed.has(node.location.path));
  const nodes = selected.slice(0, 10_000);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const mapped = new Set(graph.nodes.map((node) => node.location.path));
  const roots = resolveRoots(nodes.map((node) => node.id), new Set(graph.nodes.map((node) => node.id)));
  const result = traverse(graph, { rootIds: roots.resolvedIds, direction: 'dependents', maxDepth: options.maxDepth, maxReached: options.maxReached, dispatch: options.dispatch });
  const traversal = createTraversalDocument({ graph, graphRevision: computeGraphRevision(graph), header: { project: '.', toolVersion: options.toolVersion, generatedAt: options.generatedAt, revision: input.revision }, direction: 'dependents', dispatch: options.dispatch, roots, result, entryPoints: true });
  return {
    input: provenance(input),
    seedsTruncated: selected.length > nodes.length,
    seeds: nodes.map((node) => ({ id: node.id, location: node.location, reason: configuration ? 'configuration-wide' : 'changed-file', precision: 'file' })),
    unmappedFiles: paths.filter((path) => !mapped.has(path)),
    traversal,
    reviewCandidates: result.reached.map((entry) => {
      const node = nodeMap.get(entry.id)!;
      return { id: entry.id, via: entry.via, depth: entry.depth, evidence: entry.evidence, location: node.location, entries: node.entries ?? [] };
    }),
  };
}

/** 재현 가능한 before/after 캡처를 만들고 독립적으로 분석한다. 임시 소스는 항상 제거한다. */
export async function analyzeChange(options: ChangeOptions) {
  const start = performance.now();
  const root = realpathSync(options.project);
  const before = capture(root, options.base);
  const after = capture(root, options.head);
  if (options.head === undefined && capture(root).digest !== after.digest) throw new CaptureError('working tree changed during capture; retry on stable input');
  const changes = changedFiles(before, after);
  const configuration = changes.some(({ path }) => /(?:^|\/)(?:[tj]sconfig[^/]*\.json|package(?:-lock)?\.json)$/u.test(path));
  const preparationMilliseconds = performance.now() - start;
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-change-'));
  try {
    const old = await analyze(before, join(directory, 'before'), changes.filter((file) => file.status !== 'added').map((file) => file.path), configuration, options);
    const current = await analyze(after, join(directory, 'after'), changes.filter((file) => file.status !== 'deleted').map((file) => file.path), configuration, options);
    return {
      format: 'tsograph-change-impact', version: 1, mode: 'before-after', status: 'incomplete',
      tool: { name: 'tsograph', version: options.toolVersion }, generatedAt: options.generatedAt.toISOString(),
      changes, before: old, after: current,
      scope: { files: 'tracked-and-nonignored-untracked', sourceExecution: false, dependenciesInstalled: false, compilerInputs: 'capture-and-bundled-typescript-sdk' },
      limits: { ...CAPTURE_LIMITS, maxSeeds: 10_000, maxDepth: options.maxDepth, maxReached: options.maxReached, outputCharacters: 16 * 1024 * 1024 },
      cost: { preparationMilliseconds, totalMilliseconds: performance.now() - start },
      limitations: [
        'file-seeds: all declarations in changed files are candidates; unchanged declarations may be over-selected; configuration changes may select the entire graph',
        'static-candidates: paths and connected test/endpoint entries are review evidence, not predicted failures or permission to skip tests; empty results do not establish safety',
        'capture-scope: ignored files, symlinks and submodules are not followed; external dependencies are not installed into historical captures; both traversal limitation lists apply',
        'unmapped-files: files without graph declarations may affect runtime configuration, contracts or generated code; these effects are not assessed',
        'snapshot-isolation: every witness belongs to one capture; no propagation path combines before and after edges',
        'seed-budget: at most 10000 seeds per capture are traversed; seedsTruncated marks omitted declarations and their unknown propagation',
      ],
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
