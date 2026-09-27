import { type ItemStore, SqlClient, SqlItemStore } from './store';

// 모듈 싱글턴: 팩터리 반환값이 모듈 변수에 담긴다.
function createStore(): ItemStore {
  return new SqlItemStore(new SqlClient());
}

export const itemStore: ItemStore = createStore();

export function readSingleton(id: string) {
  return itemStore.findItem(id);
}
