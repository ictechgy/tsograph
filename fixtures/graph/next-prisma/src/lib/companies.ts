import { prisma } from './db';

export const companyQueries = {
  byId: async (id: number) => prisma.company.findMany({ where: { id } }),
};
