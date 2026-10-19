/**
 * SQL 텍스트에서 관계(테이블·뷰) 이름을 읽는 어휘 기반 추출기다.
 *
 * dartograph `sql_relations.dart`(kartograph `SqlRelations.kt`·cartograph
 * `SqlRelations.swift`의 포트)를 한 규칙씩 옮겼다. 생산자마다 같은 SQL을 다르게 읽으면
 * isthmus persistence 조인 결과가 생산자 언어에 따라 달라지므로 알고리즘·게이트·
 * 미해석 계수 규칙을 가족과 같게 유지한다. 오프셋은 JS 문자열의 UTF-16 코드 단위 위치다
 * (Dart와 같은 단위라 공유 벡터의 키워드 위치가 그대로 맞는다).
 *
 * 관계 이름이 아닌 세 경우 — 함수 인자 안의 FROM(R1), 같은 문장의 CTE 이름(R2), `IS [NOT] DISTINCT FROM`의
 * 피연산자(R3) — 는 persistence 생산자 계열이 같은 공통 사례로 고정한 규칙이다. 이 이름을 relation-use로 내면
 * isthmus가 선언과 잇지 못해 거짓 `relation-use-without-decl` error를 낸다.
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
  return tokenRelations(lexSql(text), strict);
}

/**
 * 어휘 목록에서 관계 이름을 읽는다(`sqlRelations`의 본체). 어휘를 위치마다 다시 훑지 않는지(작업량이 어휘 수에
 * 비례하는지) 테스트가 원소 읽기를 세는 목록을 넘길 수 있게 따로 둔다.
 *
 * @param tokens `lexSql` 어휘 목록
 * @param strict 관계 키워드와 동사가 대문자일 때만 발화할지 여부
 * @returns 관계 목록과 미해석 피연산자 수
 */
export function tokenRelations(tokens: readonly SqlToken[], strict = false): SqlRelationsResult {
  const scan = new RelationScan(tokens, strict);
  for (let index = 0; index < tokens.length; index++) scan.visitKeyword(index);
  return { relations: scan.out, unresolved: scan.unresolved };
}

