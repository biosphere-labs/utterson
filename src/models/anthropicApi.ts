// Claude through the Anthropic API with a key, metered against a Ledger. Exact usage, a hard dollar cap, and native
// structured output (output_config.format) when the request has a schema.
import Anthropic from '@anthropic-ai/sdk';
import type { Model, ModelReply, ModelRequest } from '../types.ts';
import { Ledger, costUsd } from './ledger.ts';

export interface AnthropicApiOptions {
  model: string;
  ledger: Ledger;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Default: the SDK reads ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Injected in tests. */
  client?: Pick<Anthropic, 'messages'>;
}

const CHARS_PER_TOKEN_ESTIMATE = 3; // over-estimates the input on purpose; the books measured 2.8-3.0

export function anthropicApi(options: AnthropicApiOptions): Model {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  const maxTokens = options.maxTokens ?? 16000;
  return {
    name: `anthropic-api:${options.model}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const booking = options.ledger.reserve(options.model, Math.ceil((request.system.length + request.prompt.length) / CHARS_PER_TOKEN_ESTIMATE), maxTokens);
      const outputConfig: Record<string, unknown> = {};
      if (options.effort) outputConfig.effort = options.effort;
      if (request.schema) outputConfig.format = { type: 'json_schema', schema: request.schema };
      let message: any;
      try {
        const stream = client.messages.stream({
          model: options.model, max_tokens: maxTokens, system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        } as any, { signal: request.signal });
        message = await stream.finalMessage();
      } catch (error) {
        // A request refused before generation (4xx) costs nothing; anything else keeps its worst-case booking.
        if (error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 400 && error.status < 500) options.ledger.settle(booking, 0, { released: error.status });
        throw error;
      }
      const u = message.usage ?? {};
      const usd = costUsd(options.model, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
      options.ledger.settle(booking, usd, { requestId: message._request_id });
      if (message.stop_reason === 'refusal') throw new Error(`refusal (${message.stop_details?.category ?? 'no category'})`);
      const text = message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const reply: ModelReply = {
        text, costUsd: usd, costIsNotional: false, requestId: message._request_id,
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens },
      };
      if (request.schema) reply.json = JSON.parse(text);
      return reply;
    },
  };
}
