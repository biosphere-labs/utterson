# Events (schema 1)

A run publishes a stream of events. This document is the contract for consumers: loggers, an inspector, an optimiser,
cassette recorders, a bridge to another bus. Every event carries `schema: 1` (`EVENT_SCHEMA_VERSION`). Shapes follow
semver: adding a field or a new kind is a minor release; renaming or removing one changes `schema` and is a major
release.

## Subscribing

```ts
const rlm = createRlm({ ..., events: [jsonlLog('run.jsonl'), (e) => bus.publish(e)] });  // or utterson({ ..., events })
const off = rlm.on('model_call', (e) => records.push(e));   // one kind, or '*' for all; returns unsubscribe
```

`log` is the older name for a single subscriber, and it still works.

## Delivery

- **Order.** Handlers are called synchronously, in the order given, for every event, as it happens. A cassette sees
  events in the order they occurred.
- **Promises.** A handler may return a promise. The run does not wait for it, but does catch a rejection.
- **Errors.** A handler that throws, or whose promise rejects, never affects the run or the other handlers. The others
  receive a `handler_error` event. With `strictEvents: true`, a synchronous throw stops the run instead (`stop.code:
  'host_error'`), which is for tests.
- **One stream.** When an advisor is used, its events and the advised run's events arrive on the same stream.

## Common fields

Every event has these fields:

| Field | Meaning |
| --- | --- |
| `schema` | `1` |
| `kind` | one of the kinds below |
| `rlm` | the id of the RLM that emitted it (`r1`, `r2`, …), or `advisor` |
| `parent` | the parent RLM's id, for a nested `rlm_query` run |
| `depth` | 0 for the top run |
| `time` | ISO timestamp |

## `model_call`: one per model call

This is the event for per-call records, cost accounting and replay. It covers every model call: the root model, the
sub-models, a strategy's prepare step, and every decision-model call (the advisor, the survey and `filter_chunks`).

| Field | Meaning |
| --- | --- |
| `role` | `'root'`, `'sub'`, `'prepare'` or `'decision'` |
| `model` | the adapter's name, e.g. `claude-agent-sdk:claude-sonnet-5-5`, `deepinfra:Qwen/…`, `openrouter-decisions:perplexity/pplx-decider-v1.2` |
| `usage` | `{ inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens? }`; an absent field was not reported |
| `costUsd` | dollars, when the provider reported a cost |
| `costIsNotional` | `true` for a subscription's estimate, `false` for a bill |
| `requestId` | the provider's id for the call, when it gives one |
| `promptHash` | `sha256:<hex>` of the request (system and prompt, or the decision state and questions). Equal hashes mean identical requests |
| `seconds` | how long the call took |
| `error` | present when the call failed |
| `payload` | `{ request, reply }`, only with `includePayloads: true`. It's large, and may contain the documents you passed in; enough to replay the call |

## The other kinds

| Kind | Fields | When |
| --- | --- | --- |
| `rlm_start` | `task`, `substrates`, `tools` | an RLM starts |
| `root_request` | `turn`, `promptChars` | before each root turn |
| `root_reply` | `turn`, `note`, `code`, `usage`, `usd`, `seconds` | the root model's turn |
| `step_output` | `turn`, `output`, `error?`, `seconds` | the sandbox ran the turn's code |
| `sub_call` | `call`, `promptChars`, `reply`, `usd?`, `seconds`, `error?` | an `llm_query` finished (narrative; `model_call` has the record) |
| `tool_call` | `tool`, `args`, `result?`, `error?`, `seconds` | a tool other than `llm_query`/`rlm_query` ran (`filter_chunks` results include `costUsd`; a `claudeWorker` result is `{ ok, report, stop?, turns?, usd?, seconds }`) |
| `nested_rlm` | `child`, `question` | an `rlm_query` run finished |
| `advice` | `strategy`, `reason`, `profile`, `answers`, `costUsd`, `judge`, `prepared?`, `seconds` | the advisor chose a strategy (and prepared its substrates) |
| `submit` | `outputs` | the model submitted |
| `stop` | `code`, `detail` | the run stopped without submitting (`cancelled` when its signal was aborted) |
| `rlm_end` | `status`, `usd` | an RLM ended |
| `handler_error` | `eventKind`, `error` | another handler threw on an event of `eventKind` |

The TypeScript types are `RlmEvent` and `LoggedEvent` (an event plus the common fields), exported from the package.
