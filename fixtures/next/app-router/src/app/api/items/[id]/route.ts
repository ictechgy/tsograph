const handler = async () => new Response(null, { status: 204 });

export const GET = async () => new Response('item');
export const DELETE = handler;
export { handler as PATCH };
export type { ItemShape } from './types';
export function get() {
  return 'lowercase names are not handlers';
}
