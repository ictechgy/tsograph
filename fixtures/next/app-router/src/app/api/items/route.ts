import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json([]);
}

export async function POST(request: Request) {
  return NextResponse.json(await request.json(), { status: 201 });
}

export function helper() {
  return 1;
}
