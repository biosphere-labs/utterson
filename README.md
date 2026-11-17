# @biosphere-labs/utterson-agent

A TypeScript library for answering questions about long inputs (books, contracts, document sets, logs).

- The input is never pasted into the prompt. It sits in a sandbox as a variable, and the model writes JavaScript, one step
  at a time, to search and slice it.
- The model can hand passages to cheaper sub-models.
- A decision model (typed yes/no answers, cents per book) profiles each problem, picks a strategy and filters the text
  before the model starts.

Agents: read [AGENTS.md](AGENTS.md); [llms.txt](llms.txt) is the index.

## Install

Install from GitHub with Node 24 or later. npm builds the ESM package on install.

```bash
npm install github:biosphere-labs/utterson#main
```

## Quick start: `utterson()`

```ts
import { utterson, text, value } from '@biosphere-labs/utterson-agent';

const agent = utterson({
  model: 'deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507',  // the adapter is chosen from the name (see below)
  task: { instructions: 'Answer from the document alone, or NOT_FOUND.', outputs: ['answer'] },
  keys: {
    model: process.env.DEEPINFRA_API_KEY!,           // required: the model's key, or 'subscription'
    decisions: process.env.OPENROUTER_API_KEY!,      // required: the decision model's key
  },
});

const result = await agent.run([
  text(documentText, { label: 'the contract' }),     // the big input becomes the variable `context`
  value('question', 'Can either party assign the agreement?'),
]);

if (result.status === 'submitted') console.log(result.outputs.answer);
else console.error(result.stop?.code, result.stop?.detail);
```

**Both keys are required, and they are kept separate.** The exceptions: `keys.model` isn't needed when `model` and
`subModel` are `Model` objects, and `keys.decisions` isn't needed when you pass `decisions.judge`. A missing key throws `UttersonConfigError` before anything
runs. Without the decision model the strategy step is skipped and the results are poor, so the library refuses to run
without it.

### Model names

| Name | Adapter | `keys.model` |
| --- | --- | --- |
| `claude-*` | Claude Agent SDK on the logged-in subscription, or the Anthropic API with a key | `'subscription'` or an API key |
| `gpt-*`, `o<digit>*` | Codex SDK | `'subscription'` |
| `gemini-*` | Antigravity (ACP) | `'subscription'` |
| `grok-*` | Grok CLI | `'subscription'` |
| any other name | **an error**: prefix it with its provider. A typo never runs on a default provider | |
| `<provider>:<model>`, e.g. `deepinfra:…`, `openrouter:…`, `groq:…`, `deepseek:…`, `cerebras:…` | that provider (OpenAI-compatible): about 200 known, see below | that provider's key |
| `anthropic-api:claude-…` | the Anthropic API | an API key |

**Base URLs are looked up for you.** The order is: your `providers` option, then hand-added presets for the big providers
(DeepInfra, OpenRouter, Together, Groq, Fireworks, OpenAI, Mistral, xAI, Cerebras), then a bundled snapshot of the
[models.dev](https://models.dev) catalog with about 200 OpenAI-compatible providers (MIT; `CATALOG_PROVIDERS`). Override
any of them, or add your own, with `providers: { deepinfra: 'https://my-proxy/v1', acme: 'https://api.acme.ai/v1' }`.
`modelBaseUrl` covers a one-off. For anything else, pass a `Model` object
instead of a name.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `subModel` | same as `model` | the model `llm_query` uses: a name (same key) or a `Model` |
| `decisions.endpoint` | OpenRouter Decisions API | where decision questions go |
| `decisions.model` | `perplexity/pplx-decider-v1.2` | the decision model |
| `decisions.capUsd`, `decisions.ledgerPath` | `3`, `./utterson-decision-spend.jsonl` | a hard spending cap kept in a file |
| `decisions.ledger` | a file at `ledgerPath` | your own `Ledger`, or `null` for none |
| `decisions.judge` | OpenRouter | your own decisions client (`Judge`); then `keys.decisions` isn't needed |
| `limits` | 20 turns, 400 sub-calls, depth 1, $5 | see `DEFAULT_LIMITS` |
| `tools` | none | your functions, callable from the model's code |
| `events` | none | subscribers to the event stream (see Events); `log` is the older single-subscriber form |
| `includePayloads` | `false` | full request and reply in each `model_call` event |
| `advisor`, `prompt` | the decision advisor with prepared strategies | override the strategy logic or any prompt part |

## The result

```ts
{
  status: 'submitted' | 'stopped',
  outputs?: Record<string, string>,            // when submitted: every name in task.outputs, as strings
  stop?: { code, detail },                     // root_turns_exhausted, root_turn_invalid, budget_exhausted, model_error, host_error, cancelled
  trajectory: Array<{ turn, note, code, output, error?, seconds }>,
  spend: { usd, notionalUsd, rootCalls, subCalls },
  advice?: { strategy, reason, profile, prepared?, costUsd },
}
```

## Events

A run publishes a typed, versioned stream of events. There's one `model_call` per model call (root, sub, prepare and
decision), with the model name, usage, cost, whether the cost is notional, the request id and a prompt hash. There are
also narrative events (turns, steps, advice, submit, stop).

