import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { ormLines, usrLines } from './testing.test.ts';
import { camelCase, snakeCase, titleCase } from './typeorm-catalog.ts';

/** 이름 규칙 사례를 담은 엔터티다. */
const entities: Record<string, string> = {
  'src/user.ts': [
    "import { Entity, Column, PrimaryGeneratedColumn, OneToMany, ManyToMany, JoinTable, BaseEntity, ViewEntity, ViewColumn } from 'typeorm';",
    "import { Photo } from './photo';",
    '@Entity()',
    'export class User extends BaseEntity {',
    '  @PrimaryGeneratedColumn() id!: number;',
    "  @Column(() => Meta, { prefix: false }) meta!: Meta;",
    "  @Column(() => Meta, { prefix: '' }) meta2!: Meta;",
    "  @Column(() => Meta, { prefix: 'm' }) meta3!: Meta;",
    "  @Column({ type: 'int', primary: true }) tenant!: number;",
    '  @OneToMany(() => Photo, (p) => p.owner) photos!: Photo[];',
    "  @ManyToMany('Photo') @JoinTable({ name: 'user_likes', joinColumn: { name: 'uid' }, inverseJoinColumn: { name: 'pid' } }) likes!: Photo[];",
    '}',
    'export class Meta { @Column() note!: string; }',
    "@ViewEntity({ name: 'user_stats', expression: 'select 1' })",
    'export class UserStats { @ViewColumn({ name: \'n\' }) total!: number; }',
    '',
  ].join('\n'),
  'src/photo.ts': [
    "import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';",
    "import type { User } from './user';",
    "@Entity('photos')",
    'export class Photo {',
    '  @PrimaryColumn() key!: string;',
    "  @ManyToOne('User', 'photos') @JoinColumn([{ name: 'owner_id', referencedColumnName: 'id' }]) owner!: User;",
    '}',
    '',
  ].join('\n'),
};

test('기본 이름 규칙: snake_case 테이블, 임베디드 접두사, 뷰, 조인 컬럼·조인 테이블 옵션', () => {
  assert.deepEqual(ormLines(entities), [
    'src/photo.ts:4:14 photos @src/photo.ts#model:Photo',
    'src/photo.ts:5:20 photos.key @src/photo.ts#model:Photo.key',
    'src/photo.ts:6:96 photos.owner_id @src/photo.ts#model:Photo.owner',
    'src/user.ts:4:14 user @src/user.ts#model:User',
    'src/user.ts:5:29 user.id @src/user.ts#model:User.id',
    'src/user.ts:6:42 user.note @src/user.ts#model:User.meta.note',
    'src/user.ts:7:39 user.note @src/user.ts#model:User.meta2.note',
    'src/user.ts:8:40 user.mNote @src/user.ts#model:User.meta3.note',
    'src/user.ts:9:43 user.tenant @src/user.ts#model:User.tenant',
    'src/user.ts:11:124 user_likes @src/user.ts#model:User.likes',
    'src/user.ts:11:124 user_likes.pid @src/user.ts#model:User.likes.pid',
    'src/user.ts:11:124 user_likes.uid @src/user.ts#model:User.likes.uid',
    'src/user.ts:15:14 user_stats @src/user.ts#model:UserStats',
    'src/user.ts:15:53 user_stats.n @src/user.ts#model:UserStats.total',
  ]);
});

