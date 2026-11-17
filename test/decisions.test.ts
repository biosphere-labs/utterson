import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseStrategy, chunkText, createRlm, datedEnvKey, decisionAdvisor, decisionTools, memoryLog, preparedStrategies,
  scripted, text, value, type DecisionQuestion, type Judge,
} from '../src/index.ts';

/** A judge that answers from a function of the state and the question, and records every call. */
function fakeJudge(answer: (state: any, name: string, q: DecisionQuestion) => any): Judge & { calls: number } {
  const judge = {
    name: 'fake', calls: 0,
    async decide(state: unknown, questions: Record<string, DecisionQuestion>) {
      judge.calls += 1;
      return { answers: Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, { type: q.type, ...answer(state, n, q) }])), costUsd: 0.001 };
    },
  };
  return judge;
}

test('datedEnvKey picks the newest DDMMYYYY key', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'keys-')), '.env');
  writeFileSync(path, 'OPENROUTER_API_KEY_01102026=old\nOPENROUTER_API_KEY_13112026="new"\nOTHER=x\n');
  const key = datedEnvKey(path, 'OPENROUTER_API_KEY_');
  assert.equal(key.name, 'OPENROUTER_API_KEY_13112026');
  assert.equal(key.value, 'new');
});

test('chunkText cuts at paragraph breaks and loses nothing', () => {
  const book = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`).join('\n\n');
  const chunks = chunkText(book, 1000);
  assert.equal(chunks.join(''), book);
  assert.ok(chunks.slice(0, -1).every((c) => c.endsWith('\n\n') && c.length <= 1000));
});

test('filter_chunks: one request per chunk, every condition scored, cost summed', async () => {
  const judge = fakeJudge((state) => ({ noul: state.chunk.includes('RULE') ? 0.9 : 0.05 }));
  const { filter_chunks } = decisionTools(judge);
  const out = await filter_chunks!.fn(['plain', 'a RULE here', 'plain'], { rule: 'Does the chunk state a rule?', date: 'Does it give a date?' }) as any;
  assert.equal(judge.calls, 3);
  assert.deepEqual(out.scores.map((s: any) => s.max), [0.05, 0.9, 0.05]);
  assert.ok(Math.abs(out.costUsd - 0.003) < 1e-9);
  await assert.rejects(async () => { await filter_chunks!.fn(['x'], 'not an object'); }, /conditions/);
});

test('chooseStrategy: the profile decides, low confidence falls back to the survey', () => {
  const p = { combine: 'rules_to_facts', combineConfidence: 0.95, namesHandles: 1, unnamedDependencies: 0.97, scope: 0.66 };
  assert.equal(chooseStrategy(p).strategy, 'rulebook');
  assert.equal(chooseStrategy({ ...p, combine: 'one_passage', unnamedDependencies: 0.6 }).strategy, 'searchFirst');
  assert.equal(chooseStrategy({ ...p, combine: 'one_passage', unnamedDependencies: 0.9 }).strategy, 'survey');
  assert.equal(chooseStrategy({ ...p, combine: 'total' }).strategy, 'mapReduce');
  assert.equal(chooseStrategy({ ...p, combineConfidence: 0.3 }).strategy, 'survey');
});

test('an advised run: the advice is logged and returned, and the prepared survey reaches the sandbox', async () => {
  // Each paragraph is padded to about 3,000 characters, so the 4,000-character chunks hold one paragraph each.
  const pad = (s: string) => s + ' filler'.repeat(430);
  const book = ['Ordinary text.', 'Jobs tagged billing may never be preempted.', 'More ordinary text.', 'Zorbo works in Ops.'].map(pad).join('\n\n');
  const judge = fakeJudge((state, name, q) => {
    if (q.type === 'choice') return { choice: 'rules_to_facts', confidence: 0.97 };
    if (q.type === 'score') return { score: 2 };
    if (state.chunk !== undefined) return { noul: state.chunk.includes('billing') ? 0.9 : 0.01 };
    return { noul: 0.95 };
  });
  // The sub-model is asked once for the conditions; the root then reads `survey` and submits what it found.
  const sub = scripted([{ conditions: [{ name: 'billing', question: 'Does the chunk say which jobs may be preempted?' }, { name: 'a', question: 'a?' }, { name: 'b', question: 'b?' }] }]);
  const root = scripted([{ note: 'read the survey', code: 'SUBMIT({ answer: survey.map(s => s.why + ":" + s.text.slice(0, 50)).join(" | ") })' }]);
  const log = memoryLog();
  const rlm = createRlm({
    model: root, subModel: sub, task: { instructions: 'Decide the case.', outputs: ['answer'] }, log,
    advisor: decisionAdvisor(judge, { strategies: preparedStrategies(judge) }),
  });
  const result = await rlm.run([text(book.repeat(1)), value('question', 'Does Zorbo preempt?')]);
  assert.equal(result.advice?.strategy, 'rulebook');
  assert.equal(result.advice?.prepared?.summary.kept, 2);
  assert.match(result.outputs!.answer, /billing:Jobs tagged billing/);
  assert.match(result.outputs!.answer, /name:Zorbo works in Ops/, 'a rare name from the inputs is kept even when the filter says no');
  assert.ok(log.events.some((e) => e.kind === 'advice'));
  assert.match(root.requests[0]!.prompt, /survey already done/);
});
