export { GET } from './impl';

const remove = async () => {
  const { heavy } = await import('@/lib/lazy');
  return Response.json(await heavy());
};

export { remove as DELETE };
