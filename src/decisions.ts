// Decision models: one forward pass that answers typed questions (yes/no, choice, score) about a piece of state with
// probabilities, and writes no text. They cost a fraction of a generative call, so "judge every chunk of the input"
// becomes cheap enough to do routinely. This file has the client (OpenRouter's Decisions API), a key reader, and the
// filter_chunks tool that gives an RLM's code a third kind of sub-call next to llm_query and rlm_query.
import { readFileSync } from 'node:fs';
import type { Ledger } from './models/ledger.ts';
import { observedDecide } from './observe.ts';
import type { Tools } from './types.ts';

export type DecisionQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export interface DecisionAnswer {
  type: string;
  /** noul: the probability of "true". */
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface DecisionReply {
  answers: Record<string, DecisionAnswer>;
  costUsd: number;
  model?: string;
  provider?: string;
  inputTokens?: number;
  requestId?: string;
}

/** Anything that answers typed questions about a state: the OpenRouter client, or a scripted fake in tests. */
export interface Judge {
  readonly name: string;
  decide(state: unknown, questions: Record<string, DecisionQuestion>, options?: { signal?: AbortSignal }): Promise<DecisionReply>;
}

/** Dollars per million input tokens, the highest listed provider price (output is free). Worst-case booking only. */
export const DECISION_PRICES: Record<string, number> = {
  'cloudflare/clef': 0.24,
  'cloudflare/clef-flash': 0.09,
  'typesafe/jev-1.14': 0.042,
  'typesafe/jev-1.13': 0.042,
  'perplexity/pplx-decider-v1.2': 0.02,
};

/**
 * Reads the newest dated key `PREFIX` + DDMMYYYY from an env file, e.g. OPENROUTER_API_KEY_13112026.
 * Returns the value and the key's age in days (a dated key pins dated model versions, so an old one wants renewing).
 */
export function datedEnvKey(path: string, prefix: string): { name: string; value: string; ageDays: number } {
  let best: { name: string; value: string; time: number } | undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || !m[1]!.startsWith(prefix)) continue;
    const d = m[1]!.slice(prefix.length).match(/^(\d{2})(\d{2})(\d{4})$/);
    if (!d) continue;
    const time = Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1]));
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (!best || time > best.time) best = { name: m[1]!, value, time };
  }
  if (!best) throw new Error(`no ${prefix}DDMMYYYY key in ${path}`);
  return { name: best.name, value: best.value, ageDays: Math.floor((Date.now() - best.time) / 86_400_000) };
}

export interface OpenRouterDecisionsOptions {
  model: string;
  apiKey: string;
  /** Provider routing, e.g. { only: ['deepinfra', 'prime-intellect'] } for Clef (Workers AI truncates text state). */
  provider?: Record<string, unknown>;
  /** A hard dollar cap shared by every call through it. Omit for no cap (the caller accounts for spend itself). */
  ledger?: Ledger;
  /** The Decisions endpoint. Default: OpenRouter's. */
  endpoint?: string;
  retries?: number;
  sessionId?: string;
}

