import { lookup, primaryHandler, service } from '@/compose';
import { type ItemStore, MemoryItemStore } from '@/lib/store';

export async function GET() {
  return Response.json(await primaryHandler.get('1'));
}

export async function POST() {
  await service.save('1');
  return new Response(null, { status: 204 });
}

// 진입점의 매개변수는 프레임워크가 채운다: 기본값이 있어도 흐름을 증명하지 않는다.
export async function PATCH(request: Request, store: ItemStore = new MemoryItemStore()) {
  return Response.json(await store.findItem(request.url));
}

export async function PUT() {
  return Response.json(await lookup.run('1'));
}
