// A worker that can act: a tool that starts a full Claude Code agent (through the Claude Agent SDK) in one folder,
// hands it a brief, and returns its report. It is how the root's code gets something done outside the sandbox. The
// sandbox can read no file and start no process, and every model call this library makes itself has no tools.
//
// What bounds a worker:
//   - `cwd` is required and is where it starts. It is not a wall: with Bash allowed, a worker can reach whatever the
//     operating-system user running it can. Narrow `allow` (for example 'Bash(npm test:*)') or run it as a user with
//     less access.
//   - permissionMode 'dontAsk': a tool call that `allow` does not cover is refused. Nobody is there to be asked.
//   - No MCP servers, and no settings files unless `settingSources` names them.
//   - One worker at a time by default, so two never write the same files.
//   - A turn limit, a dollar limit and a time limit for each call. The dollar limit is cut to what is left of the
//     run's budget, and the time limit to what is left of the step that called it (less a margin, so its report still
//     gets back). Its cost is charged to the run's budget, and the run refuses to start it once that budget is spent.
//     A worker stopped before the SDK reports its cost is charged at its dollar limit, so the budget still trips.
//   - It is stopped when the run is cancelled, and when the step that called it is stopped.
//
// A worker that is stopped leaves whatever it had changed in the folder. Nothing is rolled back.
//
// It runs on the Claude subscription login, like the claudeAgentSdk adapter, and refuses to start on a metered route.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { meteredEnvNames, withoutParentSession } from '../models/claudeAgentSdk.ts';
import { currentRecorder } from '../observe.ts';
import type { Tools } from '../types.ts';

export const WORKER_DEFAULT_ALLOW = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

export interface ClaudeWorkerOptions {
  /** The folder the worker starts in: absolute, and it must exist. There is no default. */
  cwd: string;
  model: string;
  /** The tool's name in the sandbox. Default 'worker'. */
  name?: string;
  /**
   * What the worker may use without being asked; everything else is refused. Tool names ('Read', 'Bash') or
   * permission rules ('Bash(npm test:*)'). Default WORKER_DEFAULT_ALLOW.
   */
  allow?: string[];
  /** Added to Claude Code's own system prompt for every worker: house rules the root should not have to repeat. */
  instructions?: string;
  /** Turns one worker may take. Default 40. */
  maxTurns?: number;
  /** Dollars one worker may spend (notional on the subscription). Default 2. */
  maxUsd?: number;
  /** Seconds one worker may run. Default 900. `limits.stepSeconds` must be at least this. */
  timeoutSeconds?: number;
  /** Workers running at once. Default 1; raise it only when their briefs cannot touch the same files. */
  parallel?: number;
  /** Settings files the worker loads: 'user', 'project' (needed for CLAUDE.md), 'local'. Default none. */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** The environment the CLI subprocess gets. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Injected in tests instead of the SDK's query(). */
  query?: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;
}

/** What one call returns to the root's code. Fields the SDK did not report are absent, never zero. */
export interface WorkerReport {
  /** True when the worker finished on its own. False when it was stopped; `stop` says why. */
  ok: boolean;
  /** The worker's last message: its report when it finished, as far as it got when it did not. */
  report: string;
  /**
   * 'timeout' (its own limit, or the end of the step that called it); 'no_time_left' (the step had too little time
   * left to start one); 'api_error' (the model API failed, with its message in `report`); or the SDK's reason:
   * error_max_turns, error_max_budget_usd, error_during_execution.
   */
  stop?: string;
  turns?: number;
  /** What it cost. When `usdIsLimit` is true the real cost is unknown and this is the limit it was charged at. */
  usd?: number;
  usdIsLimit?: boolean;
  seconds: number;
}