test('사용자 namingStrategy가 있으면 명시 이름만 확정하고, 스키마 옵션은 postgres에서 테이블을 한정한다', () => {
  const result = extractProject({
    ...entities,
    'src/ds.ts': "import { DataSource } from 'typeorm';\nimport { SnakeNamingStrategy } from 'typeorm-naming-strategies';\nexport const ds = new DataSource({ type: 'postgres', schema: 'app', namingStrategy: new SnakeNamingStrategy() });\n",
  });
  assert.deepEqual(usrLines(result), [
    'src/photo.ts:4:14 app.photos @src/photo.ts#model:Photo',
    'src/photo.ts:6:96 app.photos.owner_id @src/photo.ts#model:Photo.owner',
    'src/user.ts:4:14 Entity() class User dyn @src/user.ts#model:User',
    'src/user.ts:11:124 app.user_likes @src/user.ts#model:User.likes',
    'src/user.ts:11:124 app.user_likes.pid @src/user.ts#model:User.likes.pid',
    'src/user.ts:11:124 app.user_likes.uid @src/user.ts#model:User.likes.uid',
    'src/user.ts:15:14 app.user_stats @src/user.ts#model:UserStats',
    'src/user.ts:15:53 app.user_stats.n @src/user.ts#model:UserStats.total',
  ]);
  assert.ok(result.limitations.includes('orm-naming-unverified: typeorm: a custom namingStrategy is configured; only explicitly named tables and columns are emitted, other table names are dynamic'));
});

test('DataSource 접두사가 엇갈리거나 비리터럴이면 테이블 이름은 dynamic이다', () => {
  const result = extractProject({
    ...entities,
    'src/ds.ts': "import { DataSource } from 'typeorm';\nexport const ds = new DataSource({ type: 'postgres', schema: 'app' });\nexport const other = new DataSource({ type: 'sqlite', entityPrefix: process.env.P });\n",
  });
  assert.ok(usrLines(result).includes("src/photo.ts:4:14 Entity('photos') class Photo dyn @src/photo.ts#model:Photo"));
  assert.ok(result.limitations.includes('orm-naming-unverified: typeorm: DataSource options disagree on entityPrefix; table names are dynamic; typeorm: entityPrefix is not a string literal; table names are dynamic'));
});

