// Logging: every event names the RLM it came from (`rlm`), its parent and its depth, so a nested run's events form a
// tree. A logger is any function that takes an event; compose them with `teeLog`.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CallRecord } from './observe.ts';

/** The version of the event shapes. Adding a field is a minor release; renaming or removing one bumps this and is major. */
export const EVENT_SCHEMA_VERSION = 1;

export type RlmEvent =
  | { kind: 'rlm_start'; task: string; substrates: string[]; tools: string[] }
  | { kind: 'root_request'; turn: number; promptChars: number }
  | { kind: 'root_reply'; turn: number; note: string; code: string; usage?: unknown; usd?: number; seconds: number }
  | { kind: 'step_output'; turn: number; output: string; error?: string; seconds: number }
  | { kind: 'tool_call'; tool: string; args: unknown; result?: unknown; error?: string; seconds: number }
  | { kind: 'sub_call'; call: number; promptChars: number; reply: string; usd?: number; seconds: number; error?: string }
  | { kind: 'nested_rlm'; child: string; question: string }
  | { kind: 'submit'; outputs: Record<string, string> }
  | { kind: 'stop'; code: string; detail: string }
  | { kind: 'rlm_end'; status: string; usd: number }
  | ({ kind: 'model_call' } & CallRecord)
  | { kind: 'handler_error'; eventKind: string; error: string }
  | { kind: 'advice'; strategy: string; reason: string; profile: unknown; answers: unknown; costUsd: number; judge: string; seconds: number };

/** An event as logged: the event plus where it sits in the call tree and when. */
export type LoggedEvent = RlmEvent & { schema: typeof EVENT_SCHEMA_VERSION; rlm: string; parent?: string; depth: number; time: string };

export type Logger = (event: LoggedEvent) => void;
/** A subscriber to the event stream. It may return a promise; the run does not wait for it. */
export type EventHandler = (event: LoggedEvent) => void | Promise<void>;
export type EventKind = RlmEvent['kind'];

/**
 * Delivers each event to every handler, in order, synchronously. A handler that throws (or whose promise rejects) never
 * affects the run or the other handlers: the error is reported to the others as a handler_error event. With strict,
 * a synchronous throw propagates instead, so the run stops (for tests).
 */
export function eventBus(initial: EventHandler[] = [], options: { strict?: boolean } = {}) {
  const handlers = [...initial];
  const report = (failed: EventHandler, event: LoggedEvent, error: unknown) => {
    if (event.kind === 'handler_error') return;
    const notice = { ...event, kind: 'handler_error', eventKind: event.kind, error: String(error) } as unknown as LoggedEvent;
    for (const h of handlers) if (h !== failed) { try { void h(notice); } catch { /* a second failure is dropped */ } }
  };
  const emit = (event: LoggedEvent) => {
    for (const h of [...handlers]) {
      try {
        const result = h(event);
        if (result && typeof (result as Promise<void>).then === 'function') (result as Promise<void>).catch((error) => report(h, event, error));
      } catch (error) {
        if (options.strict) throw error;
        report(h, event, error);
      }
    }
  };
  /** Adds a handler; returns the function that removes it. */
  const add = (handler: EventHandler) => { handlers.push(handler); return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); }; };
  return { emit, add };
}

/** Discards everything. */
export const silentLog: Logger = () => {};

/** Appends each event as one JSON line, the format to analyse afterwards. */
export function jsonlLog(path: string): Logger {
  mkdirSync(dirname(path), { recursive: true });
  return (event) => appendFileSync(path, JSON.stringify(event) + '\n');
}

/** A readable line per event on stderr, indented by depth. Long texts are cut to `width` characters. */
export function consoleLog(width = 160): Logger {
  const cut = (text: string) => (text.length > width ? text.slice(0, width) + '…' : text).replace(/\s+/g, ' ');
  return (e) => {
    const pad = '  '.repeat(e.depth) + `[${e.rlm}] `;
    switch (e.kind) {
      case 'rlm_start': return void process.stderr.write(`${pad}start: ${cut(e.task)}\n`);
      case 'root_reply': return void process.stderr.write(`${pad}turn ${e.turn}: ${cut(e.note)}\n${pad}  code: ${cut(e.code)}\n`);
      case 'step_output': return void process.stderr.write(`${pad}  -> ${cut(e.error ?? e.output)}\n`);
      case 'tool_call': return void process.stderr.write(`${pad}  tool ${e.tool}${e.error ? ' FAILED ' + cut(e.error) : ''}\n`);
      case 'sub_call': return void process.stderr.write(`${pad}  sub-call ${e.call} (${e.promptChars} chars): ${cut(e.error ?? e.reply)}\n`);
      case 'nested_rlm': return void process.stderr.write(`${pad}  nested RLM ${e.child}: ${cut(e.question)}\n`);
      case 'submit': return void process.stderr.write(`${pad}SUBMIT ${cut(JSON.stringify(e.outputs))}\n`);
      case 'stop': return void process.stderr.write(`${pad}STOP ${e.code}: ${cut(e.detail)}\n`);
      case 'model_call': return void process.stderr.write(`${pad}  ${e.role} call ${e.model}${e.error ? ' FAILED ' + cut(e.error) : ''} (${e.seconds.toFixed(1)}s)\n`);
      case 'handler_error': return void process.stderr.write(`${pad}event handler failed on ${e.eventKind}: ${cut(e.error)}\n`);
      case 'advice': return void process.stderr.write(`${pad}ADVICE ${e.strategy}: ${cut(e.reason)}\n`);
      case 'rlm_end': return void process.stderr.write(`${pad}end: ${e.status}, $${e.usd.toFixed(4)}\n`);
      default: return;
    }
  };
}

/** Sends every event to each logger. */
export function teeLog(...loggers: Logger[]): Logger {
  return (event) => { for (const log of loggers) log(event); };
}

/** Collects events in memory (tests, and callers that want the tree afterwards). */
export function memoryLog(): Logger & { events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  const log = ((event: LoggedEvent) => { events.push(event); }) as Logger & { events: LoggedEvent[] };
  log.events = events;
  return log;
}
