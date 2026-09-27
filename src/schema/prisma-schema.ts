/**
 * Prisma 스키마 언어(PSL)의 선언 구조만 읽는 작은 파서다.
 *
 * 관계 사실에 필요한 것은 블록(model·view·enum·type·generator·datasource), 필드의 이름·타입·
 * 수식자, 그리고 `@map`·`@@map`·`@@schema`·`@relation`·`@ignore`·`@@ignore` 같은 속성의
 * 인자뿐이다. 식 평가나 검증은 하지 않는다 — Prisma 자체 파서를 실행하지 않고(분석 대상의
 * 도구를 실행하지 않는다는 제품 불변 조건) 원문 위치를 보존하기 위해서다. 읽지 못한 줄은
 * 버리지 않고 개수로 센다.
 */

/** 속성 인자의 값이다. 필요한 모양만 구분하고 나머지는 `other`다. */
export type PrismaValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'identifier'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly PrismaValue[] }
  | { readonly kind: 'call'; readonly callee: string; readonly arguments: readonly PrismaArgument[] }
  | { readonly kind: 'other' };

/** 속성 인자 하나다. 이름 있는 인자(`name: "x"`)는 `name`을 가진다. */
export interface PrismaArgument {
  readonly name?: string;
  readonly value: PrismaValue;
}

/** `@map("x")`·`@@schema("s")` 같은 속성 하나다. 이름에는 `@`를 붙이지 않는다. */
export interface PrismaAttribute {
  readonly name: string;
  readonly arguments: readonly PrismaArgument[];
}

/** model·view·type 블록의 필드 하나다. */
export interface PrismaField {
  readonly name: string;
  /** 필드 이름의 파일 안 UTF-16 오프셋이다. */
  readonly nameOffset: number;
  /** 타입 이름이다. `Unsupported("…")`는 `Unsupported`다. */
  readonly typeName: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
  readonly attributes: readonly PrismaAttribute[];
}

/** 블록 종류다. */
export type PrismaBlockKind = 'model' | 'view' | 'enum' | 'type' | 'generator' | 'datasource';

/** 최상위 블록 하나다. */
export interface PrismaBlock {
  readonly kind: PrismaBlockKind;
  readonly name: string;
  /** 블록 이름의 파일 안 UTF-16 오프셋이다. */
  readonly nameOffset: number;
  /** model·view·type의 필드다. */
  readonly fields: readonly PrismaField[];
  /** `@@…` 블록 속성이다. */
  readonly blockAttributes: readonly PrismaAttribute[];
  /** generator·datasource의 `key = value` 속성이다. */
  readonly properties: ReadonlyMap<string, PrismaValue>;
}

/** 파일 하나의 파싱 결과다. */
export interface PrismaSchemaFile {
  readonly blocks: readonly PrismaBlock[];
  /** 블록 안에서 읽지 못한 줄 수다. 그 줄의 필드는 사실이 되지 않는다. */
  readonly unparsedLines: number;
}

/** PSL 어휘 종류다. */
type TokenKind = 'identifier' | 'string' | 'number' | 'punctuation' | 'newline';

/** PSL 어휘 하나다. 문자열은 escape를 푼 값을 `text`에 담는다. */
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly offset: number;
}

/** 블록을 여는 키워드다. */
const blockKeywords: ReadonlySet<string> = new Set(['model', 'view', 'enum', 'type', 'generator', 'datasource']);

/** 필드를 가진 블록이다. */
const fieldBlocks: ReadonlySet<string> = new Set(['model', 'view', 'type']);

/**
 * 스키마 텍스트를 블록 구조로 읽는다.
 *
 * @param text 스키마 파일 텍스트(BOM 제거 뒤)
 * @returns 블록과 읽지 못한 줄 수
 */
export function parsePrismaSchema(text: string): PrismaSchemaFile {
  const tokens = lexPrisma(text);
  const blocks: PrismaBlock[] = [];
  let unparsedLines = 0;
  let index = 0;
  while (index < tokens.length) {
    const header = readBlockHeader(tokens, index);
    if (header === undefined) {
      index = skipToLineEnd(tokens, index) + 1;
      continue;
    }
    const body = readBlockBody(tokens, header.bodyStart);
    const parsed = parseBlock(header, body.lines);
    blocks.push(parsed.block);
    unparsedLines += parsed.unparsedLines;
    index = body.next;
  }
  return { blocks, unparsedLines };
}

