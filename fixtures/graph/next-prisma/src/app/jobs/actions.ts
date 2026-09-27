'use server';

import { createJob } from '@/lib/jobs';

export async function createJobAction(form: FormData) {
  await createJob(String(form.get('title')));
}
