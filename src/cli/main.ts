#!/usr/bin/env node

/**
 * 프로세스 진입점이다. 인자를 분배기에 넘기고 결과를 스트림·종료 코드로 옮긴다.
 *
 * 로직은 run-cli.ts에 두고 이 파일은 프로세스 경계만 다룬다.
 */

import { createNodeFileSystem } from './file-system.ts';
import { runCliSafely } from './run-cli.ts';
import { readToolVersion } from './tool-version.ts';

// write callback이 오류를 반환하는 동안 별도 error event도 종료 상태에 반영한다.
let outputFailed = false;
process.stdout.on('error', () => { outputFailed = true; });

/** 완료 callback을 기다려 그래프와 일반 출력 모두 pipe 실패를 성공으로 처리하지 않는다. */
function writeOutput(chunk: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(chunk, (error) => { if (error) reject(error); else resolve(); });
  });
}

const result = await runCliSafely(process.argv.slice(2), {
  toolVersion: readToolVersion(),
  fileSystem: createNodeFileSystem(),
  now: () => new Date(),
  graphOutput: writeOutput,
});
try { if (result.standardOutput !== '') await writeOutput(result.standardOutput); }
catch { outputFailed = true; }
process.stderr.write(result.standardError);
if (outputFailed && result.exitCode !== 2) process.stderr.write('tsograph: output could not be written; check the destination.\n');
process.exitCode = outputFailed ? 2 : result.exitCode;
