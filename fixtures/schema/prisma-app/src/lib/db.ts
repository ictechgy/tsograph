import { PrismaClient } from '@/generated/prisma/client';

// 개발 서버의 핫 리로드에서 클라이언트를 재사용하는 관용구다.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();
