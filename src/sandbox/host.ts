// The sandbox host: starts the child process with its walls, sends it code, answers its tool calls.
//
// Walls, from the outside in:
//   1. The network: on macOS the child runs under `sandbox-exec` with a profile that denies all network access.
//      Elsewhere pass `launchPrefix` (on Linux, for example, ['srt', '--settings', profile, '--']). Without either,
//      `walls()` says so; the remaining walls still stand.
//   2. Node's permission model (`--permission`): the child may read only its own script; no writes, no child
//      processes, no worker threads, no native addons.
//   3. `--disallow-code-generation-from-strings`: eval and new Function throw in the child's own realm, which closes
//      the usual node:vm escape (reaching the outer Function through a host object's constructor).
//   4. A node:vm context holding only the variables, memory, print, SUBMIT and the tools.
// A step that runs past its time limit kills the child; the next step gets a fresh one, with memory cleared. Tool calls
// still running for a killed child are told to stop through their handler's signal.
//
// What a step shows the root model is bounded here as well as in the child. The child cuts what the code printed; the
// host cuts the error text, because an error can carry as much as a print can (`throw new Error(context)`, or a tool's
// failure message) and it is shown in the prompt of every later turn.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./child.mjs', import.meta.url));
const MAC_SANDBOX = '/usr/bin/sandbox-exec';
const MAC_DENY_NETWORK = '(version 1) (allow default) (deny network*)';

/** `stopped` is aborted when the child the call came from is killed: nothing can receive the result after that. */
export type ToolHandler = (args: unknown[], stopped?: AbortSignal) => Promise<unknown>;

/** An error's text at most `limit` characters long, with the cut stated the way the child states an output cut. */
function cutError(error: string | undefined, limit: number): string | undefined {
  if (error === undefined || error.length <= limit) return error;
  return error.slice(0, limit) + `\n[error cut: ${error.length.toLocaleString('en-US')} characters, ${limit.toLocaleString('en-US')} shown]`;
}

export interface SandboxOptions {
  /** A command the child is started under, for a network wall where sandbox-exec is unavailable. */
  launchPrefix?: string[];
  /** Run without any network wall (tests only). Default false. */
  allowNetwork?: boolean;
}

export interface StepResult {
  output: string;
  error?: string;
  /** The object passed to SUBMIT, if the step called it. */
  submitted?: Record<string, unknown>;
  /** The step was killed for running past its limit; memory was cleared. */
  restarted?: boolean;
  /** The step was stopped because the run was cancelled. The sandbox is closed. */
  cancelled?: boolean;
}

export class Sandbox {
  #child?: ChildProcess;
  #variables: Record<string, unknown>;
  #tools: Record<string, ToolHandler>;
  #outputChars: number;
  #options: SandboxOptions;
  #steps = 0;
  #waiting?: (message: any) => void;
  /** Aborted when the current child is killed. One per child. */
  #stopped = new AbortController();

  private constructor(variables: Record<string, unknown>, tools: Record<string, ToolHandler>, outputChars: number, options: SandboxOptions) {
    this.#variables = variables;
    this.#tools = tools;
    this.#outputChars = outputChars;
    this.#options = options;
  }

  /** Starts a sandbox holding these variables, with these host functions callable from its code. */
  static async start(variables: Record<string, unknown>, tools: Record<string, ToolHandler>, outputChars: number,
                     options: SandboxOptions = {}): Promise<Sandbox> {
    const sandbox = new Sandbox(variables, tools, outputChars, options);
    await sandbox.#spawn();
    return sandbox;
  }

