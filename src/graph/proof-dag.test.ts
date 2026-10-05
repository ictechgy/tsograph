/** 정적 proof DAG의 자원·문맥·negative replay 계약이다. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProofDag, ProofQuery, type ProofRecipe } from './proof-dag.ts';

const binding = () => ({ checker: {}, program: {}, view: 'whole', manifest: {}, policy: {}, version: 1 });
const leaf = (id: string, ok = true): ProofRecipe<boolean> => ({
  id, capability: 'legacy', identity: {}, valid: () => true,
  dependencies: () => [], evaluate: (work) => { work(); work(); return ok ? { kind: 'proved', value: true } : { kind: 'rejected', reason: 'syntax' }; },
});

test('cold/warm diamond retains negative child work and charges local work once', () => {
  const dag = new ProofDag(binding());
  const negative = leaf('negative', false);
  const child = (id: string): ProofRecipe<boolean> => ({ ...leaf(id), dependencies: () => [{ recipe: negative, depth: 1, frames: 1 }] });
  const root = { ...leaf('root'), dependencies: () => [
    { recipe: child('b'), depth: 1, frames: 1 }, { recipe: child('a'), depth: 1, frames: 1 },
  ] };
  const run = () => { const query = new ProofQuery(); const result = dag.resolve(root, query); return [result.kind, query.steps, query.maxDepth, query.maxFrames]; };
  assert.deepEqual(run(), ['rejected', 7, 2, 2]);
  assert.deepEqual(run(), ['rejected', 7, 2, 2]);
});

test('certificates bind context, capability, identity and current entry', () => {
  const context = binding(); const dag = new ProofDag(context); const recipe = leaf('root');
  const outcome = dag.resolve(recipe, new ProofQuery()); assert.equal(outcome.kind, 'proved');
  if (outcome.kind !== 'proved') return;
  assert.equal(dag.accepts(outcome.certificate, 'legacy', recipe.identity), true);
  assert.equal(dag.accepts(outcome.certificate, 'primitive-effects', recipe.identity), false);
  assert.equal(new ProofDag(binding()).accepts(outcome.certificate, 'legacy', recipe.identity), false);
  const invalid = { ...recipe, valid: () => false };
  assert.equal(dag.resolve(invalid, new ProofQuery()).kind, 'incomplete');
  assert.equal(dag.accepts(outcome.certificate, 'legacy', {}), false);
});

test('shared edges validate depth/frame requirements even after shallow success', () => {
  const dag = new ProofDag(binding()); const shared = leaf('shared');
  const root = { ...leaf('root'), dependencies: () => [
    { recipe: shared, depth: 1, frames: 1 }, { recipe: shared, depth: 257, frames: 1 },
  ] };
  assert.equal(dag.resolve(root, new ProofQuery()).kind, 'exhausted');
  assert.equal(dag.resolve({ ...root, dependencies: () => [{ recipe: shared, depth: 1, frames: 401 }] }, new ProofQuery()).kind, 'exhausted');
});

test('caller limits cannot raise fixed caps or disable them with malformed numbers', () => {
  const heavy = { ...leaf('heavy'), evaluate: (work: () => void) => {
    for (let i = 0; i < 20_001; i++) work();
    return { kind: 'proved' as const, value: true };
  } };
  const deep = { ...leaf('deep'), dependencies: () => [{ recipe: leaf('child'), depth: 257, frames: 0 }] };
  const framed = { ...leaf('framed'), dependencies: () => [{ recipe: leaf('child'), depth: 0, frames: 401 }] };
  for (const limit of [100_000, Infinity, NaN, -1, 1.5]) {
    const limits = { steps: limit, depth: limit, frames: limit };
    assert.equal(new ProofDag(binding()).resolve(heavy, new ProofQuery(limits)).kind, 'exhausted', `steps ${limit}`);
    assert.equal(new ProofDag(binding()).resolve(deep, new ProofQuery(limits)).kind, 'exhausted', `edges ${limit}`);
    assert.equal(new ProofDag(binding()).resolve(framed, new ProofQuery(limits)).kind, 'exhausted', `frames ${limit}`);
  }
  assert.equal(new ProofDag(binding()).resolve(leaf('normal'), new ProofQuery({ steps: 100_000, depth: 1_000, frames: 1_000 })).kind, 'proved');
  assert.equal(new ProofDag(binding()).resolve(leaf('small'), new ProofQuery({ steps: 2 })).kind, 'exhausted');
});

test('interrupted construction clears pending; exceptions and unstable outcomes never become semantic rejection', () => {
  const dag = new ProofDag(binding()); let fail = true;
  const recipe = { ...leaf('root'), evaluate: (work: () => void) => { work(); if (fail) throw new RangeError('internal'); return { kind: 'proved' as const, value: true }; } };
  assert.throws(() => dag.resolve(recipe, new ProofQuery()), RangeError); fail = false;
  assert.equal(dag.resolve(recipe, new ProofQuery()).kind, 'proved');
  const incomplete = { ...leaf('missing'), evaluate: () => ({ kind: 'incomplete' as const, reason: 'coverage' }) };
  assert.equal(dag.resolve(incomplete, new ProofQuery()).kind, 'incomplete');
  assert.equal(dag.resolve(leaf('missing'), new ProofQuery()).kind, 'proved');
  const cycle: ProofRecipe<boolean> = { ...leaf('cycle'), dependencies: () => [{ recipe: cycle, depth: 1, frames: 0 }] };
  assert.equal(dag.resolve(cycle, new ProofQuery()).kind, 'cycle');
  assert.equal(dag.resolve(leaf('cycle'), new ProofQuery()).kind, 'proved');
  assert.equal(dag.resolve(leaf('small'), new ProofQuery({ steps: 1 })).kind, 'exhausted');
  assert.equal(dag.resolve(leaf('small'), new ProofQuery()).kind, 'proved');
});

test('extended proof rejects mixed capability/mode without running a legacy fallback', () => {
  const context = { ...binding(), coverage: () => true };
  const dag = new ProofDag(context); const legacy = leaf('legacy');
  const extended = { ...leaf('extended'), mode: 'extended' as const, capability: 'primitive-effects' as const,
    dependencies: () => [{ recipe: legacy, depth: 1, frames: 0 }] };
  assert.deepEqual(dag.resolve(extended, new ProofQuery()), { kind: 'rejected', reason: 'capability' });
  assert.equal(dag.resolve(legacy, new ProofQuery()).kind, 'proved');
  const wrong = { ...leaf('wrong'), dependencies: () => [{ recipe: legacy, capability: 'descriptor' as const, depth: 1, frames: 0 }] };
  assert.deepEqual(dag.resolve(wrong, new ProofQuery()), { kind: 'rejected', reason: 'capability' });
  assert.deepEqual(new ProofDag(binding()).resolve(extended, new ProofQuery()), { kind: 'incomplete', reason: 'coverage' });
  const matching = { ...extended, id: 'matching', dependencies: () => [] };
  const result = dag.resolve(matching, new ProofQuery()); assert.equal(result.kind, 'proved');
  if (result.kind === 'proved') {
    assert.equal(result.certificate.mode, 'extended');
    assert.equal(dag.accepts(result.certificate, 'primitive-effects', matching.identity), false);
    assert.equal(dag.accepts(result.certificate, 'primitive-effects', matching.identity, new ProofQuery(), 'extended'), true);
  }
  assert.deepEqual(dag.resolve({ ...legacy, id: 'legacy-effects', capability: 'primitive-effects' }, new ProofQuery()), { kind: 'rejected', reason: 'capability' });
  assert.deepEqual(dag.resolve({ ...legacy, id: 'extended-legacy', mode: 'extended' }, new ProofQuery()), { kind: 'rejected', reason: 'capability' });
});

test('mode and capability mismatches reject before any child recipe executes', () => {
  let executions = 0;
  const child = { ...leaf('child'), evaluate: () => {
    executions++; throw new Error('mismatched child executed');
  } };
  const extendedChild = { ...child, id: 'extended-child', mode: 'extended' as const, capability: 'descriptor' as const };
  const cases: ProofRecipe<boolean>[] = [
    { ...leaf('extended-root'), mode: 'extended', capability: 'primitive-effects', dependencies: () => [{ recipe: child, depth: 1, frames: 0 }] },
    { ...leaf('legacy-root'), dependencies: () => [{ recipe: extendedChild, depth: 1, frames: 0 }] },
    { ...leaf('wrong-capability'), dependencies: () => [{ recipe: child, capability: 'descriptor', depth: 1, frames: 0 }] },
  ];
  for (const recipe of cases) {
    const dag = new ProofDag({ ...binding(), coverage: () => true });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(dag.resolve(recipe, new ProofQuery()), { kind: 'rejected', reason: 'capability' });
    }
  }
  assert.equal(executions, 0);
});

test('cold/warm local work preserves exact steps and edge-relative resource interruption', () => {
  const recipe = { ...leaf('local'), evaluate: (work: (depth?: number, frames?: number) => void) => {
    work(); work(2, 3); work(2, 3); work(4, 5); return { kind: 'proved' as const, value: true };
  } };
  const dag = new ProofDag(binding()); assert.equal(dag.resolve(recipe, new ProofQuery()).kind, 'proved');
  for (let steps = 0; steps <= 7; steps++) for (const depth of [0, 2, 4]) for (const frames of [0, 3, 5]) {
    const run = (runner: ProofDag) => {
      const query = new ProofQuery({ steps, depth, frames }); const result = runner.resolve(recipe, query);
      return [result.kind, query.steps, query.maxDepth, query.maxFrames];
    };
    assert.deepEqual(run(dag), run(new ProofDag(binding())), `${steps}/${depth}/${frames}`);
  }
  const root = { ...leaf('root'), dependencies: () => [{ recipe, depth: 253, frames: 396 }] };
  assert.equal(dag.resolve(root, new ProofQuery()).kind, 'exhausted');
  const identityMismatch = { ...recipe, identity: {} };
  assert.deepEqual(dag.resolve(identityMismatch, new ProofQuery()), { kind: 'incomplete', reason: 'identity' });
  const capabilityMismatch = { ...recipe, capability: 'descriptor' as const };
  assert.equal(dag.resolve(capabilityMismatch, new ProofQuery()).kind, 'incomplete');
});

test('canonical dependencies and reordered entry queries preserve costs and negatives', () => {
  const shared = leaf('shared', false); const other = leaf('other');
  const root = { ...leaf('root'), dependencies: (work: () => void) => {
    work(); return [{ recipe: shared, depth: 2, frames: 1 }, { recipe: other, depth: 1, frames: 2 }];
  } };
  const run = (order: boolean) => {
    const dag = new ProofDag(binding()); const query = new ProofQuery();
    const entries = order ? [root, shared, other] : [other, shared, root];
    const results = entries.map((entry) => dag.resolve(entry, query).kind);
    return { steps: query.steps, depth: query.maxDepth, frames: query.maxFrames, results: results.sort() };
  };
  assert.deepEqual(run(true), run(false));
  const capped = { ...leaf('cap'), dependencies: () => Array.from({ length: 20_001 }, () => ({ recipe: shared, depth: 1, frames: 0 })) };
  assert.equal(new ProofDag(binding()).resolve(capped, new ProofQuery()).kind, 'exhausted');
});

test('ordered guards have identical cold/warm events at every budget and check before callbacks', () => {
  let events: string[] = [];
  const guard = { read: () => { events.push('guard'); return true; } };
  const recipe: ProofRecipe<boolean> = { ...leaf('guarded'), dependencies: (work) => {
    work.require(guard, true, 2, 3); work(1, 1); return [];
  }, evaluate: (work) => {
    work(4, 5); assert.equal(work.observe(guard, 6, 7), true);
    return { kind: 'proved', value: true };
  } };
  const warm = new ProofDag(binding()); assert.equal(warm.resolve(recipe, new ProofQuery()).kind, 'proved');
  const run = (dag: ProofDag, steps: number, depth = 256, frames = 400) => {
    events = [];
    const query = new ProofQuery({ steps, depth, frames }, {
      step: () => { events.push('step'); }, check: (d, f) => { events.push(`check:${d}:${f}`); },
    });
    const outcome = dag.resolve(recipe, query);
    return { kind: outcome.kind, steps: query.steps, depth: query.maxDepth, frames: query.maxFrames, events: [...events] };
  };
  const full = run(new ProofDag(binding()), 20_000);
  for (let budget = 0; budget <= full.steps + 1; budget++) {
    assert.deepEqual(run(warm, budget), run(new ProofDag(binding()), budget), `budget ${budget}`);
  }
  for (const [depth, frames] of [[1, 400], [256, 2], [5, 400], [256, 6]]) {
    assert.deepEqual(run(warm, 20_000, depth, frames), run(new ProofDag(binding()), 20_000, depth, frames));
  }
  assert.equal(run(warm, 1).events.includes('guard'), false);
  assert.equal(run(warm, 20_000, 1).events.includes('guard'), false);
  assert.equal(full.events.filter((event) => event === 'guard').length, 1);
});

test('stale guard remains incomplete on repeated resolution and certificate acceptance in one query', () => {
  let allowed = true;
  const guard = { read: () => allowed };
  const recipe: ProofRecipe<boolean> = { ...leaf('stale'), dependencies: (work) => {
    work.require(guard, true); return [];
  } };
  const dag = new ProofDag(binding()); const success = dag.resolve(recipe, new ProofQuery());
  assert.equal(success.kind, 'proved'); if (success.kind !== 'proved') return;
  allowed = false;
  const query = new ProofQuery();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(dag.resolve(recipe, query), { kind: 'incomplete', reason: 'entry' });
    assert.equal(dag.accepts(success.certificate, 'legacy', recipe.identity, query), false);
  }
  const initiallyInvalid = new ProofDag(binding());
  assert.equal(initiallyInvalid.resolve(recipe, new ProofQuery()).kind, 'incomplete');
  allowed = true;
  assert.equal(initiallyInvalid.resolve(recipe, new ProofQuery()).kind, 'proved');
  assert.equal(dag.resolve(recipe, new ProofQuery()).kind, 'proved');
});

test('shared negative guarded nodes retain canonical work and fresh per-query snapshots', () => {
  let reads = 0;
  const guard = { read: () => { reads++; return false; } };
  const negative: ProofRecipe<boolean> = { ...leaf('guard-negative'), dependencies: (work) => {
    assert.equal(work.observe(guard, 1, 2), false); return [];
  }, evaluate: (work) => { work(); return { kind: 'rejected', reason: 'syntax' }; } };
  const child = (id: string): ProofRecipe<boolean> => ({ ...leaf(id), dependencies: (work) => {
    work.observe(guard); return [{ recipe: negative, depth: 1, frames: 1 }];
  } });
  const root = { ...leaf('guard-root'), dependencies: () => [
    { recipe: child('guard-b'), depth: 1, frames: 1 }, { recipe: child('guard-a'), depth: 2, frames: 1 },
  ] };
  const dag = new ProofDag(binding());
  const run = () => {
    reads = 0; const query = new ProofQuery(); const outcome = dag.resolve(root, query);
    return { kind: outcome.kind, steps: query.steps, depth: query.maxDepth, frames: query.maxFrames, reads };
  };
  const cold = run(); assert.equal(cold.kind, 'rejected'); assert.equal(cold.reads, 1);
  assert.deepEqual(run(), cold);
  const deep = { ...leaf('guard-deep'), dependencies: () => [{ recipe: negative, depth: 256, frames: 0 }] };
  assert.equal(dag.resolve(deep, new ProofQuery()).kind, 'exhausted');
});

test('guard exceptions and interrupted reads clear pending without caching unstable results', () => {
  let fail = true; let reads = 0;
  const guard = { read: () => { reads++; if (fail) throw new RangeError('internal guard'); return true; } };
  const recipe: ProofRecipe<boolean> = { ...leaf('guard-error'), dependencies: (work) => { work.require(guard, true); return []; } };
  const dag = new ProofDag(binding());
  assert.throws(() => dag.resolve(recipe, new ProofQuery()), RangeError);
  fail = false;
  assert.equal(dag.resolve(recipe, new ProofQuery()).kind, 'proved');
  const before = reads;
  assert.equal(dag.resolve(recipe, new ProofQuery({ steps: 1 })).kind, 'exhausted');
  assert.equal(reads, before);
  assert.equal(dag.resolve(recipe, new ProofQuery()).kind, 'proved');
});
