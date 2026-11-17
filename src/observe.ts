// One record per model call, whatever made it: the root model, a sub-call, a strategy's prepare step, or a decision
// model inside the advisor, the survey or filter_chunks. The RLM loop gives each phase a recorder; code it does not
// call directly (advisor, prepare, tools) finds the current recorder through AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { DecisionQuestion, DecisionReply, Judge } from './decisions.ts';
import type { Model, ModelReply, ModelRequest, Usage } from './types.ts';

export type CallRole = 'root' | 'sub' | 'prepare' | 'decision';

export interface CallRecord {
  role: CallRole;
  /** The adapter's name, e.g. "claude-agent-sdk:claude-sonnet-5-5" or "openrouter-decisions:perplexity/pplx-decider-v1.2". */
  model: string;
  usage?: Usage;
  costUsd?: number;
  /** True for a subscription's estimate rather than a bill. */
  costIsNotional?: boolean;
  requestId?: string;
  /** sha256 of the request (system + prompt, or the decision state + questions). Equal hashes mean identical requests. */
  promptHash: string;
  seconds: number;
  error?: string;
  /** The full request and reply, only when the run has includePayloads. */
  payload?: { request: unknown; reply: unknown };
}

export interface CallRecorder {
  record(call: CallRecord): void;
  includePayloads: boolean;
  /**
   * The run's cancellation signal, passed to every model and decision call made under this recorder. Inside a tool
   * call it is also aborted when the sandbox process the call came from is stopped (a step past its time limit, the
   * end of the run), since nothing can receive the result after that.
   */
  signal?: AbortSignal;
  /**
   * Adds spend this library's own model calls did not report (a tool that runs an agent of its own) to the run's
   * budget and to the result's spend. Absent outside a run.
   */
  charge?(cost: { costUsd?: number; costIsNotional?: boolean }): void;
  /** Throws BudgetExhausted when the run's dollars are spent. Absent outside a run. */
  admitSpend?(): void;
  /** Dollars left in the run's budget, so a tool can cap its own spend. Absent outside a run. */
  budgetLeft?(): number;
  /**
   * When the step that made this call will be stopped, in milliseconds since the epoch. Present only inside a tool
   * call, so a long tool can end on its own first, while its result can still be returned.
   */
  deadline?: number;
}

const store = new AsyncLocalStorage<CallRecorder>();

/** Runs fn with this recorder as the current one (also inside anything fn awaits). */
export const withRecorder = <T>(recorder: CallRecorder | undefined, fn: () => T): T => (recorder ? store.run(recorder, fn) : fn());
export const currentRecorder = (): CallRecorder | undefined => store.getStore();

export const hashOf = (value: unknown) =>
  'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** model.complete, recorded. */
export async function observedComplete(role: CallRole, model: Model, request: ModelRequest, recorder = currentRecorder()): Promise<ModelReply> {
  const started = Date.now();
  const base = { role, model: model.name, promptHash: hashOf(`${request.system}\n\n${request.prompt}`) };
  const payloadRequest = { system: request.system, prompt: request.prompt, schema: request.schema };
  try {
    const reply = await model.complete(request.signal || !recorder?.signal ? request : { ...request, signal: recorder.signal });
    recorder?.record({
      ...base, usage: reply.usage, costUsd: reply.costUsd, costIsNotional: reply.costIsNotional ?? false, requestId: reply.requestId,
      seconds: (Date.now() - started) / 1000,
      ...(recorder.includePayloads ? { payload: { request: payloadRequest, reply: reply.json ?? reply.text } } : {}),
    });
    return reply;
  } catch (error) {
    recorder?.record({ ...base, seconds: (Date.now() - started) / 1000, error: String(error),
      ...(recorder.includePayloads ? { payload: { request: payloadRequest, reply: null } } : {}) });
    throw error;
  }
}

/** judge.decide, recorded as a decision call. */
export async function observedDecide(judge: Judge, state: unknown, questions: Record<string, DecisionQuestion>, recorder = currentRecorder()): Promise<DecisionReply> {
  const started = Date.now();
  const base = { role: 'decision' as const, model: judge.name, promptHash: hashOf({ state, questions }) };
  try {
    const reply = await judge.decide(state, questions, recorder?.signal ? { signal: recorder.signal } : undefined);
    recorder?.record({
      ...base, usage: reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : undefined,
      costUsd: reply.costUsd, costIsNotional: false, requestId: reply.requestId, seconds: (Date.now() - started) / 1000,
      ...(recorder.includePayloads ? { payload: { request: { state, questions }, reply: reply.answers } } : {}),
    });
    return reply;
  } catch (error) {
    recorder?.record({ ...base, seconds: (Date.now() - started) / 1000, error: String(error) });
    throw error;
  }
}
