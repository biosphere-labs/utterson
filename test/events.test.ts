import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_SCHEMA_VERSION, createRlm, decisionAdvisor, preparedStrategies, scripted, text, value,
  type DecisionQuestion, type Judge, type LoggedEvent } from '../src/index.ts';

const task = { instructions: 'Find it.', outputs: ['answer'] };
const ONE_SUB = [
  { note: 'ask', code: 'memory.a = await llm_query("what is it?"); print(memory.a)' },
  { note: 'done', code: 'SUBMIT({ answer: memory.a })' },
];
const priced = (m: ReturnType<typeof scripted>) => ({ ...m, name: 'scripted-priced',
  complete: async (r: any) => ({ ...(await m.complete(r)), usage: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.01, costIsNotional: true, requestId: 'req-1' }) });

test('every event carries the schema version; model_call records root and sub calls with model, usage, cost and hash', async () => {
  const events: LoggedEvent[] = [];
  const rlm = createRlm({ model: priced(scripted(ONE_SUB)), subModel: priced(scripted(['42'])), task, events: [(e) => { events.push(e); }] });
  const result = await rlm.run([text('the text')]);
  assert.equal(result.outputs?.answer, '42');
  assert.ok(events.every((e) => e.schema === EVENT_SCHEMA_VERSION));
  const calls = events.filter((e) => e.kind === 'model_call') as Array<Extract<LoggedEvent, { kind: 'model_call' }>>;
  assert.deepEqual(calls.map((c) => c.role), ['root', 'sub', 'root']);
  const sub = calls[1]!;
  assert.equal(sub.model, 'scripted-priced');
  assert.deepEqual(sub.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(sub.costIsNotional, true);
  assert.equal(sub.requestId, 'req-1');
  assert.match(sub.promptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sub.payload, undefined, 'no payload unless asked');
});

test('includePayloads adds the full request and reply', async () => {
  const events: LoggedEvent[] = [];
  const rlm = createRlm({ model: scripted(ONE_SUB), subModel: scripted(['42']), task, includePayloads: true, events: [(e) => { events.push(e); }] });
  await rlm.run([text('t')]);
  const sub = events.find((e) => e.kind === 'model_call' && e.role === 'sub') as any;
  assert.equal(sub.payload.request.prompt, 'what is it?');
  assert.equal(sub.payload.reply, '42');
});

test('a handler that throws never breaks the run; the others get handler_error. strictEvents stops the run instead', async () => {
  const seen: LoggedEvent[] = [];
  const bad = () => { throw new Error('inspector bug'); };
  const rlm = createRlm({ model: scripted([{ note: 'n', code: 'SUBMIT({ answer: "x" })' }]), task, events: [bad, (e) => { seen.push(e); }] });
  assert.equal((await rlm.run([text('t')])).status, 'submitted');
  assert.ok(seen.some((e) => e.kind === 'handler_error' && /inspector bug/.test(e.error)));

  const strict = createRlm({ model: scripted([{ note: 'n', code: 'SUBMIT({ answer: "x" })' }]), task, events: [bad], strictEvents: true });
  const stopped = await strict.run([text('t')]);
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.stop!.detail, /inspector bug/);
});

test('on(kind) receives only that kind and can unsubscribe; the log option still works', async () => {
  const logged: LoggedEvent[] = [];
  const rlm = createRlm({ model: scripted([{ note: 'n', code: 'SUBMIT({ answer: "x" })' }, { note: 'n', code: 'SUBMIT({ answer: "y" })' }]), task, log: (e) => logged.push(e) });
  const calls: string[] = [];
  const off = rlm.on('model_call', (e) => { calls.push(e.role); });
  await rlm.run([text('t')]);
  off();
  await rlm.run([text('t')]);
  assert.deepEqual(calls, ['root']);
  assert.ok(logged.some((e) => e.kind === 'rlm_start') && logged.some((e) => e.kind === 'model_call'));
});

test('decision and prepare calls appear in the same stream as model_call events', async () => {
  const judge: Judge = {
    name: 'fake-judge',
    async decide(state: any, questions: Record<string, DecisionQuestion>) {
      const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n,
        q.type === 'choice' ? { type: 'choice', choice: 'rules_to_facts', confidence: 0.97 } :
        q.type === 'score' ? { type: 'score', score: 2 } :
        { type: 'noul', noul: state.chunk === undefined ? 0.95 : state.chunk.includes('RULE') ? 0.9 : 0.01 }]));
      return { answers, costUsd: 0.0001, requestId: 'dec-1', inputTokens: 50 };
    },
  };
  const sub = scripted([{ conditions: [{ name: 'r', question: 'a rule?' }, { name: 'a', question: 'a?' }, { name: 'b', question: 'b?' }] }]);
  const root = scripted([{ note: 'n', code: 'SUBMIT({ answer: String(survey.length) })' }]);
  const calls: any[] = [];
  const rlm = createRlm({ model: root, subModel: sub, task, advisor: decisionAdvisor(judge, { strategies: preparedStrategies(judge) }) });
  rlm.on('model_call', (e) => { calls.push(e); });
  const book = ['plain ' + 'x '.repeat(1800), 'RULE ' + 'y '.repeat(1800)].join('\n\n');
  await rlm.run([text(book), value('question', 'q')]);
  const roles = calls.map((c) => c.role);
  assert.ok(roles.filter((r) => r === 'decision').length >= 2, roles.join(','));
  assert.ok(roles.includes('prepare') && roles.includes('root'));
  const decision = calls.find((c) => c.role === 'decision');
  assert.equal(decision.model, 'fake-judge');
  assert.equal(decision.requestId, 'dec-1');
  assert.equal(decision.costIsNotional, false);
});
