import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChild } from './run-child.mjs';

// 빌드된 CLI(dist)가 종료 코드 계약(0/2/64, 1은 예약)을 지키는지 실제 프로세스로 확인한다.
const binaryPath = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures/openapi/', import.meta.url));
const nextFixtures = fileURLToPath(new URL('../fixtures/next/', import.meta.url));
const schemaFixture = fileURLToPath(new URL('../fixtures/schema/prisma-app/', import.meta.url));
const graphFixture = fileURLToPath(new URL('../fixtures/graph/next-prisma/', import.meta.url));
const packageDocument = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

verifyHelp();
verifyVersion();
verifyUsageErrors();
verifyOpenApiSuccess();
verifyOpenApiInputErrors();
verifyOpenApiUsageErrors();
verifyRoutesSuccess();
verifyRoutesErrors();
verifySchema();
verifyGraph();
process.stdout.write('CLI contract verified: 0/2/64 (1 reserved)\n');

/** 도움말이 성공으로 나오는지 확인한다. */
function verifyHelp() {
  const result = run(['--help']);
  verify(result.status === 0 && result.stdout.startsWith('Usage: tsograph'), 'help');
}

/** 버전이 package.json과 같은지 확인한다. */
function verifyVersion() {
  const result = run(['--version']);
  verify(result.status === 0 && result.stdout === `${packageDocument.version}\n`, 'version');
}

/** 잘못된 호출이 64로 끝나는지 확인한다. */
function verifyUsageErrors() {
  verify(run([]).status === 64, 'missing command');
  verify(run(['no-such-command']).status === 64, 'unknown command');
}

/** 합성 스펙이 결정적인 route-contract 문서로 변환되는지 확인한다. */
function verifyOpenApiSuccess() {
  for (const name of ['petstore-3.0.yaml', 'swagger-2.0.json', 'openapi-3.1.json', 'utf8-column.yaml']) {
    const args = ['openapi', join(fixtures, name), '--service', 'contract-check', '--format', 'json'];
    const first = run(args);
    verify(first.status === 0, `openapi ${name} exit code`);
    const document = JSON.parse(first.stdout);
    verify(document.format === 'bridge-facts' && document.version === 1, `openapi ${name} envelope`);
    verify(document.platform === 'openapi' && document.target === 'http', `openapi ${name} platform`);
    verify(document.facts.length > 0 && document.facts.every((fact) => fact.kind === 'route-contract'), `openapi ${name} facts`);
    const second = run(args);
    verify(withoutGeneratedAt(first.stdout) === withoutGeneratedAt(second.stdout), `openapi ${name} determinism`);
  }
  verify(run(['help', 'openapi']).stdout.startsWith('Usage: tsograph openapi'), 'openapi help');
}

