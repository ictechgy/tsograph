/**
 * mount 접두사와 라우트 경로 조각(정적 값)을 프레임워크 규칙으로 잇는다.
 *
 * 접두사 조각이 확정되지 않으면(`unknown`) 그 앞은 알 수 없는 base가 되어 앵커가 `base`이고 뒤 조각만 잇는다. 앞부분만
 * 확정된 조각(`partial`)을 만나면 그 뒤는 모르므로 거기서 멈추고 확정한 앞부분을 돌려준다(dynamic 스코프 접두사용).
 */

import type { PathAnchor } from '../../exchange/bridge-facts.ts';
import type { PathValue } from './router-model.ts';

/** 이은 결과다. */
export type JoinedPath =
  | { readonly kind: 'literal'; readonly text: string; readonly anchor: PathAnchor }
  /** 앞부분만 확정했다. `head`는 확정한 앞부분이다. */
  | { readonly kind: 'partial'; readonly head: string; readonly anchor: PathAnchor };

/**
 * 조각들을 잇는다.
 *
 * @param pieces 앞에서부터의 조각(접두사들, 마지막은 라우트 경로일 수 있다)
 * @param initial 시작 경로(루트)
 * @param merge 두 경로를 잇는 프레임워크 함수
 * @returns 이은 결과
 */
export function joinPieces(pieces: readonly PathValue[], initial: string, merge: (base: string, sub: string) => string): JoinedPath {
  let text = initial;
  let anchor: PathAnchor = 'root';
  for (const piece of pieces) {
    if (piece.kind === 'literal') {
      text = merge(text, piece.text);
    } else if (piece.kind === 'partial') {
      return { kind: 'partial', head: merge(text, piece.head), anchor };
    } else {
      anchor = 'base';
      text = initial;
    }
  }
  return { kind: 'literal', text, anchor };
}
