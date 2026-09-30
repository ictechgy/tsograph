/**
 * SQL 텍스트에서 관계(테이블·뷰) 이름을 읽는 어휘 기반 추출기다.
 *
 * dartograph `sql_relations.dart`(kartograph `SqlRelations.kt`·cartograph
 * `SqlRelations.swift`의 포트)를 한 규칙씩 옮겼다. 생산자마다 같은 SQL을 다르게 읽으면
 * isthmus persistence 조인 결과가 생산자 언어에 따라 달라지므로 알고리즘·게이트·
 * 미해석 계수 규칙을 가족과 같게 유지한다. 오프셋은 JS 문자열의 UTF-16 코드 단위 위치다
 * (Dart와 같은 단위라 공유 벡터의 키워드 위치가 그대로 맞는다).
 */

/** SQL 어휘 하나다. 인용된 식별자는 키워드가 아니다. */
export interface SqlToken {
  /** 인용 부호를 벗긴 어휘 본문이다. */
  readonly text: string;
  /** `"…"`·`` `…` ``·`[…]`로 인용된 식별자인지 여부다. */
  readonly quoted: boolean;
  /** 원문에서의 UTF-16 시작 위치다. */
  readonly offset: number;
}

/** 관계 이름 하나와 그것을 연 키워드 토큰의 원문 위치다. */
export interface SqlRelation {
  readonly name: string;
  readonly keyword: number;
}

/** 관계 추출 결과다. `unresolved`는 관계 자리의 피연산자를 읽지 못한 횟수다. */
export interface SqlRelationsResult {
  readonly relations: readonly SqlRelation[];
  readonly unresolved: number;
}

/** 단일 기호 토큰으로 남기는 문자다. `;`는 문장 경계, 나머지는 피연산자 판정용이다. */
const symbolTokens = new Set(['.', ',', '(', ')', ';', '{', '}', '$', '?', ':', '@']);

/** 읽히지 않은 피연산자의 근거가 되는 플레이스홀더 기호다. */
const placeholderSymbols = new Set(['{', '}', '$', '?', ':', '@']);

/**
 * SQL 텍스트를 어휘로 나눈다.
 *
 * 인용 식별자는 내용을 보존하고, 그 외에는 식별자 문자열과 단일 기호 토큰만 만든다.
 * 주석과 문자열 리터럴은 이름이 아니므로 건너뛴다.
 *
 * @param text SQL 텍스트
 * @returns 어휘 목록
 */
export function lexSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"' || character === '`' || character === '[') {
      index = lexQuoted(text, index, tokens);
    } else if (isIdentStart(text.charCodeAt(index))) {
      let end = index + 1;
      while (end < text.length && isIdentPart(text.charCodeAt(end))) end++;
      tokens.push({ text: text.slice(index, end), quoted: false, offset: index });
      index = end;
    } else if (character === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index + 2);
    } else if (character === "'") {
      index = skipStringLiteral(text, index + 1);
    } else {
      if (symbolTokens.has(character)) tokens.push({ text: character, quoted: false, offset: index });
      index++;
    }
  }
  return tokens;
}

/**
 * 인용 식별자 하나를 읽어 토큰으로 넣는다.
 *
 * @param text SQL 텍스트
 * @param start 여는 인용 부호 위치
 * @param tokens 결과 토큰 목록(추가된다)
 * @returns 닫는 부호 다음 위치
 */
function lexQuoted(text: string, start: number, tokens: SqlToken[]): number {
  const open = text[start]!;
  const close = open === '[' ? ']' : open;
  let end = start + 1;
  while (end < text.length && text[end] !== close) end++;
  tokens.push({ text: text.slice(start + 1, end), quoted: true, offset: start });
  return end + 1;
}

/**
 * 블록 주석을 건너뛴다.
 *
 * @param text SQL 텍스트
 * @param start 주석 본문 시작 위치
 * @returns 주석 끝 다음 위치
 */
function skipBlockComment(text: string, start: number): number {
  let index = start;
  while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
  return index + 2;
}

