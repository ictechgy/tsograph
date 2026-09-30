import knex from 'knex';

import { activeUsers, recordEvent } from './queries';

const db = knex({ client: 'pg' });

export async function handleLogin(actorId: number) {
  await db.transaction(async (trx) => {
    await recordEvent(trx, actorId);
    await trx('sessions').insert({ actor_id: actorId });
  });
  return activeUsers(db);
}