/** The tool an RLM's code calls to have work done in a folder. Spread it into `tools`. */
export function claudeWorker(options: ClaudeWorkerOptions): Tools {
  const env = options.env ?? process.env;
  const metered = meteredEnvNames(env);
  if (metered.length) throw new Error(`unset these before a subscription run: ${metered.join(', ')}`);
  if (!isAbsolute(options.cwd) || !existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new Error(`claudeWorker: cwd must be an existing folder, given as an absolute path; got ${JSON.stringify(options.cwd)}`);
  }
  const name = options.name ?? 'worker';
  const allow = options.allow ?? WORKER_DEFAULT_ALLOW;
  const maxTurns = options.maxTurns ?? 40;
  const maxUsd = options.maxUsd ?? 2;
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  const parallel = Math.max(1, options.parallel ?? 1);
  // Kept back from the step's end, so a worker stopped by it can shut down and its report reach the root's code.
  const STEP_MARGIN_MS = 10_000;
  const childEnv = withoutParentSession(env);
  // A rule such as 'Bash(npm test:*)' allows part of a tool; the tool itself still has to be switched on.
  const builtIns = [...new Set(allow.map((rule) => rule.replace(/\(.*$/, '')))];

  // A slot is handed straight from a finishing worker to the next one waiting, so the count never passes `parallel`.
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (running < parallel) { running += 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  };

  async function work(brief: unknown): Promise<WorkerReport> {
    if (typeof brief !== 'string' || !brief.trim()) throw new Error(`${name} takes one string: the brief`);
    const recorder = currentRecorder();
    const stopped = recorder?.signal;
    await acquire();
    const started = Date.now();
    // Its own limit, cut to what is left of the step: a worker queued behind another starts late.
    const stepLeft = recorder?.deadline === undefined ? Infinity : recorder.deadline - started - STEP_MARGIN_MS;
    const ms = Math.min(timeoutSeconds * 1000, stepLeft);
    const usdLimit = Math.min(maxUsd, recorder?.budgetLeft?.() ?? maxUsd);
    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, Math.max(0, ms));
    const onStop = () => abortController.abort();
    stopped?.addEventListener('abort', onStop, { once: true });
    try {
      if (stopped?.aborted) throw new Error('cancelled');
      if (ms <= 0) return { ok: false, report: '', stop: 'no_time_left', seconds: 0 };
      recorder?.admitSpend?.();
      const query = options.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const sdkOptions: Record<string, unknown> = {
        model: options.model, cwd: options.cwd, env: childEnv, abortController,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(options.instructions ? { append: options.instructions } : {}) },
        tools: builtIns, allowedTools: allow, permissionMode: 'dontAsk',
        mcpServers: {}, strictMcpConfig: true, settingSources: options.settingSources ?? [], persistSession: false,
        maxTurns, maxBudgetUsd: usdLimit,
      };
      let last = '';
      let result: any;
      try {
        for await (const message of query({ prompt: brief, options: sdkOptions as any })) {
          if (message.type === 'assistant') {
            const said = (message.message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
            if (said.trim()) last = said;
          } else if (message.type === 'result') {
            result = message;
          }
        }
      } catch (error) {
        if (!timedOut && !stopped?.aborted) throw error;
      }
      const seconds = (Date.now() - started) / 1000;
      // The SDK reports the cost in its result message. A worker stopped before that message may still have spent up
      // to its limit, so it is charged at the limit: charging nothing would let stopped workers run past the budget.
      const known = typeof result?.total_cost_usd === 'number';
      const usd = known ? result.total_cost_usd : usdLimit;
      recorder?.charge?.({ costUsd: usd, costIsNotional: true });
      const cost = known ? { usd } : { usd, usdIsLimit: true };
      if (stopped?.aborted) throw new Error('cancelled');
      if (!result) {
        if (timedOut) return { ok: false, report: last, stop: 'timeout', seconds, ...cost };
        throw new Error('the Agent SDK returned no result');
      }
      const ok = result.subtype === 'success' && !result.is_error;
      // A 'success' result with is_error set is a failed API call; its message is in result.result.
      const apiError = result.subtype === 'success' && result.is_error;
      return {
        ok, report: ok || apiError ? String(result.result ?? last) : last,
        ...(ok ? {} : { stop: timedOut ? 'timeout' : apiError ? 'api_error' : String(result.subtype) }),
        ...(typeof result.num_turns === 'number' ? { turns: result.num_turns } : {}),
        ...cost,
        seconds,
      };
    } finally {
      clearTimeout(timer);
      stopped?.removeEventListener('abort', onStop);
      release();
    }
  }

  return {
    [name]: {
      signature: `await ${name}(brief)`,
      description:
        `starts a worker agent in ${options.cwd} that can act there (${allow.join(', ')}), which your code cannot. It knows ` +
        'only your brief: say what to do, which files, and what done looks like. Returns { ok, report, stop?, turns?, usd? } ' +
        `when it ends: up to ${timeoutSeconds} s, ${maxTurns} turns, $${maxUsd}. ${parallel === 1 ? 'Workers run one at a time' : `${parallel} workers run at once`}. ` +
        'When ok is false it was stopped (`stop` says why) and whatever it changed is still in the folder.',
      fn: work,
      seconds: timeoutSeconds,
    },
  };
}
