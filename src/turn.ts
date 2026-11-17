// Structured turns, never parsed prose: each root reply is exactly the JSON object { note, code }, produced through
// the model's native structured output. A reply that is not exactly that object stops the run (root_turn_invalid).
// No repair, no fallback. (Design rule 1 of the TypeScript port's journal; the Python reference's 8 crashes in 13
// control runs came from parsing prose.)
import type { JsonSchema } from './types.ts';

export interface RootTurn {
  note: string;
  code: string;
}

export const TURN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'One or two sentences: what you know, what remains, your next action.' },
    code: { type: 'string', description: 'JavaScript to run in the REPL now. Call SUBMIT({...}) in it when done.' },
  },
  required: ['note', 'code'],
  additionalProperties: false,
};

/** The turn, or the reason it is not one. */
export function readTurn(json: unknown): RootTurn | { problem: string } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { problem: 'the reply is not a JSON object' };
  const keys = Object.keys(json).sort().join(',');
  if (keys !== 'code,note') return { problem: `the reply has fields [${keys}], not exactly [code,note]` };
  const { note, code } = json as Record<string, unknown>;
  if (typeof note !== 'string' || typeof code !== 'string') return { problem: 'note and code must both be strings' };
  return { note, code };
}

/** Parses JSON text strictly (for adapters whose structured output arrives as text). Throws on anything else. */
export function strictJson(text: string): unknown {
  return JSON.parse(text.trim());
}
