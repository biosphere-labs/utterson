// The RLM loop. createRlm(config) composes the parts (models, prompt, tools, limits, log, sandbox) into a function that
// runs one investigation over some substrates:
//
//   repeat up to rootTurns times:
//     ask the root model for { note, code }        (structured output; a bad turn stops the run)
//     run the code in the sandbox                  (it can call print, SUBMIT and the tools)
//     if it SUBMITted, check the outputs and return them
//     otherwise show the model what the code printed, and go round again
//   out of turns -> stop root_turns_exhausted      (nothing is salvaged)
//
// Built-in tools: llm_query and llm_query_batched (a sub-model reads a passage), and rlm_query (a nested RLM with its
// own REPL over a text you hand it) while depth allows. Your own tools are plain functions passed in `tools`. A tool
// that spends money on its own (claudeWorker) charges the run's budget through the current recorder.
import { Budget, BudgetExhausted, DEFAULT_LIMITS } from './budget.ts';
import { EVENT_SCHEMA_VERSION, eventBus, type EventHandler, type EventKind, type LoggedEvent, type Logger, type RlmEvent } from './log.ts';
import { observedComplete, withRecorder, type CallRecorder } from './observe.ts';
import { DEFAULT_PROMPT, rootPrompt } from './prompt.ts';
import { Sandbox, type SandboxOptions, type ToolHandler } from './sandbox/host.ts';
import { text } from './substrate.ts';
import { TURN_SCHEMA, readTurn, strictJson } from './turn.ts';
import type { Limits, Model, ModelReply, PromptParts, RlmResult, Substrate, Task, Tools, TrajectoryStep } from './types.ts';
import type { Advisor } from './advisor.ts';

export interface RlmConfig {
  /** The root model: it writes the code. */
  model: Model;
  /** The model llm_query uses. Defaults to `model`. */
  subModel?: Model;
  task: Task;
  prompt?: Partial<PromptParts>;
  /** Extra functions the model's code may call, passed in as functions. */
  tools?: Tools;
  limits?: Partial<Limits>;
  /** One subscriber to the event stream (kept for compatibility; same as events: [log]). */
  log?: Logger;
  /** Subscribers to the event stream, called in order for every event. See EVENTS.md. */
  events?: EventHandler[];
  /** Include each model call's full request and reply in its model_call event (large; may contain your documents). */
  includePayloads?: boolean;
  /** A handler that throws stops the run (host_error) instead of being reported as handler_error. For tests. */
  strictEvents?: boolean;
  sandbox?: SandboxOptions;
  /** The system prompt for llm_query sub-calls. */
  subSystem?: string;
  /**
   * Profiles the problem before the first turn and returns a strategy (method text, tools, limits) to run with.
   * The strategy's parts are laid over this config's; the advice is logged and returned with the result.
   */
  advisor?: Advisor;
}

export const DEFAULT_SUB_SYSTEM = 'Answer the request using only the text it contains. Be exact and brief; say so plainly if the text does not say.';

let ids = 0;

