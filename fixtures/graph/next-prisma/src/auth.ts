import { audit } from '@/lib/audit';

export const handlers = {
  GET: async () => new Response('session'),
  POST: async () => {
    await audit('login');
    return new Response('signed-in');
  },
};