/** 블록 머리(`model Name {`)다. */
interface BlockHeader {
  readonly kind: PrismaBlockKind;
  readonly name: Token;
  readonly bodyStart: number;
}

/**
 * 위치에서 블록 머리를 읽는다.
 *
 * @param tokens 어휘 목록
 * @param index 줄 첫 어휘 위치
 * @returns 블록 머리. 아니면 undefined
 */
function readBlockHeader(tokens: readonly Token[], index: number): BlockHeader | undefined {
  const keyword = tokens[index];
  const name = tokens[index + 1];
  const brace = tokens[index + 2];
  if (keyword?.kind !== 'identifier' || !blockKeywords.has(keyword.text)) return undefined;
  if (name?.kind !== 'identifier' || brace?.text !== '{' || brace.kind !== 'punctuation') return undefined;
  return { kind: keyword.text as PrismaBlockKind, name, bodyStart: index + 3 };
}

/**
 * 블록 본문을 줄 단위 어휘 목록으로 나눈다.
 *
 * 괄호 안의 개행은 줄을 나누지 않는다(여러 줄에 걸친 속성 인자). 블록은 깊이 0의 `}` 또는 줄 첫
 * 어휘인 `}`에서 끝난다 — 닫히지 않은 괄호가 있어도 다음 블록까지 삼키지 않기 위해서다.
 *
 * @param tokens 어휘 목록
 * @param start `{` 다음 위치
 * @returns 본문 줄들과 블록 다음 위치
 */
function readBlockBody(tokens: readonly Token[], start: number): { lines: Token[][]; next: number } {
  const lines: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  let atLineStart = true;
  let index = start;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === 'newline') {
      atLineStart = true;
      if (depth > 0) continue;
      if (current.length > 0) lines.push(current);
      current = [];
      continue;
    }
    if (token.kind === 'punctuation' && token.text === '}' && (depth === 0 || atLineStart)) break;
    atLineStart = false;
    if (token.kind === 'punctuation') depth = Math.max(0, depth + bracketDelta(token.text));
    current.push(token);
  }
  // 블록 끝까지 괄호가 닫히지 않은 줄은 뒤 줄을 삼켰을 수 있다 — 읽지 않고 센다.
  if (current.length > 0) lines.push(depth > 0 ? [unbalancedMarker] : current);
  return { lines, next: index + 1 };
}

/** 괄호가 닫히지 않은 줄을 대신하는 표식 어휘다. 어떤 줄 모양과도 맞지 않아 읽지 못한 줄로 센다. */
const unbalancedMarker: Token = { kind: 'punctuation', text: '\u0000', offset: 0 };

/**
 * 괄호 기호가 깊이를 얼마나 바꾸는지 돌려준다.
 *
 * @param text 기호
 * @returns +1·-1·0
 */
function bracketDelta(text: string): number {
  if (text === '(' || text === '[' || text === '{') return 1;
  if (text === ')' || text === ']' || text === '}') return -1;
  return 0;
}

/**
 * 블록 하나를 만든다.
 *
 * @param header 블록 머리
 * @param lines 본문 줄
 * @returns 블록과 읽지 못한 줄 수
 */
function parseBlock(header: BlockHeader, lines: readonly Token[][]): { block: PrismaBlock; unparsedLines: number } {
  const fields: PrismaField[] = [];
  const blockAttributes: PrismaAttribute[] = [];
  const properties = new Map<string, PrismaValue>();
  let unparsedLines = 0;
  for (const line of lines) {
    const outcome = parseBodyLine(header.kind, line);
    if (outcome === undefined) unparsedLines++;
    else if (outcome === 'ignored') continue;
    else if ('typeName' in outcome) fields.push(outcome);
    else if ('arguments' in outcome) blockAttributes.push(outcome);
    else properties.set(outcome.key, outcome.value);
  }
  return {
    block: {
      kind: header.kind,
      name: header.name.text,
      nameOffset: header.name.offset,
      fields,
      blockAttributes,
      properties,
    },
    unparsedLines,
  };
}

/** 본문 한 줄의 해석 결과다. */
type BodyLine = PrismaField | PrismaAttribute | { readonly key: string; readonly value: PrismaValue };

