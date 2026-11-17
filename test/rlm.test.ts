import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger, Sandbox, SpendRefused, TURN_SCHEMA, claudeAgentSdk, createRlm, memoryLog, readTurn, scripted, text, value,
  type ModelRequest,
} from '../src/index.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const task = { instructions: 'Find the number.', outputs: ['answer'] };
const turn = (note: string, code: string) => ({ note, code });

// ---------- sandbox ----------

test('sandbox: variables, memory across steps, tools, SUBMIT', async () => {
  const sb = await Sandbox.start({ context: 'abc NEEDLE 42' }, { double: async ([n]) => (n as number) * 2 }, 1000);
  try {
    assert.equal((await sb.run('memory.i = context.indexOf("NEEDLE"); print(memory.i)', 5)).output, '4');
    assert.equal((await sb.run('print(memory.i, await double(21))', 5)).output, '4 42');
    assert.deepEqual((await sb.run('SUBMIT({ answer: "42" }); print("after")', 5)).submitted, { answer: '42' });
  } finally { sb.close(); }
});

test('sandbox: the vm escape, process, require and fetch are out of reach', async () => {
  const sb = await Sandbox.start({}, {}, 1000);
  try {
    const escape = await sb.run('try { print(print.constructor.constructor("return process")().pid) } catch (e) { print("blocked") }', 5);
    assert.equal(escape.output, 'blocked');
    assert.equal((await sb.run('print(typeof process, typeof require, typeof fetch)', 5)).output, 'undefined undefined undefined');
    assert.match(sb.walls().join(' '), process.platform === 'darwin' ? /network denied/ : /./);
  } finally { sb.close(); }
});

test('sandbox: output is cut with the cut stated; a hung async step restarts the child', async () => {
  const sb = await Sandbox.start({}, {}, 50);
  try {
    assert.match((await sb.run('print("x".repeat(500))', 5)).output, /\[output cut: 500 characters, 50 shown\]/);
    const hung = await sb.run('memory.keep = 1; await new Promise(() => {})', 1);
    assert.ok(hung.restarted && /memory was cleared/.test(hung.error ?? ''));
    assert.equal((await sb.run('print(JSON.stringify(memory))', 5)).output, '{}');
  } finally { sb.close(); }
});

test('sandbox: a thrown error is cut like printed output, with the cut stated', async () => {
  const sb = await Sandbox.start({ context: 'y'.repeat(5000) }, {}, 50);
  try {
    const big = await sb.run('throw new Error(context)', 5);
    assert.match(big.error ?? '', /^Error: y{43}\n\[error cut: 5,007 characters, 50 shown\]$/);
    assert.equal((await sb.run('throw new Error("short")', 5)).error, 'Error: short', 'an error within the limit is untouched');
    // an error raised by a host tool reaches the model the same way
    const tools = { fail: async () => { throw new Error('z'.repeat(5000)); } };
    const sb2 = await Sandbox.start({}, tools, 50);
    try { assert.match((await sb2.run('await fail()', 5)).error ?? '', /\[error cut: 5,007 characters, 50 shown\]$/); } finally { sb2.close(); }
  } finally { sb.close(); }
});

// ---------- turns ----------

test('turns: exactly { note, code }, nothing else', () => {
  assert.deepEqual(readTurn({ note: 'n', code: 'c' }), { note: 'n', code: 'c' });
  for (const bad of [null, '{0,80}', ['x'], { note: 'n' }, { note: 'n', code: 'c', extra: 1 }, { note: 'n', code: 5 }]) {
    assert.ok('problem' in readTurn(bad), JSON.stringify(bad));
  }
  assert.deepEqual((TURN_SCHEMA as any).required, ['note', 'code']);
});

// ---------- the loop ----------

