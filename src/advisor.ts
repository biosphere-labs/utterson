// The advisor: before the first root turn, a decision model profiles the problem and code picks the strategy.
//
// The profile is about how the answer is assembled (its combine shape), whether the question names what the answer
// depends on, and how much of the input matters. These decide the method the way the shape of a recursion decides an
// algorithm: one passage wants a search, rules applied to facts want a survey that reads everything relevant, a total
// over many places wants map-reduce. The questions only describe the problem; the mapping to a strategy is a plain
// function in code, so a wrong mapping is fixed in one place without touching the questions.
import { chunkText, decisionTools, judgeChunks, type DecisionQuestion, type DecisionReply, type Judge } from './decisions.ts';
import { observedComplete, observedDecide } from './observe.ts';
import { STRATEGIES } from './prompt.ts';
import type { Limits, Model, PromptParts, Substrate, Task, Tools } from './types.ts';

/** What a prepare step reports: what it added and what it cost. */
export interface Prepared {
  substrates: Substrate[];
  summary: Record<string, unknown>;
  decisionUsd: number;
  modelUsd: number;
}

/** What a strategy changes in the RLM: its suggested method, extra tools, limits, and optionally work done up front. */
export interface StrategyParts {
  prompt?: Partial<PromptParts>;
  tools?: Tools;
  limits?: Partial<Limits>;
  /**
   * Runs before the first root turn and adds substrates. For steps the method needs done, not just suggested: advice in
   * the prompt alone was ignored (the root searched by keyword and never called the filter).
   */
  prepare?: (args: { task: Task; substrates: Substrate[]; model: Model }) => Promise<Prepared>;
}

export interface Advice {
  strategy: string;
  /** Why, in a line: which answers led there. */
  reason: string;
  profile: { combine: string; combineConfidence: number; namesHandles: number; unnamedDependencies: number; scope: number };
  answers: DecisionReply['answers'];
  costUsd: number;
  judge: string;
  /** Filled in when the strategy has a prepare step. */
  prepared?: Omit<Prepared, 'substrates'>;
}

/** Profiles a problem and returns the strategy's parts. */
export type Advisor = (task: Task, substrates: Substrate[]) => Promise<{ advice: Advice; parts: StrategyParts }>;

export const COMBINE_SHAPES = {
  one_passage: {
    what: 'The answer is stated in one place, or found by following a short chain of named facts from one to the next.',
    examples: ['What was the scheduler originally called?', 'Which component replaced the one named X?'],
  },
  total: {
    what: 'The answer is a count, total, list or digest of many separate places in the text.',
    examples: ['How many chapters mention deadlock?', 'List every function that writes to the log.'],
  },
  pairs: {
    what: 'The answer compares or matches items found in different places of the text with each other.',
    examples: ['Which pairs of users share a city?', 'Which two sections contradict each other?'],
  },
  rules_to_facts: {
    what: 'The text states rules, conditions or exceptions, and the answer is a decision reached by applying them to stated facts about cases.',
    examples: ['Is this request allowed under the policy?', 'Which applicants qualify for the grant?'],
  },
  whole_text: {
    what: 'The answer is a judgment about the text as a whole, such as its argument, tone or structure.',
    examples: ['What is the main argument of the book?', 'How is the report organised?'],
  },
  other: { what: 'None of the other descriptions fits.' },
};

export const ADVISOR_QUESTIONS: Record<string, DecisionQuestion> = {
  combine: {
    type: 'choice',
    instructions: {
      question: 'How is the answer to `task` put together from the source text?',
      inspect: 'task',
      focus: 'Judge what the task asks for and how its answer is reached, not the subject of the text. `samples` are short extracts of the source text.',
    },
    criteria: COMBINE_SHAPES,
  },
  names_handles: {
    type: 'noul',
    instructions: { question: 'Does `task` name the specific people, terms or items whose facts the answer depends on?', inspect: 'task' },
  },
  unnamed_dependencies: {
    type: 'noul',
    instructions: {
      question: 'Could the answer to `task` depend on statements in the source text that use none of the words in `task`?',
      inspect: 'task',
      focus: 'For example a general rule, a definition or an exception that applies to the case without mentioning it.',
    },
  },
  scope: {
    type: 'score',
    instructions: { question: 'How much of the source text does the answer to `task` depend on?', inspect: 'task' },
    criteria: [
      'One sentence or one short passage settles it',
      'A few statements in different places settle it',
      'Statements spread through many sections are needed',
      'Nearly the whole text is needed',
    ],
  },
};

