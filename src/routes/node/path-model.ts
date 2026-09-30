/**
 * Node 라우터 경로를 isthmus 정규 템플릿으로 옮길 때 쓰는 공통 세그먼트 모델이다.
 *
 * 프레임워크마다 경로 문법은 다르지만(Hono·path-to-regexp 0.1/6/8·find-my-way), 결과는 같은 모양으로 모은다:
 * 요청 경로의 세그먼트 목록(리터럴, 세그먼트 전체·부분 파라미터, 끝 catch-all)과 그 세그먼트가 빈 값을 받는지다.
 * 문법 모듈은 원문을 이 모델로 바꾸고, 사실 조립은 이 모델에서 정규 템플릿·빈 값 변형·catch-all 접두사 decl·
 * `paramConstraints`를 만든다. 정규 템플릿의 규칙은 isthmus `docs/GRAPH-EXCHANGE.md` "정규 경로 템플릿" 절이다.
 */

import type { ParamConstraint } from '../../exchange/bridge-facts.ts';
import { isCanonicalTemplate } from '../../exchange/route-template-grammar.ts';

/** 한 등록에서 펼칠 수 있는 템플릿 최대 수다(계약의 optional 세그먼트·빈 값 변형 상한). */
export const MAX_TEMPLATE_VARIANTS = 16;

/** 파라미터 세그먼트의 제약이다(`segment` 인덱스는 조립할 때 붙인다). */
export type SegmentConstraint = Omit<ParamConstraint, 'segment'>;

/** 템플릿 세그먼트 하나다. 리터럴 텍스트는 이미 정규화(percent-encoding)한 값이다. */
export type TemplateSegment =
  /** 리터럴 세그먼트. `''`는 빈 세그먼트(끝 슬래시·중복 슬래시)다. */
  | { readonly kind: 'literal'; readonly text: string }
  /** 파라미터. 세그먼트 전체면 prefix·suffix가 `''`이고, 아니면 리터럴 골격 `prefix{}suffix`다. */
  | {
    readonly kind: 'param';
    readonly prefix: string;
    readonly suffix: string;
    readonly acceptsEmpty: boolean;
    readonly constraint?: SegmentConstraint;
  }
  /**
   * 끝 catch-all. `zeroSegments`는 catch-all 앞 경로 자체(`/files`)도 받는지, `acceptsEmpty`는 빈 나머지
   * (`/files/`)도 받는지다.
   */
  | { readonly kind: 'catch-all'; readonly zeroSegments: boolean; readonly acceptsEmpty: boolean };

/** 경로 대안 하나(선택 세그먼트를 펼친 결과 하나)다. 루트 `/`는 빈 리터럴 하나다. */
export interface PathVariant {
  readonly segments: readonly TemplateSegment[];
}

/** dynamic으로 내린 이유다. limitation 문구의 분류에 쓴다. */
export type DynamicPathReason =
  | 'non-literal'
  | 'unsupported-syntax'
  | 'multiple-parameters'
  | 'regex'
  | 'expansion-capped'
  | 'dot-segment';

/** 경로 컴파일 결과다. */
export type CompiledPath =
  | { readonly kind: 'variants'; readonly variants: readonly PathVariant[] }
  /**
   * 정규 템플릿으로 옮기지 못했다. `prefixes`는 그 경로가 받을 수 있는 요청의 증명된 정적 접두사(세그먼트 경계)다.
   * 증명하지 못했으면 undefined다.
   */
  | { readonly kind: 'dynamic'; readonly reason: DynamicPathReason; readonly prefixes: readonly PathVariant[] | undefined };

/** 사실 하나로 펼친 템플릿이다. */
export interface ExpandedTemplate {
  readonly channel: string;
  readonly constraints: readonly ParamConstraint[];
  /** 0세그먼트 catch-all을 펼친 접두사 decl이면 true */
  readonly catchAllPrefix: boolean;
  /** 빈 값 변형으로 만든 끝 슬래시 템플릿이면 true(끝 슬래시 규칙은 strict다) */
  readonly emptyTail: boolean;
  /** 어느 자리든 빈 값을 채운 변형이면 true */
  readonly emptyVariant: boolean;
  /** 끝이 `{**}`면 true(끝 슬래시 규칙을 싣지 않는다) */
  readonly endsWithCatchAll: boolean;
}

/** 루트 경로 대안이다. */
export const ROOT_VARIANT: PathVariant = { segments: [{ kind: 'literal', text: '' }] };

