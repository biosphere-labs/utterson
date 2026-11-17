// One budget shared by an RLM and every sub-call and nested RLM under it. Root turns are counted per RLM (in rlm.ts);
// sub-calls and dollars are counted for the whole tree, because recursion multiplies them.
import type { Limits, ModelReply } from './types.ts';

export class BudgetExhausted extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

export class Budget {
  readonly limits: Limits;
  subCalls = 0;
  usd = 0;
  notionalUsd = 0;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  /** Dollars not yet spent, notional included. */
  get usdLeft(): number {
    return Math.max(0, this.limits.budgetUsd - this.usd - this.notionalUsd);
  }

  get subCallsLeft(): number {
    return Math.max(0, this.limits.subCalls - this.subCalls);
  }

  /** Before a sub-call: refuses when the tree's count or dollars are spent. */
  admitSubCall(promptChars: number): void {
    if (this.subCalls >= this.limits.subCalls) throw new BudgetExhausted('sub_calls_exhausted', `all ${this.limits.subCalls} sub-calls are used`);
    if (promptChars > this.limits.subCallMaxChars) {
      throw new BudgetExhausted('sub_call_too_large', `a sub-call of ${promptChars} characters is over the ${this.limits.subCallMaxChars} limit`);
    }
    this.admitSpend();
    this.subCalls += 1;
  }

  admitSpend(): void {
    if (this.usd + this.notionalUsd >= this.limits.budgetUsd) {
      throw new BudgetExhausted('budget_exhausted', `$${(this.usd + this.notionalUsd).toFixed(4)} spent of $${this.limits.budgetUsd}`);
    }
  }

  /** After any model call: adds what it reported. */
  charge(reply: Pick<ModelReply, 'costUsd' | 'costIsNotional'>): void {
    if (reply.costUsd === undefined) return;
    if (reply.costIsNotional) this.notionalUsd += reply.costUsd;
    else this.usd += reply.costUsd;
  }
}

export const DEFAULT_LIMITS: Limits = {
  rootTurns: 20,
  subCalls: 400,
  depth: 1,
  subCallMaxChars: 200_000,
  concurrency: 8,
  budgetUsd: 5,
  stepSeconds: 60,
  outputChars: 12_000,
};