/**
 * 문자열 리터럴을 건너뛴다. `''`와 `\'`는 escape다.
 *
 * @param text SQL 텍스트
 * @param start 여는 따옴표 다음 위치
 * @returns 닫는 따옴표 다음 위치(닫히지 않으면 텍스트 끝)
 */
function skipStringLiteral(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === "'" && text[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (text[index] === "'") return index + 1;
    index++;
  }
  return index;
}

/**
 * SQL 문을 여는 강한 동사가 있는지 본다.
 *
 * 관계 키워드와 겹치는 update·truncate는 문장 머리일 때만 인정한다. `strict`는 게이트 없는
 * 문자열 리터럴용으로, 동사가 대문자일 때만 인정해 산문을 거른다.
 *
 * @param text 검사할 텍스트
 * @param strict 대문자 동사만 인정할지 여부
 * @returns SQL로 보이면 true
 */
export function looksLikeSql(text: string, strict = false): boolean {
  let head = true;
  for (const token of lexSql(text)) {
    if (!isNameToken(token)) continue;
    const upper = token.text === token.text.toUpperCase();
    if (sqlVerbs.has(token.text.toLowerCase()) && (!strict || upper)) return true;
    if (head) {
      head = false;
      const lower = token.text.toLowerCase();
      if ((lower === 'update' || lower === 'truncate') && (!strict || upper)) return true;
    }
  }
  return false;
}

/**
 * SQL 텍스트에서 관계 이름을 읽는다.
 *
 * 한정 이름(`schema.table`)은 그대로 두고, 이름 자체에 점이 있는 인용 식별자(`"a.b"`)는 한
 * 세그먼트로 escape한다. `FROM {}` 같은 플레이스홀더는 사실 없이 넘기지 않고 미해석으로 센다.
 *
 * @param text SQL 텍스트
 * @param strict 관계 키워드와 동사가 대문자일 때만 발화할지 여부
 * @returns 관계 목록과 미해석 피연산자 수
 */
export function sqlRelations(text: string, strict = false): SqlRelationsResult {
  const tokens = lexSql(text);
  const scan = new RelationScan(tokens, strict);
  for (let index = 0; index < tokens.length; index++) scan.visitKeyword(index);
  return { relations: scan.out, unresolved: scan.unresolved };
}

/** `sqlRelations` 한 번의 스캔 상태다. 포트 원본의 필드·메서드와 한 줄씩 대응한다. */
class RelationScan {
  /** 어휘 목록이다. */
  private readonly tokens: readonly SqlToken[];
  /** 대문자 게이트 여부다. */
  private readonly strict: boolean;
  /** 수식어·이름·별칭으로 이미 쓰인 토큰이다. 키워드로 다시 읽지 않는다. */
  private readonly consumed: boolean[];
  /** `;`로 갈리는 각 문장의 머리 식별자 위치다. */
  private readonly statementHead: boolean[];
  /** 각 토큰이 속한 문장의 (대문자 게이트를 통과한) 동사다. */
  private readonly statementVerb: (string | undefined)[];
  /** 같은 키워드의 피연산자 목록 안에서만 중복을 막는 키다(`FROM a, a`). */
  private readonly seen = new Set<string>();
  /** 읽은 관계다. */
  readonly out: SqlRelation[] = [];
  /** 읽지 못한 관계 자리 수다. */
  unresolved = 0;

  /**
   * @param tokens 어휘 목록
   * @param strict 대문자 게이트 여부
   */
  constructor(tokens: readonly SqlToken[], strict: boolean) {
    this.tokens = tokens;
    this.strict = strict;
    this.consumed = tokens.map(() => false);
    this.statementHead = tokens.map(() => false);
    this.statementVerb = tokens.map(() => undefined);
    this.markStatements();
  }

  /**
   * strict 모드에서는 대문자 토큰만 통과시킨다.
   *
   * @param token 검사할 토큰
   * @returns 게이트를 통과하면 true
   */
  private upperOk(token: SqlToken): boolean {
    return !this.strict || token.text === token.text.toUpperCase();
  }

