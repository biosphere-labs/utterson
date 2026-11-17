// Provider lookup by prefix (FAC-164), written before the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_PROVIDERS, OPENAI_COMPATIBLE_PRESETS, modelFor, providerOf, resolveBaseUrl, scripted, utterson } from '../src/index.ts';

test('the bundled catalog has the OpenAI-compatible providers with base URLs', () => {
  assert.ok(Object.keys(CATALOG_PROVIDERS).length > 150, String(Object.keys(CATALOG_PROVIDERS).length));
  for (const [id, p] of Object.entries(CATALOG_PROVIDERS)) assert.match(p.baseUrl, /^https?:\/\//, id);
  assert.equal(resolveBaseUrl('deepseek'), CATALOG_PROVIDERS.deepseek!.baseUrl);
});

test('hand-added presets cover the big providers the catalog lists without a URL', () => {
  for (const id of ['deepinfra', 'openrouter', 'together', 'groq', 'fireworks', 'openai', 'mistral', 'xai', 'cerebras']) {
    assert.match(resolveBaseUrl(id) ?? '', /^https:\/\//, id);
  }
  assert.equal(resolveBaseUrl('deepinfra'), OPENAI_COMPATIBLE_PRESETS.deepinfra);
});

test('the providers option overrides a preset or adds a new provider; lookup order is option, preset, catalog', () => {
  assert.equal(resolveBaseUrl('deepinfra', { deepinfra: 'https://proxy.example/v1' }), 'https://proxy.example/v1');
  assert.equal(resolveBaseUrl('acme', { acme: 'https://api.acme.example/v1' }), 'https://api.acme.example/v1');
  assert.equal(resolveBaseUrl('nowhere'), undefined);
});

test('any catalogued provider works as a prefix, including ids with digits or dots', () => {
  assert.deepEqual(providerOf('deepseek:deepseek-chat'), { provider: 'deepseek', id: 'deepseek-chat' });
  assert.equal(providerOf('302ai:some-model').provider, '302ai');
  assert.match(modelFor('deepseek:deepseek-chat', 'k').name, /^deepseek:deepseek-chat$/);
  assert.match(modelFor('acme:m1', 'k', { providers: { acme: 'https://api.acme.example/v1' } }).name, /^acme:m1$/);
  assert.throws(() => modelFor('nowhere:m', 'k'), /unknown provider prefix "nowhere:"/);
});

test('utterson() passes the providers option through', () => {
  assert.ok(utterson({ model: 'acme:m1', task: { instructions: 'x', outputs: ['a'] }, keys: { model: 'k', decisions: 'd' },
    providers: { acme: 'https://api.acme.example/v1' } }).run);
  assert.ok(utterson({ model: scripted([]), task: { instructions: 'x', outputs: ['a'] }, keys: { decisions: 'd' } }).run);
});
