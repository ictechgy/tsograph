import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { camelize, pluralize, singularize, underscore } from './inflection.ts';
import { usrLines } from './testing.test.ts';

test('define·init 옵션, 자동 속성, 연관 외래 키·조인 테이블, 모델 사용을 읽는다', () => {
  const result = extractProject({
  'src/db.ts': "import { Sequelize, DataTypes, Model } from 'sequelize';\nexport const sequelize = new Sequelize('postgres://x', { define: { ...{ timestamps: false } } });\n",
  'src/models.ts': [
    "import { DataTypes, Model, Op } from 'sequelize';",
    "import { sequelize } from './db';",
    'const shared = { note: DataTypes.STRING };',
    'declare const dynamicName: string;',
    "export const Person = sequelize.define('Person', { ...shared, nick: { type: DataTypes.STRING, field: 'nick_name' }, [dynamicName]: DataTypes.STRING, calc: DataTypes.VIRTUAL(DataTypes.STRING) }, { schema: 'crm', name: { singular: 'human', plural: 'humans' }, version: 'rev', timestamps: true, paranoid: true, deletedAt: 'removed' });",
    "export const Mystery = sequelize.define(dynamicName, { a: DataTypes.STRING });",
    'class BaseModel extends Model {}',
    'export class Team extends BaseModel {',
    "  static setup() { this.init({ code: { type: DataTypes.STRING, primaryKey: true } }, { sequelize, tableName: 'teams', underscored: true }); }",
    '  static associate(models: any) { this.belongsToMany(models.Person, { through: models.Membership, foreignKey: { name: \'teamCode\', field: \'team_ref\' } }); }',
    '}',
    "export const Membership = sequelize.define('Membership', { role: DataTypes.STRING }, { freezeTableName: true });",
    "Person.hasOne(Team, { as: 'leader' });",
    "Person.belongsTo(Person, { as: 'mentor', foreignKey: 'mentorRef' });",
    "Person.belongsToMany(Person, { as: 'friends', through: 'Friendships', otherKey: { name: 'friendRef' } });",
    'Team.belongsToMany(Person, { through: loadThrough() });',
    'declare function loadThrough(): any;',
    '',
  ].join('\n'),
  'src/use.ts': [
    "import { Op } from 'sequelize';",
    "import { sequelize } from './db';",
    "import { Person, Team } from './models';",
    'export async function find(id: number) {',
    "  await sequelize.models.Person.findAll({ where: { [Op.or]: [{ nick: 'a' }], note: 'x' }, attributes: { include: ['nick'], exclude: [['note', 'n']] } });",
    "  await sequelize.model('Team').count({ include: [{ model: Person, include: [{ model: Team, where: { code: 'x' } }] }] });",
    "  await Person.findByPk(id, { attributes: ['nick'] });",
    "  await Person.bulkCreate([{ nick: 'a' }, { note: 'b' }]);",
    '  await sequelize.query(`select * from persons where id = ${id}`);',
    '  return (unknownThing as any).findAll();',
    '}',
    'declare const unknownThing: unknown;',
    '',
  ].join('\n'),
});
  assert.deepEqual(usrLines(result), [
    'src/models.ts:3:18 crm.People.note @src/models.ts#model:Person.note',
    'src/models.ts:5:40 crm.People @src/models.ts#model:Person',
    'src/models.ts:5:40 crm.People.createdAt @src/models.ts#model:Person.createdAt',
    'src/models.ts:5:40 crm.People.id @src/models.ts#model:Person.id',
    'src/models.ts:5:40 crm.People.removed @src/models.ts#model:Person.removed',
    'src/models.ts:5:40 crm.People.rev @src/models.ts#model:Person.rev',
    'src/models.ts:5:40 crm.People.updatedAt @src/models.ts#model:Person.updatedAt',
    'src/models.ts:5:63 crm.People.nick_name @src/models.ts#model:Person.nick',
    'src/models.ts:6:41 sequelize model dynamicName dyn @src/models.ts#model:dynamicName',
    'src/models.ts:8:14 teams @src/models.ts#model:Team',
    'src/models.ts:9:32 teams.code @src/models.ts#model:Team.code',
    'src/models.ts:10:40 Membership.humanId @src/models.ts#model:Membership.humanId',
    'src/models.ts:10:40 Membership.team_ref @src/models.ts#model:Membership.teamCode',
    'src/models.ts:12:44 Membership @src/models.ts#model:Membership',
    'src/models.ts:12:44 Membership.id @src/models.ts#model:Membership.id',
    'src/models.ts:12:60 Membership.role @src/models.ts#model:Membership.role',
    'src/models.ts:13:8 teams.leader_id @src/models.ts#model:Team.leaderId',
    'src/models.ts:14:8 crm.People.mentorRef @src/models.ts#model:Person.mentorRef',
    'src/models.ts:15:8 crm.Friendships @src/models.ts#model:Person.Friendships',
    'src/models.ts:15:8 crm.Friendships.friendRef @src/models.ts#model:Person.Friendships.friendRef',
    'src/models.ts:15:8 crm.Friendships.humanId @src/models.ts#model:Person.Friendships.humanId',
    'src/models.ts:15:8 crm.Friendships.rev @src/models.ts#model:Person.Friendships.rev',
    'src/use.ts:5:33 crm.People @src/use.ts#find',
    'src/use.ts:5:78 crm.People.note @src/use.ts#find',
    'src/use.ts:5:115 crm.People.nick_name @src/use.ts#find',
    'src/use.ts:5:135 crm.People.note @src/use.ts#find',
    'src/use.ts:6:33 teams @src/use.ts#find',
    'src/use.ts:6:60 crm.People @src/use.ts#find',
    'src/use.ts:6:87 teams @src/use.ts#find',
    'src/use.ts:6:102 teams.code @src/use.ts#find',
    'src/use.ts:7:16 crm.People @src/use.ts#find',
    'src/use.ts:7:44 crm.People.nick_name @src/use.ts#find',
    'src/use.ts:8:16 crm.People @src/use.ts#find',
    'src/use.ts:8:30 crm.People.nick_name @src/use.ts#find',
    'src/use.ts:8:45 crm.People.note @src/use.ts#find',
    'src/use.ts:9:25 `select * from persons where id = ${id}` dyn @src/use.ts#find',
  ]);
  assert.deepEqual(result.limitations, [
    "unresolved-orm-receivers: 1 ORM call(s) have a query shape but receivers that could not be traced to a model, repository, or client; not emitted: sequelize (1)",
    "unreadable-orm-declarations: 2 ORM declaration part(s) (spreads, computed keys, non-literal names or options) could not be read statically and were not emitted: sequelize (2)",
    "dynamic-relation-names: 2 SQL argument(s), relation operand(s), or delegate access(es) were not statically readable; they are emitted as dynamic facts",
  ]);
});

