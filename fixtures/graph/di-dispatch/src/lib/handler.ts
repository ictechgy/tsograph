import type { ItemStore } from './store';

// deps 객체 주입: 속성 타입이 인터페이스다.
export interface HandlerDeps {
  store: ItemStore;
}

export class ItemHandler {
  constructor(private readonly deps: HandlerDeps) {}

  get(id: string) {
    return this.deps.store.findItem(id);
  }
}