/**
 * 본문 한 줄을 블록 종류에 맞게 해석한다.
 *
 * @param kind 블록 종류
 * @param line 줄 어휘
 * @returns 필드·블록 속성·키 값, 사실과 무관한 줄이면 'ignored', 읽지 못하면 undefined
 */
function parseBodyLine(kind: PrismaBlockKind, line: readonly Token[]): BodyLine | 'ignored' | undefined {
  const cursor = new TokenCursor(line);
  if (cursor.peekPunctuation('@@')) {
    cursor.next();
    return readAttribute(cursor);
  }
  if (kind === 'generator' || kind === 'datasource') return readProperty(cursor);
  if (kind === 'enum') return readEnumValue(cursor);
  /* node:coverage ignore next */
  if (!fieldBlocks.has(kind)) return undefined;
  return readField(cursor);
}

/**
 * enum 값 줄은 사실과 무관하다. 모양만 확인한다.
 *
 * @param cursor 줄 커서
 * @returns 식별자로 시작하면 'ignored', 아니면 undefined
 */
function readEnumValue(cursor: TokenCursor): 'ignored' | undefined {
  return cursor.next()?.kind === 'identifier' ? 'ignored' : undefined;
}

/**
 * `key = value` 줄을 읽는다.
 *
 * @param cursor 줄 커서
 * @returns 키와 값. 모양이 다르면 undefined
 */
function readProperty(cursor: TokenCursor): BodyLine | undefined {
  const key = cursor.next();
  if (key?.kind !== 'identifier' || !cursor.peekPunctuation('=')) return undefined;
  cursor.next();
  const value = readValue(cursor);
  return cursor.done() ? { key: key.text, value } : undefined;
}

/**
 * 필드 줄(`name Type? @attr(...)`)을 읽는다.
 *
 * @param cursor 줄 커서
 * @returns 필드. 모양이 다르면 undefined
 */
function readField(cursor: TokenCursor): PrismaField | undefined {
  const name = cursor.next();
  const type = cursor.next();
  if (name?.kind !== 'identifier' || type?.kind !== 'identifier') return undefined;
  if (cursor.peekPunctuation('(')) readArguments(cursor);
  let isList = false;
  let isOptional = false;
  if (cursor.peekPunctuation('[')) {
    cursor.next();
    if (!cursor.peekPunctuation(']')) return undefined;
    cursor.next();
    isList = true;
  }
  if (cursor.peekPunctuation('?')) {
    cursor.next();
    isOptional = true;
  }
  const attributes: PrismaAttribute[] = [];
  while (!cursor.done()) {
    if (!cursor.peekPunctuation('@')) return undefined;
    cursor.next();
    const attribute = readAttribute(cursor);
    if (attribute === undefined) return undefined;
    attributes.push(attribute);
  }
  return { name: name.text, nameOffset: name.offset, typeName: type.text, isList, isOptional, attributes };
}

/**
 * `@`·`@@` 뒤의 속성 이름(`db.VarChar` 같은 점 이름 포함)과 인자를 읽는다.
 *
 * @param cursor `@` 다음을 가리키는 커서
 * @returns 속성. 이름이 없으면 undefined
 */
function readAttribute(cursor: TokenCursor): PrismaAttribute | undefined {
  const name = readDottedName(cursor);
  if (name === undefined) return undefined;
  const attributeArguments = cursor.peekPunctuation('(') ? readArguments(cursor) : [];
  return { name, arguments: attributeArguments };
}

/**
 * `a.b.c` 모양 이름을 읽는다.
 *
 * @param cursor 커서
 * @returns 이름. 식별자가 아니면 undefined
 */
function readDottedName(cursor: TokenCursor): string | undefined {
  const first = cursor.next();
  if (first?.kind !== 'identifier') return undefined;
  let name = first.text;
  while (cursor.peekPunctuation('.') && cursor.peek(1)?.kind === 'identifier') {
    cursor.next();
    name += `.${cursor.next()!.text}`;
  }
  return name;
}

/**
 * 괄호 인자 목록을 읽는다. 모양이 다른 인자는 `other` 값으로 보존한다.
 *
 * @param cursor `(`를 가리키는 커서
 * @returns 인자 목록
 */
