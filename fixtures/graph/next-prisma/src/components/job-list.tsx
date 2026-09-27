import { formatJob, listJobs } from '@/lib/jobs';

export async function JobList() {
  const jobs = await listJobs();
  return <ul>{jobs.map((job) => <li>{formatJob(job)}</li>)}</ul>;
}
