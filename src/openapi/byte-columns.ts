/**
 * 줄 안의 UTF-16 오프셋을 UTF-8 바이트 열로 바꾸는 색인이다.
 *
 * 한 줄로 압축한 JSON 스펙은 줄 하나가 수 MB라, 사실마다 줄 시작부터 바이트를 세면
 * 제곱 시간이 된다. 긴 줄은 일정 간격의 바이트 누계 체크포인트를 한 번 만들고,
 * 조회는 가장 가까운 앞 체크포인트부터만 센다.
 */

/** 체크포인트 간격(UTF-16 코드 단위)이다. 조회 한 번의 최대 작업량이다. */
export const CHECKPOINT_INTERVAL = 4096;

/** 체크포인트 하나: 텍스트 오프셋과 줄 시작부터 그 오프셋까지의 UTF-8 바이트 수다. */
interface Checkpoint {
  readonly offset: number;
  readonly bytes: number;
}

/** UTF-8 바이트 열 색인이다. */
export class ByteColumnIndex {
  /** 색인 대상 텍스트다. */
  private readonly text: string;
  /** 줄 시작 오프셋 → 체크포인트 목록이다. 조회한 긴 줄에만 만든다. */
  private readonly checkpoints = new Map<number, readonly Checkpoint[]>();

  /**
   * @param text 위치를 계산할 전체 텍스트
   */
  constructor(text: string) {
    this.text = text;
  }

  /**
   * 오프셋의 1부터 시작하는 UTF-8 바이트 열을 돌려준다.
   *
   * @param lineStart 오프셋이 속한 줄의 시작 오프셋
   * @param offset 텍스트 오프셋(서러게이트 쌍 가운데가 아니어야 한다)
   * @returns 줄 안 UTF-8 바이트 오프셋 + 1
   */
  column(lineStart: number, offset: number): number {
    const nearest = this.nearestCheckpoint(lineStart, offset);
    return nearest.bytes + Buffer.byteLength(this.text.slice(nearest.offset, offset), 'utf8') + 1;
  }

  /**
   * 오프셋 앞의 가장 가까운 체크포인트를 찾는다. 짧은 거리는 줄 시작을 쓴다.
   *
   * @param lineStart 줄 시작 오프셋
   * @param offset 텍스트 오프셋
   * @returns 체크포인트
   */
  private nearestCheckpoint(lineStart: number, offset: number): Checkpoint {
    if (offset - lineStart < CHECKPOINT_INTERVAL) return { offset: lineStart, bytes: 0 };
    let table = this.checkpoints.get(lineStart);
    if (table === undefined) {
      table = this.buildCheckpoints(lineStart);
      this.checkpoints.set(lineStart, table);
    }
    let index = Math.min(Math.floor((offset - lineStart) / CHECKPOINT_INTERVAL), table.length - 1);
    while (table[index]!.offset > offset) index -= 1;
    return table[index]!;
  }

  /**
   * 줄 하나의 체크포인트를 만든다. 서러게이트 쌍을 가르지 않게 경계를 한 칸 민다.
   *
   * @param lineStart 줄 시작 오프셋
   * @returns 오프셋 오름차순 체크포인트 목록(첫 원소는 줄 시작)
   */
  private buildCheckpoints(lineStart: number): Checkpoint[] {
    const lineEnd = this.lineEnd(lineStart);
    const table: Checkpoint[] = [{ offset: lineStart, bytes: 0 }];
    let previous = table[0]!;
    for (let target = lineStart + CHECKPOINT_INTERVAL; target < lineEnd; target += CHECKPOINT_INTERVAL) {
      const offset = isLowSurrogate(this.text.charCodeAt(target)) ? target + 1 : target;
      const bytes = previous.bytes + Buffer.byteLength(this.text.slice(previous.offset, offset), 'utf8');
      previous = { offset, bytes };
      table.push(previous);
    }
    return table;
  }

  /**
   * 줄 끝(다음 `\n` 또는 텍스트 끝) 오프셋을 찾는다.
   *
   * @param lineStart 줄 시작 오프셋
   * @returns 줄 끝 오프셋
   */
  private lineEnd(lineStart: number): number {
    const newline = this.text.indexOf('\n', lineStart);
    return newline === -1 ? this.text.length : newline;
  }
}

/**
 * UTF-16 코드 단위가 서러게이트 쌍의 뒤쪽인지 확인한다.
 *
 * @param code 코드 단위
 * @returns 뒤쪽 서러게이트면 true
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
