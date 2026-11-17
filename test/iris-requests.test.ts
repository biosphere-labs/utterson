// The changes Iris asked for before integrating (FAC-133 / FAC-145), written before the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRlm, openRouterDecisions, scripted, text, utterson, value, type DecisionQuestion, type Judge, type Model } from '../src/index.ts';

const task = { instructions: 'x', outputs: ['answer'] };
const submit = { note: 'n', code: 'SUBMIT({ answer: "ok" })' };

function fakeJudge(): Judge & { calls: number } {
  const j = {
    name: 'iris-judge', calls: 0,
    async decide(_state: unknown, questions: Record<string, DecisionQuestion>) {
      j.calls++;
      const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n,
        q.type === 'choice' ? { type: 'choice', choice: 'one_passage', confidence: 0.9 } : q.type === 'score' ? { type: 'score', score: 0 } : { type: 'noul', noul: 0.1 }]));
      return { answers, costUsd: 0 };
    },
  };
  return j;
}

test('(2) keys.model is optional when model and subModel are Model objects; still required for a name', () => {
  assert.ok(utterson({ model: scripted([]), subModel: scripted([]), task, keys: { decisions: 'd' } }).run);
  assert.ok(utterson({ model: scripted([]), task, keys: { decisions: 'd' } }).run);
  assert.throws(() => utterson({ model: 'deepinfra:Qwen/Qwen3-235B-A22B', task, keys: { decisions: 'd' } } as any), /keys\.model/);
  assert.throws(() => utterson({ model: scripted([]), subModel: 'deepinfra:Qwen/Qwen3-235B-A22B', task, keys: { decisions: 'd' } } as any), /keys\.model/);
});

test('(6) an injected judge is used, and then keys.decisions is not needed; with neither, it still fails loudly', async () => {
  const judge = fakeJudge();
  const agent = utterson({ model: scripted([submit]), task, decisions: { judge } });
  const result = await agent.run([text('t')]);
  assert.equal(result.status, 'submitted');
  assert.ok(judge.calls >= 1);
  assert.throws(() => utterson({ model: scripted([]), task } as any), /keys\.decisions/);
});

test('(3) the decision ledger is injectable, or none; nothing is written to the current folder', () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  process.chdir(dir);
  try {
    utterson({ model: scripted([]), task, keys: { decisions: 'd' }, decisions: { ledger: null } });
    assert.equal(existsSync(join(dir, 'utterson-decision-spend.jsonl')), false);
    assert.ok(openRouterDecisions({ model: 'perplexity/pplx-decider-v1.2', apiKey: 'k' }).decide, 'a judge without a ledger');
  } finally { process.chdir(cwd); }
});

test('(5) a signal aborted before the run stops it at once as cancelled', async () => {
  const rlm = createRlm({ model: scripted([submit]), task });
  const result = await rlm.run([text('t')], { signal: AbortSignal.abort() });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stop?.code, 'cancelled');
});

test('(5) aborting during a model call reaches the model through its request signal', async () => {
  let sawSignal: AbortSignal | undefined;
  const slow: Model = { name: 'slow', complete: (r) => new Promise((_, reject) => { sawSignal = r.signal; r.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await createRlm({ model: slow, task }).run([text('t')], { signal: controller.signal });
  assert.ok(sawSignal, 'the model got the signal');
  assert.equal(result.stop?.code, 'cancelled');
});

test('(5) aborting during a sandbox step stops it promptly', async () => {
  const controller = new AbortController();
  const rlm = createRlm({ model: scripted([{ note: 'hang', code: 'await new Promise(() => {})' }]), task, limits: { stepSeconds: 60 } });
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const result = await rlm.run([text('t'), value('q', 'q')], { signal: controller.signal });
  assert.equal(result.stop?.code, 'cancelled');
  assert.ok(Date.now() - started < 10_000, 'well before the 60 s step limit');
});