/** The default mapping from profile to strategy name. A plain function: replace it to change the policy. The
 * thresholds were set on two tests (chain: one passage, unnamed 0.44-0.67; policy: rules, unnamed 0.86-0.99). */
export function chooseStrategy(p: Advice['profile'], floor = 0.5, unnamedCut = 0.75): { strategy: string; reason: string } {
  if (p.combineConfidence < floor) return { strategy: 'survey', reason: `combine shape unsure (${p.combine} at ${p.combineConfidence.toFixed(2)}), so the thorough method` };
  switch (p.combine) {
    case 'rules_to_facts': return { strategy: 'rulebook', reason: 'rules applied to facts: rules can be anywhere and unnamed, so filter, extract, compile' };
    case 'one_passage':
      return p.unnamedDependencies >= unnamedCut
        ? { strategy: 'survey', reason: `one passage, but it may not use the task's words (${p.unnamedDependencies.toFixed(2)})` }
        : { strategy: 'searchFirst', reason: 'one passage reached through named handles: search' };
    case 'total': case 'pairs': case 'whole_text': return { strategy: 'mapReduce', reason: `${p.combine}: every part of the text contributes` };
    default: return { strategy: 'survey', reason: 'no shape fits, so the thorough method' };
  }
}

/** Short evenly spaced extracts of a long text, so the judge sees what kind of text it is without reading it all. */
function samplesOf(text: string, count: number, chars: number): string[] {
  if (text.length <= count * chars) return [text];
  return Array.from({ length: count }, (_, i) => {
    const at = Math.floor(((i + 0.5) / count) * (text.length - chars));
    return text.slice(at, at + chars);
  });
}

export interface DecisionAdvisorOptions {
  /** Strategy name -> parts. Defaults to the built-in methods, each with the decision-model tools available. */
  strategies?: Record<string, StrategyParts>;
  choose?: (profile: Advice['profile']) => { strategy: string; reason: string };
  samples?: number;
  sampleChars?: number;
}

export function defaultStrategies(judge: Judge): Record<string, StrategyParts> {
  const tools = decisionTools(judge);
  return {
    searchFirst: { prompt: { strategy: STRATEGIES.searchFirst }, tools },
    mapReduce: { prompt: { strategy: STRATEGIES.mapReduce }, tools },
    survey: { prompt: { strategy: STRATEGIES.survey }, tools, limits: { stepSeconds: 180 } },
    rulebook: { prompt: { strategy: STRATEGIES.rulebook }, tools, limits: { stepSeconds: 180 } },
  };
}

/** An advisor that asks a decision model the profile questions in one request. */
export function decisionAdvisor(judge: Judge, options: DecisionAdvisorOptions = {}): Advisor {
  const strategies = options.strategies ?? defaultStrategies(judge);
  const choose = options.choose ?? ((p) => chooseStrategy(p));
  return async (task, substrates) => {
    const inputs: Record<string, string> = {};
    let longest = '';
    for (const s of substrates) {
      if (typeof s.value !== 'string') continue;
      if (s.value.length <= 20_000) inputs[s.name] = s.value;
      if (s.value.length > longest.length) longest = s.value;
    }
    const state = {
      task: { instructions: task.instructions, ...inputs },
      samples: longest.length > 20_000 ? samplesOf(longest, options.samples ?? 6, options.sampleChars ?? 1200) : [],
    };
    const reply = await observedDecide(judge, state, ADVISOR_QUESTIONS);
    const a = reply.answers;
    const scopeLevels = (ADVISOR_QUESTIONS.scope as { criteria: unknown[] }).criteria.length - 1;
    const profile = {
      combine: a.combine?.choice ?? 'other',
      combineConfidence: a.combine?.confidence ?? 0,
      namesHandles: a.names_handles?.noul ?? 0,
      unnamedDependencies: a.unnamed_dependencies?.noul ?? 0,
      scope: (a.scope?.score ?? 0) / scopeLevels,
    };
    const { strategy, reason } = choose(profile);
    const parts = strategies[strategy];
    if (!parts) throw new Error(`advisor chose "${strategy}", which is not among the strategies (${Object.keys(strategies).join(', ')})`);
    return { advice: { strategy, reason, profile, answers: a, costUsd: reply.costUsd, judge: judge.name }, parts };
  };
}

// ---- the survey, done by the harness

const CONDITIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['conditions'],
  properties: {
    conditions: {
      type: 'array', minItems: 3, maxItems: 8,
      items: { type: 'object', additionalProperties: false, required: ['name', 'question'], properties: { name: { type: 'string' }, question: { type: 'string' } } },
    },
  },
};

