import { countItems } from './lib/defaults';
import { ItemHandler } from './lib/handler';
import { createLookup } from './lib/lookup';
import { ItemService } from './lib/service';
import { MemoryItemStore, SqlClient, SqlItemStore } from './lib/store';

// 조립 지점(composition root). 같은 ItemHandler가 두 곳에서 다른 구현으로 조립된다.
const sql = new SqlItemStore(new SqlClient());

export const primaryHandler = new ItemHandler({ store: sql });
export const scratchHandler = new ItemHandler({ store: new MemoryItemStore() });
export const service = new ItemService(sql);
export const lookup = createLookup({ store: sql });

export function countDefault(id: string) {
  return countItems(id);
}