  /**
   * 위치의 토큰이 비인용 기호 `symbol`인지 본다.
   *
   * @param index 토큰 위치
   * @param symbol 기호 문자
   * @returns 같으면 true
   */
  private isSymbol(index: number, symbol: string): boolean {
    const token = this.tokens[index];
    return token !== undefined && !token.quoted && token.text === symbol;
  }

  /**
   * 문장 머리와 동사를 표시한다.
   *
   * 문장 머리의 `ident :`는 SQLDelight·drift 라벨이라 머리를 차지하지 않고 다음 식별자가
   * 머리가 된다(`::` 캐스트는 라벨이 아니다).
   */
  private markStatements(): void {
    let pending = true;
    let verb: string | undefined;
    let index = 0;
    while (index < this.tokens.length) {
      const token = this.tokens[index]!;
      if (this.isSymbol(index, ';')) {
        pending = true;
        verb = undefined;
        index++;
        continue;
      }
      if (isNameToken(token) && pending) {
        if (this.isSymbol(index + 1, ':') && !this.isSymbol(index + 2, ':')) {
          index += 2;
          continue;
        }
        this.statementHead[index] = true;
        verb = this.upperOk(token) ? token.text.toLowerCase() : undefined;
        pending = false;
      }
      this.statementVerb[index] = verb;
      index++;
    }
  }

  /**
   * `end` 앞쪽으로 같은 문장 안의 토큰들을 가까운 것부터 돌려준다.
   *
   * @param end 기준 위치(포함하지 않는다)
   * @returns 역순 토큰 목록
   */
  private segmentBefore(end: number): SqlToken[] {
    const result: SqlToken[] = [];
    for (let index = end - 1; index >= 0; index--) {
      const token = this.tokens[index]!;
      if (token.text === ';') break;
      result.push(token);
    }
    return result;
  }

  /**
   * `start`부터 같은 문장 안에 대문자 게이트를 통과한 단어 `word`가 있는지 본다.
   *
   * @param start 시작 위치
   * @param word 소문자 단어
   * @returns 있으면 true
   */
  private segmentAfterHas(start: number, word: string): boolean {
    for (let index = start; index < this.tokens.length; index++) {
      const token = this.tokens[index]!;
      if (token.text === ';') return false;
      if (!token.quoted && token.text.toLowerCase() === word && this.upperOk(token)) return true;
    }
    return false;
  }

  /**
   * 같은 문장 안의 앞선 비인용 토큰 중 조건을 만족하는 것이 있는지 본다.
   *
   * @param index 기준 위치
   * @param test 소문자 단어 판정 함수
   * @returns 있으면 true
   */
  private precededBy(index: number, test: (lower: string) => boolean): boolean {
    return this.segmentBefore(index)
      .some((token) => !token.quoted && this.upperOk(token) && test(token.text.toLowerCase()));
  }

  /**
   * 키워드 토큰이 현재 문맥에서 관계 자리를 여는지 판정한다.
   *
   * @param index 키워드 위치
   * @param word 소문자 키워드
   * @param grantStatement GRANT/REVOKE 문장인지 여부
   * @returns 관계 자리를 열면 true
   */
  private fires(index: number, word: string, grantStatement: boolean): boolean {
    switch (word) {
      // 산문 "update the .."·upsert의 `DO UPDATE SET`을 막는다.
      case 'update': return this.statementHead[index]! && this.segmentAfterHas(index + 1, 'set');
      case 'truncate': return this.statementHead[index]!;
      // "merged the branch into main" 같은 산문을 막는다.
      case 'into': return this.precededBy(index, (lower) => intoVerbs.has(lower));
      case 'table': return this.tableKeywordContext(index);
      case 'on': return this.onFires(index, grantStatement);
      // grant·revoke의 FROM은 권한 주체 자리다.
      case 'from':
      case 'join': return !grantStatement;
      /* node:coverage ignore next */
      default: return true;
    }
  }

