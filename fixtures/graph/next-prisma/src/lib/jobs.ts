import { audit } from './audit';
import { prisma } from '@/lib/db';

export async function listJobs() {
  return prisma.job.findMany({ where: { title: 'open' } });
}

export async function createJob(title: string) {
  const job = await prisma.job.create({ data: { title } });
  await audit(`created ${title}`);
  return job;
}

export function formatJob(job: unknown) {
  return String(job);
}

export default async function countJobs() {
  return (await listJobs()).length;
}
