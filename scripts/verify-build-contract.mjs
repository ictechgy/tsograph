import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChild } from './run-child.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(repositoryRoot, 'dist');
const stalePath = join(distDirectory, '__stale-build-contract.js');

await mkdir(distDirectory, { recursive: true });
await writeFile(stalePath, 'stale build output\n', { flag: 'w' });
try {
  const build = runChild('npm', ['run', 'build'], {
    cwd: repositoryRoot,
    timeout: 6 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  verify(build.status === 0 && build.error === undefined, 'build');
  const staleWasRemoved = await access(stalePath)
    .then(() => false, () => true);
  verify(staleWasRemoved, 'stale output removal');
  process.stdout.write('Build contract verified: clean dist output.\n');
} finally {
  await unlink(stalePath).catch(() => undefined);
}

/** 빌드 계약 위반을 저장소 경로 없는 검사 이름으로 보고한다. */
function verify(condition, name) {
  if (!condition) throw new Error(`Build contract failed: ${name}`);
}