  /**
   * `ON`은 `GRANT .. ON t`와 `CREATE INDEX/TRIGGER/POLICY .. ON t`만 관계 자리다.
   * CREATE RULE의 ON은 이벤트 자리라 제외한다.
   *
   * @param index 키워드 위치
   * @param grantStatement GRANT/REVOKE 문장인지 여부
   * @returns 관계 자리를 열면 true
   */
  private onFires(index: number, grantStatement: boolean): boolean {
    const grantOn = grantStatement && this.precededBy(index, (lower) => grantPrivileges.has(lower));
    const createOn = this.statementVerb[index] === 'create'
      && this.precededBy(index, (lower) => createOnKinds.has(lower));
    return grantOn || createOn;
  }

  /**
   * `table` 토큰은 직전 비인용 식별자가 DDL 동사일 때만 키워드다.
   *
   * @param index `table` 토큰 위치
   * @returns 키워드면 true
   */
  private tableKeywordContext(index: number): boolean {
    for (let previous = index - 1; previous >= 0; previous--) {
      const token = this.tokens[previous]!;
      if (!isNameToken(token)) continue;
      if (this.strict && token.text !== token.text.toUpperCase()) return false;
      return tableVerbs.has(token.text.toLowerCase());
    }
    return false;
  }

  /**
   * 한 토큰이 관계 키워드면 뒤의 피연산자 목록을 읽는다.
   *
   * @param index 토큰 위치
   */
  visitKeyword(index: number): void {
    const keyword = this.tokens[index]!;
    if (this.consumed[index] || keyword.quoted || !relationKeywords.has(keyword.text.toLowerCase())
      || !this.upperOk(keyword)) {
      return;
    }
    const word = keyword.text.toLowerCase();
    const verb = this.statementVerb[index];
    const grantStatement = verb === 'grant' || verb === 'revoke';
    if (!this.fires(index, word, grantStatement)) return;
    let next = this.skipModifiers(index + 1, word === 'truncate');
    if (word === 'on' && grantStatement) {
      const afterKind = this.skipGrantObjectKind(next);
      if (afterKind === undefined) return;
      next = afterKind;
    }
    if (next >= this.tokens.length) {
      this.unresolved++; // 이름이 없는 키워드 — "SELECT ... FROM" 꼴.
      return;
    }
    this.readOperands(next, keyword, word === 'on' && grantStatement);
  }

  /**
   * ONLY·IF NOT EXISTS 같은 수식어를 건너뛴다. `table`은 TRUNCATE 뒤에서만 수식어다.
   *
   * @param start 키워드 다음 위치
   * @param afterTruncate TRUNCATE 뒤인지 여부
   * @returns 수식어 다음 위치
   */
  private skipModifiers(start: number, afterTruncate: boolean): number {
    let index = start;
    while (index < this.tokens.length && !this.tokens[index]!.quoted
      && isNameModifier(this.tokens[index]!.text, afterTruncate)) {
      this.consumed[index] = true;
      index++;
    }
    return index;
  }

  /**
   * GRANT/REVOKE ON 뒤의 객체 종류어를 처리한다.
   *
   * 테이블 계열이면 이름 위치를, 비테이블 권한 객체면 이름까지 삼키고 undefined를 돌려준다
   * (사실을 내지 않는다).
   *
   * @param start 종류어 위치
   * @returns 이름 위치 또는 undefined
   */
  private skipGrantObjectKind(start: number): number | undefined {
    const first = this.tokens[start];
    if (first === undefined || first.quoted) return start;
    const kind = first.text.toLowerCase();
    if (grantTableKinds.has(kind)) {
      let index = start;
      while (index < this.tokens.length && grantTableKinds.has(this.tokens[index]!.text.toLowerCase())) {
        this.consumed[index] = true;
        index++;
      }
      return index;
    }
    if (!grantNonTableKinds.has(kind)) return start;
    this.swallowNonTableObject(start);
    return undefined;
  }