function readArguments(cursor: TokenCursor): PrismaArgument[] {
  cursor.next();
  const result: PrismaArgument[] = [];
  while (!cursor.done() && !cursor.peekPunctuation(')')) {
    result.push(readArgument(cursor));
    if (cursor.peekPunctuation(',')) cursor.next();
    else if (!cursor.peekPunctuation(')')) cursor.skipUntil(new Set([',', ')']));
    else break;
  }
  if (cursor.peekPunctuation(')')) cursor.next();
  return result;
}

/**
 * 인자 하나(`name: value` 또는 `value`)를 읽는다.
 *
 * @param cursor 커서
 * @returns 인자
 */
function readArgument(cursor: TokenCursor): PrismaArgument {
  const first = cursor.peek(0);
  if (first?.kind === 'identifier' && cursor.peek(1)?.kind === 'punctuation' && cursor.peek(1)?.text === ':') {
    cursor.next();
    cursor.next();
    return { name: first.text, value: readValue(cursor) };
  }
  return { value: readValue(cursor) };
}

/**
 * 값 하나를 읽는다.
 *
 * @param cursor 커서
 * @returns 값. 모르는 모양은 한 어휘를 소비한 `other`다
 */
function readValue(cursor: TokenCursor): PrismaValue {
  const token = cursor.peek(0);
  if (token === undefined) return { kind: 'other' };
  if (token.kind === 'string') {
    cursor.next();
    return { kind: 'string', value: token.text };
  }
  if (token.kind === 'punctuation' && token.text === '[') return readList(cursor);
  if (token.kind === 'punctuation' && token.text === '(') {
    readArguments(cursor);
    return { kind: 'other' };
  }
  if (token.kind === 'identifier') {
    const name = readDottedName(cursor)!;
    if (cursor.peekPunctuation('(')) return { kind: 'call', callee: name, arguments: readArguments(cursor) };
    return { kind: 'identifier', value: name };
  }
  cursor.next();
  return { kind: 'other' };
}

/**
 * `[a, b]` 목록 값을 읽는다.
 *
 * @param cursor `[`를 가리키는 커서
 * @returns 목록 값
 */
function readList(cursor: TokenCursor): PrismaValue {
  cursor.next();
  const items: PrismaValue[] = [];
  while (!cursor.done() && !cursor.peekPunctuation(']')) {
    items.push(readValue(cursor));
    if (cursor.peekPunctuation(',')) cursor.next();
    else if (!cursor.peekPunctuation(']')) cursor.skipUntil(new Set([',', ']']));
  }
  if (cursor.peekPunctuation(']')) cursor.next();
  return { kind: 'list', items };
}

/** 한 줄 어휘 위를 움직이는 커서다. */
class TokenCursor {
  /** 줄 어휘다. */
  private readonly tokens: readonly Token[];
  /** 현재 위치다. */
  private position = 0;

  /**
   * @param tokens 줄 어휘
   */
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  /**
   * 현재 위치에서 `ahead`만큼 앞의 어휘를 본다.
   *
   * @param ahead 앞으로 볼 칸 수
   * @returns 어휘 또는 undefined
   */
  peek(ahead: number): Token | undefined {
    return this.tokens[this.position + ahead];
  }

  /**
   * 현재 어휘가 기호 `text`인지 본다.
   *
   * @param text 기호
   * @returns 같으면 true
   */
  peekPunctuation(text: string): boolean {
    const token = this.peek(0);
    return token?.kind === 'punctuation' && token.text === text;
  }

  /**
   * 현재 어휘를 소비한다.
   *
   * @returns 소비한 어휘 또는 undefined
   */
  next(): Token | undefined {
    const token = this.peek(0);
    if (token !== undefined) this.position++;
    return token;
  }

  /**
   * 줄 끝인지 본다.
   *
   * @returns 남은 어휘가 없으면 true
   */
  done(): boolean {
    return this.position >= this.tokens.length;
  }

  /**
   * 같은 괄호 깊이의 종료 기호 앞까지 건너뛴다.
   *
   * @param stops 멈출 기호
   */
  skipUntil(stops: ReadonlySet<string>): void {
    let depth = 0;
    while (!this.done()) {
      const token = this.peek(0)!;
      if (token.kind === 'punctuation') {
        const closes = token.text === ')' || token.text === ']';
        // 깊이 0의 닫는 괄호는 바깥 목록의 끝이다 — 넘어가면 바깥 구조가 깨진다.
        if (depth === 0 && (stops.has(token.text) || closes)) return;
        if (token.text === '(' || token.text === '[') depth++;
        if (closes) depth--;
      }
      this.position++;
    }
  }
}

