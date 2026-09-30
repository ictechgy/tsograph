import type { Knex } from 'knex';

export function activeUsers(db: Knex) {
  return db('users as u').leftJoin('orders as o', 'u.id', 'o.user_id').select('u.id', 'u.email', 'o.total').where('u.active', true);
}

export function dailyRevenue(db: Knex) {
  return db.withSchema('reporting').select('day', 'revenue').from('daily_revenue').orderBy('day');
}

export function recordEvent(db: Knex, actorId: number) {
  return db.insert({ event: 'login', actor_id: actorId }).into('audit_events');
}

export function totals(db: Knex, userId: number) {
  return db.raw('select sum(total) from orders where user_id = ?', [userId]);
}

export function productSkus(db: Knex) {
  return db.select('p.sku').from({ p: 'products' }).where('p.archived', false);
}
