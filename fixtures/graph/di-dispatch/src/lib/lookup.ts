import type { ItemStore } from './store';

// 팩터리 함수: 인터페이스 타입의 객체 리터럴을 돌려준다.
export interface Lookup {
  run(id: string): Promise<string | null>;
}

export function createLookup(deps: { store: ItemStore }): Lookup {
  return { run: (id: string) => deps.store.findItem(id) };
}