/**
 * 위치부터 줄 끝(개행 어휘) 위치를 찾는다.
 *
 * @param tokens 어휘 목록
 * @param index 시작 위치
 * @returns 개행 어휘 위치 또는 목록 끝
 */
function skipToLineEnd(tokens: readonly Token[], index: number): number {
  let position = index;
  while (position < tokens.length && tokens[position]!.kind !== 'newline') position++;
  return position;
}

/**
 * PSL 텍스트를 어휘로 나눈다. `//` 주석은 버리고 개행은 줄 경계 어휘로 남긴다.
 *
 * @param text 스키마 텍스트
 * @returns 어휘 목록
 */
function lexPrisma(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '\n') {
      tokens.push({ kind: 'newline', text: '\n', offset: index });
      index++;
    } else if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '"') {
      index = lexString(text, index, tokens);
    } else if (isIdentifierCharacter(character)) {
      let end = index + 1;
      while (end < text.length && isIdentifierCharacter(text[end]!)) end++;
      const word = text.slice(index, end);
      tokens.push({ kind: /^[0-9]/u.test(word) ? 'number' : 'identifier', text: word, offset: index });
      index = end;
    } else if (character === '@' && text[index + 1] === '@') {
      tokens.push({ kind: 'punctuation', text: '@@', offset: index });
      index += 2;
    } else {
      if (!/\s/u.test(character)) tokens.push({ kind: 'punctuation', text: character, offset: index });
      index++;
    }
  }
  return tokens;
}

/**
 * 큰따옴표 문자열 하나를 읽는다. 줄바꿈 전에 닫히지 않으면 그 줄 끝까지를 값으로 본다.
 *
 * @param text 스키마 텍스트
 * @param start 여는 따옴표 위치
 * @param tokens 결과 어휘 목록(추가된다)
 * @returns 문자열 다음 위치
 */
function lexString(text: string, start: number, tokens: Token[]): number {
  let index = start + 1;
  let value = '';
  while (index < text.length && text[index] !== '"' && text[index] !== '\n') {
    if (text[index] === '\\' && index + 1 < text.length) {
      value += decodeEscape(text[index + 1]!);
      index += 2;
      continue;
    }
    value += text[index];
    index++;
  }
  tokens.push({ kind: 'string', text: value, offset: start });
  return text[index] === '"' ? index + 1 : index;
}

/**
 * 문자열 escape 한 글자를 푼다. 이름에 쓰이는 흔한 escape만 풀고 나머지는 그대로 둔다.
 *
 * @param character 역슬래시 뒤 글자
 * @returns 푼 문자
 */
function decodeEscape(character: string): string {
  switch (character) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    default: return character;
  }
}

/**
 * PSL 식별자·숫자 구성 문자인지 본다.
 *
 * @param character 문자
 * @returns 구성 문자면 true
 */
function isIdentifierCharacter(character: string): boolean {
  return /[A-Za-z0-9_\-]/u.test(character) || character.charCodeAt(0) >= 0x80;
}

/**
 * 속성의 이름 인자(첫 위치 인자 또는 `name:`)의 문자열 값을 꺼낸다.
 *
 * `@map("x")`·`@@map(name: "x")`·`@relation("R")`·`@@schema("s")`가 모두 이 모양이다.
 *
 * @param attribute 속성
 * @returns 문자열 값. 없거나 문자열이 아니면 undefined
 */
export function attributeNameArgument(attribute: PrismaAttribute): PrismaValue | undefined {
  const named = attribute.arguments.find((argument) => argument.name === 'name');
  if (named !== undefined) return named.value;
  return attribute.arguments.find((argument) => argument.name === undefined)?.value;
}

/**
 * 이름으로 속성을 찾는다.
 *
 * @param attributes 속성 목록
 * @param name `@` 없는 속성 이름
 * @returns 첫 속성 또는 undefined
 */
export function findAttribute(attributes: readonly PrismaAttribute[], name: string): PrismaAttribute | undefined {
  return attributes.find((attribute) => attribute.name === name);
}
