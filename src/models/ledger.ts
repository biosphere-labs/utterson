// A hard dollar cap across runs, kept in one append-only JSONL file (ported from the Python rlm-book spend.py).
// Each call books its worst case before it is sent and is settled at the reported price after. An unsettled booking
// (a crash mid-call) stays counted at its worst case, so the ledger can over-count but never under-count.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** US dollars per million tokens, first-party Claude API (cached 2026-11-03). Cache writes are 1.25x input. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.5, output: 2.5, cacheRead: 0.05 }, // the >100K-prompt tier, used throughout
};

export class SpendRefused extends Error {}

function price(model: string) {
  const p = PRICES[model];
  if (!p) throw new SpendRefused(`no price for ${model}; add it to PRICES before spending`);
  return p;
}

export function costUsd(model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
  const p = price(model);
  return ((u.input ?? 0) * p.input + (u.cacheWrite ?? 0) * p.input * 1.25 + (u.cacheRead ?? 0) * p.cacheRead + (u.output ?? 0) * p.output) / 1e6;
}

export class Ledger {
  readonly path: string;
  readonly capUsd: number;

  constructor(path: string, capUsd = 100) {
    this.path = path;
    this.capUsd = capUsd;
    mkdirSync(dirname(path), { recursive: true });
  }

  spent(): number {
    if (!existsSync(this.path)) return 0;
    const booked = new Map<string, number>();
    const settled = new Map<string, number>();
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      (entry.kind === 'reserve' ? booked : settled).set(entry.id, entry.usd);
    }
    let total = 0;
    for (const [id, usd] of booked) total += settled.get(id) ?? usd;
    return total;
  }

  /** Books the worst case or throws SpendRefused. Synchronous, so concurrent calls in one process cannot interleave. */
  reserve(model: string, inputTokens: number, maxOutputTokens: number): string {
    const p = price(model);
    const usd = (inputTokens * p.input * 1.25 + maxOutputTokens * p.output) / 1e6;
    const spent = this.spent();
    if (spent + usd > this.capUsd) throw new SpendRefused(`refused: $${spent.toFixed(4)} spent + $${usd.toFixed(4)} worst case passes the $${this.capUsd} cap`);
    const id = randomUUID();
    appendFileSync(this.path, JSON.stringify({ kind: 'reserve', id, model, usd, time: new Date().toISOString() }) + '\n');
    return id;
  }

  /** Books a worst case already priced in dollars (for APIs priced per call or per input token), or throws SpendRefused. */
  reserveUsd(label: string, usd: number): string {
    const spent = this.spent();
    if (spent + usd > this.capUsd) throw new SpendRefused(`refused: $${spent.toFixed(4)} spent + $${usd.toFixed(4)} worst case passes the $${this.capUsd} cap`);
    const id = randomUUID();
    appendFileSync(this.path, JSON.stringify({ kind: 'reserve', id, model: label, usd, time: new Date().toISOString() }) + '\n');
    return id;
  }

  settle(id: string, usd: number, detail: Record<string, unknown> = {}): void {
    appendFileSync(this.path, JSON.stringify({ kind: 'settle', id, usd, ...detail, time: new Date().toISOString() }) + '\n');
  }
}