/** Composes the parts into a runnable RLM. `run` may be called many times; each call is one investigation. */
export function createRlm(config: RlmConfig) {
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  for (const [name, tool] of Object.entries(config.tools ?? {})) {
    if (tool.seconds !== undefined && tool.seconds > limits.stepSeconds) {
      throw new Error(`the tool ${name} may run ${tool.seconds} s but limits.stepSeconds is ${limits.stepSeconds}: a step past its limit is stopped, and the call with it. Raise stepSeconds`);
    }
  }
  const parts: PromptParts = { ...DEFAULT_PROMPT, ...config.prompt };
  const subModel = config.subModel ?? config.model;
  const bus = eventBus([...(config.log ? [config.log] : []), ...(config.events ?? [])], { strict: config.strictEvents });
  const log = bus.emit;
  const recorderFor = (emit: (event: RlmEvent) => void, signal?: AbortSignal, money?: Pick<CallRecorder, 'charge' | 'admitSpend' | 'budgetLeft'>): CallRecorder => ({
    includePayloads: config.includePayloads ?? false,
    signal,
    record: (call) => emit({ kind: 'model_call', ...call }),
    ...money,
  });

  async function investigate(substrates: Substrate[], budget: Budget, depth: number, parent?: string, signal?: AbortSignal): Promise<RlmResult> {
    const id = `r${++ids}`;
    const emit = (event: RlmEvent) => log({ ...event, schema: EVENT_SCHEMA_VERSION, rlm: id, parent, depth, time: new Date().toISOString() } as LoggedEvent);
    const spend = { usd: 0, notionalUsd: 0, rootCalls: 0, subCalls: 0 };
    const trajectory: TrajectoryStep[] = [];
    // Every dollar goes through here: the tree's budget, and this RLM's own spend.
    const charge = (cost: Pick<ModelReply, 'costUsd' | 'costIsNotional'>) => {
      budget.charge(cost);
      if (cost.costIsNotional) spend.notionalUsd += cost.costUsd ?? 0; else spend.usd += cost.costUsd ?? 0;
    };
    const recorder = recorderFor(emit, signal, { charge, admitSpend: () => budget.admitSpend(), budgetLeft: () => budget.usdLeft });
    // When the running step will be stopped; set just before each step, read by the tools it calls.
    let stepDeadline: number | undefined;
    const cancelled = (): RlmResult => ({ status: 'stopped', stop: { code: 'cancelled', detail: 'the run was cancelled through its signal' }, id, trajectory, spend });
    if (signal?.aborted) return cancelled();

    // ---- the host functions the model's code can call
    async function llmQuery(prompt: unknown): Promise<string> {
      if (typeof prompt !== 'string') throw new Error('llm_query takes one string');
      if (signal?.aborted) throw new Error('cancelled');
      budget.admitSubCall(prompt.length);
      const call = ++spend.subCalls;
      const started = Date.now();
      try {
        const reply = await observedComplete('sub', subModel, { system: config.subSystem ?? DEFAULT_SUB_SYSTEM, prompt }, recorder);
        charge(reply);
        emit({ kind: 'sub_call', call, promptChars: prompt.length, reply: reply.text, usd: reply.costUsd, seconds: (Date.now() - started) / 1000 });
        return reply.text;
      } catch (error) {
        emit({ kind: 'sub_call', call, promptChars: prompt.length, reply: '', error: String(error), seconds: (Date.now() - started) / 1000 });
        throw error;
      }
    }
    async function llmQueryBatched(prompts: unknown): Promise<string[]> {
      if (!Array.isArray(prompts)) throw new Error('llm_query_batched takes an array of strings');
      const answers: string[] = new Array(prompts.length);
      let next = 0;
      const worker = async () => { while (next < prompts.length) { const i = next++; answers[i] = await llmQuery(prompts[i]); } };
      await Promise.all(Array.from({ length: Math.min(limits.concurrency, prompts.length) }, worker));
      return answers;
    }
    async function rlmQuery(question: unknown, context: unknown): Promise<string> {
      if (typeof question !== 'string' || typeof context !== 'string') throw new Error('rlm_query takes (question, text)');
      const child = await investigate([text(context), { name: 'question', value: question, describe: () => `\`question\`: ${JSON.stringify(question)}` }],
        budget, depth + 1, id, signal);
      emit({ kind: 'nested_rlm', child: child.id, question });
      if (child.status !== 'submitted') throw new Error(`nested RLM stopped: ${child.stop?.code}`);
      return JSON.stringify(child.outputs);
    }

    const tools: Tools = {
      llm_query: { signature: 'await llm_query(prompt)', description: 'ask a sub-model about a passage you include in the prompt; returns its answer', fn: llmQuery },
      llm_query_batched: { signature: 'await llm_query_batched([prompt, ...])', description: `the same for many prompts, ${limits.concurrency} at a time; returns the answers in order`, fn: llmQueryBatched },
      ...(depth < limits.depth
        ? { rlm_query: { signature: 'await rlm_query(question, text)', description: 'start a nested investigation with its own REPL over a text too large for llm_query; returns its outputs as JSON', fn: rlmQuery } }
        : {}),
      ...config.tools,
    };
    const handlers: Record<string, ToolHandler> = {};
    for (const [name, tool] of Object.entries(tools)) {
      handlers[name] = async (args, stopped) => {
        const started = Date.now();
        try {
          // Tools run in this RLM's recorder, so the model calls they make (e.g. filter_chunks) are recorded here. Its
          // signal also fires when the sandbox process that made the call is stopped.
          const scoped = { ...recorder, deadline: stepDeadline, ...(stopped ? { signal: signal ? AbortSignal.any([signal, stopped]) : stopped } : {}) };
          const result = await withRecorder(scoped, () => tool.fn(...args));
          if (!name.startsWith('llm_query') && name !== 'rlm_query') emit({ kind: 'tool_call', tool: name, args, result, seconds: (Date.now() - started) / 1000 });
          return result;
        } catch (error) {
          emit({ kind: 'tool_call', tool: name, args, error: error instanceof Error ? error.message : String(error), seconds: (Date.now() - started) / 1000 });
          throw error;
        }
      };
    }

    // ---- the loop
    try {
      emit({ kind: 'rlm_start', task: config.task.instructions, substrates: substrates.map((s) => s.name), tools: Object.keys(tools) });
    } catch (error) { // only with strictEvents: a handler threw
      return { status: 'stopped', stop: { code: 'host_error', detail: String(error) }, id, trajectory, spend };
    }
    const variables = Object.fromEntries(substrates.map((s) => [s.name, s.value]));
    const sandbox = await Sandbox.start(variables, handlers, limits.outputChars, config.sandbox);
    const finish = (result: Omit<RlmResult, 'id' | 'trajectory' | 'spend'>): RlmResult => {
      sandbox.close();
      if (result.stop) emit({ kind: 'stop', code: result.stop.code, detail: result.stop.detail });
      emit({ kind: 'rlm_end', status: result.status, usd: spend.usd + spend.notionalUsd });
      return { ...result, id, trajectory, spend };
    };

    try {
      for (let turn = 1; turn <= limits.rootTurns; turn++) {
        if (signal?.aborted) return finish({ status: 'stopped', stop: { code: 'cancelled', detail: 'the run was cancelled through its signal' } });
        try { budget.admitSpend(); } catch (error) {
          return finish({ status: 'stopped', stop: { code: (error as BudgetExhausted).code, detail: (error as Error).message } });
        }
        const { system, prompt } = rootPrompt({ parts, task: config.task, substrates, tools, history: trajectory,
          limits: { rootTurns: limits.rootTurns, subCallsLeft: budget.subCallsLeft, turn } });
        emit({ kind: 'root_request', turn, promptChars: system.length + prompt.length });
        const started = Date.now();
        let reply;
        try {
          reply = await observedComplete('root', config.model, { system, prompt, schema: TURN_SCHEMA }, recorder);
        } catch (error) {
          if (signal?.aborted) return finish({ status: 'stopped', stop: { code: 'cancelled', detail: 'the run was cancelled through its signal' } });
          return finish({ status: 'stopped', stop: { code: 'model_error', detail: error instanceof Error ? error.message : String(error) } });
        }
        charge(reply);
        spend.rootCalls += 1;
        let json = reply.json;
        if (json === undefined) { try { json = strictJson(reply.text); } catch { json = undefined; } }
        const parsed = readTurn(json);
        if ('problem' in parsed) {
          return finish({ status: 'stopped', stop: { code: 'root_turn_invalid', detail: `${parsed.problem}; reply: ${reply.text.slice(0, 500)}` } });
        }
        emit({ kind: 'root_reply', turn, note: parsed.note, code: parsed.code, usage: reply.usage, usd: reply.costUsd, seconds: (Date.now() - started) / 1000 });

        const stepStarted = Date.now();
        stepDeadline = stepStarted + limits.stepSeconds * 1000;
        const step = await sandbox.run(parsed.code, limits.stepSeconds, signal);
        if (step.cancelled || signal?.aborted) return finish({ status: 'stopped', stop: { code: 'cancelled', detail: 'the run was cancelled through its signal' } });
        const seconds = (Date.now() - stepStarted) / 1000;
        emit({ kind: 'step_output', turn, output: step.output, error: step.error, seconds });
        trajectory.push({ turn, note: parsed.note, code: parsed.code, output: step.output, error: step.error, seconds });

        if (step.submitted !== undefined) {
          const outputs = step.submitted;
          const want = [...config.task.outputs].sort().join(',');
          const got = typeof outputs === 'object' && outputs ? Object.keys(outputs).sort().join(',') : '';
          if (got !== want || !Object.values(outputs).every((v) => typeof v === 'string')) {
            // A wrong SUBMIT is shown to the model like any error, so it can correct it.
            trajectory[trajectory.length - 1]!.error = `SUBMIT needs exactly { ${config.task.outputs.join(', ')} } as strings; got ${JSON.stringify(outputs).slice(0, 300)}`;
            continue;
          }
          emit({ kind: 'submit', outputs: outputs as Record<string, string> });
          return finish({ status: 'submitted', outputs: outputs as Record<string, string> });
        }
      }
      return finish({ status: 'stopped', stop: { code: 'root_turns_exhausted', detail: `no SUBMIT in ${limits.rootTurns} turns` } });
    } catch (error) {
      return finish({ status: 'stopped', stop: { code: 'host_error', detail: error instanceof Error ? error.stack ?? error.message : String(error) } });
    }
  }

  return {
    limits,
    parts,
    /**
     * One investigation over these substrates, with a fresh budget for its whole call tree. Aborting `signal` cancels
     * the run: model and decision calls get the signal, a running sandbox step is stopped, and the run returns
     * status 'stopped' with stop.code 'cancelled'.
     */
    async run(substrates: Substrate[], options: { signal?: AbortSignal } = {}): Promise<RlmResult> {
      const signal = options.signal;
      if (!config.advisor) return investigate(substrates, new Budget(limits), 0, undefined, signal);
      const cancelledEarly = (): RlmResult => ({ status: 'stopped', stop: { code: 'cancelled', detail: 'the run was cancelled through its signal' }, id: 'advisor', trajectory: [], spend: { usd: 0, notionalUsd: 0, rootCalls: 0, subCalls: 0 } });
      if (signal?.aborted) return cancelledEarly();
      const started = Date.now();
      const emit = (event: RlmEvent) => log({ ...event, schema: EVENT_SCHEMA_VERSION, rlm: 'advisor', depth: 0, time: new Date().toISOString() } as LoggedEvent);
      const recorder = recorderFor(emit, signal);
      let advice, chosen;
      try {
        ({ advice, parts: chosen } = await withRecorder(recorder, () => config.advisor!(config.task, substrates)));
      } catch (error) {
        if (signal?.aborted) return cancelledEarly();
        throw error;
      }
      let all = substrates;
      if (chosen.prepare) {
        let prepared;
        try {
          prepared = await withRecorder(recorder, () => chosen.prepare!({ task: config.task, substrates, model: subModel }));
        } catch (error) {
          if (signal?.aborted) return { ...cancelledEarly(), advice };
          throw error;
        }
        all = [...substrates, ...prepared.substrates];
        advice.prepared = { summary: prepared.summary, decisionUsd: prepared.decisionUsd, modelUsd: prepared.modelUsd };
      }
      emit({ kind: 'advice', ...advice, seconds: (Date.now() - started) / 1000 });
      // The advised run sends its events into this one's stream, so subscribers see a single stream.
      const advised = createRlm({
        ...config, advisor: undefined, log: log, events: undefined,
        prompt: { ...config.prompt, ...chosen.prompt },
        tools: { ...config.tools, ...chosen.tools },
        limits: { ...config.limits, ...chosen.limits },
      });
      return { ...(await advised.run(all, { signal })), advice };
    },
    /**
     * Subscribes to events of one kind (or '*' for all) from every run of this RLM. Returns the unsubscribe function.
     *   rlm.on('model_call', (e) => records.push(e));
     */
    on<K extends EventKind | '*'>(kind: K, handler: (event: K extends '*' ? LoggedEvent : Extract<LoggedEvent, { kind: K }>) => void | Promise<void>): () => void {
      return bus.add((event) => (kind === '*' || event.kind === kind ? handler(event as never) : undefined));
    },
  };
}

export { BudgetExhausted };
