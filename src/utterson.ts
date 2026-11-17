// The front door: one call with a model name, a task and two keys. It builds the same parts createRlm takes (model
// adapters, a decision-model judge, the advisor with the prepared strategies) and runs them. Every part can still be
// passed in instead; nothing here is needed to use createRlm directly.
//
//   const agent = utterson({
//     model: 'deepinfra:Qwen/Qwen3-235B-A22B',     // claude-*, gpt-*, gemini-*, grok-* are recognised; others need provider:
//     task: { instructions: '...', outputs: ['answer'] },
//     keys: { model: process.env.DEEPINFRA_API_KEY!, decisions: process.env.OPENROUTER_API_KEY! },
//   });
//   const result = await agent.run([text(book), value('question', q)]);
import { decisionAdvisor, preparedStrategies, type Advisor } from './advisor.ts';
import { OPENROUTER_DECISIONS_ENDPOINT, openRouterDecisions, type Judge } from './decisions.ts';
import type { EventHandler, Logger } from './log.ts';
import { anthropicApi } from './models/anthropicApi.ts';
import { antigravityAcp } from './models/antigravityAcp.ts';
import { claudeAgentSdk } from './models/claudeAgentSdk.ts';
import { codexSdk } from './models/codexSdk.ts';
import { grokCli } from './models/grokCli.ts';
import { Ledger } from './models/ledger.ts';
import { openAiCompatible, resolveBaseUrl } from './models/openAiCompatible.ts';
import { createRlm } from './rlm.ts';
import type { Limits, Model, PromptParts, Task, Tools } from './types.ts';

/** Thrown at construction when something the run needs is missing. The run never starts half-configured. */
export class UttersonConfigError extends Error {
  override name = 'UttersonConfigError';
}

/** The model key value meaning "use the logged-in subscription" (Claude Agent SDK, Codex). */
export const SUBSCRIPTION = 'subscription';

export interface UttersonOptions {
  /** A model name ('claude-sonnet-5-5', 'Qwen/Qwen3-235B-A22B', 'openrouter:...') or a Model object. */
  model: string | Model;
  task: Task;
  keys?: {
    /** The model's API key, or 'subscription' for Claude or Codex on a logged-in subscription. Required whenever
     *  `model` or `subModel` is a name; not needed when both are Model objects. */
    model?: string;
    /** The decision model's API key. Required unless `decisions.judge` is given. Never assumed to be `model`'s. */
    decisions?: string;
  };
  decisions?: {
    /** Default: OpenRouter's Decisions endpoint. */
    endpoint?: string;
    /** Default: perplexity/pplx-decider-v1.2 (best of three tried for filtering and routing). */
    model?: string;
    /** Hard cap for all decision calls through this ledger file. Default $3. */
    capUsd?: number;
    /** Default ./utterson-decision-spend.jsonl (ignored when `ledger` is given). */
    ledgerPath?: string;
    /** A ledger to book decision spend in, shared however you like; null for none. Default: a file at ledgerPath. */
    ledger?: Ledger | null;
    /** Your own decisions client. When given, endpoint, model, key and ledger options are not used. */
    judge?: Judge;
  };
  /** The model llm_query uses: a name (same key as `model`) or a Model. Default: the same model. */
  subModel?: string | Model;
  /** For an OpenAI-compatible provider with no preset: its base URL (the name is then used as the model id). */
  modelBaseUrl?: string;
  /** Base URLs by provider prefix: overrides a preset or the catalog, or adds a provider. { acme: 'https://…/v1' } */
  providers?: Record<string, string>;
  /** Hard cap for Anthropic API calls (only that adapter keeps a ledger). Default $20. */
  modelCapUsd?: number;
  advisor?: Advisor;
  tools?: Tools;
  limits?: Partial<Limits>;
  log?: Logger;
  /** Subscribers to the event stream (see EVENTS.md). */
  events?: EventHandler[];
  /** Full request and reply in each model_call event. Off by default. */
  includePayloads?: boolean;
  strictEvents?: boolean;
  prompt?: Partial<PromptParts>;
}

