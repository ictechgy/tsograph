import type { ItemStore } from './store';

declare function externalStore(): ItemStore;

// 호출자가 모두 프로젝트 안(진입점 파일이 아닌 모듈)이면 내보낸 함수라도 닫힌 흐름이다.
export function lookupAnywhere(store: ItemStore, id: string) {
  return store.findItem(id);
}

// 프로젝트 안 호출자가 없는 내보낸 함수: 스캔 밖에서만 불린다고 보고 흐름을 증명하지 않는다.
export function lookupUncalled(store: ItemStore, id: string) {
  return store.findItem(id);
}

// 선언만 있는(구현이 밖에 있는) 함수가 돌려준 값.
export function lookupExternal(id: string) {
  return externalStore().findItem(id);
}

// 값으로 새어 나간 함수: 호출자를 다 알 수 없다.
function viaCallback(store: ItemStore) {
  return store.saveItem('callback');
}

export const callbacks = [viaCallback];