```ts
const agent = utterson({ ..., events: [jsonlLog('run.jsonl'), (e) => myBus.publish(e)] });
const off = agent.on('model_call', (e) => records.push(e));
```

Handlers run in order and can't break a run: an error in one becomes a `handler_error` event for the others. Full
request and reply payloads come only with `includePayloads: true`. The contract is in [EVENTS.md](EVENTS.md).

## Cancelling

```ts
const controller = new AbortController();
const result = await agent.run([text(doc), value('question', q)], { signal: controller.signal });
// controller.abort() → model and decision calls get the signal, a running sandbox step stops,
// and the result is { status: 'stopped', stop: { code: 'cancelled' } }
```

## Composing it yourself: `createRlm()`

`utterson()` builds these parts. Use them directly for full control.

```ts
import { createRlm, claudeAgentSdk, decisionAdvisor, preparedStrategies, openRouterDecisions, Ledger,
         text, value, consoleLog } from '@biosphere-labs/utterson-agent';

const judge = openRouterDecisions({ model: 'perplexity/pplx-decider-v1.2', apiKey, ledger: new Ledger('./spend.jsonl', 3) });
const rlm = createRlm({
  model: claudeAgentSdk({ model: 'claude-sonnet-5-5' }),
  subModel: claudeAgentSdk({ model: 'claude-haiku-5-5' }),
  task: { instructions: '…', outputs: ['answer'] },
  tools: { wordCount: { signature: 'await wordCount(text)', description: 'words in a text', fn: (t: string) => t.split(/\s+/).length } },
  advisor: decisionAdvisor(judge, { strategies: preparedStrategies(judge) }),
  limits: { rootTurns: 20, subCalls: 400, budgetUsd: 2 },
  log: consoleLog(),
});
const result = await rlm.run([text(book), value('question', '…')]);
```

| Part | What it is | Built-ins |
| --- | --- | --- |
| Model | anything with `complete({ system, prompt, schema })` | `claudeAgentSdk`, `anthropicApi`, `openAiCompatible`, `codexSdk`, `antigravityAcp`, `grokCli`, `scripted` (tests) |
| Substrate | a variable in the sandbox, described to the model | `text(string)`, `value(name, x)` |
| Tools | plain functions; arguments and results cross as JSON | `llm_query`, `llm_query_batched`, `rlm_query`, with decisions `filter_chunks`, and `claudeWorker` (below) |
| Advisor | profiles the task before turn 1 and returns a strategy | `decisionAdvisor`, `chooseStrategy`, `defaultStrategies`, `preparedStrategies` |
| Prompt | `identity`, `replRules`, `strategy` | `INVESTIGATOR_IDENTITY`, `JS_REPL_RULES`, `STRATEGIES.*` |
| Limits | turns per RLM; sub-calls, depth and dollars for the whole call tree | `DEFAULT_LIMITS` |

## A worker that can act: `claudeWorker()`

