// The root prompt, assembled from replaceable parts. The REPL rules follow DSPy 3.4.1's RLM action instructions
// (dspy/predict/rlm.py ACTION_INSTRUCTIONS_TEMPLATE), adapted from Python to JavaScript.
import type { PromptParts, Substrate, Task, Tools, TrajectoryStep } from './types.ts';

/** Says what the model is and how it works. The default. */
export const INVESTIGATOR_IDENTITY =
  'You investigate inputs that are too large to read at once, by writing JavaScript. The inputs are never in your prompt: ' +
  'they are variables in a REPL that you query with code. You can search and slice them, keep results in variables, and ' +
  'hand passages to sub-models with llm_query. Each turn you write a short note and one step of code; you see what the ' +
  'code prints, then decide the next step.';

/** The Python reference's system prompt, kept for comparison. It contradicts the REPL ("no tools"). */
export const COMPLETION_MODEL_IDENTITY =
  'You are a text completion model. Answer only with the text requested, in exactly the output format the instructions ' +
  'give. You have no tools: never write tool-call markup such as <invoke>, <function_calls> or <parameter>; put code ' +
  'inside the requested field.';

export const JS_REPL_RULES = `You have a JavaScript REPL. Each turn's code runs as the body of an async function, so \`await\` works at the top level.
- Variables declared with let/const/var last one step only. Keep anything you need later on the \`memory\` object (memory.hits = ...).
- print(...values) shows output; nothing else is shown. Output past the step's limit is cut, and the cut is stated.
- SUBMIT({...}) ends the run with the outputs. Call it only after you have seen the output that justifies it.
- Code that throws shows you the error; correct it in the next step.

How to work:
1. EXPLORE FIRST: look at the data before processing it (lengths, samples, structure).
2. ITERATE: small steps, read the output, decide the next step.
3. VERIFY BEFORE SUBMITTING: if results look wrong (empty, zero, unexpected), reconsider.
4. USE llm_query FOR MEANING: string matching finds WHERE things are; llm_query understands WHAT they mean.
5. DON'T RETYPE: re-access long or exact values (ids, numbers, quotes) through variables instead of copying them.`;

/** Generic rulebook conditions. Measured on the policy test: they match most chunks of a textbook (no discrimination),
 * so the rulebook method has the model write narrow conditions from the task instead. Kept for comparison. */
export const RULEBOOK_CONDITIONS: Record<string, string> = {
  rule: 'Does the chunk state a rule, requirement or permission saying what may or may not be done?',
  definition: 'Does the chunk define a category, saying what counts as belonging to it?',
  exception: 'Does the chunk state an exception, an override, or an amendment to a rule?',
  dates: 'Does the chunk state a specific date, day of the month, or date range during which something applies?',
  entity: 'Does the chunk state a fact about a specific named person, such as their team, role or status, and when it holds?',
};

