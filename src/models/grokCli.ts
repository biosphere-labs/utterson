// Grok through xAI's `grok` binary in headless mode, ported from Iris's grokCli.ts (tools 'none', blank context):
//   -p <prompt> --cwd <empty dir> -m <model> --reasoning-effort <effort> --output-format streaming-messages-json
//   --permission-mode dontAsk --disable-web-search --no-subagents --tools '' --deny '*' --max-turns 1 -s <uuid>
// streaming-messages-json ends with a `result` row in the Claude stream-json shape.
//
// grok has no structured-output flag that Iris uses, so with a schema the prompt asks for exactly that JSON object and
// the reply is parsed strictly (JSON.parse, no repair); anything else fails the call.
// As in Iris, GROK_HOME must hold no config, instructions, memory, rules, skills, personas or folder trust.
// Not run on this Mac: grok is not installed here. Treat it as untested until a live call passes.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model, ModelReply, ModelRequest } from '../types.ts';

export const GROK_BLANK_FORBIDDEN = ['config.toml', 'AGENTS.md', 'memory', 'rules', 'skills', 'personas', 'trusted_folders.toml'];

export interface GrokCliOptions {
  model: string;
  effort?: string;
  /** Default `grok` on PATH. */
  binary?: string;
  /** The GROK_HOME to use (it holds the login). Default ~/.grok. Must be clean (see GROK_BLANK_FORBIDDEN). */
  grokHome?: string;
  timeoutSeconds?: number;
}

export function grokArgs(prompt: string, cwd: string, model: string, effort: string, sessionId: string): string[] {
  return ['-p', prompt, '--cwd', cwd, '-m', model, '--reasoning-effort', effort, '--output-format', 'streaming-messages-json',
    '--permission-mode', 'dontAsk', '--disable-web-search', '--no-subagents', '--tools', '', '--deny', '*', '--max-turns', '1', '-s', sessionId];
}

export function grokCli(options: GrokCliOptions): Model {
  const grokHome = options.grokHome ?? join(homedir(), '.grok');
  return {
    name: `grok-cli:${options.model}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const dirty = GROK_BLANK_FORBIDDEN.filter((entry) => existsSync(join(grokHome, entry)));
      if (dirty.length) throw new Error(`GROK_HOME ${grokHome} is not blank: it holds ${dirty.join(', ')}`);
      const cwd = mkdtempSync(join(tmpdir(), 'rlm-grok-'));
      const schemaRule = request.schema
        ? `\n\nReply with exactly one JSON object matching this JSON Schema and nothing else, no code fences: ${JSON.stringify(request.schema)}`
        : '';
      const prompt = `${request.system}\n\n${request.prompt}${schemaRule}`;
      const env: Record<string, string> = {};
      for (const name of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'XAI_API_KEY']) if (process.env[name]) env[name] = process.env[name]!;
      env.GROK_HOME = grokHome;
      try {
        const rows = await new Promise<any[]>((resolve, reject) => {
          const child = spawn(options.binary ?? 'grok', grokArgs(prompt, cwd, options.model, options.effort ?? 'medium', randomUUID()), { cwd, env });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('grok timed out')); }, (options.timeoutSeconds ?? 600) * 1000);
          let out = '';
          let err = '';
          child.stdout.on('data', (c) => { out += c; });
          child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timer);
            const parsed = out.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
            if (code !== 0 && !parsed.some((r) => r?.type === 'result')) reject(new Error(`grok exited ${code}: ${err.trim()}`));
            else resolve(parsed.filter(Boolean));
          });
        });
        const result = rows.filter((r) => r.type === 'result').at(-1);
        if (!result) throw new Error('grok returned no result row');
        if (result.is_error || String(result.subtype ?? '').startsWith('error')) throw new Error(`grok result ${result.subtype}: ${String(result.result ?? '').slice(0, 300)}`);
        const text = String(result.result ?? '');
        const reply: ModelReply = {
          text, costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined, costIsNotional: true,
          usage: result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : undefined,
          requestId: result.session_id,
        };
        if (request.schema) reply.json = JSON.parse(text.trim());
        return reply;
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
