// Substrates: the values the model's code works on. They live only in the sandbox; the prompt sees a description.
import type { Substrate } from './types.ts';

/** A text the model searches with code, e.g. a book. The prompt shows its length and a short preview. */
export function text(value: string, options: { name?: string; preview?: number; label?: string } = {}): Substrate {
  const name = options.name ?? 'context';
  const preview = options.preview ?? 300;
  return {
    name,
    value,
    describe: () =>
      `\`${name}\`: string, ${value.length.toLocaleString('en-US')} characters${options.label ? ` (${options.label})` : ''}. ` +
      `Starts: ${JSON.stringify(value.slice(0, preview))}${value.length > preview ? '…' : ''}`,
  };
}

/** A small value shown to the model in full, e.g. the question. */
export function value(name: string, content: unknown, label?: string): Substrate {
  return { name, value: content, describe: () => `\`${name}\`${label ? ` (${label})` : ''}: ${JSON.stringify(content)}` };
}
