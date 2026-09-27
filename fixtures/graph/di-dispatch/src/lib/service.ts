import type { ItemStore } from './store';

// 생성자 매개변수 주입(매개변수 속성).
export class ItemService {
  constructor(private readonly repository: ItemStore) {}

  save(id: string) {
    return this.repository.saveItem(id);
  }
}
