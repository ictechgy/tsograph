import { prisma } from '../src/lib/db';

await prisma.author.create({ data: { fullName: 'Synthetic Author' } });
