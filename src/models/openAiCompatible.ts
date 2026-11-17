// Any provider with an OpenAI-compatible chat completions API: DeepInfra, OpenRouter, Together, Groq, Fireworks, or
// your own base URL. With a schema, the request asks for a JSON object (response_format json_object) and states the
// schema in the system prompt; the reply is parsed strictly, never repaired. A reply that is not one JSON object comes
// back as text only, so the RLM loop stops it as an invalid turn.
import type { Model, ModelReply, ModelRequest } from '../types.ts';
import { CATALOG_PROVIDERS } from './providers.generated.ts';

/** Hand-added base URLs for big providers the catalog lists without one. They win over the catalog; your overrides win over both. */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, string> = {
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
};

/**
 * The base URL for a provider prefix: your overrides first, then the hand-added presets above, then the bundled
 * models.dev catalog (about 200 OpenAI-compatible providers). Undefined when none knows it.
 */
export function resolveBaseUrl(provider: string, overrides: Record<string, string> = {}): string | undefined {
  return overrides[provider] ?? OPENAI_COMPATIBLE_PRESETS[provider] ?? CATALOG_PROVIDERS[provider]?.baseUrl;
}

export interface OpenAiCompatibleOptions {
  model: string;
  apiKey: string;
  /** e.g. OPENAI_COMPATIBLE_PRESETS.deepinfra */
  baseUrl: string;
  /** Used in the model's name for logs, e.g. "deepinfra". */
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  timeoutSeconds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openAiCompatible(options: OpenAiCompatibleOptions): Model {
  if (!options.apiKey) throw new Error(`${options.provider ?? options.baseUrl}: an API key is required`);
  const url = options.baseUrl.replace(/\/$/, '') + '/chat/completions';
  return {
    name: `${options.provider ?? 'openai-compatible'}:${options.model}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const system = request.schema
        ? `${request.system}\n\nReply with one JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(request.schema)}`
        : request.system;
      const body = JSON.stringify({
        model: options.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: request.prompt }],
        max_tokens: options.maxTokens ?? 16384,
        temperature: options.temperature ?? 0,
        ...(request.schema ? { response_format: { type: 'json_object' } } : {}),
        usage: { include: true }, // OpenRouter reports cost only when asked; others ignore the field
      });
      let lastError = '';
      for (let attempt = 0; attempt <= (options.retries ?? 4); attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1));
        const abort = AbortSignal.any([AbortSignal.timeout((options.timeoutSeconds ?? 300) * 1000), ...(request.signal ? [request.signal] : [])]);
        let response: Response;
        try {
          response = await fetch(url, { method: 'POST', body, signal: abort, headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' } });
        } catch (error) { lastError = String(error); if (request.signal?.aborted) break; continue; }
        const raw = await response.text();
        if (response.status === 429 || response.status >= 500) { lastError = `${response.status} ${raw.slice(0, 300)}`; continue; }
        if (!response.ok) throw new Error(`${url} ${response.status}: ${raw.slice(0, 500)}`);
        const json = JSON.parse(raw);
        const text = String(json.choices?.[0]?.message?.content ?? '');
        if (!text.trim()) throw new Error(`empty reply from ${options.model} (finish: ${json.choices?.[0]?.finish_reason})`);
        const u = json.usage ?? {};
        const reply: ModelReply = {
          text, requestId: json.id,
          usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cacheReadTokens: u.prompt_tokens_details?.cached_tokens },
          // DeepInfra reports estimated_cost; OpenRouter reports cost. Absent means the provider did not say.
          costUsd: u.estimated_cost ?? u.cost,
        };
        if (request.schema) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reply.json = parsed;
          } catch { /* not one JSON object: returned as text, never repaired */ }
        }
        return reply;
      }
      throw new Error(`${url} failed after retries: ${lastError}`);
    },
  };
}