/**
 * 대안들을 컴파일 결과로 감싼다. 대안이 상한을 넘으면 dynamic이다.
 *
 * @param variants 대안 목록
 * @param prefixes 상한 초과 시 쓸 정적 접두사
 * @returns 컴파일 결과
 */
export function variantsResult(variants: readonly PathVariant[], prefixes?: readonly PathVariant[]): CompiledPath {
  if (variants.length > MAX_TEMPLATE_VARIANTS) return { kind: 'dynamic', reason: 'expansion-capped', prefixes };
  return { kind: 'variants', variants };
}

/**
 * 세그먼트 목록을 대안으로 만든다. `.`·`..` 리터럴 세그먼트는 클라이언트 URL 정규화가 지워 실제 경로가 달라지므로
 * 정규 템플릿으로 쓰지 않는다.
 *
 * @param segments 세그먼트
 * @returns 대안 또는 undefined(점 세그먼트)
 */
export function variantOf(segments: readonly TemplateSegment[]): PathVariant | undefined {
  const hasDot = segments.some((segment) => segment.kind === 'literal' && (segment.text === '.' || segment.text === '..'));
  return hasDot ? undefined : { segments: segments.length === 0 ? ROOT_VARIANT.segments : segments };
}

/**
 * 두 대안을 세그먼트 단위로 잇는다(mount 접두사 + 자식 경로). 접두사가 루트면 자식 그대로, 자식이 루트면 접두사 그대로다.
 *
 * @param prefix 접두사 대안
 * @param child 자식 대안
 * @returns 이은 대안
 */
export function joinVariants(prefix: PathVariant, child: PathVariant): PathVariant {
  if (isRootVariant(prefix)) return child;
  if (isRootVariant(child)) return prefix;
  return { segments: [...prefix.segments, ...child.segments] };
}

/**
 * 대안이 루트(`/`)인지 본다.
 *
 * @param variant 대안
 * @returns 루트면 true
 */
export function isRootVariant(variant: PathVariant): boolean {
  const only = variant.segments[0];
  return variant.segments.length === 1 && only?.kind === 'literal' && only.text === '';
}

/**
 * 대안 하나를 정규 템플릿 문자열로 만든다. catch-all 변형을 펼치지 않은 기본 모양이다.
 *
 * @param variant 대안
 * @returns 정규 템플릿
 */
export function templateOf(variant: PathVariant): string {
  return `/${variant.segments.map(segmentText).join('/')}`;
}

/**
 * 세그먼트 하나의 템플릿 텍스트다.
 *
 * @param segment 세그먼트
 * @returns 텍스트
 */
function segmentText(segment: TemplateSegment): string {
  if (segment.kind === 'literal') return segment.text;
  if (segment.kind === 'catch-all') return '{**}';
  return `${segment.prefix}{}${segment.suffix}`;
}

/**
 * 대안 하나를 사실로 낼 템플릿들로 펼친다: 기본 템플릿, 빈 값 변형(빈 값을 받는 파라미터·catch-all 자리),
 * 0세그먼트 catch-all 접두사. 상한을 넘거나 정규 문법을 어기면 undefined다.
 *
 * @param variant 대안
 * @returns 펼친 템플릿 목록 또는 undefined
 */
export function expandVariant(variant: PathVariant): ExpandedTemplate[] | undefined {
  const shapes = emptyShapes(variant.segments);
  if (shapes === undefined) return undefined;
  const expanded: ExpandedTemplate[] = [];
  for (const shape of shapes) {
    expanded.push(templateFromShape(shape.segments, shape.emptyTail, shape.emptyVariant));
    const last = shape.segments.at(-1);
    if (last?.kind === 'catch-all' && last.zeroSegments) expanded.push(catchAllPrefixTemplate(shape.segments));
  }
  if (expanded.length > MAX_TEMPLATE_VARIANTS) return undefined;
  return expanded.every((entry) => isCanonicalTemplate(entry.channel)) ? dedupe(expanded) : undefined;
}

/** 빈 값 변형 하나의 세그먼트 모양이다. */
interface EmptyShape {
  readonly segments: readonly TemplateSegment[];
  readonly emptyTail: boolean;
  readonly emptyVariant: boolean;
}

/**
 * 빈 값을 받는 자리마다 (원래 모양, 빈 값) 조합을 만든다. 조합 수가 상한을 넘으면 undefined다.
 *
 * @param segments 세그먼트
 * @returns 모양 목록 또는 undefined
 */
