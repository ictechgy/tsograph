import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

/**
 * D1 바인딩으로 Drizzle 클라이언트를 만든다. 키 이름 컬럼은 snake_case로 바뀐다.
 *
 * @param binding D1 바인딩
 * @returns 클라이언트
 */
export function createDb(binding: D1Database) {
  return drizzle(binding, { schema, casing: 'snake_case' });
}

/** 클라이언트 타입이다. */
export type Db = ReturnType<typeof createDb>;
