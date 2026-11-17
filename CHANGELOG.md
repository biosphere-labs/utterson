# Changelog

Versions follow semver: a patch for fixes, a minor for new features or new exports, and a major for breaking changes
(pre-1.0, a minor may break).

## 0.7.0 (2026-11-16)

Built from 0.5.1. The tags `v0.6.0-rc.1` and `v0.6.0-rc.2` belong to a line that was not merged (a root that may not
read); this release has none of it, and skips 0.6.0 so the two cannot be confused.

- **`claudeWorker({ cwd, model })`: a tool that can act.** The model's code calls `await worker(brief)` and a Claude
  Code agent edits files and runs commands in `cwd`, then returns `{ ok, report, stop?, turns?, usd?, seconds }`. Until
  now nothing the model's code could call could change anything outside the sandbox. A tool call that `allow` does not
  cover is refused; workers run one at a time by default; each has a turn, dollar and time limit. `cwd` is where a
  worker starts, not a wall. Not yet run live: the tests replace the SDK with a fake. See the README.
- **A tool's spend counts.** A tool can charge the run's budget through the current recorder
  (`currentRecorder()?.charge({ costUsd, costIsNotional })`, and `admitSpend()` to be refused once the budget is
  spent). The worker does; its cost is in `limits.budgetUsd` and `result.spend`. `currentRecorder` is exported.
- **A tool call is told to stop when its step is.** A step past `limits.stepSeconds`, or the end of the run, aborts the
  recorder's `signal` inside tool calls still running. Before, such a call carried on with nothing to receive its
  result. `llm_query` is unchanged.
- **`Tool.seconds`**: the longest one call may run. `createRlm` throws when `limits.stepSeconds` is below it.
- **A tool knows its step's deadline and the budget left.** Inside a tool call the recorder carries `deadline` (when
  the calling step is stopped) and `budgetLeft()`. The worker cuts its time limit to the step's time left, less 10 s,
  so a second worker in the same step ends on its own with a report instead of being killed (`stop: 'no_time_left'`
  when too little is left to start one). It cuts its dollar limit to the budget left.
- **A worker stopped before the SDK reports its cost is charged at its dollar limit** (`usdIsLimit: true`), so
  stopped workers can no longer run past the budget unseen. A failed API call is `stop: 'api_error'` with the message
  in `report`, not a stop named 'success'.
- Fix: **an error's text is cut at the step's output limit**, with the cut stated, as printed output already was.
  Before, code that threw a large message (`throw new Error(context)`, or a tool failing with a long message) put the
  whole message into the prompt of every later turn. A 2.2M-character input thrown this way gave a 2.2M-character
  prompt; it now gives one under 20,000. The cut is made in the host (`src/sandbox/host.ts`).

## 0.5.1 (2026-11-13)

- **Own repository.** The library now sits at the root of `biosphere-labs/utterson-agent`, with its history filtered
  from the old monorepo. Release tags are now `v0.x.y`. You can install it straight from GitHub:
  `npm install github:biosphere-labs/utterson-agent#v0.5.1` (`prepare` builds `dist/`).
- Fix: `EVENTS.md` and `CHANGELOG.md` are now in the package. Earlier releases left them out of `files`.

## 0.5.0 (2026-11-13)

- **Provider catalog.** A `provider:` model prefix now works for about 200 OpenAI-compatible providers with no base URL
  to look up. The package bundles a snapshot of the models.dev catalog (MIT; `CATALOG_PROVIDERS`), refreshed by
  `scripts/update-providers.ts`, plus hand-added presets for big providers the catalog lists without a URL: OpenAI,
  Mistral, xAI and Cerebras are new, alongside DeepInfra, OpenRouter, Together, Groq and Fireworks.
- **Overrides:** `providers: { name: baseUrl }` (in `utterson()` and `modelFor`) overrides any base URL or adds a
  provider. The lookup order is: the option, then the presets, then the catalog.
- Prefixes may start with a digit or contain dots (for example `302ai:`). `resolveBaseUrl` is exported.

## 0.4.0 (2026-11-13)

- **Breaking: no default provider.** An unrecognised model name without a `provider:` prefix now throws
  `UttersonConfigError` instead of running on DeepInfra. A typo must fail loudly, not bill an account. Write
  `deepinfra:Qwen/…` where you wrote `Qwen/…`. `claude-*`, `gpt-*`, `o<digit>*`, `gemini-*` and `grok-*` are still
  recognised.

## 0.3.0 (2026-11-13)

- **Cancellation:** `run(substrates, { signal })`. The signal reaches every model and decision call (through
  `ModelRequest.signal` and `Judge.decide(…, { signal })`), stops a running sandbox step, and is passed on to nested runs.
  A cancelled run returns `status: 'stopped'`, `stop.code: 'cancelled'`.
- **`keys.model` is optional when `model` and `subModel` are `Model` objects.** It's still required for a model name.
- **Injectable decisions client:** `decisions.judge`. When it's given, `keys.decisions` isn't needed (with neither,
  `utterson()` still throws).
- **Injectable decision ledger:** `decisions.ledger` takes a `Ledger`, or `null` for none. `openRouterDecisions` no
  longer requires a ledger.
- `Judge.decide` takes an optional third argument, `{ signal }`. `StepResult.cancelled`.

## 0.2.1 (2026-11-13)

- Fix: a clean checkout of the repository failed `npm install` (E404). The test-bed packages depended on `^0.1.0`, which a
  0.x minor bump falls outside, so npm looked for the package on the public registry. They now depend on `*`, which the
  workspace copy always satisfies. The library itself is unchanged.

## 0.2.0 (2026-11-13)

- **Events API.** `events: [handlers]` on `createRlm` and `utterson`, and `rlm.on(kind, handler)` returning an
  unsubscribe function. `log` still works as a single subscriber.
- Every event carries `schema: 1` (`EVENT_SCHEMA_VERSION`). The contract is in EVENTS.md.
- New `model_call` event for every model call (roles `root`, `sub`, `prepare`, `decision`), with model name, typed
  usage, cost, `costIsNotional`, request id and prompt hash. Full payloads come with `includePayloads`. Decision-model
  calls are now visible in the stream.
- Handler errors are isolated and reported as `handler_error`. `strictEvents` stops the run instead.
- `DecisionReply.requestId`; exports `eventBus`, `observedComplete`, `observedDecide`, `withRecorder`, `hashOf`.

## 0.1.1 (2026-11-13)

- Fix: the Claude Agent SDK adapter allows 3 turns when a schema is set, so the SDK's retry after a failed schema
  validation no longer fails with "Reached maximum number of turns (1)".

## 0.1.0 (2026-11-13)

- First packaged release: `createRlm`, the sandbox, the model adapters (including `openAiCompatible`), budgets,
  logging, decision models, the advisor and prepared strategies, and the `utterson()` front door with required model
  and decision keys.
