/**
 * 프로젝트 루트 git 저장소의 HEAD 커밋을 읽는다(`revision`).
 *
 * git을 실행하지 않고 `.git`의 HEAD·ref 파일만 읽는다. 작업 트리 변경은 반영하지 않으므로 그래프 내용
 * 신원은 `graphRevision`(내용 해시)이 맡고, `revision`은 어느 커밋에서 분석했는지 알리는 정보다.
 * `.git`이 파일이면(worktree·submodule) `gitdir:`를 따라가고, ref는 gitdir → commondir → packed-refs 순으로 찾는다.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 커밋 id 형식(SHA-1 40자, SHA-256 64자)이다. */
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * HEAD 커밋 id를 읽는다.
 *
 * @param project 프로젝트 realpath
 * @returns 커밋 id. 저장소가 없거나 읽지 못하면 undefined
 */
export function readGitRevision(project: string): string | undefined {
  const gitDirectory = locateGitDirectory(project);
  if (gitDirectory === undefined) return undefined;
  const head = readText(join(gitDirectory, 'HEAD'));
  if (head === undefined) return undefined;
  if (objectId.test(head)) return head;
  const reference = /^ref: (refs\/[^\s]+)$/u.exec(head)?.[1];
  if (reference === undefined) return undefined;
  const common = readText(join(gitDirectory, 'commondir'));
  const directories = common === undefined ? [gitDirectory] : [gitDirectory, resolve(gitDirectory, common)];
  return directories.map((directory) => readReference(directory, reference)).find((value) => value !== undefined);
}

/**
 * 프로젝트 루트의 git 디렉터리를 찾는다(부모 디렉터리는 찾지 않는다).
 *
 * @param project 프로젝트 realpath
 * @returns git 디렉터리 절대 경로 또는 undefined
 */
function locateGitDirectory(project: string): string | undefined {
  const dotGit = join(project, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    // 저장소가 아니면 revision이 없다.
    return undefined;
  }
  const pointer = /^gitdir: (.+)$/u.exec(readText(dotGit) ?? '')?.[1];
  return pointer === undefined ? undefined : resolve(project, pointer);
}

/**
 * ref 하나를 loose 파일 또는 packed-refs에서 읽는다.
 *
 * @param directory git 디렉터리
 * @param reference `refs/…` 이름
 * @returns 커밋 id 또는 undefined
 */
function readReference(directory: string, reference: string): string | undefined {
  const loose = readText(join(directory, reference));
  if (loose !== undefined && objectId.test(loose)) return loose;
  const packed = readText(join(directory, 'packed-refs')) ?? '';
  for (const line of packed.split('\n')) {
    const [id, name] = line.split(' ');
    if (name === reference && id !== undefined && objectId.test(id)) return id;
  }
  return undefined;
}

/**
 * 작은 텍스트 파일을 읽어 앞뒤 공백을 뗀다.
 *
 * @param path 절대 경로
 * @returns 텍스트 또는 undefined(없음·읽기 실패)
 */
function readText(path: string): string | undefined {
  try {
    if (statSync(path).size > 1024 * 1024) return undefined;
    return readFileSync(path, 'utf8').trim();
  } catch {
    // 없는 ref 파일은 다음 후보(commondir·packed-refs)에서 찾는다.
    return undefined;
  }
}
