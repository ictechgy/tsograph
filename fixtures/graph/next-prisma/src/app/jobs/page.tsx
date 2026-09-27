import { JobList } from '@/components/job-list';
import { createJobAction } from './actions';

export default async function JobsPage() {
  return (
    <form action={createJobAction}>
      <JobList />
    </form>
  );
}
