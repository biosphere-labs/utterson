// Claude through the Claude Agent SDK, on the subscription login (claude.ai). The route the Python reference's
// attempt 16 and its 24/24 runs used.
//
// Kept from the Python provider and Iris's claudeSdk.ts: refuse to start when any ANTHROPIC_* variable or a
// Bedrock/Vertex/Foundry switch is set (any of them moves the CLI off the subscription onto a metered route); one
// turn with no tools, no MCP servers, no setting sources, no persisted session; a throwaway working directory.
// With a schema, the SDK's outputFormat returns a validated object in `structured_output`; that object is the reply,
// never the prose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model, ModelReply, ModelRequest } from '../types.ts';

const METERED_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'AWS_BEARER_TOKEN_BEDROCK'];

export interface ClaudeAgentSdkOptions {
  model: string;
  /** Per call, in seconds. Default 600. */
  timeoutSeconds?: number;
  /** The environment the CLI subprocess gets. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Injected in tests instead of the SDK's query(). */
  query?: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;
}

/** Names that would move the CLI off the subscription. Values are never read out or logged. */
export function meteredEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((name) => env[name] && (name.startsWith('ANTHROPIC_') || METERED_SWITCHES.includes(name))).sort();
}

/** Blanks variables a parent Claude Code session leaks into this process (the subscription token is kept). */
export function withoutParentSession(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const parent = name === 'CLAUDECODE' || (name.startsWith('CLAUDE_CODE_') && name !== 'CLAUDE_CODE_OAUTH_TOKEN') || name === 'CLAUDE_PID' || name === 'CLAUDE_EFFORT';
    out[name] = parent ? '' : value;
  }
  return out;
}

export function claudeAgentSdk(options: ClaudeAgentSdkOptions): Model {
  const env = options.env ?? process.env;
  const metered = meteredEnvNames(env);
  if (metered.length) throw new Error(`unset these before a subscription run: ${metered.join(', ')}`);
  const timeoutMs = (options.timeoutSeconds ?? 600) * 1000;
  const childEnv = withoutParentSession(env);

  return {
    name: `claude-agent-sdk:${options.model}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const query = options.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const cwd = mkdtempSync(join(tmpdir(), 'rlm-claude-'));
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), timeoutMs);
      request.signal?.addEventListener('abort', () => abortController.abort());
      try {
        const sdkOptions: Record<string, unknown> = {
          model: options.model, systemPrompt: request.system, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
          settingSources: [], persistSession: false, permissionMode: 'dontAsk',
          // With an outputFormat the SDK retries a reply that fails schema validation, and the retry needs a turn of its
          // own; with one turn such calls failed ("Reached maximum number of turns (1)"). No tools are allowed, so the
          // extra turns can only be that retry.
          maxTurns: request.schema ? 3 : 1,
          canUseTool: async () => ({ behavior: 'deny', message: 'No tools in an RLM call' }),
          cwd, env: childEnv, abortController,
          ...(request.schema ? { outputFormat: { type: 'json_schema', schema: request.schema } } : {}),
        };
        let texts: string[] = [];
        let result: any;
        for await (const message of query({ prompt: request.prompt, options: sdkOptions as any })) {
          if (message.type === 'assistant') {
            for (const block of message.message?.content ?? []) if (block.type === 'text') texts.push(block.text);
          } else if (message.type === 'result') {
            result = message;
          }
        }
        if (!result) throw new Error('the Agent SDK returned no result');
        if (result.subtype !== 'success' || result.is_error) throw new Error(`Agent SDK result ${result.subtype}: ${String(result.result ?? '').slice(0, 300)}`);
        const usage = {
          inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
          cacheReadTokens: result.usage?.cache_read_input_tokens, cacheWriteTokens: result.usage?.cache_creation_input_tokens,
        };
        const common = { usage, costUsd: result.total_cost_usd, costIsNotional: true, requestId: result.session_id };
        if (request.schema) {
          if (result.structured_output === undefined || result.structured_output === null) throw new Error(`no structured output (${result.subtype})`);
          return { text: JSON.stringify(result.structured_output), json: result.structured_output, ...common };
        }
        const text = texts.join('') || String(result.result ?? '');
        if (!text.trim()) throw new Error('empty reply');
        return { text, ...common };
      } finally {
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
