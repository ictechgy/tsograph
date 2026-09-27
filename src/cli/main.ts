#!/usr/bin/env node

/**
 * 프로세스 진입점이다. 인자를 분배기에 넘기고 결과를 스트림·종료 코드로 옮긴다.
 *
 * 로직은 run-cli.ts에 두고 이 파일은 프로세스 경계만 다룬다.
 */

import { createNodeFileSystem } from './file-system.ts';
import { runCliSafely } from './run-cli.ts';
import { readToolVersion } from './tool-version.ts';

const result = await runCliSafely(process.argv.slice(2), {
  toolVersion: readToolVersion(),
  fileSystem: createNodeFileSystem(),
  now: () => new Date(),
});
process.stdout.write(result.standardOutput);
process.stderr.write(result.standardError);
process.exitCode = result.exitCode;
