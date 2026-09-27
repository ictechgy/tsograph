import { prisma } from './db';

export async function audit(message: string) {
  await prisma.auditLog.create({ data: { message } });
}