/** 읽을 수 없거나 잘못된 스펙이 2로 끝나는지 확인한다. */
function verifyOpenApiInputErrors() {
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-cli-contract-'));
  try {
    const duplicate = join(directory, 'duplicate.yaml');
    writeFileSync(duplicate, 'openapi: 3.0.0\npaths:\n  /a: {}\n  /a: {}\n');
    verify(run(['openapi', duplicate, '--service', 'x']).status === 2, 'openapi duplicate key');
    verify(run(['openapi', join(directory, 'missing.yaml'), '--service', 'x']).status === 2, 'openapi missing file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** openapi의 잘못된 호출이 64로 끝나는지 확인한다. */
function verifyOpenApiUsageErrors() {
  const spec = join(fixtures, 'swagger-2.0.json');
  verify(run(['openapi', spec]).status === 64, 'openapi missing service');
  verify(run(['openapi', spec, '--service', 'x', '--format', 'yaml']).status === 64, 'openapi format');
  verify(run(['openapi', '--service', 'x']).status === 64, 'openapi missing spec');
}

/** 합성 Next 프로젝트가 결정적인 route-decl 문서로 변환되는지 확인한다. */
function verifyRoutesSuccess() {
  for (const name of ['app-router', 'pages-api']) {
    const args = ['routes', '--role', 'server', '--project', join(nextFixtures, name), '--service', 'contract-check', '--format', 'json'];
    const first = run(args);
    verify(first.status === 0, `routes ${name} exit code`);
    const document = JSON.parse(first.stdout);
    verify(document.format === 'bridge-facts' && document.version === 1, `routes ${name} envelope`);
    verify(document.platform === 'js' && document.target === 'http' && document.dispatch === 'specificity', `routes ${name} platform`);
    verify(document.facts.length > 0 && document.facts.every((fact) => fact.kind === 'route-decl'), `routes ${name} facts`);
    const second = run(args);
    verify(withoutGeneratedAt(first.stdout) === withoutGeneratedAt(second.stdout), `routes ${name} determinism`);
  }
  verify(run(['help', 'routes']).stdout.startsWith('Usage: tsograph routes'), 'routes help');
}

/** routes의 잘못된 호출은 64, 읽을 수 없는 프로젝트는 2로 끝나는지 확인한다. */
function verifyRoutesErrors() {
  const project = join(nextFixtures, 'app-router');
  verify(run(['routes', '--project', project]).status === 64, 'routes missing role');
  const client = run(['routes', '--role', 'client', '--project', project]);
  verify(client.status === 0 && JSON.parse(client.stdout).roles[0] === 'client', 'routes client role');
  verify(run(['routes', '--role', 'server']).status === 64, 'routes missing project');
  verify(run(['routes', '--role', 'server', '--project', join(project, 'missing')]).status === 2, 'routes missing project directory');
}

/** schema 명령이 결정적인 persistence 문서를 내고 0/2/64 계약을 지키는지 확인한다. */
function verifySchema() {
  const args = ['schema', '--project', schemaFixture, '--format', 'json'];
  const first = run(args);
  verify(first.status === 0, 'schema exit code');
  const document = JSON.parse(first.stdout);
  verify(document.format === 'bridge-facts' && document.version === 1, 'schema envelope');
  verify(document.platform === 'js' && document.target === 'persistence', 'schema platform');
  verify(document.facts.length > 0 && document.facts.every((fact) => fact.kind === 'relation-use'), 'schema facts');
  verify(withoutGeneratedAt(first.stdout) === withoutGeneratedAt(run(args).stdout), 'schema determinism');
  verify(run(['help', 'schema']).stdout.startsWith('Usage: tsograph schema'), 'schema help');
  verify(run(['schema']).status === 64, 'schema missing project');
  verify(run(['schema', '--project', schemaFixture, '--format', 'yaml']).status === 64, 'schema format');
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-cli-contract-'));
  try {
    verify(run(['schema', '--project', join(directory, 'missing')]).status === 2, 'schema missing directory');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** graph·reach·impact가 결정적인 문서를 내고 0/2/64 계약(모르는 id는 문서를 낸 뒤 64)을 지키는지 확인한다. */
function verifyGraph() {
  const graphArgs = ['graph', '--project', graphFixture, '--format', 'json'];
  const first = run(graphArgs);
  verify(first.status === 0, 'graph exit code');
  const snapshot = JSON.parse(first.stdout);
  verify(snapshot.format === 'tsograph-graph' && snapshot.version === 1 && /^sha256:/u.test(snapshot.graphRevision), 'graph envelope');
  verify(withoutGeneratedAt(first.stdout) === withoutGeneratedAt(run(graphArgs).stdout), 'graph determinism');
  const root = 'src/app/api/jobs/route.ts#POST';
  for (const [command, direction] of [['reach', 'dependencies'], ['impact', 'dependents']]) {
    const args = [command, '--project', graphFixture, root];
    const result = run(args);
    verify(result.status === 0, `${command} exit code`);
    const document = JSON.parse(result.stdout);
    verify(document.format === 'language-traversal' && document.version === 1 && document.direction === direction, `${command} envelope`);
    verify(document.graphRevision === snapshot.graphRevision, `${command} graphRevision`);
    verify(withoutGeneratedAt(result.stdout) === withoutGeneratedAt(run(args).stdout), `${command} determinism`);
    const unknown = run([command, '--project', graphFixture, 'src/nope.ts#missing', root]);
    verify(unknown.status === 64, `${command} unknown id exit code`);
    const partial = JSON.parse(unknown.stdout);
    verify(partial.roots[0].id === 'src/nope.ts#missing' && partial.roots[0].symbol === undefined
      && partial.roots[1].symbol?.usr === root && partial.truncationReasons.includes('root-not-found'), `${command} root-not-found document`);
    const missing = run([command, '--project', graphFixture]);
    verify(missing.status === 64 && missing.stdout === '', `${command} missing id`);
    verify(run(['help', command]).stdout.startsWith(`Usage: tsograph ${command}`), `${command} help`);
  }
  verify(run(['graph']).status === 64, 'graph missing project');
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-cli-contract-'));
  try {
    verify(run(['graph', '--project', join(directory, 'missing')]).status === 2, 'graph missing directory');
    verify(run(['reach', '--project', join(directory, 'missing'), root]).status === 2, 'reach missing directory');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 추출 시각만 다른 두 출력을 비교할 수 있게 generatedAt 줄을 지운다. */
function withoutGeneratedAt(text) {
  return text.replace(/"generatedAt": "[^"]*"/u, '');
}

/** 빌드된 CLI를 실행한다. */
function run(arguments_) {
  return runChild(process.execPath, [binaryPath, ...arguments_], { timeout: 60_000 });
}

/** 계약 위반을 검사 이름으로 보고한다. */
function verify(condition, name) {
  if (!condition) throw new Error(`CLI contract failed: ${name}`);
}
