/**
 * Sequelize 6 모델 선언·연관·전역 `define` 옵션을 모으고, Sequelize 값 판정 규칙을 제공한다.
 *
 * 이름 규칙(sequelize 6.37.8 `lib/model.js` `init`·`_addDefaultAttributes`, `lib/associations/*.js`로 확인):
 *
 * - 테이블: `tableName`, 없으면 `freezeTableName ? modelName : underscoredIf(pluralize(modelName), underscored)`.
 *   모델 옵션은 `new Sequelize(…, { define })`의 전역 옵션 위에 덮인다(`Utils.merge`).
 * - 컬럼: 속성의 `field`, 없으면 `underscoredIf(속성 이름, underscored)`. `VIRTUAL` 속성은 컬럼이 아니다.
 *   주 키가 없으면 `id`가, `timestamps`(기본 true)면 `createdAt`·`updatedAt`이, `paranoid`면 `deletedAt`이,
 *   `version`이면 `version`이 더해진다(이름은 옵션 문자열로 바뀐다).
 * - 외래 키: `belongsTo`는 `camelize(as ?? 대상 단수 + '_' + 대상 주 키)`를 원본에, `hasMany`는
 *   `camelize(원본 단수 + '_' + 원본 주 키)`를 대상에, `hasOne`은 `camelize(singularize(as ?? 원본 이름) + '_' + 원본 주 키)`를
 *   대상에 더한다. `belongsToMany`의 `through` 문자열은 그대로 조인 테이블 이름이다.
 */

import ts from 'typescript';

import type { SourceModule } from '../source-module.ts';
import { dynamicChannel } from '../relation-facts.ts';
import { bump, type OrmCounts, unwrap, walk } from './orm-facts.ts';
import { camelize, pluralize, singularize, underscore } from './inflection.ts';
import {
  type ExtraDeclaration, type OrmColumn, qualifiedChannel, type SequelizeModel, type SequelizeModelOptions, type TableName,
} from './orm-model.ts';
import { enclosingClass, objectMember, type OrmEvaluator, type OrmValue, type OrmValueRules, propertyNameText } from './orm-values.ts';

/** 표면 이름이다. */
export const SEQUELIZE = 'sequelize';

/** 연관 메서드다. */
const associationMethods: ReadonlySet<string> = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany']);

/** 전역 `define` 옵션(여럿이 다르면 undefined)이다. */
type GlobalDefine = SequelizeModelOptions | undefined;

/** Sequelize 선언 목록이다. */
export class SequelizeCatalog {
  /** 평가기다. */
  private readonly evaluator: OrmEvaluator;
  /** 계수다. */
  private readonly counts: OrmCounts;
  /** `define` 호출·`init` 호출의 클래스 → 모델이다. */
  private readonly models = new Map<ts.Node, SequelizeModel>();
  /** 연관 호출이다. */
  private readonly associationCalls: ts.CallExpression[] = [];
  /** 연관이 만든 조인 테이블·외래 키 선언이다. */
  readonly extras: ExtraDeclaration[] = [];
  /** 외래 키 컬럼 선언(모델, 속성, 컬럼, 위치)이다. */
  readonly foreignKeys: { readonly model: SequelizeModel; readonly key: string; readonly column: string; readonly node: ts.Node }[] = [];
  /** 전역 define 옵션이다. */
  private define: GlobalDefine = {};

  /**
   * @param evaluator 평가기
   * @param counts 계수
   */
  constructor(evaluator: OrmEvaluator, counts: OrmCounts) {
    this.evaluator = evaluator;
    this.counts = counts;
  }

  /** 모든 모델이다(발견 순). */
  get all(): readonly SequelizeModel[] {
    return [...new Set(this.models.values())];
  }

  /**
   * 인스턴스 옵션·모델 선언·연관을 모은다.
   *
   * @param modules 소스 모듈
   */
  discover(modules: readonly SourceModule[]): void {
    const calls: ts.CallExpression[] = [];
    const constructions: ts.NewExpression[] = [];
    for (const module of modules) {
      walk(module.sourceFile, (node) => {
        if (ts.isCallExpression(node)) calls.push(node);
        else if (ts.isNewExpression(node)) constructions.push(node);
      });
    }
    this.define = this.globalDefine(constructions);
    for (const call of calls) this.discoverCall(call);
    this.evaluator.resetCache();
    for (const call of this.associationCalls) this.associate(call);
  }

