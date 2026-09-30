/**
 * Node 백엔드(Hono·Express·Fastify·Koa·NestJS) 라우트 추출의 진입점이다.
 *
 * 흐름: `package.json`·잠금 파일로 프레임워크 감지 → 감지했으면 프로젝트 Program 준비 → 라우터 해석(사건 수집) →
 * 프레임워크별 mount 펼치기 → 사실·한계 조립. 감지한 프레임워크가 없으면 Program을 만들지 않는다(Next.js 전용 프로젝트의
 * 비용과 결과가 바뀌지 않게 하기 위해서다).
 */

import type { CommandFileSystem } from '../../cli/file-system.ts';
import { readProjectDependencies } from './dependency-versions.ts';
import { expressAdapter, flattenExpress } from './express-adapter.ts';
import { fastifyAdapter, flattenFastify } from './fastify-adapter.ts';
import type { FrameworkRoutes } from './flat-route.ts';
import { flattenHono, honoAdapter } from './hono-adapter.ts';
import { flattenKoa, koaAdapter } from './koa-adapter.ts';
import { extractNestRoutes } from './nest-routes.ts';
import { type DetectedFrameworks, detectFrameworks, hasNodeFramework } from './node-frameworks.ts';
import { hasParseErrors, isNodeTestPath, loadNodeProject, type NodeProject } from './node-project.ts';
import { type FrameworkAdapter, interpretProject } from './router-interpreter.ts';

/** 추출 입력이다. */
export interface NodeRoutesInput {
  readonly fileSystem: CommandFileSystem;
  readonly project: string;
  readonly includeTests: boolean;
}

/** 추출 결과다. */
export interface NodeRoutesResult {
  readonly detected: DetectedFrameworks;
  /** 프레임워크를 감지해 분석했으면 있다 */
  readonly analysis?: {
    readonly project: NodeProject;
    readonly frameworks: readonly FrameworkRoutes[];
    readonly truncatedCalls: number;
    /** 분석한(테스트 제외 등) 파일 중 구문 오류가 있는 파일 수 */
    readonly syntaxErrorFiles: number;
  };
}

/**
 * 프레임워크를 감지한다(Program은 만들지 않는다).
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 감지 결과
 */
export async function detectNodeFrameworks(fileSystem: CommandFileSystem, project: string): Promise<DetectedFrameworks> {
  return detectFrameworks(await readProjectDependencies(fileSystem, project));
}

/**
 * Node 백엔드 라우트를 추출한다.
 *
 * @param input 입력
 * @param detected 감지 결과(없으면 새로 감지한다)
 * @returns 추출 결과
 */
export async function extractNodeRoutes(input: NodeRoutesInput, detected?: DetectedFrameworks): Promise<NodeRoutesResult> {
  const frameworks = detected ?? await detectNodeFrameworks(input.fileSystem, input.project);
  if (!hasNodeFramework(frameworks)) return { detected: frameworks };
  const project = loadNodeProject(input.project);
  const adapters = adaptersFor(frameworks);
  const includeFile = (path: string): boolean => input.includeTests || !isNodeTestPath(path);
  const interpretation = interpretProject(project, adapters, includeFile);
  const results: FrameworkRoutes[] = [];
  if (frameworks.hono !== undefined) results.push(flattenHono(project, interpretation.instances, interpretation.events));
  if (frameworks.express !== undefined) results.push(flattenExpress(project, interpretation.instances, interpretation.events, frameworks.express.major));
  if (frameworks.koa !== undefined) results.push(flattenKoa(project, interpretation.instances, interpretation.events, frameworks.koa.routerMajor));
  if (frameworks.fastify !== undefined) results.push(flattenFastify(project, interpretation.instances, interpretation.events));
  if (frameworks.nest !== undefined) results.push(...extractNestRoutes(project, frameworks.nest, includeFile));
  const syntaxErrorFiles = [...project.files].filter(([path, sourceFile]) => includeFile(path) && hasParseErrors(sourceFile)).length;
  return { detected: frameworks, analysis: { project, frameworks: results, truncatedCalls: interpretation.truncatedCalls, syntaxErrorFiles } };
}

/**
 * 감지한 프레임워크의 해석 어댑터다(NestJS는 데코레이터 기반이라 해석기를 쓰지 않는다).
 *
 * @param detected 감지 결과
 * @returns 어댑터 목록
 */
function adaptersFor(detected: DetectedFrameworks): FrameworkAdapter[] {
  const adapters: FrameworkAdapter[] = [];
  if (detected.hono !== undefined) adapters.push(honoAdapter);
  if (detected.express !== undefined) adapters.push(expressAdapter);
  if (detected.koa !== undefined) adapters.push(koaAdapter);
  if (detected.fastify !== undefined) adapters.push(fastifyAdapter);
  return adapters;
}