test('loop: searches the substrate with code and submits; the model never sees the text itself', async () => {
  const book = 'filler '.repeat(400_000) + 'The Kestrel timeout is 47 seconds. ' + 'filler '.repeat(1000);
  const model = scripted([
    turn('find it', 'memory.m = context.match(/Kestrel timeout is (\\d+)/); print(memory.m[1])'),
    turn('submit', 'SUBMIT({ answer: memory.m[1] })'),
  ]);
  const log = memoryLog();
  const result = await createRlm({ model, task, log }).run([text(book), value('question', 'What is the timeout?')]);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.outputs, { answer: '47' });
  assert.equal(result.trajectory[0]!.output, '47');
  assert.ok(model.requests.every((r) => r.prompt.length < 20_000), 'the book never enters a prompt');
  assert.ok(model.requests.every((r) => r.schema === TURN_SCHEMA), 'every root call asks for a structured turn');
  assert.deepEqual(log.events.map((e) => e.kind), ['rlm_start', 'root_request', 'model_call', 'root_reply', 'step_output', 'root_request', 'model_call', 'root_reply', 'step_output', 'submit', 'rlm_end']);
});

test('loop: code that throws the text does not put the text in the next prompt', async () => {
  const mark = 'ZEBRA-SECRET-91375';
  const book = 'filler '.repeat(200_000) + mark + ' ' + 'filler '.repeat(200_000);
  const model = scripted([turn('throws', 'throw new Error(context)'), turn('submit', 'SUBMIT({ answer: "x" })')]);
  const result = await createRlm({ model, task, limits: { outputChars: 12_000 } }).run([text(book)]);
  assert.equal(result.status, 'submitted');
  assert.match(result.trajectory[0]!.error ?? '', /\[error cut: /);
  assert.ok(model.requests.every((r) => r.prompt.length < 20_000), 'the book never enters a prompt');
  assert.ok(model.requests.every((r) => !r.prompt.includes(mark)));
});

test('loop: an invalid turn stops loudly (no repair); out of turns stops (no salvage)', async () => {
  const invalid = await createRlm({ model: scripted(['{0,80}']), task }).run([text('x')]);
  assert.equal(invalid.stop?.code, 'root_turn_invalid');
  const exhausted = await createRlm({ model: scripted([turn('a', 'print(1)'), turn('b', 'print(2)')]), task, limits: { rootTurns: 2 } }).run([text('x')]);
  assert.equal(exhausted.stop?.code, 'root_turns_exhausted');
});

test('loop: a SUBMIT with the wrong outputs is shown as an error and can be corrected', async () => {
  const model = scripted([turn('a', 'SUBMIT({ answer: 47 })'), turn('b', 'SUBMIT({ answer: "47" })')]);
  const result = await createRlm({ model, task }).run([text('x')]);
  assert.deepEqual(result.outputs, { answer: '47' });
  assert.match(result.trajectory[0]!.error ?? '', /exactly \{ answer \} as strings/);
  assert.match(model.requests[1]!.prompt, /exactly \{ answer \} as strings/);
});

test('loop: tools are plain functions passed in; their calls are logged', async () => {
  const log = memoryLog();
  const model = scripted([turn('use it', 'SUBMIT({ answer: String(await add(40, 2)) })')]);
  const tools = { add: { signature: 'await add(a, b)', description: 'adds two numbers', fn: (a: number, b: number) => a + b } };
  const result = await createRlm({ model, task, tools, log }).run([text('x')]);
  assert.deepEqual(result.outputs, { answer: '42' });
  assert.match(model.requests[0]!.prompt, /await add\(a, b\)` - adds two numbers/);
  assert.ok(log.events.some((e) => e.kind === 'tool_call' && e.tool === 'add'));
});

// ---------- sub-calls, budget, recursion ----------

test('sub-calls: llm_query_batched goes through the sub-model, counted against one tree budget', async () => {
  const sub = scripted(Array.from({ length: 10 }, (_, i) => (r: ModelRequest) => `chunk says ${r.prompt.length}`));
  const model = scripted([turn('map', 'memory.a = await llm_query_batched(["aa", "bbb", "c"]); print(memory.a.join("|"))'),
                          turn('done', 'SUBMIT({ answer: memory.a[1] })')]);
  const log = memoryLog();
  const result = await createRlm({ model, subModel: sub, task, log }).run([text('x')]);
  assert.deepEqual(result.outputs, { answer: 'chunk says 3' });
  assert.equal(result.spend.subCalls, 3);
  assert.equal(log.events.filter((e) => e.kind === 'sub_call').length, 3);
});

test('budget: past the sub-call limit the tool errors, and the model sees why', async () => {
  const sub = scripted(['a', 'b', 'c']);
  const model = scripted([turn('too many', 'await llm_query("1"); await llm_query("2"); await llm_query("3")'), turn('give up', 'SUBMIT({ answer: "NOT_FOUND" })')]);
  const result = await createRlm({ model, subModel: sub, task, limits: { subCalls: 2 } }).run([text('x')]);
  assert.match(result.trajectory[0]!.error ?? '', /all 2 sub-calls are used/);
  assert.equal(result.spend.subCalls, 2);
});

test('budget: dollars are shared by the tree and stop the root when spent', async () => {
  const pricey = scripted([{ ...turn('a', 'print(1)') }, turn('b', 'print(2)')].map((t) => () => t));
  const model = { name: 'pricey', complete: async (r: ModelRequest) => ({ ...(await pricey.complete(r)), costUsd: 0.6, costIsNotional: true }) };
  const result = await createRlm({ model, task, limits: { budgetUsd: 1 } }).run([text('x')]);
  assert.equal(result.stop?.code, 'budget_exhausted');
  assert.equal(result.spend.rootCalls, 2);
});

test('recursion: rlm_query runs a nested RLM with its own REPL; the log forms a tree', async () => {
  const model = scripted([
    turn('delegate', 'memory.r = await rlm_query("what number?", "inner text with 7"); print(memory.r)'),
    turn('inner: read', 'SUBMIT({ answer: context.match(/\\d+/)[0] })'),
    turn('outer: done', 'SUBMIT({ answer: JSON.parse(memory.r).answer })'),
  ]);
  const log = memoryLog();
  const result = await createRlm({ model, task, log, limits: { depth: 1 } }).run([text('outer')]);
  assert.deepEqual(result.outputs, { answer: '7' });
  const inner = log.events.filter((e) => e.depth === 1);
  assert.ok(inner.length > 0 && inner.every((e) => e.parent === result.id));
  assert.ok(log.events.some((e) => e.kind === 'nested_rlm' && e.rlm === result.id));
  // at the depth limit the nested RLM has no rlm_query of its own
  assert.doesNotMatch(model.requests[1]!.prompt, /rlm_query/);
});

// ---------- adapters ----------

test('claude-agent-sdk: refuses to start on any metered route; sends the schema and takes structured_output', async () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) {
    assert.throws(() => claudeAgentSdk({ model: 'm', env: { [name]: 'x' } }), new RegExp(name));
  }
  const seen: any[] = [];
  const model = claudeAgentSdk({
    model: 'claude-sonnet-5-5', env: { PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'keep' },
    query: async function* ({ options }) {
      seen.push(options);
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'prose to ignore' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: { note: 'n', code: 'c' }, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 6 }, session_id: 's' };
    },
  });
  const reply = await model.complete({ system: 'S', prompt: 'P', schema: TURN_SCHEMA });
  assert.deepEqual(reply.json, { note: 'n', code: 'c' });
  assert.equal(reply.costIsNotional, true);
  const o = seen[0];
  assert.deepEqual([o.tools, o.mcpServers, o.settingSources, o.maxTurns, o.outputFormat.type], [[], {}, [], 3, 'json_schema']);
  assert.equal(o.env.CLAUDE_CODE_ENTRYPOINT, '');
  assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN, 'keep');
});

test('ledger: a booking past the cap is refused before any call', () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'spend.jsonl'), 0.05);
  assert.throws(() => ledger.reserve('claude-sonnet-5-5', 10_000, 16_000), SpendRefused);
  const id = ledger.reserve('claude-sonnet-5-5', 1000, 1000);
  ledger.settle(id, 0.001);
  assert.equal(ledger.spent(), 0.001);
});
