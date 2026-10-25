/** 프로젝트 내부 .gitignore만 명령별로 고정해 진입 파일 선택에 적용한다. Git/대상 코드는 실행하지 않는다. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { readBoundedFileBytes } from '../graph/bounded-config-reader.ts';

/** 읽기·패턴·경로 비교 전체의 상한이다. 초과 입력은 부분 선택으로 진행하지 않는다. */
export const GITIGNORE_LIMITS = { fileBytes: 64 * 1024, totalBytes: 1024 * 1024, files: 2048,
  rules: 8192, lineLength: 4096, depth: 64, pathLength: 4096, comparisons: 100_000_000 } as const;

/** .gitignore를 신뢰할 수 없을 때 원문·절대 경로 없이 전체 명령을 거부한다. */
export class GitignoreInputError extends Error {
  constructor() {
    super('project-local .gitignore could not be read within its UTF-8, regular-file, path or work budgets; fix the ignore files or pass a narrower project');
    this.name = 'GitignoreInputError';
  }
}

interface RuleGroup { readonly matcher: Ignore; readonly rules: number }
interface SelectionState { readonly policies: Map<string, ProjectGitignore> }
const selection = new AsyncLocalStorage<SelectionState>();

/** 비동기 명령별 정책과 메모를 격리한다. 일반 API·동시 기본 명령에는 옵션이 새지 않는다. */
export function withGitignoreSelection<T>(run: () => T): T {
  return selection.run({ policies: new Map() }, run);
}

/** 출력에 선택 범위를 남긴다. ignored 의존성을 읽는 것은 진입 선택과 별개다. */
export function gitignoreSelectionLimitation(): string | undefined {
  return selection.getStore() === undefined ? undefined
    : 'gitignore-selection: project-local .gitignore rules select entries, including explicitly configured files; imported dependencies may still be read; global excludes, .git/info/exclude and tracked-file precedence are not applied';
}

/** compiler 설정의 files/include 진입도 같은 정책으로 고른다. import 의존성 reader에는 쓰지 않는다. */
export function gitignoreEntryFilter(root: string): ((absolute: string) => boolean) | undefined {
  if (selection.getStore() === undefined) return undefined;
  return (absolute) => {
    let directory = false;
    try { directory = lstatSync(absolute).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GitignoreInputError(); }
    return acceptsGitignoreEntry(root, absolute, directory);
  };
}

/** scanner에서 이미 종류를 확인한 파일·디렉터리를 고른다. symlink는 호출자의 기존 정책대로 제외한다. */
export function acceptsGitignoreEntry(root: string, absolute: string, directory = false): boolean {
  const state = selection.getStore();
  if (state === undefined) return true;
  const key = resolve(root);
  let policy = state.policies.get(key);
  if (policy === undefined) { policy = new ProjectGitignore(key); state.policies.set(key, policy); }
  return policy.accepts(absolute, directory);
}

/** 루트와 하위 규칙을 origin별로 적용한다. 제외한 부모 아래의 negation은 부모를 복구할 수 없다. */
class ProjectGitignore {
  readonly #root: string;
  readonly #groups = new Map<string, RuleGroup | undefined>();
  readonly #directories = new Map<string, boolean>();
  #bytes = 0;
  #loaded = 0;
  #rules = 0;
  #work = 0;
  constructor(root: string) { this.#root = root; this.#directories.set(root, true); }

  /** 모든 부모가 선택되고 root-relative 마지막 경로도 선택될 때만 진입을 허용한다. */
  accepts(absolute: string, directory: boolean): boolean {
    const path = resolve(absolute);
    const child = relative(this.#root, path);
    if (child === '') return true;
    const parts = child.split(sep);
    if (isAbsolute(child) || parts[0] === '..' || parts.length > GITIGNORE_LIMITS.depth || child.length > GITIGNORE_LIMITS.pathLength) throw new GitignoreInputError();
    let cursor = this.#root;
    for (const part of parts.slice(0, -1)) {
      cursor = join(cursor, part);
      if (!this.#directory(cursor)) return false;
    }
    if (directory) return this.#directory(path);
    return this.#selected(path, false);
  }

  /** 디렉터리를 따라가기 전에 lstat으로 링크·비일반 경로를 막고 부모 결과를 메모한다. */
  #directory(path: string): boolean {
    const known = this.#directories.get(path);
    if (known !== undefined) return known;
    let regular = false;
    try { regular = lstatSync(path).isDirectory(); } catch { throw new GitignoreInputError(); }
    const accepted = regular && this.#selected(path, true);
    this.#directories.set(path, accepted);
    return accepted;
  }

  /** 각 .gitignore에 상대적인 경로를 검사해 가장 가까운 명시 규칙을 우선한다. */
  #selected(path: string, directory: boolean): boolean {
    const origins: string[] = [];
    for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
      origins.push(cursor);
      if (cursor === this.#root) break;
    }
    let selected = true;
    for (const origin of origins.reverse()) {
      const group = this.#group(origin);
      if (group === undefined) continue;
      const local = relative(origin, path).split(sep).join('/') + (directory ? '/' : '');
      this.#work += group.rules * Math.max(local.length, 1);
      if (this.#work > GITIGNORE_LIMITS.comparisons) throw new GitignoreInputError();
      let result;
      try { result = group.matcher.test(local); } catch { throw new GitignoreInputError(); }
      if (result.ignored) selected = false;
      else if (result.unignored) selected = true;
    }
    return selected;
  }

  /** symlink/FIFO/장치·잘못된 UTF-8·변경 중 커진 파일은 열거 결과로 대체하지 않고 거부한다. */
  #group(origin: string): RuleGroup | undefined {
    if (this.#groups.has(origin)) return this.#groups.get(origin);
    const path = join(origin, '.gitignore');
    try { if (!lstatSync(path).isFile()) throw new GitignoreInputError(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GitignoreInputError();
      this.#groups.set(origin, undefined); return undefined;
    }
    if (++this.#loaded > GITIGNORE_LIMITS.files) throw new GitignoreInputError();
    const read = readBoundedFileBytes(path, GITIGNORE_LIMITS.fileBytes, { noFollow: true });
    if (!read.ok) throw new GitignoreInputError();
    this.#bytes += read.bytes.length;
    if (this.#bytes > GITIGNORE_LIMITS.totalBytes) throw new GitignoreInputError();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); } catch { throw new GitignoreInputError(); }
    const lines = text.split(/\r?\n/u);
    if (text.includes('\0') || lines.some(line => line.length > GITIGNORE_LIMITS.lineLength)) throw new GitignoreInputError();
    const rules = lines.filter(line => line !== '' && !line.startsWith('#')).length;
    this.#rules += rules;
    if (this.#rules > GITIGNORE_LIMITS.rules) throw new GitignoreInputError();
    let matcher: Ignore;
    try { matcher = ignore({ ignorecase: false }).add(text); } catch { throw new GitignoreInputError(); }
    const group = { matcher, rules };
    this.#groups.set(origin, group);
    return group;
  }
}
