import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
verifyNavigation();
verifyProjectInputFiles();
verifyGitignoreSelection();
verifyStaticPnp();
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
    verify(document.roots.every((entry) => entry.symbol?.entries === undefined)
      && document.reached.every((entry) => entry.symbol.entries === undefined), `${command} legacy entries omitted`);
    const marked = run([...args, '--entry-points']);
    verify(marked.status === 0 && JSON.parse(marked.stdout).roots[0]?.symbol?.entries?.includes('route-handler'),
      `${command} observed root entry kinds`);
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

/** 합성 등록을 배포 CLI로 추출해 graph의 같은 screen ID에 연결한다. */
function verifyNavigation() {
  const root = mkdtempSync(join(tmpdir(), 'tsograph-navigation-cli-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/router-api.ts'), 'export function registerScreens(input: unknown) { return input; }');
    writeFileSync(join(root, 'src/screens.ts'), 'export function Catalog() { return null; }');
    writeFileSync(join(root, 'src/router.ts'), `import { registerScreens } from './router-api';
import { Catalog } from './screens';
registerScreens([{ path: '/catalog/:item', screen: Catalog }]);`);
    writeFileSync(join(root, 'router-model.json'), JSON.stringify({ format: 'router-models', version: 1,
      models: [{ factory: { path: 'src/router-api.ts', name: 'registerScreens' }, routesArgument: 0,
        pathProperty: 'path', screenProperty: 'screen', pathSyntax: 'colon' }] }));
    const args = ['navigation', '--project', root, '--router-model', 'router-model.json'];
    const result = run(args);
    verify(result.status === 0, 'navigation success');
    const document = JSON.parse(result.stdout);
    verify(document.format === 'navigation-facts' && document.facts.length === 1, 'navigation document');
    verify(document.facts[0].urlTemplate === '/catalog/{}' && document.facts[0].screen.usr === 'src/screens.ts#Catalog', 'navigation exact identity');
    const graph = JSON.parse(run(['graph', '--project', root]).stdout);
    verify(graph.nodes.some((node) => node.id === document.facts[0].screen.usr), 'navigation graph identity');
    verify(run(['help', 'navigation']).status === 0, 'navigation help');
    verify(run(['navigation']).status === 64, 'navigation usage');
    writeFileSync(join(root, 'router-model.json'), '{');
    verify(run(args).status === 2, 'navigation model failure');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/**
 * 명령마다 realpath가 --project 밖인 입력 파일(스펙·client 모델·router 모델·--tsconfig)은 문서 없는 사용 오류 64,
 * 없는 입력 파일은 2이고, --project 안이면 절대 경로 --tsconfig도 받는지 확인한다.
 */
function verifyProjectInputFiles() {
  const root = mkdtempSync(join(tmpdir(), 'tsograph-input-files-'));
  try {
    const project = join(root, 'project');
    const config = JSON.stringify({ include: [], compilerOptions: { types: [] } });
    const routerModel = JSON.stringify({ format: 'router-models', version: 1, models: [{
      factory: { path: 'src/router-api.ts', name: 'registerScreens' }, routesArgument: 0,
      pathProperty: 'path', screenProperty: 'screen', pathSyntax: 'colon' }] });
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(project, 'src/router-api.ts'), 'export function registerScreens(input: unknown) { return input; }');
    for (const directory of [project, join(root, 'outside')]) {
      writeFileSync(join(directory, 'tsconfig.json'), config);
      writeFileSync(join(directory, 'router-model.json'), routerModel);
      writeFileSync(join(directory, 'client-model.json'), '{}');
    }
    writeFileSync(join(root, 'outside/spec.json'), '{"openapi": "3.0.0", "info": {"title": "x", "version": "1"}, "paths": {}}');
    const commands = [
      ['openapi spec', (file) => ['openapi', file('spec.json', true), '--service', 'x', '--project', project]],
      ['routes client model', (file) => ['routes', '--role', 'client', '--project', project, '--client-model', file('client-model.json')]],
      ['routes tsconfig', (file) => ['routes', '--role', 'client', '--project', project, '--tsconfig', file('tsconfig.json')]],
      ['navigation router model', (file) => ['navigation', '--project', project, '--router-model', file('router-model.json')]],
      ['navigation tsconfig', (file) => ['navigation', '--project', project, '--router-model', 'router-model.json', '--tsconfig', file('tsconfig.json')]],
      ['graph tsconfig', (file) => ['graph', '--project', project, '--tsconfig', file('tsconfig.json')]],
      ['reach tsconfig', (file) => ['reach', '--project', project, '--tsconfig', file('tsconfig.json'), 'src/router-api.ts#registerScreens']],
      ['impact tsconfig', (file) => ['impact', '--project', project, '--tsconfig', file('tsconfig.json'), 'src/router-api.ts#registerScreens']],
    ];
    for (const [name, build] of commands) {
      const outside = run(build((file, absolute) => (absolute ? join(root, 'outside', file) : `../outside/${file}`)));
      verify(outside.status === 64 && outside.stdout === '' && /is outside --project; /u.test(outside.stderr), `${name} outside --project`);
      verify(run(build((file) => join(project, `missing-${file}`))).status === 2, `${name} missing file`);
    }
    verify(run(['graph', '--project', project, '--tsconfig', join(project, 'tsconfig.json')]).status === 0, 'graph absolute tsconfig inside --project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 빌드된 공개 CLI에서 기본/선택 진입·JSON/NDJSON 한계·오류 코드를 검증한다. */
function verifyGitignoreSelection() {
  const root = mkdtempSync(join(tmpdir(), 'tsograph-cli-gitignore-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"types":[],"lib":[]},"files":["kept.ts","ignored.ts"]}');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(root, 'kept.ts'), 'export function kept() { return 1; }');
    writeFileSync(join(root, 'ignored.ts'), 'export function ignored() { return 2; }');
    const base = run(['graph', '--project', root]);
    verify(base.status === 0 && JSON.parse(base.stdout).nodes.some(node => node.id === 'ignored.ts#ignored'), 'gitignore default unchanged');
    for (const format of ['json', 'ndjson']) {
      const selected = run(['graph', '--project', root, '--respect-gitignore', '--format', format]);
      verify(selected.status === 0, `gitignore ${format} exit`);
      const records = format === 'json' ? [JSON.parse(selected.stdout)] : selected.stdout.trim().split('\n').map(line => JSON.parse(line));
      verify(!selected.stdout.includes('ignored.ts#ignored') && selected.stdout.includes('kept.ts#kept'), `gitignore ${format} selected entries`);
      verify(records.some(record => JSON.stringify(record.limitations ?? record.document?.limitations ?? []).includes('gitignore-selection:')), `gitignore ${format} selection contract`);
    }
    verify(run(['reach', '--graph-file', 'missing.json', '--respect-gitignore', 'root']).status === 64, 'gitignore saved graph misuse');
    writeFileSync(join(root, '.gitignore'), Buffer.from([0xff]));
    const refused = run(['graph', '--project', root, '--respect-gitignore']);
    verify(refused.status === 2 && refused.stdout === '' && refused.stderr.includes('.gitignore could not be read'), 'gitignore invalid metadata exit 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** 실제 Yarn이 만든 JSON/inline state와 ZIP을 빌드 CLI로 해석하며 loader를 실행하지 않는다. */
function verifyStaticPnp() {
  const fixture = fileURLToPath(new URL('../fixtures/pnp/yarn-generated/', import.meta.url));
  for (const inline of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'tsograph-cli-pnp-'));
    try {
      cpSync(fixture, root, { recursive: true });
      writeFileSync(join(root, '.pnp.cjs'), inline ? readFileSync(join(root, 'inline-state.txt')) : 'require("node:fs").writeFileSync("PNP_EXECUTED", "bad"); throw Error("must not run");');
      if (inline) rmSync(join(root, '.pnp.data.json'));
      const result = run(['graph', '--project', root]);
      verify(result.status === 0, `static PnP ${inline ? 'inline' : 'JSON'} CLI success`);
      const document = JSON.parse(result.stdout);
      verify(document.statistics.calls.external === 3 && document.statistics.calls.missingDependencies === 0 && document.statistics.calls.unresolved.untyped === 0, 'static PnP ZIP declarations actually resolve');
      const pnpIssues = [...new Set(document.limitations.filter(line => line.startsWith('pnp-dependencies:'))
        .flatMap(line => line.match(/\b(?:metadata-invalid|ignore-pattern-unsupported|ambiguous-owner|outside-boundary|archive-invalid|archive-budget|input-unreadable|missing-dependency|locator-mismatch)\b/gu) ?? []))].sort();
      verify(!document.limitations.some(line => line.includes('pnp-dependencies:')), `static PnP valid metadata is usable (issue codes: ${pnpIssues.join(',') || 'none'})`);
      verify(!existsSync(join(root, 'PNP_EXECUTED')), 'PnP loader not executed');
      const metadata = JSON.parse(readFileSync(join(fixture, '.pnp.data.json'), 'utf8'));
      const client = metadata.packageRegistryData.find(([name]) => name === '@fixture/client')[1].find(([ref]) => ref.startsWith('virtual:'))[1];
      const archive = client.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0] + '.zip';
      const originalSource = readFileSync(join(root, 'src/main.ts'));
      mkdirSync(join(root, '.tsograph-pnp'));
      cpSync(join(root, archive), join(root, '.tsograph-pnp/private.zip'));
      writeFileSync(join(root, 'src/main.ts'), 'import {answer} from "../.tsograph-pnp/private.zip/node_modules/@fixture/client/index"; export const value = answer();');
      const reserved = run(['graph', '--project', root]);
      verify(reserved.status === 0, 'reserved PnP namespace remains partial analysis');
      const reservedCalls = JSON.parse(reserved.stdout).statistics.calls;
      verify(reservedCalls.external === 0 && reservedCalls.missingDependencies === 0 && reservedCalls.unresolved['unresolved-import'] === 1 && reservedCalls.unresolved.untyped === 0, 'unmapped reserved PnP ZIP is not a resolved dependency');
      writeFileSync(join(root, 'src/main.ts'), originalSource);
      rmSync(join(root, archive));
      const missing = run(['graph', '--project', root]);
      verify(missing.status === 0 && JSON.parse(missing.stdout).limitations.some(line => line.includes('input-unreadable')), 'selected missing PnP ZIP retains explicit incomplete evidence');
      writeFileSync(join(root, '.pnp.data.json'), '{"packageRegistryData": [], "packageRegistryData": []}');
      const refused = run(['graph', '--project', root]);
      verify(refused.status === 0, 'invalid automatic PnP remains explicit partial analysis');
      const partial = JSON.parse(refused.stdout);
      verify(partial.limitations.some(line => line.includes('metadata-invalid')) && partial.statistics.calls.missingDependencies > 0 && partial.statistics.calls.unresolved.untyped > 0, 'invalid PnP metadata retains unresolved dependency evidence');
      writeFileSync(join(root, 'src/local.ts'), 'export function kept() { return 1; }');
      writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"types":[],"lib":[],"baseUrl":".","paths":{"alias/*":["src/*"],"@/*":["src/*"],"~/*":["src/*"],"$lib/*":["src/*"]}},"include":["src"]}');
      for (const alias of ['alias/local', '@/local', '~/local', '$lib/local']) {
        writeFileSync(join(root, 'src/main.ts'), `import {kept} from "${alias}"; export function caller() { return kept(); }`);
        const local = run(['graph', '--project', root]);
        verify(local.status === 0 && JSON.parse(local.stdout).edges.some(edge => edge.from === 'src/main.ts#caller' && edge.to === 'src/local.ts#kept'), `local alias ${alias} survives incomplete PnP metadata`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
