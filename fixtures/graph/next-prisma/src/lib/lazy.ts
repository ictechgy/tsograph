import { prisma } from './db';

export async function heavy() {
  return prisma.company.findMany();
}