  /**
   * 비테이블 권한 객체의 이름(괄호 인자 포함)을 삼킨다.
   *
   * @param start 종류어 위치
   */
  private swallowNonTableObject(start: number): void {
    let index = start;
    while (index < this.tokens.length) {
      const token = this.tokens[index]!;
      if (!token.quoted && token.text === '(') {
        const next = skipParens(this.tokens, index);
        if (next === undefined) {
          this.unresolved++; // 닫히지 않은 괄호.
          return;
        }
        index = next;
      } else if (isNameToken(token) || (!token.quoted && token.text === '.')) {
        this.consumed[index] = true;
        index++;
      } else {
        // 플레이스홀더 피연산자(`ON SEQUENCE {s}`)는 읽히지 않은 근거다.
        if (!token.quoted && placeholderSymbols.has(token.text)) this.unresolved++;
        return;
      }
    }
  }

  /**
   * 쉼표로 이어지는 피연산자 목록(`FROM a, b`)을 읽는다.
   *
   * 괄호 피연산자는 통째로 건너뛰고(안쪽 관계는 그 안의 키워드가 읽는다) 별칭은 삼킨다.
   *
   * @param start 첫 피연산자 위치
   * @param keyword 목록을 연 키워드
   * @param bufferedGrant GRANT 형태 확인 뒤에만 내보낼지 여부
   */
  private readOperands(start: number, keyword: SqlToken, bufferedGrant: boolean): void {
    const buffer: string[] = [];
    let index = start;
    let endPosition = index;
    while (index < this.tokens.length) {
      const operandEnd = this.readOperand(index, keyword, bufferedGrant ? buffer : undefined);
      if (operandEnd === undefined) break;
      const afterAlias = this.skipAlias(operandEnd);
      endPosition = afterAlias;
      if (!this.isSymbol(afterAlias, ',')) break;
      index = afterAlias + 1;
    }
    if (bufferedGrant && this.grantTerminatorAt(endPosition)) {
      for (const name of buffer) this.emit(name, keyword);
    }
  }

  /**
   * 피연산자 하나를 읽는다.
   *
   * @param index 피연산자 위치
   * @param keyword 목록을 연 키워드
   * @param buffer GRANT 버퍼(있으면 즉시 내보내지 않고 모은다)
   * @returns 피연산자 끝 위치. 목록이 끝났으면 undefined
   */
  private readOperand(index: number, keyword: SqlToken, buffer: string[] | undefined): number | undefined {
    if (this.isSymbol(index, '(')) {
      const next = skipParens(this.tokens, index);
      if (next === undefined) this.unresolved++; // 닫히지 않은 괄호.
      return next;
    }
    const read = readQualifiedName(this.tokens, index);
    if (read === undefined) {
      // 이름 자리에 절 키워드가 오는 것은 정상 종료다 — 플레이스홀더 등 읽히지 않는
      // 피연산자만 미해석으로 센다.
      const token = this.tokens[index];
      const clauseNext = token !== undefined && isNameToken(token) && clauseWords.has(token.text.toLowerCase());
      if (!clauseNext) this.unresolved++;
      return undefined;
    }
    // FROM/JOIN의 함수 피연산자는 테이블 신원이 아니다. INSERT t(cols)는 관계를 유지한다.
    if (['from', 'join'].includes(keyword.text.toLowerCase()) && this.isSymbol(read.next, '(')) {
      this.unresolved++;
      for (let consumed = index; consumed < read.next; consumed++) this.consumed[consumed] = true;
      return skipParens(this.tokens, read.next);
    }
    if (buffer === undefined) this.emit(read.name, keyword);
    else buffer.push(read.name);
    for (let consumed = index; consumed < read.next; consumed++) this.consumed[consumed] = true;
    return read.next;
  }

  /**
   * `AS alias` 또는 쉼표 직전 별칭(`FROM users u, ..`)을 건너뛴다.
   *
   * @param operandEnd 피연산자 끝 위치
   * @returns 별칭 다음 위치
   */
  private skipAlias(operandEnd: number): number {
    let index = operandEnd;
    const token = this.tokens[index];
    const following = this.tokens[index + 1];
    if (token !== undefined && !token.quoted && token.text.toLowerCase() === 'as'
      && following !== undefined && isNameToken(following)) {
      index += 2;
    } else if (token !== undefined && isNameToken(token) && this.isSymbol(index + 1, ',')) {
      index += 1;
    }
    for (let consumed = operandEnd; consumed < index; consumed++) this.consumed[consumed] = true;
    return index;
  }

