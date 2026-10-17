/**
 * 분석 대상 파일을 크기 상한 안에서 UTF-8로 읽고, 실패를 계수로 남긴다.
 *
 * "없다"와 "못 읽었다"를 구분하기 위한 장부다. 오류 문구에 경로·내용을 싣지 않고 개수만 센다.
 * 걷기 밖에서 조립한 경로가 디렉터리 링크를 따라가지 않게 판정하는 `LinkFreePaths`도 둔다.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { decodeUtf8 } from './source-text.ts';

/** 파일 하나의 크기 상한(바이트)이다. 이보다 큰 소스는 생성물일 가능성이 커 읽지 않고 센다. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** 읽은 파일의 텍스트와 수정 시각이다. */
export interface ReadResult {
  readonly text: string;
  readonly modifiedAt: Date;
}

/** 계수를 가진 파일 읽기 도우미다. */
export class ProjectReader {
  /** 읽지 못한 파일 수(권한·UTF-8 아님)다. */
  unreadable = 0;
  /** 크기 상한을 넘어 읽지 않은 파일 수다. */
  oversized = 0;
  /** 읽은 파일 중 가장 늦은 수정 시각이다. */
  newestModifiedAt: Date | undefined;

  /**
   * 파일을 읽는다.
   *
   * @param path 절대 경로
   * @returns 텍스트와 수정 시각. 읽지 못하면 undefined(계수에 남긴다)
   */
  read(path: string): ReadResult | undefined {
    let bytes: Uint8Array;
    let modifiedAt: Date;
    try {
      const result = readSourceBytes(path);
      if (result === undefined) {
        this.oversized++;
        return undefined;
      }
      modifiedAt = result.modifiedAt;
      bytes = result.bytes;
    } catch {
      // 권한·경합으로 못 읽은 파일은 unreadable 계수로 보고한다.
      this.unreadable++;
      return undefined;
    }
    const text = decodeUtf8(bytes);
    if (text === undefined) {
      this.unreadable++;
      return undefined;
    }
    if (this.newestModifiedAt === undefined || modifiedAt > this.newestModifiedAt) this.newestModifiedAt = modifiedAt;
    return { text, modifiedAt };
  }
}

/** 일반 파일 핸들에서만 최대 상한+1 바이트를 읽어 변경 중인 파일도 무제한 읽지 않는다. */
function readSourceBytes(path: string): { bytes: Uint8Array; modifiedAt: Date } | undefined {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('source is not a regular file');
    if (stats.size > MAX_SOURCE_BYTES) return undefined;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SOURCE_BYTES + 1 - total), null);
      if (count === 0) return { bytes: Buffer.concat(chunks, total), modifiedAt: stats.mtime };
      total += count;
      if (total > MAX_SOURCE_BYTES) return undefined;
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * 경로가 있는지와 종류를 본다.
 *
 * @param path 절대 경로
 * @returns 'file'·'directory'·undefined
 */
export function pathKind(path: string): 'file' | 'directory' | undefined {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return 'file';
    return stats.isDirectory() ? 'directory' : undefined;
  } catch {
    // 없는 경로는 종류가 없다.
    return undefined;
  }
}

/**
 * 링크를 따라가지 않고 본 경로 종류다. 'symlink'는 따라가지 않은 링크를 거친다는 뜻이고, 'outside'는
 * 어휘적으로 프로젝트 루트 밖이라는 뜻이다. undefined는 없거나 파일·디렉터리가 아닌 경로다.
 */
export type LinkFreePathKind = 'file' | 'directory' | 'symlink' | 'outside' | undefined;

/**
 * 걷기(`collectProjectFiles`)를 거치지 않고 조립한 프로젝트 안 경로(Prisma 설정·스키마·TypedSQL 위치)를
 * 걷기와 같은 링크 규칙으로 판정하고, 따라가지 않은 링크를 모은다.
 *
 * `stat`은 중간 디렉터리 링크를 따라가 프로젝트 밖 트리를 저장소 경로로 읽게 하므로, 루트부터 경로 요소마다
 * `lstat`한다. realpath 문자열 비교는 대소문자를 무시하는 파일 시스템에서 같은 경로를 밖으로 오판해 쓰지 않는다.
 * 같은 링크를 여러 경로가 거쳐도 한 번만 세도록 링크 경로로 모은다.
 */
export class LinkFreePaths {
  /** 판정 중 만나 따라가지 않은 링크의 절대 경로다. */
  readonly skippedLinks = new Set<string>();
  /** 프로젝트 루트 절대 경로(realpath)다. */
  private readonly root: string;

  /**
   * @param root 프로젝트 realpath
   */
  constructor(root: string) {
    this.root = root;
  }

  /**
   * 경로 종류를 본다. 루트와 경로 사이의 디렉터리 요소가 링크면 그 링크를 모으고 'symlink'다.
   * 마지막 요소는 지금처럼 `stat` 종류를 쓰되, 디렉터리를 가리키는 링크는 목록 읽기가 따라가므로 막는다.
   * 파일을 가리키는 마지막 링크는 'file'이다 — 읽기가 O_NOFOLLOW로 거부해 읽지 못한 파일로 센다.
   * 루트 자신은 호출자가 고른 조인 루트라 링크 여부를 보지 않는다.
   *
   * @param path 절대 경로
   * @returns 경로 종류
   */
  kind(path: string): LinkFreePathKind {
    const relativePath = relative(this.root, path);
    if (relativePath === '') return pathKind(path);
    const parts = relativePath.split(sep);
    if (parts[0] === '..' || isAbsolute(relativePath)) return 'outside';
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const stats = lstatOrUndefined(current);
      if (stats?.isSymbolicLink() === true) return this.skip(current);
      if (stats?.isDirectory() !== true) return undefined;
    }
    const kind = pathKind(path);
    return kind === 'directory' && lstatOrUndefined(path)?.isSymbolicLink() === true ? this.skip(path) : kind;
  }

  /**
   * 따라가지 않은 링크를 모은다.
   *
   * @param link 링크 절대 경로
   * @returns 'symlink'
   */
  private skip(link: string): 'symlink' {
    this.skippedLinks.add(link);
    return 'symlink';
  }
}

/**
 * lstat을 구한다.
 *
 * @param path 절대 경로
 * @returns 상태. 없거나 권한이 없으면 undefined
 */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    // 없거나 권한이 없는 경로는 종류가 없다(pathKind와 같은 규칙).
    return undefined;
  }
}
