// Node 백엔드 라우트 오라클: 합성 fixture를 스크래치 사본에 설치해 실제 프레임워크로 불러오고, tsograph 문서의 예측과
// 실제 응답을 대조해 `recorded/<fixture>.json`에 기록한다.
//
// 사용법: node experiments/node-routes-oracle/run-oracle.mjs <스크래치 디렉터리> [fixture 이름 ...]
//
// - 네트워크는 npm 레지스트리(`npm install --ignore-scripts`)에만 쓴다. 요청은 프로세스 안(`app.request`·`inject`)이나
//   127.0.0.1 임시 포트로만 보내고 끝나면 서버를 닫는다.
// - 기록에는 절대 경로·시각을 싣지 않는다(tsograph 문서의 `project`·`generatedAt`은 뺀다).
// - 분석 대상 코드를 실행하는 것은 이 하네스뿐이다. 제품(tsograph)은 실행하지 않는다.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES } from './fixtures.mjs';
import { factProbes, markerLookup, recallProbes, summarize } from './lib/probes.mjs';

/** 저장소 루트다. */
const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * fixture 소스 파일 목록(기준 경로)을 모은다.
 *
 * @param {string} root fixture 루트
 * @returns {string[]} 파일 목록
 */
function sourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(relative(root, path));
    }
  };
  walk(root);
  return files.sort();
}

/**
 * tsograph routes를 fixture 원본에 실행한다.
 *
 * @param {string} fixture fixture 원본 경로
 * @returns {object} 문서
 */
function runTsograph(fixture) {
  const output = execFileSync(process.execPath, [join(repository, 'src/cli/main.ts'), 'routes', '--role', 'server', '--project', fixture], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output);
}

/**
 * 설치한 패키지 버전을 읽는다.
 *
 * @param {string} copy 사본 경로
 * @param {string[]} names 패키지 이름
 * @returns {Record<string, string>} 이름 → 버전
 */
function installedVersions(copy, names) {
  return Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(join(copy, 'node_modules', name, 'package.json'), 'utf8')).version]));
}

/**
 * fixture 하나를 기록한다.
 *
 * @param {string} scratch 스크래치 디렉터리
 * @param {object} spec fixture 명세
 * @returns {Promise<object>} 요약
 */
async function recordFixture(scratch, spec) {
  const original = join(repository, 'fixtures/node', spec.name);
  const copy = join(scratch, `oracle-${spec.name}`);
  rmSync(copy, { recursive: true, force: true });
  cpSync(original, copy, { recursive: true });
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: copy, stdio: 'inherit' });
  if (spec.prepare !== undefined) await spec.prepare(copy);
  const document = runTsograph(original);
  const files = sourceFiles(original);
  const driver = await spec.load(copy);
  const log = console.log;
  // fixture의 로거 미들웨어 출력은 기록과 무관하므로 탐침 동안 가린다.
  console.log = () => undefined;
  try {
    // CONNECT는 Node가 요청 처리기로 넘기지 않는다. fixture가 막는 method(예: cors의 OPTIONS 응답)도 뺀다.
    const skipMethods = new Set(['CONNECT', ...(spec.skipMethods ?? [])]);
    const context = { document, markerOf: markerLookup(original, files), request: driver.request, skipMethods };
    const records = [...await factProbes(context), ...await recallProbes(context, driver.routeRequests())];
    const summary = summarize(document, records);
    const dependencies = Object.keys(JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')).dependencies ?? {});
    const recording = { fixture: spec.name, framework: spec.framework, versions: installedVersions(copy, dependencies), dispatch: document.dispatch, facts: document.facts, limitations: document.limitations, records, summary };
    writeFileSync(join(repository, 'experiments/node-routes-oracle/recorded', `${spec.name}.json`), `${JSON.stringify(recording, null, 2)}\n`);
    return summary;
  } finally {
    console.log = log;
    await driver.close();
  }
}

const [scratch, ...only] = process.argv.slice(2);
if (scratch === undefined || !existsSync(scratch)) {
  console.error('usage: node experiments/node-routes-oracle/run-oracle.mjs <scratch-directory> [fixture ...]');
  process.exit(64);
}
mkdirSync(join(repository, 'experiments/node-routes-oracle/recorded'), { recursive: true });
for (const spec of FIXTURES.filter((entry) => only.length === 0 || only.includes(entry.name))) {
  const summary = await recordFixture(scratch, spec);
  console.log(`${spec.name}: precision ${summary.verifiedFacts}/${summary.staticFacts}, recall ${summary.coveredRoutes}/${summary.servedRoutes}, probes ${summary.probes - summary.failedProbes}/${summary.probes}, dynamic ${summary.dynamicFacts}`);
}
