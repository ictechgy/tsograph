/**
 * registration-order 문서의 `order.group` 이름을 만든다.
 *
 * group은 "한 라우터 체인"(요청을 받는 앱 하나, NestJS는 컨트롤러 하나)이다. 이름은 프레임워크와 그 앱을 만든 위치
 * (`hono:src/index.ts:3:13`)로 정해 결정적이고 문서 안에서 유일하다. 계약 상한(256자)을 넘으면 SHA-256 앞 16자리로 줄인다.
 */

import { createHash } from 'node:crypto';

import type ts from 'typescript';

import { MAX_ORDER_GROUP_LENGTH } from '../../exchange/dispatch-order.ts';
import type { NodeProject } from './node-project.ts';
import type { RouterInstance } from './router-model.ts';

/**
 * 노드 위치로 group 이름을 만든다.
 *
 * @param framework 프레임워크 이름
 * @param project 프로젝트
 * @param node 앱·컨트롤러를 만든 노드
 * @returns group 이름
 */
export function groupName(framework: string, project: NodeProject, node: ts.Node): string {
  const location = project.locationOf(node);
  const name = `${framework}:${location.path}:${location.line}:${location.column}`;
  if (name.length <= MAX_ORDER_GROUP_LENGTH) return name;
  return `${framework}:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

/**
 * 요청을 받는 라우터 인스턴스의 group 이름이다. 모듈 최상위에서 만든 인스턴스는 만든 위치로 이름을 짓고, 팩토리 호출
 * 프레임에서 만든 인스턴스는 호출마다 다른 앱이므로 프레임 id의 짧은 해시를 붙여 서로 다른 group이 되게 한다.
 *
 * @param framework 프레임워크 이름
 * @param project 프로젝트
 * @param instance 인스턴스
 * @returns group 이름
 */
export function instanceGroupName(framework: string, project: NodeProject, instance: RouterInstance): string {
  const base = groupName(framework, project, instance.node);
  if (instance.frame.functionNode === undefined) return base;
  const suffix = `@${createHash('sha256').update(instance.frame.id).digest('hex').slice(0, 8)}`;
  return base.length + suffix.length <= MAX_ORDER_GROUP_LENGTH ? base + suffix : `${framework}:${createHash('sha256').update(base + suffix).digest('hex').slice(0, 16)}`;
}
