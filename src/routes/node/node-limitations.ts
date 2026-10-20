/**
 * Node 백엔드 추출 전체에 걸린 서버 측 한계(감지·버전·스캔 공백)를 만든다. 라우트 하나하나의 한계는 `node-facts.ts`다.
 */

import { SYNTAX_DEPTH_CAUSE } from '../../schema/syntax-depth.ts';
import type { FrameworkRoutes } from './flat-route.ts';
import type { LimitationEntry } from './node-facts.ts';
import { compilerConfigGaps, MAX_NODE_SOURCE_BYTES } from './node-project.ts';
import type { NodeRoutesResult } from './node-routes.ts';
import { MAX_CALL_DEPTH } from './router-interpreter.ts';

/** 프레임워크 이름 → 버전을 확인하는 패키지 이름이다. */
const VERSION_PACKAGES: Readonly<Record<FrameworkRoutes['framework'], readonly string[]>> = {
  hono: ['hono'],
  express: ['express'],
  fastify: ['fastify'],
  koa: ['@koa/router', 'koa-router'],
  nest: ['@nestjs/core'],
};

/**
 * 추출 전체의 한계를 만든다.
 *
 * @param result Node 추출 결과
 * @returns 한계 목록
 */
export function nodeProjectLimitations(result: NodeRoutesResult): LimitationEntry[] {
  const entries: LimitationEntry[] = [];
  const { detected, analysis } = result;
  if (detected.manifestUnusable) {
    entries.push({ text: 'route-coverage: the root package.json exists but could not be read (invalid JSON, not UTF-8, over 16 MiB, or a symbolic link); Node backend frameworks were not detected from it, so their routes may be missing' });
  }
  if (detected.unsupported.length > 0) {
    entries.push({ text: `route-coverage: package.json declares ${detected.unsupported.join(', ')}, whose route registrations tsograph does not model` });
  }
  if (analysis === undefined) return entries;
  const producing = analysis.frameworks.filter((framework) => framework.routes.length > 0 || framework.provided.length > 0);
  const unverified = producing.flatMap((framework) => VERSION_PACKAGES[framework.framework].filter((name) => detected.unverified.includes(name)));
  if (unverified.length > 0) {
    entries.push({ text: `route-framework-version-unknown: package.json and the lockfile do not pin ${[...new Set(unverified)].sort().join(', ')} to a major version whose routing tsograph verified; path syntax that differs between majors is emitted as dynamic` });
  }
  const gaps = analysis.project.gaps;
  const candidates: [number, string][] = [
    [gaps.symlinks, `route-coverage: ${gaps.symlinks} symbolic link(s) in the project were not followed; routers behind them were not scanned`],
    [gaps.unreadableDirectories, `route-coverage: ${gaps.unreadableDirectories} director(ies) could not be listed`],
    [gaps.unsafeNames, `route-coverage: ${gaps.unsafeNames} file or directory name(s) in the project contain characters the exchange format forbids; routers in them were not scanned`],
    [Number(gaps.truncated), 'route-coverage: the source scan stopped at its entry limit; later files were not analyzed'],
    [gaps.oversizedFiles, `route-coverage: ${gaps.oversizedFiles} source file(s) exceed ${MAX_NODE_SOURCE_BYTES} bytes and were not analyzed`],
    [gaps.unreadableFiles, `route-coverage: ${gaps.unreadableFiles} source file(s) could not be read by the compiler and were not analyzed`],
    [analysis.syntaxErrorFiles, `route-coverage: ${analysis.syntaxErrorFiles} source file(s) have syntax errors; route registrations in them may be incomplete`],
    [analysis.deeplyNestedFiles, `route-coverage: ${analysis.deeplyNestedFiles} source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; route registrations in them are missing`],
    [analysis.truncatedCalls, `route-coverage: ${analysis.truncatedCalls} function call(s) were not followed (recursion, depth ${MAX_CALL_DEPTH}, or the frame limit); routes registered inside them may be missing`],
  ];
  entries.push(...candidates.filter(([count]) => count > 0).map(([, text]) => ({ text })));
  // 설정 해석 실패면 paths 별칭으로 붙인 라우터를 놓치거나 패키지로 볼 수 있어 문서 전체(스코프 없음)에 건다.
  entries.push(...compilerConfigGaps(analysis.project.configStatus, 'route registrations').map((gap) => ({ text: `route-coverage: ${gap}` })));
  return entries;
}
