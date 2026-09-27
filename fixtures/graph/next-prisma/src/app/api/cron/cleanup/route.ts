import { JobStore } from '@/lib/repository';

export async function GET() {
  const store = new JobStore('cron-');
  await store.save('tick');
  return new Response('ok');
}