/**
 * `sqlRelations` 한 번의 스캔 상태다. 포트 원본의 필드·메서드와 한 줄씩 대응한다. 다만 원본이 키워드마다 다시
 * 훑는 앞선 단어 탐색(`segmentBefore`)과 괄호 짝 찾기(`skipParens`)는 생성자에서 한 번 계산해 조회한다(결과는 같다).
 * R1·R2의 문맥(괄호 그룹이 함수 인자인지, 문장마다의 CTE 이름)도 생성자에서 한 번에 구한다 — 키워드·피연산자마다
 * 감싼 괄호나 문장을 다시 훑으면 어휘 수의 제곱이 된다.
 */
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
  /**
   * 비인용 `(` 위치 → 짝이 맞는 `)` 다음 위치다(닫히지 않으면 undefined). 괄호 피연산자마다 끝까지 다시 훑으면
   * 닫히지 않은 괄호가 반복되는 입력에서 어휘 수의 제곱이 된다.
   */
  private readonly closeAfter: (number | undefined)[];
  /**
   * 각 위치 앞쪽 같은 구간(직전 `;` 토큰 뒤)에 대문자 게이트를 통과한 단어 부류(`PRECEDING_*` 비트)가 있었는지다.
   * 키워드마다 구간을 거꾸로 다시 훑으면 세미콜론 없는 반복 INTO·ON 입력에서 어휘 수의 제곱이 된다.
   */
  private readonly precedingWords: Uint8Array;
  /** 각 토큰이 속한 문장 번호다. 경계는 `markStatements`와 같은 비인용 `;`이고, CTE 이름(R2)이 유효한 범위다. */
  private readonly statementIndex: Uint32Array;
  /** 문장 번호 → 그 문장이 정의한 CTE 이름의 비교 키(`nameKey`)다(R2). CTE가 없는 문장은 항목이 없다. */
  private readonly commonTableExpressionNames: ReadonlyMap<number, ReadonlySet<string>>;
  /** 각 위치를 감싼 가장 안쪽 비인용 괄호가 함수 인자 그룹이면 1이다(R1). */
  private readonly functionArguments: Uint8Array;
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
    this.closeAfter = matchParens(tokens);
    this.precedingWords = this.markPrecedingWords();
    this.markStatements();
    this.statementIndex = this.markStatementIndexes();
    const commonTableExpressions = this.findCommonTableExpressions();
    this.commonTableExpressionNames = commonTableExpressions.names;
    this.functionArguments = this.markFunctionArguments(commonTableExpressions.bodies);
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
   * 위치의 토큰이 비인용 단어 `word`인지 대소문자 없이 본다. R1~R3의 인식 단어용이라 strict 게이트를 걸지 않는다 —
   * 세 규칙은 관계를 빼기만 하고, strict 게이트는 관계 자리를 여는 키워드·동사에만 건다.
   *
   * @param index 토큰 위치
   * @param word 소문자 단어
   * @returns 같으면 true
   */
  private isWord(index: number, word: string): boolean {
    const token = this.tokens[index];
    return token !== undefined && !token.quoted && token.text.toLowerCase() === word;
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
   * 위치마다 앞쪽 같은 구간에 나온 단어 부류를 누적한다. 구간은 포트 원본 `segmentBefore`처럼 인용 여부와 무관하게
   * `;` 토큰에서 끊는다(문장 머리를 정하는 `markStatements`는 비인용 `;`만 본다 — 둘을 섞지 않는다).
   *
   * @returns 위치 → 앞선 단어 부류 비트
   */
  private markPrecedingWords(): Uint8Array {
    const flags = new Uint8Array(this.tokens.length);
    let seen = 0;
    for (let index = 0; index < this.tokens.length; index++) {
      const token = this.tokens[index]!;
      flags[index] = seen;
      if (token.text === ';') seen = 0;
      else if (!token.quoted && this.upperOk(token)) seen |= wordClasses(token.text.toLowerCase());
    }
    return flags;
  }

  /**
   * 토큰마다 속한 문장 번호를 매긴다. 경계는 `markStatements`와 같은 비인용 `;`이고 `;` 자신은 앞 문장에 속한다.
   *
   * @returns 위치 → 문장 번호
   */
  private markStatementIndexes(): Uint32Array {
    const statements = new Uint32Array(this.tokens.length);
    let statement = 0;
    for (let index = 0; index < this.tokens.length; index++) {
      statements[index] = statement;
      if (this.isSymbol(index, ';')) statement++;
    }
    return statements;
  }

  /**
   * R2: 문장마다 CTE 이름을 모은다. 꼴은 `WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] (`와
   * `, name [(cols)] AS [NOT] [MATERIALIZED] (`다. 열 목록은 미리 구한 괄호 짝으로 건너뛰므로 `WITH`·쉼표마다 상수
   * 개 토큰만 본다.
   *
   * @returns 문장 번호 → 이름 비교 키 집합과, CTE 본문을 여는 `(` 위치(R1의 함수 인자 그룹이 아니다)
   */
  private findCommonTableExpressions(): { names: Map<number, Set<string>>; bodies: Set<number> } {
    const names = new Map<number, Set<string>>();
    const bodies = new Set<number>();
    for (let index = 0; index < this.tokens.length; index++) {
      const token = this.tokens[index]!;
      if (token.quoted) continue;
      const withClause = token.text.toLowerCase() === 'with';
      if (!withClause && token.text !== ',') continue;
      const nameIndex = withClause && this.isWord(index + 1, 'recursive') ? index + 2 : index + 1;
      const body = this.commonTableExpressionBody(nameIndex);
      if (body === undefined) continue;
      bodies.add(body);
      const statement = this.statementIndex[nameIndex]!;
      names.set(statement, (names.get(statement) ?? new Set<string>()).add(nameKey(this.tokens[nameIndex]!)));
    }
    return { names, bodies };
  }

  /**
   * `nameIndex`에서 `name [(cols)] AS [NOT] [MATERIALIZED] (`가 시작하면 본문을 여는 `(` 위치를 돌려준다. 꼴이 문장
   * 경계를 넘거나 열 목록 괄호가 닫히지 않으면 CTE 정의가 아니다.
   *
   * @param nameIndex 이름 후보 위치
   * @returns 본문 `(` 위치. CTE 정의가 아니면 undefined
   */
  private commonTableExpressionBody(nameIndex: number): number | undefined {
    const name = this.tokens[nameIndex];
    if (name === undefined || !(name.quoted ? name.text.length > 0 : isNameToken(name))) return undefined;
    let cursor = this.isSymbol(nameIndex + 1, '(') ? this.closeAfter[nameIndex + 1] : nameIndex + 1;
    if (cursor === undefined || !this.isWord(cursor, 'as')) return undefined;
    cursor++;
    if (this.isWord(cursor, 'not')) cursor++;
    if (this.isWord(cursor, 'materialized')) cursor++;
    const sameStatement = this.statementIndex[cursor] === this.statementIndex[nameIndex];
    return sameStatement && this.isSymbol(cursor, '(') ? cursor : undefined;
  }

  /**
   * R1: 위치마다 감싼 가장 안쪽 비인용 괄호가 함수 인자 그룹인지 표시한다. 한 번의 훑기로 구하므로 FROM마다 감싼 괄호를
   * 거꾸로 찾지 않는다. 괄호 문맥은 비인용 `;`에서 비운다 — 닫히지 않은 함수 괄호가 다음 문장의 FROM을 가리지 않게
   * 하려는 것이다(R2와 같은 문장 단위).
   *
   * @param commonTableExpressionBodies CTE 본문을 여는 `(` 위치
   * @returns 위치 → 1(가장 안쪽 괄호가 함수 인자 그룹) 또는 0
   */
  private markFunctionArguments(commonTableExpressionBodies: ReadonlySet<number>): Uint8Array {
    const inside = new Uint8Array(this.tokens.length);
    const groups: boolean[] = [];
    for (let index = 0; index < this.tokens.length; index++) {
      const token = this.tokens[index]!;
      const symbol = token.quoted ? '' : token.text;
      if (symbol === ';') groups.length = 0;
      else if (symbol === '(') groups.push(this.opensFunctionArguments(index, commonTableExpressionBodies));
      else if (symbol === ')') groups.pop();
      inside[index] = groups.at(-1) === true ? 1 : 0;
    }
    return inside;
  }

  /**
   * `(`가 함수 인자 그룹을 여는지 본다(R1). 바로 앞 토큰이 함수 이름 — 절 단어·관계 키워드가 아닌 비인용 이름 — 이고
   * 그룹 첫 토큰이 하위 질의 머리(SELECT·WITH·VALUES)가 아니어야 한다. CTE 본문 괄호는 앞 토큰과 무관하게 함수 인자가
   * 아니다 — `AS MATERIALIZED (DELETE FROM t …)`의 `materialized`는 절 단어가 아니어서 이 제외가 없으면 `t`가 사라진다.
   *
   * @param open `(` 위치
   * @param commonTableExpressionBodies CTE 본문을 여는 `(` 위치
   * @returns 함수 인자 그룹이면 true
   */
  private opensFunctionArguments(open: number, commonTableExpressionBodies: ReadonlySet<number>): boolean {
    const callee = this.tokens[open - 1];
    if (callee === undefined || !isNameToken(callee) || commonTableExpressionBodies.has(open)) return false;
    const lower = callee.text.toLowerCase();
    if (clauseWords.has(lower) || relationKeywords.has(lower)) return false;
    const first = this.tokens[open + 1];
    return first === undefined || first.quoted || !subqueryHeads.has(first.text.toLowerCase());
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
   * 같은 구간 안의 앞선 비인용 토큰 중 대문자 게이트를 통과한 부류 단어가 있는지 본다.
   *
   * @param index 기준 위치
   * @param wordClass 단어 부류(`PRECEDING_*`)
   * @returns 있으면 true
   */
  private precededBy(index: number, wordClass: number): boolean {
    return (this.precedingWords[index]! & wordClass) !== 0;
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
      case 'into': return this.precededBy(index, PRECEDING_INTO_VERB);
      case 'table': return this.tableKeywordContext(index);
      case 'on': return this.onFires(index, grantStatement);
      // grant·revoke의 FROM은 권한 주체 자리다. 함수 인자 안의 FROM(`EXTRACT(YEAR FROM ts)`, R1)과
      // `IS [NOT] DISTINCT FROM`(R3)도 관계 자리가 아니고 미해석으로도 세지 않는다. JOIN에는 R1을 걸지 않는다.
      case 'from': return !grantStatement && this.functionArguments[index] === 0 && !this.distinctFromOperator(index);
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
    const grantOn = grantStatement && this.precededBy(index, PRECEDING_GRANT_PRIVILEGE);
    const createOn = this.statementVerb[index] === 'create' && this.precededBy(index, PRECEDING_CREATE_ON_KIND);
    return grantOn || createOn;
  }

  /**
   * R3: FROM이 비교 연산자 `IS [NOT] DISTINCT FROM`의 일부인지 본다. 앞 토큰들은 비인용이어야 하고 대소문자는 가리지
   * 않는다.
   *
   * @param from FROM 위치
   * @returns 연산자의 일부면 true
   */
  private distinctFromOperator(from: number): boolean {
    if (!this.isWord(from - 1, 'distinct')) return false;
    return this.isWord(from - 2, 'is') || (this.isWord(from - 2, 'not') && this.isWord(from - 3, 'is'));
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
        const next = this.closeAfter[index];
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
      const next = this.closeAfter[index];
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
      return this.closeAfter[read.next];
    }
    // R2: 같은 문장의 CTE 이름은 관계가 아니다(내지도 미해석으로 세지도 않는다). 소비·별칭·쉼표 목록 진행은 그대로 해
    // 뒤의 스캔을 바꾸지 않는다.
    if (!this.namesCommonTableExpression(index, read.next)) {
      if (buffer === undefined) this.emit(read.name, keyword);
      else buffer.push(read.name);
    }
    for (let consumed = index; consumed < read.next; consumed++) this.consumed[consumed] = true;
    return read.next;
  }

  /**
   * R2: 한정자 없는 피연산자가 같은 문장이 정의한 CTE 이름인지 본다. 한정 이름(`public.recent`)은 CTE가 아니다.
   *
   * @param index 피연산자 위치
   * @param next 피연산자 이름 다음 위치
   * @returns CTE 이름이면 true
   */
  private namesCommonTableExpression(index: number, next: number): boolean {
    if (next !== index + 1) return false;
    const names = this.commonTableExpressionNames.get(this.statementIndex[index]!);
    return names !== undefined && names.has(nameKey(this.tokens[index]!));
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

/** `precededBy`가 보는 앞선 단어 부류 비트다: INTO 앞 동사. */
const PRECEDING_INTO_VERB = 1;

/** `precededBy`가 보는 앞선 단어 부류 비트다: GRANT/REVOKE 권한 단어. */
const PRECEDING_GRANT_PRIVILEGE = 2;

/** `precededBy`가 보는 앞선 단어 부류 비트다: CREATE 문 ON 앞 객체 종류. */
const PRECEDING_CREATE_ON_KIND = 4;

/**
 * 소문자 단어가 속한 앞선 단어 부류 비트를 모은다(한 단어가 여러 부류일 수 있다 — `select`·`trigger`).
 *
 * @param lower 소문자 단어
 * @returns 부류 비트
 */
function wordClasses(lower: string): number {
  return (intoVerbs.has(lower) ? PRECEDING_INTO_VERB : 0)
    | (grantPrivileges.has(lower) ? PRECEDING_GRANT_PRIVILEGE : 0)
    | (createOnKinds.has(lower) ? PRECEDING_CREATE_ON_KIND : 0);
}

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

/** 괄호 그룹을 하위 질의로 만드는 첫 단어다(R1). 이 단어로 시작하는 그룹 안의 FROM은 함수 이름 뒤에서도 관계를 낸다. */
const subqueryHeads = new Set(['select', 'with', 'values']);

/**
 * CTE 이름과 한정자 없는 피연산자의 비교 키다(R2). 비인용 이름은 소문자로 접고 인용 이름은 그대로 둔다 — SQL 표준·
 * Postgres의 식별자 규칙이고 계열 생산자와 같은 선택이다(`"recent"`는 `recent`와 같고 `"Recent"`와는 다르다).
 *
 * @param token 이름 토큰
 * @returns 비교 키
 */
function nameKey(token: SqlToken): string {
  return token.quoted ? token.text : token.text.toLowerCase();
}

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
 * 비인용 `(`마다 짝이 맞는 `)` 다음 위치를 한 번에 구한다. 인용 괄호는 세지 않고, 짝 없는 `)`는 건너뛴다 —
 * `(`부터 깊이를 세어 0이 되는 `)`를 찾던 원본 `skipParens`와 같은 짝이다.
 *
 * @param tokens 어휘 목록
 * @returns 위치 → `)` 다음 위치(`(`가 아니거나 닫히지 않으면 undefined)
 */
function matchParens(tokens: readonly SqlToken[]): (number | undefined)[] {
  const closeAfter: (number | undefined)[] = tokens.map(() => undefined);
  const open: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.quoted) continue;
    if (token.text === '(') open.push(index);
    else if (token.text === ')') {
      const start = open.pop();
      if (start !== undefined) closeAfter[start] = index + 1;
    }
  }
  return closeAfter;
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