/** Suggested methods. Pass one as `strategy`, or your own text, or '' for none. */
export const STRATEGIES = {
  none: '',
  searchFirst:
    'Suggested method: search first. Find the passages that mention the names or terms in the question with code, read ' +
    'around them, then follow any new names those passages introduce.',
  mapReduce:
    'Suggested method: map-reduce. Split the input into chunks of about 50,000 characters, ask llm_query_batched the ' +
    'question about every chunk, then combine and check the answers with code.',
  indexFirst:
    'Suggested method: index first. Build a map of the input (headings, sections, key terms with their positions) and keep ' +
    'it in memory, then read only the sections the map points to.',
  hypothesis:
    'Suggested method: hypothesis and refutation. Form a candidate answer early, then search specifically for evidence ' +
    'that would contradict it before submitting.',
  rulebook:
    'Suggested method: rulebook. The answer comes from applying rules stated in the text to facts stated in the text. ' +
    'Rules can sit anywhere and share no words with the question, so searching for words alone will miss some. Survey:\n' +
    '1. Split the text into chunks of about 4,000 characters at paragraph breaks; keep them on memory.\n' +
    '2. Write 4 to 8 yes/no conditions from the task and the cases, ONE property each and narrow, that tell the passages ' +
    'the task is about from the ordinary subject matter of the text (e.g. "Does the chunk state calendar dates on which ' +
    'something at a workplace is restricted?"). Generic conditions such as "states a rule" match most of any book.\n' +
    '3. Call filter_chunks(memory.chunks, conditions) and keep every chunk whose max is at least 0.3. Add every chunk that ' +
    'contains a name or key term from the cases (plain search). Print how many you kept.\n' +
    '4. With llm_query_batched, ask for every rule, definition, exception, amendment, date or date range, and fact about a ' +
    'named person or item in each kept chunk, quoted word for word. Ignore the ordinary subject matter of the text.\n' +
    '5. Consolidate the quotes into a list of clauses and a table of facts. Note anything missing or contradictory.\n' +
    '6. Write the clauses as a JavaScript function and decide every case with it, so no clause is forgotten.\n' +
    '7. Check each decision against the quotes before you SUBMIT.',
  rulebookPrepared:
    'Suggested method: rulebook, with the survey already done. The answer comes from applying rules stated in the text to ' +
    'facts stated in the text. `survey` holds the chunks a decision model flagged as likely to state them (and chunks with ' +
    'rare names from the inputs); most of the rest of the text is ordinary subject matter.\n' +
    '1. With llm_query_batched, ask for every rule, definition, exception, amendment, date or date range, and fact about a ' +
    'named person or item in each survey chunk, quoted word for word. Ignore the ordinary subject matter.\n' +
    '2. Consolidate the quotes into a list of clauses and a table of facts. Note anything missing or contradictory, and ' +
    'search the full text for it.\n' +
    '3. Write the clauses as a JavaScript function and decide every case with it, so no clause is forgotten.\n' +
    '4. Check each decision against the quotes before you SUBMIT.',
  survey:
    'Suggested method: survey. What decides the answer may be stated without the words in the question, so do not rely on ' +
    'searching for words alone. Split the text into chunks of about 15,000 characters, call filter_chunks with yes/no ' +
    'conditions you write from the task (one property each), read or llm_query the chunks that score at least 0.3, then answer.',
} as const;


export const DEFAULT_PROMPT: PromptParts = { identity: INVESTIGATOR_IDENTITY, replRules: JS_REPL_RULES, strategy: STRATEGIES.none };

/** Describes the tools from their own descriptions, so the prompt and the functions cannot drift apart. */
function describeTools(tools: Tools): string {
  return Object.entries(tools).map(([name, tool]) => `- \`${tool.signature || name + '(...)'}\` - ${tool.description}`).join('\n');
}

/** The prompt for one root turn: the parts, the task, the variables, the tools, and every earlier step. */
export function rootPrompt(args: {
  parts: PromptParts; task: Task; substrates: Substrate[]; tools: Tools; history: TrajectoryStep[];
  limits: { rootTurns: number; subCallsLeft: number; turn: number };
}): { system: string; prompt: string } {
  const { parts, task, substrates, tools, history, limits } = args;
  const outputs = task.outputs.map((name) => `${name}: string`).join(', ');
  const sections = [
    `TASK\n${task.instructions}`,
    `OUTPUTS\nSUBMIT({ ${outputs} })`,
    `VARIABLES\n${substrates.map((s) => '- ' + s.describe()).join('\n')}`,
    `FUNCTIONS\n${describeTools(tools)}\n- \`print(...values)\`\n- \`SUBMIT({ ${outputs} })\``,
    parts.strategy ? `METHOD\n${parts.strategy}` : '',
    `BUDGET\nTurn ${limits.turn} of ${limits.rootTurns}. Sub-model calls left: ${limits.subCallsLeft}.`,
    history.length
      ? 'HISTORY\n' + history.map((step) =>
          `--- turn ${step.turn}\nnote: ${step.note}\ncode:\n${step.code}\n${step.error ? 'error' : 'output'}:\n${step.error ?? step.output}`).join('\n')
      : 'HISTORY\n(none yet: this is the first turn)',
    'Reply with the JSON object { "note": ..., "code": ... } for the next step.',
  ];
  return { system: `${parts.identity}\n\n${parts.replRules}`, prompt: sections.filter(Boolean).join('\n\n') };
}
