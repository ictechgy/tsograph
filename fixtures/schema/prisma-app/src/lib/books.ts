import { Prisma, type PrismaClient } from '@/generated/prisma/client';

import { prisma } from './db';

type Tx = Prisma.TransactionClient;

const COUNT_TAGS = 'SELECT count(*) FROM "Tag"';

export async function listBooks(genre: 'FICTION' | 'ESSAY') {
  return prisma.book.findMany({
    select: { id: true, title: true, author: true },
    where: { genre },
    orderBy: [{ title: 'asc' }],
  });
}

export async function tagBook(bookId: number, label: string) {
  await prisma.$transaction(async (tx) => {
    const tag = await tx.tag.upsert({ where: { label }, create: { label }, update: {} });
    await linkTag(tx, bookId, tag.id);
  });
}

async function linkTag(tx: Tx, bookId: number, tagId: number) {
  await tx.$executeRaw`INSERT INTO "_BookToTag" ("A", "B") VALUES (${bookId}, ${tagId})`;
}

export async function authorsByName(name: string) {
  const orderBy = Prisma.sql`ORDER BY full_name`;
  return prisma.$queryRaw`SELECT id FROM authors WHERE full_name = ${name} ${orderBy}`;
}

export async function countTags() {
  return prisma.$queryRawUnsafe(COUNT_TAGS);
}

export async function fromTable(table: string) {
  return prisma.$queryRawUnsafe(`SELECT * FROM ${table}`);
}

export class BookRepository {
  private readonly cache = new Map<number, string>();

  constructor(private readonly db: PrismaClient) {}

  async remove(id: number) {
    this.cache.delete(id);
    return this.db.book.delete({ where: { id } });
  }
}

export async function withContext(context: { db: unknown }) {
  const db = context.db as { book: { findMany(): Promise<unknown[]> } };
  return db.book.findMany();
}
