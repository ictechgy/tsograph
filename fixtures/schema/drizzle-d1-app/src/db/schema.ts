import { relations } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, sqliteTableCreator, text } from 'drizzle-orm/sqlite-core';

/** 여러 테이블이 공유하는 시각 컬럼이다(키 이름 컬럼은 casing을 받는다). */
const timestamps = {
  createdAt: integer({ mode: 'timestamp' }),
  updatedAt: integer('modified_at', { mode: 'timestamp' }),
};

export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  displayName: text().notNull(),
  emailAddress: text('email').notNull().unique(),
  ...timestamps,
}, (table) => [index('users_email_idx').on(table.emailAddress)]);

export const posts = sqliteTable('blog_posts', (column) => ({
  id: column.integer().primaryKey(),
  authorId: column.integer().notNull().references(() => users.id),
  title: column.text().notNull(),
  bodyHTML: column.text(),
  publishedAt: column.integer('published_on'),
}));

/** 테이블 이름에 접두사를 붙이는 생성기다. */
const appTable = sqliteTableCreator((name) => `app_${name}`);

export const tags = appTable('tags', {
  id: integer().primaryKey(),
  label: text().notNull(),
});

export const postTags = appTable('post_tags', {
  postId: integer().notNull().references(() => posts.id),
  tagId: integer().notNull().references(() => tags.id),
}, (table) => [primaryKey({ columns: [table.postId, table.tagId] })]);

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  postTags: many(postTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));
