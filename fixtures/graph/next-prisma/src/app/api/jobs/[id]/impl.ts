import { companyQueries } from '@/lib';

export async function GET() {
  return Response.json(await companyQueries.byId(1));
}