test('전역 define이 인스턴스마다 다르면 파생 이름을 확정하지 않는다', () => {
  const result = extractProject({
    'src/a.js': "const { Sequelize, DataTypes } = require('sequelize');\nconst a = new Sequelize('x', { define: { underscored: true } });\nconst b = new Sequelize('y');\na.define('Item', { itemName: DataTypes.STRING, code: { type: DataTypes.STRING, field: 'item_code' } });\nmodule.exports = { a, b };\n",
  });
  assert.deepEqual(usrLines(result), [
    "src/a.js:4:10 sequelize model Item dyn @src/a.js#model:Item",
  ]);
  assert.ok(result.limitations.some((line) => line.startsWith('orm-naming-unverified: sequelize: global define options differ')));
});

test('모르는 수신자의 define은 DataTypes를 쓸 때만 모델로 본다', () => {
  const lines = usrLines(extractProject({
    'src/m.js': "module.exports = (db, DataTypes) => {\n  db.define('Widget', { label: DataTypes.STRING });\n  db.define('NotAModel', { label: 'x' });\n};\nrequire('sequelize');\n",
  }));
  assert.deepEqual(lines.filter((line) => line.includes('#model:')).map((line) => line.split(' ')[1]), ['Widgets', 'Widgets.createdAt', 'Widgets.id', 'Widgets.updatedAt', 'Widgets.label']);
});

test('Sequelize 문자열 변환은 inflection·Sequelize utils와 같다', () => {
  assert.equal(pluralize('Person'), 'People');
  assert.equal(pluralize('Sheep'), 'Sheep');
  assert.equal(singularize('Categories'), 'Category');
  assert.equal(underscore('BlogPostId'), 'blog_post_id');
  assert.equal(camelize('author_id'), 'authorId');
  assert.equal(camelize('trailing_'), 'trailing');
});