export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The OpenRouter Decisions API (`POST /api/alpha/decisions`, TypeSafe System One compatible). */
export function openRouterDecisions(options: OpenRouterDecisionsOptions): Judge {
  const price = DECISION_PRICES[options.model];
  if (price === undefined) throw new Error(`no price for ${options.model}; add it to DECISION_PRICES first`);
  return {
    name: `openrouter-decisions:${options.model}${options.provider ? '@' + JSON.stringify(options.provider) : ''}`,
    async decide(state, questions, callOptions) {
      const signal = callOptions?.signal;
      const body = JSON.stringify({ model: options.model, state, questions, provider: options.provider, session_id: options.sessionId });
      // Worst case: about 3 characters per token, doubled for safety.
      const booking = options.ledger?.reserveUsd(options.model, ((body.length / 3) * 2 * price) / 1e6);
      let lastError = '';
      for (let attempt = 0; attempt <= (options.retries ?? 4); attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1));
        if (signal?.aborted) throw new Error('decision call cancelled');
        let response: Response;
        try {
          response = await fetch(options.endpoint ?? OPENROUTER_DECISIONS_ENDPOINT, {
            method: 'POST', body, signal,
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          });
        } catch (error) { lastError = String(error); continue; }
        const raw = await response.text();
        if (response.status === 429 || response.status >= 500) { lastError = `${response.status} ${raw.slice(0, 300)}`; continue; }
        if (!response.ok) {
          if (booking) options.ledger!.settle(booking, 0, { error: response.status });
          throw new Error(`decisions ${response.status}: ${raw.slice(0, 500)}`);
        }
        const json = JSON.parse(raw);
        const costUsd = Number(json.usage?.cost ?? 0);
        if (booking) options.ledger!.settle(booking, costUsd, { model: json.model, provider: json.provider, inputTokens: json.usage?.input_tokens });
        return { answers: json.answers, costUsd, model: json.model, provider: json.provider, inputTokens: json.usage?.input_tokens, requestId: json.id };
      }
      throw new Error(`decisions failed after retries: ${lastError}`);
    },
  };
}

/** Splits text into chunks of about `size` characters, cutting at paragraph breaks where it can. */
export function chunkText(text: string, size = 15_000): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const brk = text.lastIndexOf('\n\n', end);
      if (brk > start + size / 2) end = brk + 2;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Runs one request per chunk (all conditions as yes/no questions together), `concurrency` at a time. */
export async function judgeChunks(judge: Judge, chunks: string[], conditions: Record<string, string>, concurrency = 16) {
  const questions = Object.fromEntries(Object.entries(conditions).map(([name, condition]) =>
    [name, { type: 'noul', instructions: { question: condition, inspect: 'chunk' } } as DecisionQuestion]));
  const scores: Array<{ i: number; p: Record<string, number>; max: number }> = new Array(chunks.length);
  let costUsd = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const reply = await observedDecide(judge, { chunk: chunks[i] }, questions);
      costUsd += reply.costUsd;
      const p = Object.fromEntries(Object.keys(conditions).map((name) => [name, Number(reply.answers[name]?.noul ?? 0)]));
      scores[i] = { i, p, max: Math.max(...Object.values(p)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return { scores, costUsd };
}

/** The decision-model tools an RLM's code can call. */
export function decisionTools(judge: Judge, options: { concurrency?: number; maxChunkChars?: number } = {}): Tools {
  const maxChunk = options.maxChunkChars ?? 40_000;
  return {
    filter_chunks: {
      signature: 'await filter_chunks(chunks, conditions)',
      description:
        'a decision model (not a text model) judges every chunk at once against yes/no conditions. `chunks` is an array of ' +
        `strings (each under ${maxChunk} characters); \`conditions\` maps a short name to one plain yes/no question about ` +
        'the chunk, one property each. Returns { scores: [{ i, p: { name: probability }, max }], costUsd }. Cheap: cents ' +
        'for a whole book. It only says WHICH chunks match; read or llm_query the kept chunks for WHAT they say.',
      fn: async (chunks: unknown, conditions: unknown) => {
        if (!Array.isArray(chunks) || !chunks.every((c) => typeof c === 'string')) throw new Error('filter_chunks: chunks must be an array of strings');
        if (typeof conditions !== 'object' || !conditions || !Object.values(conditions).every((c) => typeof c === 'string')) {
          throw new Error('filter_chunks: conditions must map names to question strings');
        }
        const long = chunks.findIndex((c) => c.length > maxChunk);
        if (long >= 0) throw new Error(`filter_chunks: chunk ${long} is ${chunks[long]!.length} characters, over ${maxChunk}`);
        return judgeChunks(judge, chunks, conditions as Record<string, string>, options.concurrency);
      },
    },
  };
}
