// claudeWorker: a tool that starts an agent which can act. No test here starts one: the SDK's query() is replaced by a
// fake that replies from a script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, WORKER_DEFAULT_ALLOW, claudeWorker, createRlm, memoryLog, scripted, text, withRecorder, type Tools, type WorkerReport } from '../src/index.ts';

const task = { instructions: 'Get the work done.', outputs: ['answer'] };
const turn = (note: string, code: string) => ({ note, code });
const folder = () => mkdtempSync(join(tmpdir(), 'worker-test-'));
/** Calls the tool as the sandbox host would, outside a run. */
const call = (tools: Tools, brief: string, name = 'worker') => tools[name]!.fn(brief) as Promise<WorkerReport>;
const said = (words: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: words }] } });
const done = (report: string, usd = 0.25) => ({ type: 'result', subtype: 'success', is_error: false, result: report, num_turns: 3, total_cost_usd: usd });

/** A fake query(): records each call and replies with what `reply` gives for it. */
function fakeQuery(reply: (call: { prompt: string; options: any }, n: number) => any[] | Promise<any[]>) {
  const calls: Array<{ prompt: string; options: any }> = [];
  const query = async function* (call: { prompt: string; options: any }) {
    calls.push(call);
    for (const message of await reply(call, calls.length)) yield message;
  };
  return { calls, query };
}

test('worker: the root\'s code starts it with a brief and gets its report; its cost is the run\'s cost', async () => {
  const cwd = folder();
  const sdk = fakeQuery(() => [said('working'), done('Fixed the typo in README.md.')]);
  const model = scripted([turn('delegate', 'const r = await worker("Fix the typo in README.md"); SUBMIT({ answer: `${r.ok} ${r.turns} ${r.report}` })')]);
  const log = memoryLog();
  const rlm = createRlm({ model, task, log, limits: { stepSeconds: 900 }, tools: claudeWorker({ cwd, model: 'claude-sonnet-5-5', env: {}, query: sdk.query }) });
  const result = await rlm.run([text('x')]);
  assert.deepEqual(result.outputs, { answer: 'true 3 Fixed the typo in README.md.' });
  assert.equal(result.spend.notionalUsd, 0.25);
  assert.match(model.requests[0]!.prompt, /await worker\(brief\)/);

  const { prompt, options } = sdk.calls[0]!;
  assert.equal(prompt, 'Fix the typo in README.md');
  assert.equal(options.cwd, cwd);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.deepEqual(options.tools, WORKER_DEFAULT_ALLOW);
  assert.deepEqual(options.allowedTools, WORKER_DEFAULT_ALLOW);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual([options.maxTurns, options.maxBudgetUsd, options.persistSession], [40, 2, false]);
  assert.deepEqual([options.settingSources, options.mcpServers], [[], {}]);
  const logged = log.events.find((e) => e.kind === 'tool_call' && e.tool === 'worker') as any;
  assert.equal(logged.result.usd, 0.25);
});

test('worker: one that is stopped says so and reports as far as it got; a rule in allow switches its tool on', async () => {
  const sdk = fakeQuery(() => [said('Half done: two of five files.'), { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 5, total_cost_usd: 0.4 }]);
  const tools = claudeWorker({ cwd: folder(), model: 'm', name: 'builder', allow: ['Read', 'Bash(npm test:*)'], instructions: 'Never push.', maxTurns: 5, env: {}, query: sdk.query });
  const report = await call(tools, 'Do the five files', 'builder');
  assert.deepEqual({ ...report, seconds: 0 }, { ok: false, report: 'Half done: two of five files.', stop: 'error_max_turns', turns: 5, usd: 0.4, seconds: 0 });
  assert.deepEqual(sdk.calls[0]!.options.tools, ['Read', 'Bash']);
  assert.deepEqual(sdk.calls[0]!.options.allowedTools, ['Read', 'Bash(npm test:*)']);
  assert.equal(sdk.calls[0]!.options.systemPrompt.append, 'Never push.');
  await assert.rejects(() => call(tools, '', 'builder'), /takes one string: the brief/);
});

test('worker: one at a time unless told otherwise', async () => {
  for (const parallel of [1, 2]) {
    let now = 0, most = 0;
    const sdk = fakeQuery(async () => {
      most = Math.max(most, ++now);
      await new Promise((resolve) => setTimeout(resolve, 20));
      now -= 1;
      return [done('ok', 0)];
    });
    const tools = claudeWorker({ cwd: folder(), model: 'm', parallel, env: {}, query: sdk.query });
    await Promise.all(['a', 'b', 'c', 'd'].map((brief) => call(tools, brief)));
    assert.equal(most, parallel);
    assert.equal(sdk.calls.length, 4);
  }
});