  /**
   * GRANT 피연산자 뒤가 TO·FROM·`;`·끝이어야 산문이 아닌 GRANT 형태다.
   *
   * @param endPosition 피연산자 목록 끝 위치
   * @returns GRANT 형태면 true
   */
  private grantTerminatorAt(endPosition: number): boolean {
    const token = this.tokens[endPosition];
    if (token === undefined) return true;
    return !token.quoted && grantTerminators.has(token.text.toLowerCase());
  }

  /**
   * 관계 하나를 결과에 넣는다. 같은 키워드의 같은 이름은 한 번만 넣는다.
   *
   * @param name 관계 이름
   * @param keyword 목록을 연 키워드
   */
  private emit(name: string, keyword: SqlToken): void {
    const key = `${keyword.offset} ${name}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push({ name, keyword: keyword.offset });
  }
}

/** INTO가 관계 자리임을 확정하는 앞선 동사다. */
const intoVerbs = new Set(['insert', 'select', 'merge', 'replace']);

/** CREATE 문에서 ON이 관계 자리가 되는 객체 종류다. */
const createOnKinds = new Set(['index', 'trigger', 'policy']);

/** `table`을 키워드로 만드는 직전 DDL 동사다. */
const tableVerbs = new Set([
  'alter', 'drop', 'create', 'truncate', 'rename', 'lock', 'unlock', 'describe', 'desc', 'analyze', 'vacuum',
]);

/** GRANT 피연산자 목록을 끝내는 단어다. */
const grantTerminators = new Set(['to', 'from', ';']);

/** GRANT ON 뒤 테이블 계열 종류어다. */
const grantTableKinds = new Set(['table', 'tables', 'view', 'materialized']);

/** GRANT ON 뒤 비테이블 권한 객체 종류어다. */
const grantNonTableKinds = new Set([
  'all', 'sequence', 'schema', 'database', 'domain', 'type', 'function', 'procedure', 'routine', 'foreign',
  'server', 'wrapper', 'language', 'large', 'publication', 'subscription', 'statistics', 'tablespace',
  'collation', 'conversion', 'extension', 'aggregate', 'operator', 'policy', 'cast', 'fdw', 'parser',
  'template', 'dictionary', 'configuration',
]);

/** 뒤따르는 식별자가 관계 이름인 키워드다. */
const relationKeywords = new Set(['from', 'join', 'into', 'update', 'table', 'truncate', 'on']);

/** SQL 문을 여는 강한 동사다. */
const sqlVerbs = new Set([
  'select', 'insert', 'delete', 'create', 'alter', 'drop', 'replace', 'merge', 'lock', 'unlock', 'rename',
  'describe', 'desc', 'analyze', 'vacuum', 'grant', 'revoke',
]);

/** GRANT/REVOKE의 권한 단어다. `ON`이 관계 자리임을 확정하는 근거다. */
const grantPrivileges = new Set([
  'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'execute', 'usage', 'create',
  'connect', 'temporary', 'temp', 'maintain', 'all',
]);

/**
 * 관계 키워드와 이름 사이에 올 수 있는 수식어인지 본다.
 *
 * @param word 단어
 * @param afterTruncate TRUNCATE 뒤인지 여부(`table`은 그때만 수식어다)
 * @returns 수식어면 true
 */
function isNameModifier(word: string, afterTruncate: boolean): boolean {
  const lower = word.toLowerCase();
  return lower === 'only' || lower === 'if' || lower === 'not' || lower === 'exists'
    || (afterTruncate && lower === 'table');
}

/**
 * `(` 토큰부터 짝이 맞는 `)` 다음 위치를 돌려준다.
 *
 * @param tokens 어휘 목록
 * @param start `(` 위치
 * @returns `)` 다음 위치. 닫히지 않으면 undefined
 */
function skipParens(tokens: readonly SqlToken[], start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.quoted) continue;
    if (token.text === '(') depth++;
    else if (token.text === ')') {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/**
 * 관계 이름 위치에 올 수 없는 SQL 절 키워드다. `table`은 `UPDATE table SET` 때문에 제외하고,
 * 산문 관사 `the`·`an`은 포함한다(`a`는 흔한 별칭이라 제외).
 */
const clauseWords = new Set([
  'where', 'set', 'on', 'group', 'order', 'by', 'having', 'limit', 'offset',
  'union', 'intersect', 'except', 'values', 'returning', 'as', 'left',
  'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'using',
  'and', 'or', 'not', 'null', 'select', 'insert', 'delete', 'from', 'join',
  'into', 'update', 'truncate', 'with', 'for', 'in', 'is', 'case', 'when',
  'then', 'else', 'end', 'distinct', 'asc', 'desc', 'if', 'exists', 'only',
  'between', 'like', 'to', 'grant', 'revoke', 'option', 'cascade',
  'restrict', 'privileges', 'the', 'an',
]);

/**
 * `ident(.ident)*` 한정 이름을 읽는다.
 *
 * @param tokens 어휘 목록
 * @param start 시작 위치
 * @returns escape한 이름과 다음 위치. 이름이 아니면 undefined
 */
function readQualifiedName(
  tokens: readonly SqlToken[],
  start: number,
): { readonly name: string; readonly next: number } | undefined {
  const first = tokens[start];
  if (first === undefined) return undefined;
  if (first.quoted ? first.text.length === 0 : !isNameToken(first) || clauseWords.has(first.text.toLowerCase())) {
    return undefined;
  }
  let name = escapeSegment(first);
  let index = start + 1;
  while (index + 1 < tokens.length && tokens[index]!.text === '.' && !tokens[index]!.quoted) {
    const next = tokens[index + 1]!;
    if (!next.quoted && (!isNameToken(next) || clauseWords.has(next.text.toLowerCase()))) break;
    name += `.${escapeSegment(next)}`;
    index += 2;
  }
  return { name, next: index };
}

/**
 * 인용 세그먼트의 `%`와 `.`을 escape한다. 비인용 세그먼트는 점이 없어 `%`만 escape한다.
 *
 * @param token 세그먼트 토큰
 * @returns escape한 세그먼트
 */
function escapeSegment(token: SqlToken): string {
  return token.quoted ? escapeName(token.text) : token.text.replaceAll('%', '%25');
}

/**
 * 한정 이름의 각 세그먼트를 escape해 합친다. `.`는 한정자라는 계약과 맞춘다.
 *
 * @param name 한정 이름
 * @returns escape한 이름
 */
export function escapeQualified(name: string): string {
  return name.split('.').map((segment) => segment.replaceAll('%', '%25')).join('.');
}

/**
 * 이름 문자열 그대로를 한 세그먼트로 escape한다. `@@map("a.b")` 같은 값은 한정자가 아니라
 * 한 식별자다.
 *
 * @param name 식별자
 * @returns escape한 세그먼트
 */
export function escapeName(name: string): string {
  return name.replaceAll('%', '%25').replaceAll('.', '%2E');
}

/**
 * 비인용 식별자 토큰인지 본다.
 *
 * @param token 토큰
 * @returns 식별자면 true
 */
function isNameToken(token: SqlToken): boolean {
  return !token.quoted && token.text.length > 0 && isIdentStart(token.text.charCodeAt(0));
}

/**
 * SQL 식별자 시작 문자인지 본다. 비ASCII(서러게이트 포함)는 식별자로 본다.
 *
 * @param unit UTF-16 코드 단위
 * @returns 시작 문자면 true
 */
function isIdentStart(unit: number): boolean {
  return unit === 0x5f || unit === 0x24
    || (unit >= 0x61 && unit <= 0x7a)
    || (unit >= 0x41 && unit <= 0x5a)
    || unit >= 0x80;
}

/**
 * SQL 식별자 구성 문자인지 본다.
 *
 * @param unit UTF-16 코드 단위
 * @returns 구성 문자면 true
 */
function isIdentPart(unit: number): boolean {
  return isIdentStart(unit) || (unit >= 0x30 && unit <= 0x39);
}
