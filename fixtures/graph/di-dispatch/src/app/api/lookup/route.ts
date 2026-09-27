import { lookupAnywhere } from '@/lib/open';
import { readSingleton } from '@/lib/singleton';
import { SqlClient, SqlItemStore } from '@/lib/store';

export async function GET() {
  return Response.json(await readSingleton('1'));
}

// lookupAnywhere의 유일한 호출자다: 흐르는 값은 SqlItemStore 하나다.
export async function POST() {
  return Response.json(await lookupAnywhere(new SqlItemStore(new SqlClient()), '2'));
}
