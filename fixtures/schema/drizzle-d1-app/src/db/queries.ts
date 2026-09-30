import { eq, sql } from 'drizzle-orm';

import type { Db } from './client';
import { posts, postTags, tags, users } from './schema';

export function listUsers(db: Db) {
  return db.select({ id: users.id, name: users.displayName }).from(users).orderBy(users.createdAt);
}

export function postsWithAuthors(db: Db, email: string) {
  return db.select().from(posts).innerJoin(users, eq(posts.authorId, users.id)).where(eq(users.emailAddress, email));
}

export function userFeed(db: Db, id: number) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
    columns: { displayName: true, updatedAt: true },
    with: { posts: { columns: { title: true }, with: { postTags: { with: { tag: true } } } } },
  });
}

export function createPost(db: Db, authorId: number) {
  return db.insert(posts).values({ authorId, title: 'draft', bodyHTML: '<p></p>' });
}

export function renameTag(db: Db, id: number, label: string) {
  return db.update(tags).set({ label }).where(eq(tags.id, id));
}

export function unlinkTag(db: Db, tagId: number) {
  return db.delete(postTags).where(eq(postTags.tagId, tagId));
}

export function countPublished(db: Db) {
  return db.select({ total: sql<number>`count(*)` }).from(posts).where(sql`${posts.publishedAt} is not null`);
}

export function authorPostCounts() {
  return sql`select ${users.displayName}, count(*) from ${users} join ${posts} on ${posts.authorId} = ${users.id} group by ${users.id}`;
}