  /**
   * 이름으로 모델을 찾는다(유일할 때만).
   *
   * @param name 모델 이름
   * @returns 모델 또는 undefined
   */
  modelNamed(name: string): SequelizeModel | undefined {
    const matches = this.all.filter((model) => model.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * 식이 가리키는 모델이다. 정적 메서드의 `this`는 감싼 모델 클래스이고, `associate(models)` 관용구의
   * `models.User`는 이름으로 찾는다.
   *
   * @param expression 식
   * @returns 모델 또는 undefined
   */
  modelOf(expression: ts.Expression): SequelizeModel | undefined {
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = enclosingClass(expression);
      return owner === undefined ? undefined : this.models.get(owner);
    }
    const value = this.evaluator.valueOf(expression);
    if (value.kind === 'sequelize-model') return value.model;
    const inner = unwrap(expression);
    if (ts.isPropertyAccessExpression(inner) && isAssociateModelsParameter(inner.expression)) return this.modelNamed(inner.name.text);
    return undefined;
  }

  /**
   * Sequelize 값 판정 규칙이다.
   *
   * @returns 규칙
   */
  rules(): OrmValueRules {
    return {
      construct: (callee) => (isSequelizeClass(callee) ? { kind: 'sequelize' } : undefined),
      classValue: (node) => modelValue(this.models.get(node)),
      call: (_callee, node) => modelValue(this.models.get(node)),
      methodCall: (receiver, method, node) => {
        if (receiver.kind !== 'sequelize' || method !== 'model') return undefined;
        const [argument] = node.arguments;
        return argument !== undefined && ts.isStringLiteralLike(argument) ? modelValue(this.modelNamed(argument.text)) : undefined;
      },
      member: (receiver, name, node) => this.memberRule(receiver, name, node),
      typeReference: (target) => (target.kind === 'external' && target.module === SEQUELIZE && target.name === 'Sequelize' ? { kind: 'sequelize' } : undefined),
    };
  }

  /**
   * 멤버 규칙: `sequelize.models.User`.
   *
   * @param receiver 수신자 값
   * @param name 멤버 이름
   * @param node 접근 식
   * @returns 값 또는 undefined
   */
  private memberRule(receiver: OrmValue, name: string, node: ts.Expression): OrmValue | undefined {
    if (!ts.isPropertyAccessExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'models') return undefined;
    if (this.evaluator.valueOf(node.expression.expression).kind !== 'sequelize') return undefined;
    return receiver.kind === 'unknown' ? modelValue(this.modelNamed(name)) : undefined;
  }

  /**
   * `new Sequelize(…, { define })`의 전역 옵션을 정한다. 여럿이 다르면 limitation과 함께 undefined다.
   *
   * @param constructions 모든 new 식
   * @returns 전역 옵션
   */
  private globalDefine(constructions: readonly ts.NewExpression[]): GlobalDefine {
    const seen = new Map<string, SequelizeModelOptions>();
    for (const node of constructions) {
      if (!isSequelizeClass(this.evaluator.valueOf(node.expression))) continue;
      const options = lastObjectArgument(node.arguments ?? [], this.evaluator);
      const define = options === undefined ? undefined : objectMember(options, 'define');
      const value = define === undefined ? undefined : this.evaluator.valueOf(define);
      const read = value?.kind === 'object' ? this.readOptions(value.node) : define === undefined ? {} : undefined;
      if (read === undefined) return this.unverifiedDefine();
      seen.set(JSON.stringify(read), read);
    }
    this.evaluator.resetCache();
    if (seen.size > 1) return this.unverifiedDefine();
    return [...seen.values()][0] ?? {};
  }

  /**
   * 전역 옵션을 확정하지 못했음을 기록한다.
   *
   * @returns undefined
   */
  private unverifiedDefine(): GlobalDefine {
    this.counts.namingUnverified.add(`${SEQUELIZE}: global define options differ across Sequelize instances or are not literals; derived table and column names are dynamic or omitted`);
    return undefined;
  }

  /**
   * 호출 하나가 모델 선언·연관이면 기록한다.
   *
   * @param call 호출 식
   */
  private discoverCall(call: ts.CallExpression): void {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    if (associationMethods.has(method)) this.associationCalls.push(call);
    else if (method === 'define') this.discoverDefine(call, callee.expression);
    else if (method === 'init') this.discoverInit(call, callee.expression);
  }

  /**
   * `sequelize.define('Name', attrs, options)`을 기록한다. 수신자가 Sequelize 인스턴스이거나, 모르는 수신자라도
   * 속성 객체가 `DataTypes`를 쓰면(`module.exports = (sequelize, DataTypes) => …` 관용구) 인정한다.
   *
   * @param call define 호출
   * @param receiver 수신자 식
   */
  private discoverDefine(call: ts.CallExpression, receiver: ts.Expression): void {
    const [nameArgument, attributes, options] = call.arguments;
    if (nameArgument === undefined || attributes === undefined) return;
    const isInstance = this.evaluator.valueOf(receiver).kind === 'sequelize';
    if (!isInstance && !this.usesDataTypes(attributes)) return;
    const name = this.evaluator.valueOf(nameArgument);
    const modelName = name.kind === 'string' ? name.value : undefined;
    const symbol = modelName ?? dynamicChannel(nameArgument.getText());
    this.models.set(call, this.buildModel(modelName, symbol, attributes, options, nameArgument));
  }

  /**
   * `class User extends Model {}; User.init(attrs, { sequelize, … })`를 기록한다.
   *
   * @param call init 호출
   * @param receiver 수신자 식(클래스 또는 정적 메서드의 `this`)
   */
  private discoverInit(call: ts.CallExpression, receiver: ts.Expression): void {
    const declaration = receiver.kind === ts.SyntaxKind.ThisKeyword ? enclosingClass(call) : this.classOf(receiver);
    const [attributes, options] = call.arguments;
    if (declaration === undefined || attributes === undefined || !this.extendsModel(declaration, 0)) return;
    const object = options === undefined ? undefined : this.objectOf(options);
    const modelNameExpression = object === undefined ? undefined : objectMember(object, 'modelName');
    const modelNameValue = modelNameExpression === undefined ? undefined : this.evaluator.valueOf(modelNameExpression);
    const className = declaration.name?.text;
    const modelName = modelNameExpression === undefined ? className : modelNameValue?.kind === 'string' ? modelNameValue.value : undefined;
    const model = this.buildModel(modelName, modelName ?? className ?? 'default', attributes, options, declaration.name ?? call);
    this.models.set(declaration, model);
    this.models.set(call, model);
  }

  /**
   * 식이 가리키는 프로젝트 클래스다.
   *
   * @param expression 식
   * @returns 클래스 또는 undefined
   */
  private classOf(expression: ts.Expression): ts.ClassLikeDeclaration | undefined {
    const inner = unwrap(expression);
    const origin = this.evaluator.binder.originOf(ts.isPropertyAccessExpression(inner) ? inner.name : inner);
    return origin.kind === 'declaration' && ts.isClassLike(origin.declaration) ? origin.declaration : undefined;
  }

  /**
   * 클래스가 Sequelize `Model`을 (프로젝트 클래스를 거쳐) 상속하는지 본다.
   *
   * @param declaration 클래스
   * @param depth 상속 깊이
   * @returns 상속하면 true
   */
  private extendsModel(declaration: ts.ClassLikeDeclaration, depth: number): boolean {
    const clause = declaration.heritageClauses?.find((candidate) => candidate.token === ts.SyntaxKind.ExtendsKeyword);
    const expression = clause?.types[0]?.expression;
    if (expression === undefined || depth > 8) return false;
    const value = this.evaluator.valueOf(expression);
    if (value.kind === 'external' && value.module === SEQUELIZE && (value.name === 'Model' || value.name.endsWith('.Model'))) return true;
    const base = this.classOf(expression);
    return base !== undefined && this.extendsModel(base, depth + 1);
  }

  /**
   * 속성 객체가 `DataTypes.X`·`Sequelize.X`를 쓰는지 본다(모르는 수신자 `define`의 증거).
   *
   * @param attributes 속성 식
   * @returns 쓰면 true
   */
  private usesDataTypes(attributes: ts.Expression): boolean {
    const object = this.objectOf(attributes);
    if (object === undefined) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === 'DataTypes' || node.expression.text === 'Sequelize')) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(object);
    return found;
  }

  /**
   * 모델을 만든다.
   *
   * @param modelName 모델 이름(비리터럴이면 undefined)
   * @param symbol 선언 사실 심볼
   * @param attributes 속성 식
   * @param optionsExpression 옵션 식
   * @param node 테이블 사실 위치
   * @returns 모델
   */
  private buildModel(
    modelName: string | undefined, symbol: string, attributes: ts.Expression, optionsExpression: ts.Expression | undefined, node: ts.Node,
  ): SequelizeModel {
    const object = optionsExpression === undefined ? undefined : this.objectOf(optionsExpression);
    const own = object === undefined ? (optionsExpression === undefined ? {} : undefined) : this.readOptions(object);
    const options = own === undefined || this.define === undefined ? undefined : mergeOptions(this.define, own);
    const name = modelName ?? symbol;
    const underscored = options?.underscored ?? false;
    const table = this.tableName(modelName, options, node);
    const model: SequelizeModel = {
      symbol, node, name, table, underscored, options: options ?? {},
      attributes: new Map(), primaryKey: 'id',
      singular: options?.singular ?? singularize(name), plural: options?.plural ?? pluralize(name),
    };
    const primary = this.readAttributes(attributes, model, options !== undefined);
    if (options !== undefined) addDefaultAttributes(model, options, primary, node);
    return { ...model, primaryKey: primary ?? 'id' };
  }

  /**
   * 모델 테이블 이름이다.
   *
   * @param modelName 모델 이름
   * @param options 병합 옵션(확정하지 못하면 undefined)
   * @param node 위치
   * @returns 테이블 이름
   */
  private tableName(modelName: string | undefined, options: SequelizeModelOptions | undefined, node: ts.Node): TableName {
    if (options === undefined || (options.tableName === undefined && modelName === undefined)) {
      return { channel: dynamicChannel(`sequelize model ${modelName ?? node.getText()}`), dynamic: true };
    }
    const name = options.tableName ?? (options.freezeTableName === true ? modelName! : underscoredIf(pluralize(modelName!), options.underscored));
    return { channel: qualifiedChannel(options.schema, name), dynamic: false };
  }

  /**
   * 속성 객체를 읽어 모델에 넣는다.
   *
   * @param attributes 속성 식
   * @param model 모델(속성이 추가된다)
   * @param namesKnown 옵션을 확정해 기본 컬럼 이름을 낼 수 있는지 여부
   * @param depth 스프레드를 따라간 깊이
   * @returns 주 키 속성 이름 또는 undefined
   */
  private readAttributes(attributes: ts.Expression, model: SequelizeModel, namesKnown: boolean, depth = 0): string | undefined {
    const object = this.objectOf(attributes);
    if (object === undefined || depth > 4) {
      bump(this.counts.unreadableDeclarations, SEQUELIZE);
      return undefined;
    }
    let primary: string | undefined;
    for (const property of object.properties) {
      const found = ts.isSpreadAssignment(property)
        ? this.readAttributes(property.expression, model, namesKnown, depth + 1)
        : this.readAttribute(property, model, namesKnown);
      primary ??= found;
    }
    return primary;
  }

  /**
   * 속성 하나를 모델에 넣는다. `VIRTUAL` 속성은 컬럼이 아니라 건너뛴다.
   *
   * @param property 속성 멤버
   * @param model 모델(속성이 추가된다)
   * @param namesKnown 기본 컬럼 이름을 낼 수 있는지 여부
   * @returns 주 키면 속성 이름
   */
  private readAttribute(property: ts.ObjectLiteralElementLike, model: SequelizeModel, namesKnown: boolean): string | undefined {
    const key = property.name === undefined ? undefined : propertyNameText(property.name);
    if (key === undefined || !ts.isPropertyAssignment(property)) {
      bump(this.counts.unreadableDeclarations, SEQUELIZE);
      return undefined;
    }
    const definition = this.objectOf(property.initializer);
    if (isVirtual(definition ?? property.initializer)) return undefined;
    const field = definition === undefined ? undefined : this.stringOption(definition, 'field');
    model.attributes.set(key, { key, column: field ?? (namesKnown ? underscoredIf(key, model.underscored) : undefined), node: property.name });
    return definition !== undefined && objectMember(definition, 'primaryKey')?.kind === ts.SyntaxKind.TrueKeyword ? key : undefined;
  }

  /**
   * 옵션 객체의 이름 관련 옵션을 읽는다. 비리터럴 값은 계수하고 지정하지 않은 것으로 본다.
   *
   * @param object 옵션 객체
   * @returns 옵션
   */
  private readOptions(object: ts.ObjectLiteralExpression): SequelizeModelOptions {
    const name = objectMember(object, 'name');
    const names = name === undefined ? undefined : this.objectOf(name);
    return {
      tableName: this.stringOption(object, 'tableName'),
      freezeTableName: this.booleanOption(object, 'freezeTableName'),
      underscored: this.booleanOption(object, 'underscored'),
      timestamps: this.booleanOption(object, 'timestamps'),
      paranoid: this.booleanOption(object, 'paranoid'),
      createdAt: this.nameOrFalse(object, 'createdAt'),
      updatedAt: this.nameOrFalse(object, 'updatedAt'),
      deletedAt: this.nameOrFalse(object, 'deletedAt'),
      version: this.versionOption(object),
      schema: this.stringOption(object, 'schema'),
      singular: names === undefined ? undefined : this.stringOption(names, 'singular'),
      plural: names === undefined ? undefined : this.stringOption(names, 'plural'),
    };
  }

  /**
   * 불리언 옵션이다(스프레드를 따라간다).
   *
   * @param object 옵션 객체
   * @param key 옵션 이름
   * @returns true·false·undefined(없거나 비리터럴)
   */
  private booleanOption(object: ts.ObjectLiteralExpression, key: string): boolean | undefined {
    const member = this.evaluator.propertyOf(object, key);
    if (member === null || (member !== undefined && member.kind !== ts.SyntaxKind.TrueKeyword && member.kind !== ts.SyntaxKind.FalseKeyword)) {
      bump(this.counts.unreadableDeclarations, SEQUELIZE);
      return undefined;
    }
    return member === undefined ? undefined : member.kind === ts.SyntaxKind.TrueKeyword;
  }

  /**
   * 문자열 또는 `false`인 옵션이다(`createdAt: 'created'`·`createdAt: false`).
   *
   * @param object 옵션 객체
   * @param key 옵션 이름
   * @returns 문자열·false·undefined
   */
  private nameOrFalse(object: ts.ObjectLiteralExpression, key: string): string | false | undefined {
    const member = this.evaluator.propertyOf(object, key);
    if (member === undefined || member === null || member.kind === ts.SyntaxKind.TrueKeyword) return undefined;
    if (member.kind === ts.SyntaxKind.FalseKeyword) return false;
    return this.stringOption(object, key);
  }

  /**
   * `version` 옵션이다(문자열 이름 또는 true).
   *
   * @param object 옵션 객체
   * @returns 이름·true·false·undefined
   */
  private versionOption(object: ts.ObjectLiteralExpression): string | boolean | undefined {
    const member = this.evaluator.propertyOf(object, 'version');
    if (member?.kind === ts.SyntaxKind.TrueKeyword) return true;
    return this.nameOrFalse(object, 'version');
  }

  /**
   * 연관 호출 하나를 적용한다: 외래 키 속성을 모델에 더하고, 조인 테이블 선언을 만든다.
   *
   * @param call 연관 호출
   */
  private associate(call: ts.CallExpression): void {
    const callee = call.expression as ts.PropertyAccessExpression;
    const source = this.modelOf(callee.expression);
    const [targetExpression, optionsExpression] = call.arguments;
    const target = targetExpression === undefined ? undefined : this.modelOf(targetExpression);
    if (source === undefined || target === undefined) return;
    const options = optionsExpression === undefined ? undefined : this.objectOf(optionsExpression);
    const association = { call, source, target, options, as: options === undefined ? undefined : this.stringOption(options, 'as') };
    switch (callee.name.text) {
      case 'belongsTo': this.addForeignKey(source, this.foreignKeyName(options, () => camelize(`${association.as ?? target.singular}_${target.primaryKey}`)), options, callee.name); break;
      case 'hasMany': this.addForeignKey(target, this.foreignKeyName(options, () => camelize(`${source.singular}_${source.primaryKey}`)), options, callee.name); break;
      case 'hasOne': this.addForeignKey(target, this.foreignKeyName(options, () => camelize(`${singularize(association.as ?? source.name)}_${source.primaryKey}`)), options, callee.name); break;
      default: this.addJunction(association, callee.name);
    }
  }

  /**
   * `foreignKey` 옵션(문자열 또는 `{ name }`)의 속성 이름, 없으면 기본 이름이다.
   *
   * @param options 연관 옵션
   * @param fallback 기본 이름 계산
   * @returns 속성 이름 또는 undefined(비리터럴)
   */
  private foreignKeyName(options: ts.ObjectLiteralExpression | undefined, fallback: () => string): string | undefined {
    const member = options === undefined ? undefined : objectMember(options, 'foreignKey');
    if (member === undefined) return fallback();
    const value = this.evaluator.valueOf(member);
    if (value.kind === 'string') return value.value;
    if (value.kind === 'object') return this.stringOption(value.node, 'name') ?? this.stringOption(value.node, 'fieldName');
    bump(this.counts.unreadableDeclarations, SEQUELIZE);
    return undefined;
  }

  /**
   * 외래 키 속성을 모델에 더하고 선언을 기록한다. 이미 있는 속성이면 그 컬럼을 쓴다.
   *
   * @param owner 외래 키를 갖는 모델
   * @param key 속성 이름
   * @param options 연관 옵션(`foreignKey.field`)
   * @param node 위치(연관 메서드 이름)
   */
  private addForeignKey(owner: SequelizeModel, key: string | undefined, options: ts.ObjectLiteralExpression | undefined, node: ts.Node): void {
    if (key === undefined || owner.table.dynamic) return;
    const existing = owner.attributes.get(key);
    const column = existing?.column ?? this.foreignKeyField(options, 'foreignKey') ?? underscoredIf(key, owner.underscored);
    if (existing === undefined) owner.attributes.set(key, { key, column, node });
    this.foreignKeys.push({ model: owner, key, column, node });
  }

  /**
   * `foreignKey: { field }`처럼 명시한 컬럼 이름이다.
   *
   * @param options 연관 옵션
   * @param key `foreignKey`·`otherKey`
   * @returns 컬럼 이름 또는 undefined
   */
  private foreignKeyField(options: ts.ObjectLiteralExpression | undefined, key: string): string | undefined {
    const member = options === undefined ? undefined : objectMember(options, key);
    const value = member === undefined ? undefined : this.evaluator.valueOf(member);
    return value?.kind === 'object' ? this.stringOption(value.node, 'field') : undefined;
  }

  /**
   * `belongsToMany`의 조인 테이블을 만든다(문자열 `through`) 또는 조인 모델에 외래 키를 더한다.
   *
   * @param association 연관 정보
   * @param node 위치
   */
  private addJunction(association: Association, node: ts.Node): void {
    const { source, target, options, as } = association;
    const through = options === undefined ? undefined : objectMember(options, 'through');
    const throughValue = through === undefined ? undefined : this.evaluator.valueOf(through);
    const throughName = throughValue?.kind === 'string' ? throughValue.value
      : throughValue?.kind === 'object' ? this.stringOption(throughValue.node, 'model') : undefined;
    const isSelf = source === target;
    const foreignKey = this.foreignKeyName(options, () => camelize(`${source.singular}_${source.primaryKey}`));
    const otherKey = this.otherKeyName(options, () => camelize(`${isSelf && as !== undefined ? singularize(as) : target.singular}_${target.primaryKey}`));
    const throughModel = throughName === undefined && through !== undefined ? this.modelOf(through) : undefined;
    if (throughModel !== undefined) {
      this.addForeignKey(throughModel, foreignKey, options, node);
      this.addForeignKey(throughModel, otherKey, undefined, node);
      return;
    }
    if (throughName === undefined || this.define === undefined) {
      bump(this.counts.unreadableDeclarations, SEQUELIZE);
      return;
    }
    this.extras.push(this.junctionDeclaration(association, throughName, [foreignKey, otherKey], node));
  }

  /**
   * `otherKey` 옵션의 속성 이름, 없으면 기본 이름이다.
   *
   * @param options 연관 옵션
   * @param fallback 기본 이름 계산
   * @returns 속성 이름 또는 undefined
   */
  private otherKeyName(options: ts.ObjectLiteralExpression | undefined, fallback: () => string): string | undefined {
    const member = options === undefined ? undefined : objectMember(options, 'otherKey');
    if (member === undefined) return fallback();
    const value = this.evaluator.valueOf(member);
    if (value.kind === 'string') return value.value;
    return value.kind === 'object' ? this.stringOption(value.node, 'name') : undefined;
  }

  /**
   * 문자열 `through`의 조인 테이블 선언이다. 조인 모델은 원본 모델 옵션(`underscored`·타임스탬프 이름·스키마)을
   * 물려받고(`associations/mixin.js`), 타임스탬프는 연관·전역 옵션을 따른다.
   *
   * @param association 연관 정보
   * @param table 조인 테이블 이름
   * @param keys 외래 키 속성 이름
   * @param node 위치
   * @returns 추가 선언
   */
  private junctionDeclaration(association: Association, table: string, keys: readonly (string | undefined)[], node: ts.Node): ExtraDeclaration {
    const { source, options } = association;
    const inherited = source.options;
    const timestamps = (options === undefined ? undefined : this.booleanOption(options, 'timestamps')) ?? this.define?.timestamps ?? true;
    const junction: SequelizeModelOptions = { ...inherited, paranoid: false, timestamps, tableName: table };
    const columns = keys.filter((key): key is string => key !== undefined).map((key) => underscoredIf(key, junction.underscored));
    for (const [attribute] of timestampAttributes(junction)) columns.push(underscoredIf(attribute, junction.underscored));
    return { symbol: `${source.symbol}.${table}`, node, table: { channel: qualifiedChannel(junction.schema, table), dynamic: false }, columns };
  }

  /**
   * 식이 객체 리터럴(또는 그것을 담은 const)이면 돌려준다.
   *
   * @param expression 식
   * @returns 객체 리터럴 또는 undefined
   */
  private objectOf(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
    const inner = unwrap(expression);
    if (ts.isObjectLiteralExpression(inner)) return inner;
    const value = this.evaluator.valueOf(inner);
    return value.kind === 'object' ? value.node : undefined;
  }

  /**
   * 옵션 객체의 문자열 속성이다. 비리터럴이면 계수한다.
   *
   * @param object 옵션 객체
   * @param key 속성 이름
   * @returns 문자열 또는 undefined
   */
  private stringOption(object: ts.ObjectLiteralExpression, key: string): string | undefined {
    const member = this.evaluator.propertyOf(object, key);
    if (member === undefined) return undefined;
    const value = member === null ? undefined : this.evaluator.valueOf(member);
    if (value === undefined) {
      bump(this.counts.unreadableDeclarations, SEQUELIZE);
      return undefined;
    }
    if (value.kind === 'string') return value.value;
    bump(this.counts.unreadableDeclarations, SEQUELIZE);
    return undefined;
  }
}

