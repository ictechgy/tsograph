/** 변경 분석 동안 compiler 입력을 캡처와 도구에 포함된 TypeScript lib로 제한한다. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const boundary = new AsyncLocalStorage<{ root: string; rejected: boolean }>();
const sdk = realpathSync(dirname(ts.getDefaultLibFilePath({})));

/** 경로가 디렉터리 안에 있는지 확인한다. */
function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child.split(/[\\/]/u)[0] !== '..';
}

/** 외부 입력의 바이트를 읽지 않는다. 존재한 외부 입력은 분석 전체를 거부하게 한다. */
export function frozenInputAllowed(path: string): boolean {
  const state = boundary.getStore();
  if (state === undefined) return true;
  const absolute = resolve(path);
  if (!existsSync(absolute)) return within(state.root, absolute);
  const real = realpathSync(absolute);
  if (within(state.root, real) || real === join(dirname(sdk), 'package.json') || (dirname(real) === sdk && /^lib(?:\..+)?\.d\.ts$/u.test(basename(real)))) return true;
  state.rejected = true;
  return false;
}

/** 비동기 호출별 경계로 일반 impact 모드와 동시에 실행해도 상태를 섞지 않는다. */
export async function withFrozenInputs<T>(root: string, analyze: () => Promise<T>): Promise<T> {
  const state = { root: realpathSync(root), rejected: false };
  const result = await boundary.run(state, analyze);
  if (state.rejected) throw new Error('capture analysis requires inputs outside the captured root; external config/dependencies are not frozen');
  return result;
}