const CONDITIONS_PROMPT = (task: string, inputs: string, sample: string) => `A long text must be surveyed for the passages a task depends on.
A decision model will read every chunk of about 4,000 characters and answer yes/no questions about it. Write 4 to 8 such
questions. Each asks ONE narrow property of "the chunk", phrased so it is true of the passages the task is about and false
of the ordinary subject matter of the text (judge that from the sample). Generic questions such as "does the chunk state a
rule" match most of any book; do not write them. Cover every kind of statement the task could depend on, including ones
that would not use the task's words: definitions, rules, exceptions, dates, and facts about named people or items.

TASK
${task}

INPUTS
${inputs}

SAMPLE OF THE TEXT
${sample}`;

const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|scenario|the)$/i;

/**
 * The rulebook survey as a prepare step: the model writes narrow conditions, the decision model judges every chunk,
 * and the chunks that pass (or that contain a rare name from the inputs) become the `survey` substrate.
 */
export function surveyPrepare(judge: Judge, options: { chunkChars?: number; threshold?: number; maxNameHits?: number } = {}) {
  const chunkChars = options.chunkChars ?? 4000;
  const threshold = options.threshold ?? 0.3;
  return async ({ task, substrates, model }: { task: Task; substrates: Substrate[]; model: Model }): Promise<Prepared> => {
    const strings = substrates.filter((s) => typeof s.value === 'string') as Array<Substrate & { value: string }>;
    const big = strings.reduce((a, b) => (b.value.length > a.value.length ? b : a));
    const small = strings.filter((s) => s !== big && s.value.length <= 20_000);
    const inputs = small.map((s) => `${s.name}:\n${s.value}`).join('\n\n');
    const sample = big.value.slice(Math.floor(big.value.length / 3), Math.floor(big.value.length / 3) + 3000);
    const reply = await observedComplete('prepare', model, { system: 'Reply with the JSON object requested.', prompt: CONDITIONS_PROMPT(task.instructions, inputs, sample), schema: CONDITIONS_SCHEMA });
    const written = (reply.json as { conditions: Array<{ name: string; question: string }> }).conditions;
    const conditions = Object.fromEntries(written.map((c, i) => [c.name.replace(/\W+/g, '_') || `c${i}`, c.question]));

    const chunks = chunkText(big.value, chunkChars);
    const { scores, costUsd } = await judgeChunks(judge, chunks, conditions);
    // Rare names from the inputs: capitalised words that occur in few chunks (a plain search the filter backs up).
    const names = [...new Set(inputs.match(/\b[A-Z][a-z]{3,}\b/g) ?? [])].filter((w) => !MONTHS.test(w));
    const nameChunks = new Map<number, string[]>();
    for (const name of names) {
      const hits = chunks.flatMap((c, i) => (c.includes(name) ? [i] : []));
      if (hits.length > (options.maxNameHits ?? 20)) continue;
      for (const i of hits) nameChunks.set(i, [...(nameChunks.get(i) ?? []), name]);
    }
    const kept = scores.filter((s) => s.max >= threshold || nameChunks.has(s.i)).map((s) => {
      const best = Object.entries(s.p).sort((a, b) => b[1] - a[1])[0]!;
      return { chunk: s.i, p: Number(s.max.toFixed(3)), why: s.max >= threshold ? best[0] : 'name', names: nameChunks.get(s.i) ?? [], text: chunks[s.i]! };
    });
    const survey: Substrate = {
      name: 'survey', value: kept,
      describe: () => `\`survey\`: ${kept.length} of the ${chunks.length} chunks of \`${big.name}\` (about ${chunkChars} characters each), ` +
        `the ones a decision model judged likely to hold what the task depends on, or that contain a rare name from the inputs. ` +
        `An array of { chunk, p, why, names, text }. The conditions used: ${JSON.stringify(conditions)}`,
    };
    return {
      substrates: [survey],
      summary: { conditions, chunks: chunks.length, kept: kept.length, byFilter: kept.filter((k) => k.why !== 'name').length, names },
      decisionUsd: costUsd, modelUsd: reply.costUsd ?? 0,
    };
  };
}

/** The default strategies, with the rulebook survey done by the harness rather than suggested. */
export function preparedStrategies(judge: Judge): Record<string, StrategyParts> {
  const base = defaultStrategies(judge);
  return { ...base, rulebook: { ...base.rulebook, prompt: { strategy: STRATEGIES.rulebookPrepared }, prepare: surveyPrepare(judge) } };
}