/** 연관 호출 하나의 정보다. */
interface Association {
  readonly call: ts.CallExpression;
  readonly source: SequelizeModel;
  readonly target: SequelizeModel;
  readonly options: ts.ObjectLiteralExpression | undefined;
  readonly as: string | undefined;
}

/**
 * 모델을 값으로 감싼다.
 *
 * @param model 모델 또는 undefined
 * @returns 값 또는 undefined
 */
function modelValue(model: SequelizeModel | undefined): OrmValue | undefined {
  return model === undefined ? undefined : { kind: 'sequelize-model', model };
}

/**
 * 값이 `Sequelize` 클래스(이름 있는 export 또는 CommonJS 모듈 자체)인지 본다.
 *
 * @param value 값
 * @returns 맞으면 true
 */
function isSequelizeClass(value: OrmValue): boolean {
  return value.kind === 'external' && value.module === SEQUELIZE && ['Sequelize', '*', 'default', 'Sequelize.Sequelize'].includes(value.name);
}

/**
 * 식이 `associate(models)` 메서드·함수의 첫 매개변수인지 본다(sequelize-cli 관용구).
 *
 * @param expression 식
 * @returns 맞으면 true
 */
function isAssociateModelsParameter(expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  for (let current: ts.Node | undefined = expression.parent; current !== undefined; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const first = current.parameters[0];
    const name = current.name !== undefined && ts.isIdentifier(current.name) ? current.name.text
      : ts.isPropertyAssignment(current.parent) || ts.isBinaryExpression(current.parent) ? associateTargetName(current.parent) : undefined;
    return name === 'associate' && first !== undefined && ts.isIdentifier(first.name) && first.name.text === expression.text;
  }
  return false;
}

