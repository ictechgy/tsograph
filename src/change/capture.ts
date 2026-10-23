/** Git 객체와 작업 트리를 따로 고정한다. 분석 대상 명령·필터·hook은 실행하지 않는다. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 캡처 예산이다. 초과하면 부분 캡처를 분석하지 않는다. */
export const CAPTURE_LIMITS = { files: 20_000, fileBytes: 4 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 } as const;
/** 내용이 고정된 입력과 생략 범위다. */
export interface Capture { readonly files: ReadonlyMap<string, Buffer>; readonly digest: string; readonly revision?: string; readonly kind: 'git' | 'working-tree'; readonly omitted: number }
/** 예상한 입력 실패다. 원문 경로나 git stderr를 공개하지 않는다. */
export class CaptureError extends Error {}

/** 프로젝트 밖의 절대 PATH 항목에서만 git 실행 파일을 찾는다. */
function gitExecutable(root: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      const actual = realpathSync(candidate);
      const inside = relative(root, actual);
      if (statSync(actual).isFile() && (inside.startsWith(`..${sep}`) || isAbsolute(inside)) && dirname(actual) !== process.cwd()) return actual;
    } catch { /* 존재하지 않는 PATH 항목은 건너뛴다. */ }
  }
  throw new CaptureError('trusted Git executable unavailable');
}

/** Git 객체·파일 이름만 읽는다. diff, checkout, status, textconv를 실행하지 않는다. */
function git(root: string, args: readonly string[], maxBuffer = CAPTURE_LIMITS.totalBytes): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    return execFileSync(gitExecutable(root), ['--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new CaptureError('Git capture failed (requires Git 2.45+, local objects and a repository root)'); }
}

/** 상대 일반 파일만 임시 캡처에 쓴다. Windows 별칭·경로 탈출도 거부한다. */
function safePath(path: string): boolean {
  return path.length > 0 && !/[\\:\u0000-\u001f\u007f]/u.test(path) && !isAbsolute(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

/** 심볼릭 링크가 포함된 작업 트리 경로는 따라가지 않는다. */
function regularPath(root: string, path: string): boolean {
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) return false;
    if (lstatSync(cursor).isSymbolicLink()) return false;
  }
  return lstatSync(cursor).isFile();
}

/** 파일 경로와 실제 바이트를 함께 해시한다. topology hash와 달리 함수 본문 변경도 구별한다. */
export function contentDigest(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify([path, bytes.length])).update(bytes);
  return `sha256:${hash.digest('hex')}`;
}

/** stat 뒤 파일이 커져도 예산+1 byte만 읽고 실제 바이트만 보관한다. */
function readWorkingFile(path: string): Buffer {
  const fd = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= CAPTURE_LIMITS.fileBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, CAPTURE_LIMITS.fileBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}

/** Git 커밋 또는 현재 작업 트리(추적·비무시 미추적 파일)를 메모리에 고정한다. */
export function capture(root: string, revision?: string): Capture {
  if (!existsSync(join(root, '.git'))) throw new CaptureError('--project must be a Git repository root');
  const commit = revision === undefined ? undefined : git(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString('ascii').trim();
  if (commit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new CaptureError('invalid Git commit');
  const rows = git(root, commit === undefined ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] : ['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
  if (rows.length > CAPTURE_LIMITS.files) throw new CaptureError('capture file-count budget exceeded');
  const files = new Map<string, Buffer>();
  const spellings = new Set<string>();
  let total = 0;
  let omitted = 0;
  for (const row of rows) {
    const tab = row.indexOf('\t');
    const path = commit === undefined ? row : row.slice(tab + 1);
    const metadata = row.slice(0, tab).split(' ');
    if (!safePath(path)) throw new CaptureError('capture contains unsupported path spelling');
    if (commit !== undefined && !['100644', '100755'].includes(metadata[0]!)) { omitted++; continue; }
    if (commit === undefined && !regularPath(root, path)) { omitted++; continue; }
    if (files.has(path)) continue;
    const spelling = process.platform === 'win32' ? path.toLowerCase() : path;
    if (spellings.has(spelling)) throw new CaptureError('capture contains colliding file paths');
    spellings.add(spelling);
    if (commit === undefined && statSync(join(root, path)).size > CAPTURE_LIMITS.fileBytes) throw new CaptureError('capture per-file byte budget exceeded');
    const bytes = commit === undefined ? readWorkingFile(join(root, path)) : git(root, ['cat-file', 'blob', metadata[2]!], CAPTURE_LIMITS.fileBytes);
    if (bytes.length > CAPTURE_LIMITS.fileBytes || (total += bytes.length) > CAPTURE_LIMITS.totalBytes) throw new CaptureError('capture byte budget exceeded');
    files.set(path, bytes);
  }
  return { files, digest: contentDigest(files), kind: commit === undefined ? 'working-tree' : 'git', ...(commit === undefined ? {} : { revision: commit }), omitted };
}

/** 빈 임시 디렉터리에 캡처만 쓴다. 외부 의존성 설치나 소스 실행은 하지 않는다. */
export function materialize(captured: Capture, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const [path, bytes] of captured.files) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
  }
}
