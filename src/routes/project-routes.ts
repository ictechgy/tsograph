/**
 * 프로젝트 하나의 서버 라우트를 추출한다(Next.js 파일 라우터 + Node 백엔드 프레임워크).
 *
 * Next.js는 `package.json`에 `next`가 있거나 `next.config.*`가 있을 때 스캔한다. Node 백엔드 프레임워크를 하나도 감지하지
 * 못했을 때도 스캔한다 — 예전 동작(라우터 디렉터리가 없다는 `route-coverage:` 등)을 그대로 두기 위해서다. `routes`
 * 명령과 `graph` 진입점 표식이 같은 규칙을 쓴다.
 */

import type { CommandFileSystem } from '../cli/file-system.ts';
import { extractNextRoutes } from './next-routes.ts';
import { detectNodeFrameworks, extractNodeRoutes } from './node/node-routes.ts';
import { hasNodeFramework } from './node/node-frameworks.ts';
import { loadNextRouteConfig, readNextVersionStatus } from './project-config.ts';
import type { NextDocumentPart } from './route-document.ts';
import type { NodeRoutesResult } from './node/node-routes.ts';

/** 추출 결과다. */
export interface ProjectRoutes {
  readonly next: NextDocumentPart | undefined;
  readonly node: NodeRoutesResult;
}

/**
 * 프로젝트의 서버 라우트를 추출한다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param includeTests 테스트 소스도 낼지
 * @returns 추출 결과
 */
export async function extractProjectRoutes(fileSystem: CommandFileSystem, project: string, includeTests: boolean): Promise<ProjectRoutes> {
  const detected = await detectNodeFrameworks(fileSystem, project);
  const config = await loadNextRouteConfig(fileSystem, project);
  const scanNext = detected.next || config.fileName !== undefined || !hasNodeFramework(detected);
  const next = scanNext
    ? { extraction: await extractNextRoutes({ fileSystem, project, config, includeTests }), config, versionStatus: await readNextVersionStatus(fileSystem, project) }
    : undefined;
  const node = await extractNodeRoutes({ fileSystem, project, includeTests }, detected);
  return { next, node };
}
