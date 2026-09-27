import { NextResponse } from 'next/server';

import { addJob, listJobs } from '@/lib';
import countJobs, { formatJob } from '@/lib/jobs';
import * as repository from '@/lib/repository';
import { withAuth } from '@/lib/hof';

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs: jobs.map(formatJob), total: await countJobs() });
}

export const POST = withAuth(async (request: Request) => {
  const job = await addJob(await request.text());
  await repository.saveProven();
  return NextResponse.json(job);
});