test('저장소·ActiveRecord·EntityManager·QueryBuilder 사용과 관계·컬럼 옵션을 읽는다', () => {
  const result = extractProject({
  'src/entities.ts': [
    "import { Entity, Column, PrimaryGeneratedColumn, OneToMany, ManyToOne, ManyToMany, JoinTable, BaseEntity } from 'typeorm';",
    '@Entity()',
    'export class Author extends BaseEntity {',
    '  @PrimaryGeneratedColumn() id!: number;',
    "  @Column({ name: 'pen_name' }) penName!: string;",
    '  @OneToMany(() => Book, (b) => b.author) books!: Book[];',
    '  @ManyToMany(() => Genre, (g) => g.authors) @JoinTable() genres!: Genre[];',
    '}',
    '@Entity()',
    'export class Book { @PrimaryGeneratedColumn() id!: number; @Column() title!: string; @ManyToOne(() => Author, (a) => a.books) author!: Author; }',
    '@Entity()',
    'export class Genre { @PrimaryGeneratedColumn() id!: number; @Column() label!: string; @ManyToMany(() => Author, (a) => a.genres) authors!: Author[]; }',
    '',
  ].join('\n'),
  'src/usage.ts': [
    "import { getRepository, Repository, EntityManager, DataSource } from 'typeorm';",
    "import { InjectRepository, InjectEntityManager } from '@nestjs/typeorm';",
    "import { Author, Book, Genre } from './entities';",
    'export class BookRepository extends Repository<Book> {',
    "  recent() { return this.find({ order: { title: 'ASC' } }); }",
    '}',
    'export class Service {',
    '  @InjectRepository(Genre) private genres!: Repository<Genre>;',
    '  constructor(@InjectEntityManager() private readonly em: EntityManager, private readonly source: DataSource) {}',
    '  async run() {',
    "    await Author.findOne({ where: [{ penName: 'a' }, { id: 1 }], relations: { books: true, genres: { authors: true } } });",
    "    await this.genres.findBy({ label: 'x' });",
    "    await this.genres.find({ relations: ['authors.books'], select: { label: true } });",
    "    await getRepository(Book).update({ title: 'a' }, { title: 'b' });",
    "    await this.em.find(Book, { where: { title: 'x' } });",
    "    await this.em.createQueryBuilder(Author, 'a').innerJoin('a.books', 'b').leftJoin(Genre, 'g').getMany();",
    "    await this.source.createQueryBuilder().select('*').from('legacy_table', 'l').innerJoinAndMapOne('l.x', Book, 'bk', 'true').getRawMany();",
    "    await this.source.createQueryBuilder().update(Book).set({ title: 'z' }).execute();",
    "    await this.em.query('select * from raw_books');",
    '    await this.em.getRepository(Author).query(`select 1 from ${Date.now()}`);',
    "    await this.source.manager.transaction(async (tx) => tx.delete(Genre, { label: 'x' }));",
    "    await this.em.withRepository(this.genres).count();",
    "    return (other as any).findOneBy({ id: 1 });",
    '  }',
    '}',
    'declare const other: unknown;',
    '',
  ].join('\n'),
});
  assert.deepEqual(usrLines(result).filter((line) => line.startsWith('src/usage.ts')), [
    'src/usage.ts:5:26 book @src/usage.ts#BookRepository.recent',
    'src/usage.ts:5:42 book.title @src/usage.ts#BookRepository.recent',
    'src/usage.ts:11:18 author @src/usage.ts#Service.run',
    'src/usage.ts:11:38 author.pen_name @src/usage.ts#Service.run',
    'src/usage.ts:11:56 author.id @src/usage.ts#Service.run',
    'src/usage.ts:11:79 book @src/usage.ts#Service.run',
    'src/usage.ts:11:92 author_genres_genre @src/usage.ts#Service.run',
    'src/usage.ts:11:92 genre @src/usage.ts#Service.run',
    'src/usage.ts:11:102 author @src/usage.ts#Service.run',
    'src/usage.ts:11:102 author_genres_genre @src/usage.ts#Service.run',
    'src/usage.ts:12:23 genre @src/usage.ts#Service.run',
    'src/usage.ts:12:32 genre.label @src/usage.ts#Service.run',
    'src/usage.ts:13:23 genre @src/usage.ts#Service.run',
    'src/usage.ts:13:42 author @src/usage.ts#Service.run',
    'src/usage.ts:13:42 author_genres_genre @src/usage.ts#Service.run',
    'src/usage.ts:13:42 book @src/usage.ts#Service.run',
    'src/usage.ts:13:70 genre.label @src/usage.ts#Service.run',
    'src/usage.ts:14:31 book @src/usage.ts#Service.run',
    'src/usage.ts:14:40 book.title @src/usage.ts#Service.run',
    'src/usage.ts:14:56 book.title @src/usage.ts#Service.run',
    'src/usage.ts:15:24 book @src/usage.ts#Service.run',
    'src/usage.ts:15:41 book.title @src/usage.ts#Service.run',
    'src/usage.ts:16:38 author @src/usage.ts#Service.run',
    'src/usage.ts:16:61 book @src/usage.ts#Service.run',
    'src/usage.ts:16:86 genre @src/usage.ts#Service.run',
    'src/usage.ts:17:61 legacy_table @src/usage.ts#Service.run',
    'src/usage.ts:17:108 book @src/usage.ts#Service.run',
    'src/usage.ts:18:51 book @src/usage.ts#Service.run',
    'src/usage.ts:19:25 raw_books @src/usage.ts#Service.run',
    'src/usage.ts:20:47 `select 1 from ${Date.now()}` dyn @src/usage.ts#Service.run',
    'src/usage.ts:21:67 genre @src/usage.ts#Service.run',
    'src/usage.ts:21:76 genre.label @src/usage.ts#Service.run',
    'src/usage.ts:22:47 genre @src/usage.ts#Service.run',
  ]);
  assert.ok(result.limitations.includes('unresolved-orm-receivers: 1 ORM call(s) have a query shape but receivers that could not be traced to a model, repository, or client; not emitted: typeorm (1)'));
});

test('TypeORM 문자열 변환은 라이브러리 StringUtils와 같다', () => {
  assert.equal(snakeCase('UserProfileHTTPLog'), 'user_profile_http_log');
  assert.equal(camelCase('user_profile_id'), 'userProfileId');
  assert.equal(camelCase('Owner id-x'), 'ownerIdX');
  assert.equal(titleCase('LAST name'), 'Last Name');
});