export function utterson(o: UttersonOptions) {
  if (!o || !o.task) throw new UttersonConfigError('task is required: { instructions, outputs }');
  const judgeGiven = o.decisions?.judge;
  if (!judgeGiven && !o.keys?.decisions) {
    throw new UttersonConfigError('keys.decisions is required (or decisions.judge): the strategy advisor and filter need a ' +
      'decision model (OpenRouter by default). Without them the results are poor, so utterson refuses to run.');
  }
  const named = typeof o.model === 'string' || typeof o.subModel === 'string';
  if (named && !o.keys?.model) {
    throw new UttersonConfigError(`keys.model is required when model or subModel is a name: the model's API key, or '${SUBSCRIPTION}' ` +
      'for Claude or Codex on a logged-in subscription. (Pass Model objects to need no key.)');
  }
  const resolve = (m: string | Model) => (typeof m === 'string' ? modelFor(m, o.keys!.model!, { baseUrl: o.modelBaseUrl, capUsd: o.modelCapUsd, providers: o.providers }) : m);
  const model = resolve(o.model);
  const subModel = o.subModel === undefined ? model : resolve(o.subModel);
  const ledger = o.decisions?.ledger === null ? undefined
    : o.decisions?.ledger ?? new Ledger(o.decisions?.ledgerPath ?? './utterson-decision-spend.jsonl', o.decisions?.capUsd ?? 3);
  const judge = judgeGiven ?? openRouterDecisions({
    model: o.decisions?.model ?? 'perplexity/pplx-decider-v1.2',
    endpoint: o.decisions?.endpoint ?? OPENROUTER_DECISIONS_ENDPOINT,
    apiKey: o.keys!.decisions!,
    ledger,
  });
  return createRlm({
    model, subModel, task: o.task, tools: o.tools, limits: o.limits, log: o.log, prompt: o.prompt,
    events: o.events, includePayloads: o.includePayloads, strictEvents: o.strictEvents,
    advisor: o.advisor ?? decisionAdvisor(judge, { strategies: preparedStrategies(judge) }),
  });
}

/**
 * Which adapter a model name means. A `provider:` prefix decides; otherwise the name's shape. An unrecognised name
 * throws: a typo must fail loudly, never run (and bill) on some default provider.
 */
export function providerOf(name: string): { provider: string; id: string } {
  const m = name.match(/^([a-z0-9][a-z0-9.-]*):(.+)$/s);
  if (m) return { provider: m[1]!, id: m[2]! };
  if (/^claude-/.test(name)) return { provider: 'claude', id: name };
  if (/^(gpt-|o\d)/.test(name)) return { provider: 'codex', id: name };
  if (/^gemini-/.test(name)) return { provider: 'antigravity', id: name };
  if (/^grok-/.test(name)) return { provider: 'grok', id: name };
  throw new UttersonConfigError(`unrecognised model name "${name}": prefix it with its provider, e.g. ` +
    `"deepinfra:${name}" (any of about 200 providers: see CATALOG_PROVIDERS and OPENAI_COMPATIBLE_PRESETS), or pass a Model object`);
}

/** Builds the adapter for a model name and its key. */
export function modelFor(name: string, key: string, extra: { baseUrl?: string; capUsd?: number; providers?: Record<string, string> } = {}): Model {
  const apiKey = (who: string) => {
    if (!key || key === SUBSCRIPTION) throw new UttersonConfigError(`${who} needs an API key in keys.model, not '${SUBSCRIPTION}'`);
    return key;
  };
  const subscription = (who: string) => {
    if (key !== SUBSCRIPTION) throw new UttersonConfigError(`${who} runs on the logged-in subscription: set keys.model to '${SUBSCRIPTION}'`);
  };
  if (extra.baseUrl) return openAiCompatible({ model: name, apiKey: apiKey(extra.baseUrl), baseUrl: extra.baseUrl, provider: 'custom' });
  const { provider, id } = providerOf(name);
  switch (provider) {
    case 'claude':
      return key === SUBSCRIPTION
        ? claudeAgentSdk({ model: id })
        : anthropicApi({ model: id, apiKey: apiKey('the Anthropic API'), ledger: new Ledger('./utterson-model-spend.jsonl', extra.capUsd ?? 20) });
    case 'anthropic-api':
      return anthropicApi({ model: id, apiKey: apiKey('the Anthropic API'), ledger: new Ledger('./utterson-model-spend.jsonl', extra.capUsd ?? 20) });
    case 'codex': subscription('Codex'); return codexSdk({ model: id });
    case 'antigravity': subscription('Antigravity'); return antigravityAcp({ model: id });
    case 'grok': subscription('Grok'); return grokCli({ model: id });
    default: {
      const baseUrl = resolveBaseUrl(provider, extra.providers);
      if (!baseUrl) {
        throw new UttersonConfigError(`unknown provider prefix "${provider}:"; it isn't a built-in adapter (claude, anthropic-api, codex, ` +
          'antigravity, grok), a preset, or in the bundled catalog. Pass providers: { name: baseUrl } or modelBaseUrl');
      }
      return openAiCompatible({ model: id, apiKey: apiKey(provider), baseUrl, provider });
    }
  }
}
