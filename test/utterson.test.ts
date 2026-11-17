import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UttersonConfigError, modelFor, providerOf, scripted, utterson } from '../src/index.ts';

const task = { instructions: 'x', outputs: ['answer'] };

test('both keys are required for named models, separately, and missing either fails at construction', () => {
  const model = scripted([]);
  assert.throws(() => utterson({ model, task, keys: { model: 'k' } as any }), (e: Error) => e instanceof UttersonConfigError && /keys\.decisions/.test(e.message));
  // keys.model is needed for a model name; a Model object needs no key (see iris-requests.test.ts).
  assert.throws(() => utterson({ model: 'deepinfra:Qwen/Qwen3-235B-A22B', task, keys: { decisions: 'd' } as any }), /keys\.model/);
  assert.throws(() => utterson({ model, task } as any), /keys\.decisions/);
  assert.ok(utterson({ model, task, keys: { model: 'k', decisions: 'd' } }).run);
});

test('the adapter is guessed from the name; a prefix overrides; an unrecognised name throws', () => {
  assert.deepEqual(providerOf('claude-sonnet-5-5'), { provider: 'claude', id: 'claude-sonnet-5-5' });
  assert.equal(providerOf('gpt-5.5').provider, 'codex');
  assert.equal(providerOf('o4-mini').provider, 'codex');
  assert.equal(providerOf('gemini-4-argon').provider, 'antigravity');
  assert.equal(providerOf('grok-5').provider, 'grok');
  assert.equal(providerOf('deepinfra:Qwen/Qwen3-235B-A22B').provider, 'deepinfra');
  // No silent fallback: an unrecognised, unprefixed name is a configuration error, never a metered call somewhere.
  assert.throws(() => providerOf('Qwen/Qwen3-235B-A22B'), (e: Error) => e instanceof UttersonConfigError && /deepinfra:/.test(e.message));
  assert.throws(() => providerOf('claud-sonnet-5-5'), /unrecognised model name/);
  assert.deepEqual(providerOf('openrouter:meta-llama/llama-4-maverick'), { provider: 'openrouter', id: 'meta-llama/llama-4-maverick' });
  assert.throws(() => providerOf('codex-mini'), /unrecognised model name/);
});

test('keys must suit the adapter', () => {
  // The subscription adapter refuses to start while ANTHROPIC_* variables are set (as inside Claude Code): either outcome is right.
  try { assert.match(modelFor('claude-sonnet-5-5', 'subscription').name, /claude-agent-sdk/); }
  catch (e) { assert.match(String(e), /unset these before a subscription run/); }
  assert.match(modelFor('deepinfra:Qwen/Qwen3-235B-A22B', 'key').name, /^deepinfra:Qwen/);
  assert.match(modelFor('together:x/y', 'key').name, /^together:x\/y/);
  assert.throws(() => modelFor('deepinfra:Qwen/Qwen3-235B-A22B', 'subscription'), /needs an API key/);
  assert.throws(() => modelFor('gpt-5.5', 'sk-123'), /subscription/);
  assert.throws(() => modelFor('nowhere:model', 'k'), /unknown provider prefix/);
  assert.match(modelFor('my-model', 'k', { baseUrl: 'https://api.example.com/v1' }).name, /^custom:my-model/);
});