The model's code runs in a sandbox that can read no file and start no process, and every model call the library makes
has no tools. `claudeWorker` is the one way out: a tool that starts a Claude Code agent in a folder you name, gives it
the brief the code wrote, and returns its report.

```ts
import { createRlm, claudeAgentSdk, claudeWorker, text } from '@biosphere-labs/utterson-agent';

const rlm = createRlm({
  model: claudeAgentSdk({ model: 'claude-sonnet-5-5' }),
  task: { instructions: '…', outputs: ['answer'] },
  tools: claudeWorker({ cwd: '/abs/path/to/checkout', model: 'claude-sonnet-5-5' }),
  limits: { stepSeconds: 900 },   // at least the worker's timeoutSeconds, or createRlm refuses
});
// in the model's code:  const r = await worker('Fix the failing test in test/a.test.ts. Done means npm test passes.');
//                       r is { ok, report, stop?, turns?, usd?, seconds }
```

| Option | Default | What it does |
| --- | --- | --- |
| `cwd` | required | where the worker starts: an absolute path to an existing folder |
| `allow` | `Read, Glob, Grep, Edit, Write, Bash` | what it may use; anything else is refused, never asked about. Rules work too: `'Bash(npm test:*)'` |
| `maxTurns`, `maxUsd`, `timeoutSeconds` | 40, $2, 900 s | limits for one worker |
| `parallel` | 1 | workers at once; raise it only when their briefs cannot touch the same files |
| `instructions` | none | added to Claude Code's system prompt for every worker |
| `settingSources` | none | settings files to load; `'project'` is needed for `CLAUDE.md` |
| `name` | `worker` | the function's name in the sandbox |

- **`cwd` is not a wall.** With `Bash` allowed a worker can reach whatever the operating-system user running it can.
  Narrow `allow`, or run it as a user with less access.
- A worker's cost is charged to `limits.budgetUsd` and shows in `result.spend`. Once the budget is spent, no worker
  starts. A worker stopped by its time limit reports no cost, so that part is not counted.
- A worker is stopped when the run is cancelled and when the step that called it is stopped. Whatever it had changed
  stays in the folder: nothing is rolled back.
- It runs on the Claude subscription login and refuses to start on a metered route, like `claudeAgentSdk`.
- It has not been run live yet: the tests replace the SDK with a fake.

## How it works

- **The loop.** Each turn the model returns exactly `{ note, code }` through its structured output. The code runs in the
  sandbox, where it can `print`, keep values on `memory`, call the tools and `SUBMIT({...})`. A reply that is not exactly
  that object stops the run. Nothing is repaired or salvaged.
- **The advisor.** One decision-model request profiles the task: how the answer is assembled, whether the task names
  what it depends on, how much of the text matters. A function in code maps the profile to a strategy. The rulebook
  strategy prepares a `survey` before the first turn: the sub-model writes narrow yes/no conditions, the decision model
  judges every chunk, and the kept chunks are handed to the model.
- **The sandbox.** It's a separate Node process per run, with these protections:
  - on macOS, `sandbox-exec` denies all network access (elsewhere, pass `sandbox.launchPrefix`);
  - `node --permission` lets it read only its own script;
  - code generation from strings is disabled;
  - a `node:vm` context holds only the variables and tools.

  A step that runs past `stepSeconds` restarts the process, which clears `memory`.

## Adapters: what has been run live

| Adapter | Status |
| --- | --- |
| `claudeAgentSdk` | live (all book, policy and contract tests). Refuses to start while `ANTHROPIC_*` variables are set |
| `openAiCompatible` | live on DeepInfra (Qwen3-235B Instruct, gpt-oss-120b and 20b): structured turns, reported cost |
| `antigravityAcp` | one live structured turn |
| `codexSdk` | not completed (account usage limit) |
| `anthropicApi` | offline tests only in TypeScript |
| `grokCli` | not run |

## Developing

```bash
npm install            # also builds dist/
npm test               # no network needed
npm run typecheck
npm run clean-check -- main     # a fresh clone of main installs, passes and builds
```

Before releasing, run `npm test`, `npm run typecheck` and `npm run build`.
