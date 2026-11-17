// The vocabulary every part of utterson-agent shares. Everything an experiment varies is one of these values,
// built by a factory function and passed in: models, substrates, tools, prompt parts, limits, loggers.

/** A JSON Schema object (only the subset the models' structured-output features accept is used). */
export type JsonSchema = Record<string, unknown>;

/** Token counts one model call reported. Absent fields were not reported, never "zero". */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One model call: a system prompt, one user prompt, and optionally the JSON object shape the reply must have. */
export interface ModelRequest {
  system: string;
  prompt: string;
  /** When set, the reply's `json` is an object matching this schema (the model's native structured output). */
  schema?: JsonSchema;
  signal?: AbortSignal;
}

export interface ModelReply {
  /** The reply text. With a schema, this is the JSON text of `json`. */
  text: string;
  /** The parsed object, present when the request had a schema. */
  json?: unknown;
  usage?: Usage;
  /** Dollars. `costIsNotional` marks a subscription's estimate rather than a bill. */
  costUsd?: number;
  costIsNotional?: boolean;
  requestId?: string;
}

/** Anything that can answer a ModelRequest: an SDK adapter, an API client, a scripted fake. */
export interface Model {
  /** For logs and results, e.g. "claude-agent-sdk:claude-sonnet-5-5". */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

/**
 * A function the model's code may call from the sandbox. Arguments and the return value cross a process boundary
 * as JSON, so both must be JSON-serialisable. The description is shown to the model.
 */
export interface Tool {
  description: string;
  /** How the call looks to the model, e.g. "await search(pattern, limit)". */
  signature: string;
  fn: (...args: any[]) => unknown;
  /**
   * The longest one call may run, in seconds, for a tool that can outlast an ordinary step. createRlm refuses a
   * `limits.stepSeconds` below it: a step past its limit is stopped, and the call with it.
   */
  seconds?: number;
}
export type Tools = Record<string, Tool>;

/** A value the model's code can read as a global variable, plus how it is described to the model. */
export interface Substrate {
  /** The variable name in the sandbox, e.g. "context". */
  name: string;
  /** The value itself (JSON-serialisable). It never enters the model's prompt. */
  value: unknown;
  /** A short description for the prompt: kind, size, a preview. */
  describe(): string;
}

/** What the run must produce: the output names SUBMIT must be given, all strings. */
export interface Task {
  /** The task text shown to the model. */
  instructions: string;
  /** The output names, e.g. ["answer"]. */
  outputs: string[];
}

/** The text blocks the root prompt is assembled from. Each can be replaced on its own. */
export interface PromptParts {
  /** Who the model is and how it works. */
  identity: string;
  /** How the REPL behaves: the language, persistence, printing, SUBMIT. */
  replRules: string;
  /** An optional suggested method (search-first, map-reduce, ...). Empty for none. */
  strategy: string;
}

export interface Limits {
  /** Root turns (think, code, see output) for one RLM. Small: tens. */
  rootTurns: number;
  /** Sub-model calls across the whole call tree. Large: hundreds (one map step over a book is ~60). */
  subCalls: number;
  /** How deep nested RLMs (rlm_query) may go. 0 disables nesting. */
  depth: number;
  /** The longest prompt one sub-call may send, in characters. */
  subCallMaxChars: number;
  /** Sub-calls running at once (llm_query_batched). */
  concurrency: number;
  /** Dollars for the whole call tree, notional costs included. The guard that matters once recursion is on. */
  budgetUsd: number;
  /** Wall-clock limit for one code step, in seconds. */
  stepSeconds: number;
  /** Characters of one step's printed output shown back to the model. */
  outputChars: number;
}

/** How a run ended. `submitted` carries the outputs; anything else is a named stop. Nothing is ever salvaged. */
export type RunStatus = 'submitted' | 'stopped';

export interface TrajectoryStep {
  turn: number;
  note: string;
  code: string;
  output: string;
  error?: string;
  seconds: number;
}

export interface RlmResult {
  status: RunStatus;
  outputs?: Record<string, string>;
  /** Named reason when stopped: root_turns_exhausted, root_turn_invalid, budget_exhausted, model_error, ... */
  stop?: { code: string; detail: string };
  trajectory: TrajectoryStep[];
  /** This RLM's id in the log's call tree. */
  id: string;
  spend: { usd: number; notionalUsd: number; rootCalls: number; subCalls: number };
  /** Present when an advisor chose the strategy. */
  advice?: import('./advisor.ts').Advice;
}