test('worker: once the run\'s dollars are spent no worker starts, and the model sees why', async () => {
  const sdk = fakeQuery(() => [done('ok', 0.25)]);
  const model = scripted([
    turn('three', 'for (const b of ["one", "two", "three"]) { try { print((await worker(b)).report) } catch (e) { print("refused: " + e.message) } }'),
    turn('give up', 'SUBMIT({ answer: "x" })'),
  ]);
  const rlm = createRlm({ model, task, limits: { stepSeconds: 900, budgetUsd: 0.4 }, tools: claudeWorker({ cwd: folder(), model: 'm', env: {}, query: sdk.query }) });
  const result = await rlm.run([text('x')]);
  assert.equal(sdk.calls.length, 2);
  assert.match(result.trajectory[0]!.output, /^ok\nok\nrefused: \$0\.5000 spent of \$0\.4$/);
  assert.equal(result.stop?.code, 'budget_exhausted');
  assert.equal(result.spend.notionalUsd, 0.5);
});

test('worker: past its time limit it is stopped and says so; a cancelled run stops it too', async () => {
  // A worker that only ends when it is aborted, as the SDK's subprocess does.
  const untilAborted = (call: { options: any }) => new Promise<any[]>((_, reject) => {
    call.options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const slow = claudeWorker({ cwd: folder(), model: 'm', timeoutSeconds: 0.05, env: {}, query: fakeQuery(untilAborted).query });
  const late = await call(slow, 'take too long');
  assert.deepEqual([late.ok, late.stop, late.usd, late.usdIsLimit], [false, 'timeout', 2, true]);

  const run = new AbortController();
  const tools = claudeWorker({ cwd: folder(), model: 'm', env: {}, query: fakeQuery(untilAborted).query });
  const pending = withRecorder({ includePayloads: false, record: () => {}, signal: run.signal }, () => call(tools, 'never ends'));
  setTimeout(() => run.abort(), 20);
  await assert.rejects(pending, /cancelled/);
});

test('worker: a failed API call says so, with the message, not "success"', async () => {
  const sdk = fakeQuery(() => [{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 rate limited', num_turns: 1, total_cost_usd: 0 }]);
  const report = await call(claudeWorker({ cwd: folder(), model: 'm', env: {}, query: sdk.query }), 'do it');
  assert.deepEqual([report.ok, report.stop, report.report], [false, 'api_error', 'API Error: 429 rate limited']);
});

test('worker: it ends before the step that called it, and starts none when too little of the step is left', async () => {
  const untilAborted = (call: { options: any }) => new Promise<any[]>((_, reject) => {
    call.options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const sdk = fakeQuery(untilAborted);
  const tools = claudeWorker({ cwd: folder(), model: 'm', env: {}, query: sdk.query });
  const inStep = (deadline: number) => withRecorder({ includePayloads: false, record: () => {}, deadline }, () => call(tools, 'long job'));
  // 10.1 s left in the step, less the 10 s margin: the worker gets about 0.1 s of its 900.
  const started = Date.now();
  const cut = await inStep(Date.now() + 10_100);
  assert.equal(cut.stop, 'timeout');
  assert.ok(Date.now() - started < 2000, 'stopped by the step, not by its own 900 s');
  const none = await inStep(Date.now() + 5_000);
  assert.deepEqual([none.ok, none.stop], [false, 'no_time_left']);
  assert.equal(sdk.calls.length, 1, 'no worker was started for the second call');
});

test('worker: its dollar limit is cut to what is left of the budget; one stopped early is charged at that limit', async () => {
  const charged: number[] = [];
  const untilAborted = (call: { options: any }) => new Promise<any[]>((_, reject) => {
    call.options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const sdk = fakeQuery(untilAborted);
  const tools = claudeWorker({ cwd: folder(), model: 'm', timeoutSeconds: 0.05, env: {}, query: sdk.query });
  const recorder = { includePayloads: false, record: () => {}, budgetLeft: () => 0.3, admitSpend: () => {}, charge: (c: { costUsd?: number }) => { charged.push(c.costUsd ?? 0); } };
  const report = await withRecorder(recorder, () => call(tools, 'stopped early'));
  assert.equal(sdk.calls[0]!.options.maxBudgetUsd, 0.3);
  assert.deepEqual(charged, [0.3]);
  assert.deepEqual([report.usd, report.usdIsLimit], [0.3, true]);
});

test('worker: a step limit shorter than the worker\'s is refused; so are a metered route and a folder that is not there', () => {
  const tools = claudeWorker({ cwd: folder(), model: 'm', env: {} });
  assert.throws(() => createRlm({ model: scripted([]), task, tools }), /worker may run 900 s but limits\.stepSeconds is 60/);
  assert.throws(() => claudeWorker({ cwd: folder(), model: 'm', env: { ANTHROPIC_API_KEY: 'x' } }), /unset these before a subscription run: ANTHROPIC_API_KEY/);
  assert.throws(() => claudeWorker({ cwd: 'relative/path', model: 'm', env: {} }), /cwd must be an existing folder/);
  assert.throws(() => claudeWorker({ cwd: join(folder(), 'missing'), model: 'm', env: {} }), /cwd must be an existing folder/);
});

test('sandbox: a tool call still running when its step is stopped is told to stop', async () => {
  let stopped = false;
  const hang = (_: unknown[], signal?: AbortSignal) => new Promise<unknown>(() => { signal?.addEventListener('abort', () => { stopped = true; }); });
  const sb = await Sandbox.start({}, { hang }, 1000);
  try {
    const step = await sb.run('await hang()', 1);
    assert.ok(step.restarted);
    assert.equal(stopped, true);
  } finally { sb.close(); }
});