/**
 * `User.associate = function (models) {…}`·`{ associate: (models) => … }`의 이름 자리다.
 *
 * @param parent 함수의 부모
 * @returns 이름 또는 undefined
 */
function associateTargetName(parent: ts.PropertyAssignment | ts.BinaryExpression): string | undefined {
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
  return ts.isPropertyAccessExpression(parent.left) ? parent.left.name.text : undefined;
}

/**
 * 인자 중 마지막 객체(리터럴 또는 const)다.
 *
 * @param args 인자 목록
 * @param evaluator 평가기
 * @returns 객체 리터럴 또는 undefined
 */
function lastObjectArgument(args: readonly ts.Expression[], evaluator: OrmEvaluator): ts.ObjectLiteralExpression | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const value = evaluator.valueOf(args[index]!);
    if (value.kind === 'object') return value.node;
  }
  return undefined;
}

/**
 * 전역 define 옵션 위에 모델 옵션을 덮는다(`Utils.merge`: undefined는 덮지 않는다).
 *
 * @param base 전역 옵션
 * @param own 모델 옵션
 * @returns 병합 옵션
 */
function mergeOptions(base: SequelizeModelOptions, own: SequelizeModelOptions): SequelizeModelOptions {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(own)) if (value !== undefined) result[key] = value;
  return result as SequelizeModelOptions;
}

