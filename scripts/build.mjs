import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChild } from './run-child.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(repositoryRoot, 'dist');
if (dirname(distDirectory) !== repositoryRoot || basename(distDirectory) !== 'dist') {
  throw new Error('Build refused an unsafe output directory.');
}
await rm(distDirectory, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
});

const compilerPath = join(repositoryRoot, 'node_modules/typescript/bin/tsc');
const result = runChild(
  process.execPath,
  [compilerPath, '--project', join(repositoryRoot, 'tsconfig.build.json')],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    timeout: 5 * 60_000,
  },
);
if (result.error !== undefined) {
  throw new Error('Build compiler failed to execute.');
}
process.exitCode = result.status ?? 2;