function emptyShapes(segments: readonly TemplateSegment[]): EmptyShape[] | undefined {
  let shapes: EmptyShape[] = [{ segments: [], emptyTail: false, emptyVariant: false }];
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const alternatives = segmentAlternatives(segment);
    shapes = shapes.flatMap((shape) => alternatives.map((alternative) => ({
      segments: [...shape.segments, alternative],
      emptyTail: isLast && alternative !== segment && alternative.kind === 'literal' && alternative.text === '',
      emptyVariant: shape.emptyVariant || alternative !== segment,
    })));
    if (shapes.length > MAX_TEMPLATE_VARIANTS) return undefined;
  }
  return shapes;
}

/**
 * 세그먼트 하나의 대안(원래 모양과, 빈 값을 받으면 빈 값을 채운 모양)이다.
 *
 * @param segment 세그먼트
 * @returns 대안 목록
 */
function segmentAlternatives(segment: TemplateSegment): TemplateSegment[] {
  if (segment.kind === 'literal' || !segment.acceptsEmpty) return [segment];
  if (segment.kind === 'catch-all') return [segment, { kind: 'literal', text: '' }];
  return [segment, { kind: 'literal', text: `${segment.prefix}${segment.suffix}` }];
}

/**
 * 모양 하나를 펼친 템플릿으로 만든다.
 *
 * @param segments 세그먼트
 * @param emptyTail 끝 빈 값 변형인지
 * @param emptyVariant 빈 값을 채운 변형인지
 * @returns 펼친 템플릿
 */
function templateFromShape(segments: readonly TemplateSegment[], emptyTail: boolean, emptyVariant: boolean): ExpandedTemplate {
  const variant: PathVariant = { segments };
  return {
    channel: templateOf(variant),
    constraints: constraintsOf(segments),
    catchAllPrefix: false,
    emptyTail,
    emptyVariant,
    endsWithCatchAll: segments.at(-1)?.kind === 'catch-all',
  };
}

/**
 * 0세그먼트 catch-all의 접두사 템플릿을 만든다(루트 catch-all은 `/`).
 *
 * @param segments catch-all로 끝나는 세그먼트
 * @returns 접두사 템플릿
 */
function catchAllPrefixTemplate(segments: readonly TemplateSegment[]): ExpandedTemplate {
  const head = segments.slice(0, -1);
  const prefix: PathVariant = { segments: head.length === 0 ? ROOT_VARIANT.segments : head };
  return { channel: templateOf(prefix), constraints: constraintsOf(head), catchAllPrefix: true, emptyTail: false, emptyVariant: false, endsWithCatchAll: false };
}

/**
 * 세그먼트의 제약을 `paramConstraints` 원소로 만든다. catch-all은 정보용 `path`다.
 *
 * @param segments 세그먼트
 * @returns 제약 목록(인덱스 순)
 */
function constraintsOf(segments: readonly TemplateSegment[]): ParamConstraint[] {
  const constraints: ParamConstraint[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'catch-all') constraints.push({ segment: index, kind: 'path' });
    else if (segment.kind === 'param' && segment.constraint !== undefined) constraints.push({ segment: index, ...segment.constraint });
  }
  return constraints;
}

/**
 * 같은 channel·표식의 템플릿을 하나로 줄인다.
 *
 * @param templates 템플릿 목록
 * @returns 중복을 뺀 목록(첫 등장 순)
 */
function dedupe(templates: readonly ExpandedTemplate[]): ExpandedTemplate[] {
  const seen = new Map<string, ExpandedTemplate>();
  for (const template of templates) {
    const key = `${template.channel}\u0000${template.catchAllPrefix}`;
    if (!seen.has(key)) seen.set(key, template);
  }
  return [...seen.values()];
}

/**
 * dynamic 스코프의 접두사로 쓸 수 있게 대안을 정리한다: catch-all 세그먼트와 그 뒤, 끝 빈 세그먼트를 떼고,
 * 정규 문법을 지키는 템플릿만 남긴다. 루트만 남으면 `/`다.
 *
 * @param prefixes 접두사 대안
 * @returns 접두사 템플릿(정렬·중복 제거)
 */
export function prefixTemplates(prefixes: readonly PathVariant[]): string[] {
  const templates = new Set<string>();
  for (const prefix of prefixes) {
    const cut = prefix.segments.findIndex((segment) => segment.kind === 'catch-all');
    const head = (cut === -1 ? prefix.segments : prefix.segments.slice(0, cut)).filter((segment, index, all) => !(index === all.length - 1 && segment.kind === 'literal' && segment.text === ''));
    const template = head.length === 0 ? '/' : templateOf({ segments: head });
    if (isCanonicalTemplate(template)) templates.add(template);
  }
  return [...templates].sort();
}
