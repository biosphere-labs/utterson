# Using @biosphere-labs/utterson-agent (for coding agents)

This file is for an AI agent writing code that uses this library. It's ordered by what you need first. Every name here
is a real export of the package.

## When to use it

Use it when you have a question, or a checklist of questions, to answer from text too long or too scattered to read
reliably in one prompt, and you can phrase the answer as named string outputs. The library runs a loop in which a model
writes JavaScript to search the text in a sandbox, with cheap sub-calls and a decision model choosing the strategy.

Don't use it for short inputs with a single question; a plain model call is simpler. Don't use it for code
repositories either: there are no AST tools yet.

## The one call

```ts
import { utterson, text, value } from '@biosphere-labs/utterson-agent';

const agent = utterson({
  model: 'claude-sonnet-5-5',                 // or 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'openrouter:…', a Model object
  task: { instructions: string, outputs: string[] },
  keys: { model: string, decisions: string }, // BOTH required; keys.model may be 'subscription' (Claude, Codex)
});
const result = await agent.run([text(bigText), value('question', q) /*, more value(...) */]);
```

Rules that cause errors if you ignore them:

1. **`keys.decisions` and `keys.model` are both required**, except that `keys.model` isn't needed when `model` and
   `subModel` are `Model` objects, and `keys.decisions` isn't needed when `decisions.judge` is given. Otherwise
   `utterson()` throws `UttersonConfigError`.
   Don't pass the same key for both unless it really is valid for both services.
2. **The adapter is chosen from the model name:**
   - `claude-*` uses the Claude subscription when `keys.model === 'subscription'`, and the Anthropic API otherwise;
   - `gpt-*` and `o<digit>*` use Codex, and need `'subscription'`;
   - `gemini-*` uses Antigravity, and needs `'subscription'`;
   - `grok-*` uses Grok, and needs `'subscription'`;
   - **any other name throws**: there's no default provider, so give a `provider:` prefix (e.g. `deepinfra:`);
   - a `provider:` prefix decides explicitly: `anthropic-api`, or any of about 200 OpenAI-compatible providers
     (`deepinfra`, `openrouter`, `groq`, `deepseek`, `cerebras`, …; see `CATALOG_PROVIDERS`). Their base URLs are
     built in; `providers: { name: baseUrl }` overrides or adds one. An unknown prefix throws.
3. **The Claude subscription adapter refuses to start while `ANTHROPIC_*` environment variables are set**, as they are
   inside Claude Code. Run with `env -u ANTHROPIC_BASE_URL`, or use an API key.
4. **`task.outputs` names are what the model must pass to `SUBMIT`.** Every output is a string; ask for JSON inside a
   string if you need structure, and parse it yourself.
5. **Substrates:**
   - `text(s)` makes a variable named `context`; pass `{ name }` to rename it.
   - `value(name, x)` makes any other variable.
   - Values must be JSON-serialisable, and never enter the prompt (only a description does).
6. **Node 24 or later, ESM only.**

## Reading the result

```ts
if (result.status === 'submitted') {
  result.outputs!.answer;           // string
} else {
  result.stop!.code;                // 'root_turns_exhausted' | 'root_turn_invalid' | 'budget_exhausted' | 'model_error' | 'host_error' | 'cancelled'
  result.stop!.detail;
}
result.trajectory;                  // every step: note, code, output/error
result.spend;                       // { usd, notionalUsd, rootCalls, subCalls }
result.advice;                      // { strategy, reason, profile, prepared } chosen before turn 1
```

There is no partial answer: a stopped run has no outputs. Retry, or raise `limits.rootTurns` and `limits.budgetUsd`.

## Common adjustments

| Want | Do |
| --- | --- |
| A cheaper root model | `model: 'deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507'` or `'deepinfra:openai/gpt-oss-120b'` with a DeepInfra key. Measured on contract review at about $0.001 a contract, against $0.067 for Sonnet (see the repo's results) |
| A cheaper sub-model only | `subModel: '…'` (it uses the same `keys.model`) or a `Model` object |
| See what it does | `events: [consoleLog()]` (stderr) or `[jsonlLog('run.jsonl')]` |
| Per-call records or cost | `agent.on('model_call', (e) => …)`: role, model, usage, costUsd, costIsNotional, requestId, promptHash. Read EVENTS.md |
| Record calls for replay | `includePayloads: true` (large; contains the documents) |
| More turns or money | `limits: { rootTurns: 30, budgetUsd: 3 }` |
| Your own function in the sandbox | `tools: { name: { signature: 'await name(x)', description: '…', fn } }`. Arguments and results must be JSON |
| Have the model's code change files or run commands | `tools: claudeWorker({ cwd, model })` with `limits: { stepSeconds: 900 }`: the code calls `await worker(brief)` and a Claude Code agent does the work in `cwd`. Read the README section first: `cwd` is not a wall |
| A different decision model or endpoint | `decisions: { model, endpoint }` |
| Stop a run | `agent.run(substrates, { signal })`, then abort: the result has `stop.code === 'cancelled'` |
| Your own decisions client or spend ledger | `decisions: { judge }` or `decisions: { ledger }` (`null` for none) |
| Full control | `createRlm({ model, subModel, task, tools, prompt, limits, log, advisor })`; see the README |

## Costs and caps

- Decision calls go through a ledger file with a hard cap: `decisions.capUsd`, default $3, at
  `./utterson-decision-spend.jsonl`. When the cap is reached, further calls throw `SpendRefused`.
- `limits.budgetUsd` caps a single run's model spend, notional subscription cost included.

## Don't

- Don't paste the long text into `task.instructions`. Pass it with `text(...)`.
- Don't catch `UttersonConfigError` and carry on without decisions. Fix the configuration.
- Don't rely on the network-denied sandbox wall outside macOS. Pass `sandbox.launchPrefix` there.
