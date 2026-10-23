/**
 * 프로젝트 하나의 서버 라우트를 추출한다(Next.js 파일 라우터 + Node 백엔드 프레임워크).
 *
 * Next.js는 `package.json`에 `next`가 있거나 `next.config.*`가 있을 때 스캔한다. Node 백엔드 프레임워크를 하나도 감지하지
 * 못했을 때도 스캔한다 — 예전 동작(라우터 디렉터리가 없다는 `route-coverage:` 등)을 그대로 두기 위해서다. `routes`
 * 명령과 `graph` 진입점 표식이 같은 규칙을 쓰고, graph의 production·test 분리도 여기의 테스트 소스 판정을 쓴다.
 */

import type { CommandFileSystem } from '../cli/file-system.ts';
import { extractNextRoutes, isTestSourcePath, type NextRoutesInput } from './next-routes.ts';
import { isNodeTestPath } from './node/node-project.ts';
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
 * 프로젝트 하나의 테스트 소스 판정 규칙이다. routes는 Next.js route 파일에 Next 규칙을, Node 백엔드 소스에 Node 규칙을
 * 쓴다. graph가 production·test 프로그램을 나눌 때도 같은 규칙을 파일마다 적용하도록 그 입력을 모은다.
 */
export interface TestSourceRule {
  /** Node 백엔드 프레임워크(Hono·Express·Fastify·Koa·NestJS)를 감지했는지 */
  readonly nodeBackend: boolean;
  /** 스캔한 Next.js `app`·`pages` 라우터 디렉터리(프로젝트 기준 경로). 이 안의 폴더 이름은 URL 세그먼트일 수 있다 */
  readonly routerDirectories: readonly string[];
}

/**
 * 프로젝트의 서버 라우트를 추출한다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param includeTests 테스트 소스도 낼지
 * @returns 추출 결과
 */
export async function extractProjectRoutes(fileSystem: CommandFileSystem, project: string, includeTests: boolean,
  compilerScope?: NextRoutesInput['compilerScope']): Promise<ProjectRoutes> {
  const detected = await detectNodeFrameworks(fileSystem, project);
  const config = await loadNextRouteConfig(fileSystem, project);
  const scanNext = detected.next || config.fileName !== undefined || !hasNodeFramework(detected);
  const next = scanNext
    ? { extraction: await extractNextRoutes({ fileSystem, project, config, includeTests, ...(compilerScope === undefined ? {} : { compilerScope }) }), config, versionStatus: await readNextVersionStatus(fileSystem, project) }
    : undefined;
  const node = await extractNodeRoutes({ fileSystem, project, includeTests }, detected);
  return { next, node };
}

/**
 * 추출 결과에서 테스트 소스 판정 규칙을 만든다. Next.js를 스캔하지 않았으면 라우터 디렉터리가 없다(모든 경로가 Node 백엔드
 * 감지 여부만으로 정해진다).
 *
 * @param routes 추출 결과
 * @returns 판정 규칙
 */
export function projectTestSourceRule(routes: ProjectRoutes): TestSourceRule {
  const directories = routes.next?.extraction.routerDirectories;
  return {
    nodeBackend: hasNodeFramework(routes.node.detected),
    routerDirectories: [directories?.appDirectory, directories?.pagesDirectory].filter((directory) => directory !== undefined),
  };
}

/**
 * 프로젝트 기준 경로가 테스트 소스인지 판정한다. Next.js 라우터 디렉터리 안은 폴더 이름이 URL일 수 있어
 * (`app/api/test/route.ts`는 `/api/test`) Next 규칙(`isTestSourcePath`)으로 본다. 그 밖은 Node 백엔드를 감지했을 때만
 * Node 규칙(`isNodeTestPath`: `test`·`tests`·`e2e` 디렉터리와 `*.e2e-spec.*`·`*.e2e.*` 추가)으로 본다. 감지하지 못한
 * 프로젝트(Next 전용·라이브러리)는 Next 규칙 그대로다.
 *
 * @param path 프로젝트 기준 POSIX 경로
 * @param rule 판정 규칙
 * @returns 테스트 소스면 true
 */
export function isProjectTestPath(path: string, rule: TestSourceRule): boolean {
  const insideRouter = rule.routerDirectories.some((directory) => path.startsWith(`${directory}/`));
  return rule.nodeBackend && !insideRouter ? isNodeTestPath(path) : isTestSourcePath(path);
}