/**
 * 속성 정의가 `DataTypes.VIRTUAL`(컬럼 없음)인지 본다.
 *
 * @param definition 속성 정의 객체 또는 타입 식
 * @returns VIRTUAL이면 true
 */
function isVirtual(definition: ts.Expression): boolean {
  const type = ts.isObjectLiteralExpression(definition) ? objectMember(definition, 'type') : definition;
  if (type === undefined) return false;
  const inner = ts.isCallExpression(type) ? type.expression : type;
  return ts.isPropertyAccessExpression(inner) && inner.name.text === 'VIRTUAL';
}

/**
 * 조건이 참이면 inflection `underscore`를 적용한다(Sequelize `underscoredIf`).
 *
 * @param text 이름
 * @param condition 적용 여부
 * @returns 이름
 */
export function underscoredIf(text: string, condition: boolean | undefined): string {
  return condition === true ? underscore(text) : text;
}

/**
 * 옵션이 켜는 타임스탬프·버전 속성 이름이다(`init`의 `_timestampAttributes`·`_versionAttribute`).
 *
 * @param options 병합 옵션
 * @returns [속성 이름] 목록
 */
function timestampAttributes(options: SequelizeModelOptions): [string][] {
  const result: [string][] = [];
  if (options.timestamps !== false) {
    if (options.createdAt !== false) result.push([options.createdAt ?? 'createdAt']);
    if (options.updatedAt !== false) result.push([options.updatedAt ?? 'updatedAt']);
    if (options.paranoid === true && options.deletedAt !== false) result.push([options.deletedAt ?? 'deletedAt']);
  }
  if (options.version !== undefined && options.version !== false) result.push([typeof options.version === 'string' ? options.version : 'version']);
  return result;
}

/**
 * 자동 추가 속성(`id`, 타임스탬프, 버전)을 모델에 더한다(`_addDefaultAttributes`).
 *
 * @param model 모델
 * @param options 병합 옵션
 * @param primary 선언한 주 키 속성
 * @param node 위치
 */
function addDefaultAttributes(model: SequelizeModel, options: SequelizeModelOptions, primary: string | undefined, node: ts.Node): void {
  const add = (key: string): void => {
    if (!model.attributes.has(key)) model.attributes.set(key, { key, column: underscoredIf(key, model.underscored), node } satisfies OrmColumn);
  };
  if (primary === undefined) add('id');
  for (const [attribute] of timestampAttributes(options)) add(attribute);
}
