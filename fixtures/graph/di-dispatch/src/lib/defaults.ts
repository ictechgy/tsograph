import { type ItemStore, MemoryItemStore } from './store';

// 기본 매개변수 DI: 호출자가 넘기지 않으면 기본값이 흐른다.
export function countItems(id: string, store: ItemStore = new MemoryItemStore()) {
  return store.findItem(id);
}
