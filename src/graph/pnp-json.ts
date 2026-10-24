/** PnP JSON의 중복 key·깊이·값 수를 parse 전에 제한한다. */
import { scanJsonNumberToken } from '../exchange/json-number-token.ts';

/** 이미 byte 상한을 통과한 엄격한 JSON만 객체로 만든다. */
export function parsePnpJson(text: string): unknown {
  new JsonLimitsScanner(text).scan();
  return JSON.parse(text) as unknown;
}

/** JSON.parse 전에 깊이·값 수·중복 key를 제한한다. */
class JsonLimitsScanner {
  #index = 0;
  #values = 0;
  private readonly text: string;

  constructor(text: string) { this.text = text; }

  scan(): void {
    try {
      this.value(0);
      this.space();
      if (this.#index !== this.text.length) throw new Error('invalid static PnP JSON');
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('invalid static PnP JSON');
    }
  }

  private value(depth: number): void {
    if (depth > 32) throw new Error('invalid static PnP JSON');
    if (++this.#values > 200_000) throw new Error('invalid static PnP JSON');
    this.space();
    const token = this.text[this.#index];
    if (token === '{') { this.object(depth); return; }
    if (token === '[') { this.array(depth); return; }
    if (token === '"') { this.string(); return; }
    if (token === 't') { this.literal('true'); return; }
    if (token === 'f') { this.literal('false'); return; }
    if (token === 'n') { this.literal('null'); return; }
    if (token !== undefined && /[-0-9]/u.test(token)) { this.number(); return; }
    throw new Error('invalid static PnP JSON');
  }

  private object(depth: number): void {
    this.#index++;
    this.space();
    const keys = new Set<string>();
    if (this.text[this.#index] === '}') { this.#index++; return; }
    while (true) {
      this.space();
      if (this.text[this.#index] !== '"') throw new Error('invalid static PnP JSON');
      const key = this.stringValue();
      if (keys.has(key)) throw new Error('invalid static PnP JSON');
      keys.add(key);
      this.space();
      if (this.text[this.#index++] !== ':') throw new Error('invalid static PnP JSON');
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === '}') return;
      if (token !== ',') throw new Error('invalid static PnP JSON');
    }
  }

  private array(depth: number): void {
    this.#index++;
    this.space();
    if (this.text[this.#index] === ']') { this.#index++; return; }
    while (true) {
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === ']') return;
      if (token !== ',') throw new Error('invalid static PnP JSON');
    }
  }

  private stringValue(): string {
    const start = this.#index;
    this.string();
    try {
      const value = JSON.parse(this.text.slice(start, this.#index)) as unknown;
      if (typeof value !== 'string') throw new Error();
      return value;
    } catch { throw new Error('invalid static PnP JSON'); }
  }

  private string(): void {
    if (this.text[this.#index++] !== '"') throw new Error('invalid static PnP JSON');
    while (this.#index < this.text.length) {
      const char = this.text[this.#index++];
      if (char === '"') return;
      if (char === '\\') {
        const escape = this.text[this.#index++];
        if (escape === 'u') {
          for (let offset = 0; offset < 4; offset++) {
            if (!isHexDigit(this.text[this.#index + offset])) throw new Error('invalid static PnP JSON');
          }
          this.#index += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new Error('invalid static PnP JSON');
        }
      } else if (char !== undefined && char < ' ') throw new Error('invalid static PnP JSON');
    }
    throw new Error('invalid static PnP JSON');
  }

  private number(): void {
    const end = scanJsonNumberToken(this.text, this.#index);
    if (end === undefined) throw new Error('invalid static PnP JSON');
    this.#index = end;
  }

  private literal(value: string): void {
    if (this.text.slice(this.#index, this.#index + value.length) !== value) throw new Error('invalid static PnP JSON');
    this.#index += value.length;
  }

  private space(): void {
    while (/\s/u.test(this.text[this.#index] ?? '')) this.#index++;
  }
}

/** `\u` escape의 고정 네 자리를 검사한다. */
function isHexDigit(value: string | undefined): boolean {
  return value !== undefined && /[0-9A-Fa-f]/u.test(value);
}
