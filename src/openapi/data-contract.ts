/** 지원 범위를 제한한 OpenAPI 데이터 계약 근거다. 완전성·실패 판정은 하지 않는다. */
import { isScalar, type ParsedNode } from 'yaml';
import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import type { SpecTree } from './spec-tree.ts';

/** Isthmus의 선택적 데이터 계약 v1 필드다. */
export interface DataField { readonly in: 'request-body' | 'response-body' | 'query' | 'header'; readonly path: string; readonly type?: string; readonly nullable?: boolean; readonly required?: boolean }
/** 소비자가 제한을 버리지 않도록 근거와 한계를 함께 전달한다. */
export interface DataContract { readonly version: 1; readonly fields: readonly DataField[]; readonly limitations: readonly string[] }
/** 필드 수의 상한이다. */
export const MAX_DATA_FIELDS = 512;

/** scalar boolean을 추측 없이 읽는다. */
function boolean(tree: SpecTree, node: ParsedNode | undefined): boolean | undefined {
  const value = tree.resolve(node);
  return isScalar(value) && typeof value.value === 'boolean' ? value.value : undefined;
}
/** 경로 구분자와 필드 이름이 충돌하지 않게 JSON Pointer 구역을 쓴다. */
function segment(value: string): string { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }

/** operation 수준의 inline primitive field만 추출한다. 나머지는 명시적 unknown이다. */
export function extractDataContract(tree: SpecTree, operation: ParsedNode): DataContract {
  const fields: DataField[] = [];
  const limitations = new Set<string>([
    'bounded-contract: only inline top-level primitive properties and operation-level query/header parameters are observed; compatibility is not established',
    'not-assessed: path-level parameters, cookies, path parameters, serialization, defaults, examples, formats, enums and validation constraints',
  ]);
  const add = (field: DataField) => {
    if (!isSafeIdentifier(field.path) || field.path.length > 1024) { limitations.add('field-path: unsupported or oversized field path'); return; }
    if (fields.length === MAX_DATA_FIELDS) { limitations.add('field-budget: more than 512 supported fields; remaining fields not assessed'); return; }
    fields.push(field);
  };
  const primitive = (node: ParsedNode | null | undefined): { type: string; nullable?: boolean } | undefined => {
    if (['$ref', 'allOf', 'anyOf', 'oneOf', 'not'].some((key) => tree.get(node, key) !== undefined)) { limitations.add('schema: references and combinators not assessed'); return undefined; }
    const type = tree.string(tree.get(node, 'type'));
    if (type === undefined || !['string', 'number', 'integer', 'boolean'].includes(type)) { limitations.add('schema: nested, array, union, missing or unsupported types not assessed'); return undefined; }
    const nullable = boolean(tree, tree.get(node, 'nullable'));
    return { type, ...(nullable === undefined ? {} : { nullable }) };
  };
  const schema = (node: ParsedNode | undefined, scope: DataField['in'], prefix: string) => {
    if (node === undefined || tree.get(node, '$ref') !== undefined || ['allOf', 'anyOf', 'oneOf'].some((key) => tree.get(node, key) !== undefined)) { limitations.add('body-schema: missing, referenced or composed schemas not assessed'); return; }
    const properties = tree.entries(tree.get(node, 'properties'));
    if (properties === undefined) { limitations.add('body-schema: only explicit top-level object properties are observed'); return; }
    const requiredNode = tree.get(node, 'required');
    const requiredItems = tree.items(requiredNode);
    const required = requiredItems?.map((entry) => tree.string(entry));
    for (const property of properties) {
      if (property.key === undefined) { limitations.add('field-name: non-string property name not assessed'); continue; }
      const value = primitive(property.value);
      if (value === undefined) continue;
      add({ in: scope, path: `${prefix}/${segment(property.key)}`, ...value,
        ...(requiredNode === undefined ? {} : required !== undefined && required.every((item) => item !== undefined) ? { required: required.includes(property.key) } : {}),
      });
    }
    if (requiredNode !== undefined && (required === undefined || required.some((item) => item === undefined))) limitations.add('required: malformed required list not assessed');
  };
  const content = (node: ParsedNode | undefined, scope: DataField['in'], prefix: string) => {
    const media = tree.entries(node);
    if (media === undefined) { limitations.add('body-content: missing or Swagger 2 body content not assessed'); return; }
    for (const item of media) {
      if (item.key === undefined) { limitations.add('body-content: non-string media type not assessed'); continue; }
      schema(tree.get(item.value, 'schema'), scope, `${prefix}/${segment(item.key)}`);
    }
  };
  content(tree.get(tree.get(operation, 'requestBody'), 'content'), 'request-body', '');
  const responses = tree.entries(tree.get(operation, 'responses'));
  if (responses === undefined) limitations.add('responses: missing or unsupported response declarations');
  for (const response of responses ?? []) {
    if (response.key === undefined) { limitations.add('responses: non-string status not assessed'); continue; }
    content(tree.get(response.value, 'content'), 'response-body', `/${segment(response.key)}`);
  }
  const parameters = tree.get(operation, 'parameters');
  const items = tree.items(parameters);
  if (parameters !== undefined && items === undefined) limitations.add('parameters: malformed parameter list not assessed');
  for (const parameter of items ?? []) {
    const scope = tree.string(tree.get(parameter, 'in'));
    const name = tree.string(tree.get(parameter, 'name'));
    if ((scope !== 'query' && scope !== 'header') || name === undefined || tree.get(parameter, '$ref') !== undefined) { limitations.add('parameters: referenced, unnamed or unsupported parameter location not assessed'); continue; }
    const value = primitive(tree.get(parameter, 'schema') ?? parameter);
    if (value === undefined) continue;
    const required = boolean(tree, tree.get(parameter, 'required'));
    add({ in: scope, path: segment(name), ...value, ...(required === undefined ? {} : { required }) });
  }
  return { version: 1, fields, limitations: [...limitations].sort() };
}