  /** Which walls stand around the child, for logs and results. */
  walls(): string[] {
    const walls = ['node --permission (own script read only)', 'no code generation from strings', 'node:vm context'];
    if (this.#options.launchPrefix?.length) walls.unshift(`launch prefix: ${this.#options.launchPrefix[0]}`);
    else if (!this.#options.allowNetwork && process.platform === 'darwin' && existsSync(MAC_SANDBOX)) walls.unshift('sandbox-exec: network denied');
    else walls.unshift('NO NETWORK WALL');
    return walls;
  }

  #command(): { command: string; args: string[] } {
    const node = [process.execPath, '--permission', `--allow-fs-read=${CHILD}`, '--disallow-code-generation-from-strings', CHILD];
    const prefix = this.#options.launchPrefix;
    if (prefix?.length) return { command: prefix[0]!, args: [...prefix.slice(1), ...node] };
    if (!this.#options.allowNetwork && process.platform === 'darwin' && existsSync(MAC_SANDBOX)) {
      return { command: MAC_SANDBOX, args: ['-p', MAC_DENY_NETWORK, ...node] };
    }
    return { command: node[0]!, args: node.slice(1) };
  }

  async #spawn(): Promise<void> {
    const { command, args } = this.#command();
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
    this.#child = child;
    this.#stopped = new AbortController();
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('message', (message: any) => this.#onMessage(message));
    const ready = new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error(`sandbox child exited before it was ready: ${stderr.trim() || 'no output'}`));
      child.once('exit', fail);
      this.#waiting = (message) => {
        if (message.type === 'started') child.send({ type: 'init', variables: this.#variables, tools: Object.keys(this.#tools), outputChars: this.#outputChars });
        if (message.type === 'ready') { child.off('exit', fail); this.#waiting = undefined; resolve(); }
      };
    });
    await ready;
  }

  #onMessage(message: any): void {
    if (message?.type === 'tool_call') {
      const handler = this.#tools[message.name];
      const reply = (ok: boolean, value: unknown) => this.#child?.connected &&
        this.#child.send(ok ? { type: 'tool_result', callId: message.callId, ok, value } : { type: 'tool_result', callId: message.callId, ok, error: String(value) });
      if (!handler) return void reply(false, `no tool named ${message.name}`);
      handler(message.args, this.#stopped.signal).then((value) => reply(true, value ?? null), (error) => reply(false, error instanceof Error ? error.message : error));
      return;
    }
    this.#waiting?.(message);
  }

  /** Runs one step of code. Resolves with its printed output, its error, or what it SUBMITted. */
  async run(code: string, stepSeconds: number, signal?: AbortSignal): Promise<StepResult> {
    if (signal?.aborted) { this.#kill(); return { output: '', error: 'cancelled', cancelled: true }; }
    const id = ++this.#steps;
    const child = this.#child!;
    let onAbort: (() => void) | undefined;
    const result = await new Promise<StepResult | 'timeout' | 'exit' | 'aborted'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), stepSeconds * 1000 + 2000);
      onAbort = () => { clearTimeout(timer); resolve('aborted'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const exited = () => { clearTimeout(timer); resolve('exit'); };
      child.once('exit', exited);
      this.#waiting = (message) => {
        if (message.type !== 'done' || message.id !== id) return;
        clearTimeout(timer);
        child.off('exit', exited);
        this.#waiting = undefined;
        resolve({ output: message.output, error: cutError(message.error, this.#outputChars), submitted: message.submitted });
      };
      child.send({ type: 'run', id, code, stepMs: stepSeconds * 1000 });
    });
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (result === 'aborted') { this.#kill(); return { output: '', error: 'cancelled', cancelled: true }; }
    if (result === 'timeout' || result === 'exit') {
      this.#kill();
      await this.#spawn();
      const why = result === 'timeout' ? `the step ran past ${stepSeconds} s and was stopped` : 'the sandbox process died';
      return { output: '', error: `${why}; the sandbox restarted, so memory was cleared`, restarted: true };
    }
    return result;
  }

  #kill(): void {
    this.#waiting = undefined;
    this.#stopped.abort();
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGKILL');
    this.#child = undefined;
  }

  close(): void {
    this.#kill();
  }
}
