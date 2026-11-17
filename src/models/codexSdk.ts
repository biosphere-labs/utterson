// Codex through the official Codex SDK, on the ChatGPT login. Settings follow Iris's codexSdk.ts for tools 'none' and
// a blank context (no shell tool, no sub-agents, no image tool, no project docs, no skill instructions, read-only
// sandbox, no network, no web search, never ask for approval). From the Python reference's codex_once.mjs: a
// throwaway CODEX_HOME that holds only a link to the existing login, so no user config, rules, skills or memories
// load, and API-key variables never reach the process.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model, ModelReply, ModelRequest } from '../types.ts';

export interface CodexSdkOptions {
  model: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Where auth.json lives. Default ~/.codex. */
  authHome?: string;
  /** A codex binary to use instead of the SDK's bundled one. */
  codexPath?: string;
  timeoutSeconds?: number;
}

const PASSED_ENV = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

export function codexSdk(options: CodexSdkOptions): Model {
  const auth = join(options.authHome ?? join(homedir(), '.codex'), 'auth.json');
  return {
    name: `codex-sdk:${options.model}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      statSync(auth); // fails loud when there is no login
      const { Codex } = await import('@openai/codex-sdk');
      const home = mkdtempSync(join(tmpdir(), 'rlm-codex-'));
      try {
        symlinkSync(auth, join(home, 'auth.json')); // the login is referenced, never copied
        const work = join(home, 'work');
        mkdirSync(work);
        const env: Record<string, string> = { CODEX_HOME: home };
        for (const name of PASSED_ENV) if (process.env[name]) env[name] = process.env[name]!;
        const codex = new Codex({
          ...(options.codexPath ? { codexPathOverride: options.codexPath } : {}),
          env,
          config: {
            forced_login_method: 'chatgpt', project_doc_max_bytes: 0, skills: { include_instructions: false },
            features: { shell_tool: false, multi_agent: false, multi_agent_v2: false }, agents: { enabled: false },
            tools: { view_image: false }, web_search: 'disabled',
          },
        });
        const thread = codex.startThread({
          model: options.model, modelReasoningEffort: options.effort ?? 'medium', sandboxMode: 'read-only', workingDirectory: work,
          skipGitRepoCheck: true, approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
        });
        const signal = AbortSignal.any([AbortSignal.timeout((options.timeoutSeconds ?? 600) * 1000), ...(request.signal ? [request.signal] : [])]);
        // Codex has no separate system prompt in a thread, so it leads the input.
        const turn = await thread.run(`${request.system}\n\n${request.prompt}`, { ...(request.schema ? { outputSchema: request.schema } : {}), signal });
        const text = turn.finalResponse;
        const reply: ModelReply = {
          text, costIsNotional: true,
          usage: turn.usage ? { inputTokens: turn.usage.input_tokens, outputTokens: turn.usage.output_tokens, cacheReadTokens: turn.usage.cached_input_tokens } : undefined,
        };
        if (request.schema) reply.json = JSON.parse(text);
        return reply;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
