export async function GET() {
  return new Response('proxied');
}

export const HEAD = GET;
