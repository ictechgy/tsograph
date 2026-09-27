/**
 * 명령이 쓰는 최소 파일 시스템 경계다.
 *
 * 명령 구현은 이 인터페이스만 받는다. 테스트는 실패 경로(읽기 오류 등)를
 * 가짜 구현으로 재현하고, 실제 실행은 Node 구현을 쓴다.
 */

import { readFile, realpath, stat } from 'node:fs/promises';

/** 경로 하나의 종류·크기·수정 시각이다. */
export interface PathStatus {
  readonly kind: 'file' | 'directory' | 'other';
  readonly size: number;
  readonly modifiedAt: Date;
}

/** 명령이 필요로 하는 파일 시스템 연산이다. 실패는 예외로 알린다. */
export interface CommandFileSystem {
  /** symlink·`..`를 푼 절대 경로(POSIX realpath)를 돌려준다. */
  realPath(path: string): Promise<string>;
  /** 경로의 종류·크기·mtime을 돌려준다. */
  status(path: string): Promise<PathStatus>;
  /** 파일 바이트를 읽는다. */
  readBytes(path: string): Promise<Uint8Array>;
}

/**
 * Node `fs/promises` 기반 구현을 만든다.
 *
 * @returns 실제 파일 시스템 구현
 */
export function createNodeFileSystem(): CommandFileSystem {
  return {
    realPath: (path) => realpath(path),
    status: async (path) => {
      const stats = await stat(path);
      const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
      return { kind, size: stats.size, modifiedAt: stats.mtime };
    },
    readBytes: (path) => readFile(path),
  };
}
