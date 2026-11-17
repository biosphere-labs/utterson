// Antigravity through its Agent Client Protocol server (`agy acp`). Google's own Antigravity SDK is Python only
// (preview); ACP is the programmatic route from TypeScript. ACP is JSON-RPC 2.0, one JSON object per line over the
// child's stdin and stdout, so this file speaks it directly (initialize, session/new, session/set_config_option,
// session/prompt) instead of using the ACP SDK: SDK 0.4.5 has no set_config_option, and agy 1.5.7's
// session/set_model answers every call with "Unknown mode", so the model has to be set as a config option.
//
// One call = one `agy acp` process, one session, one prompt. The client grants nothing: every permission request is
// answered "cancelled", and it advertises no file system and no terminal. Default customizations and telemetry are
// off. Note: agy adds a large system prompt of its own (a one-line prompt reported ~15,000 input tokens).
//
// ACP has no structured-output field, so with a schema the prompt asks for exactly that JSON object and the reply is
// parsed strictly (JSON.parse, no repair); anything else fails the call.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Model, ModelReply, ModelRequest } from '../types.ts';

export interface AntigravityAcpOptions {
  /** A model config value from agy: gemini-4-argon, gemini-4-hydrogen, gemini-3.8-flash, claude-sonnet-5-5, ... */
  model: string;
  /** agy's thought_level: low, medium or high. */
  thinking?: 'low' | 'medium' | 'high';
  binary?: string;
  timeoutSeconds?: number;
}

export function antigravityAcp(options: AntigravityAcpOptions): Model {
  return {
    name: `antigravity-acp:${options.model}${options.thinking ? '-' + options.thinking : ''}`,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const cwd = mkdtempSync(join(tmpdir(), 'rlm-agy-'));
      const child = spawn(options.binary ?? 'agy', ['acp', '--disable-telemetry', '--include-default-customizations=false'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
      const timer = setTimeout(() => child.kill('SIGKILL'), (options.timeoutSeconds ?? 600) * 1000);
      const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
      const chunks: string[] = [];
      let nextId = 0;
      const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve, reject });
        write({ id, method, params });
      });
      child.on('exit', () => { for (const w of waiting.values()) w.reject(new Error(`agy exited${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)); });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== undefined && waiting.has(message.id) && !message.method) {
          const w = waiting.get(message.id)!;
          waiting.delete(message.id);
          message.error ? w.reject(new Error(`${message.error.code}: ${message.error.message}`)) : w.resolve(message.result);
        } else if (message.method === 'session/update') {
          const update = message.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') chunks.push(update.content.text);
        } else if (message.method === 'session/request_permission') {
          write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        } else if (message.id !== undefined && message.method) {
          write({ id: message.id, error: { code: -32601, message: 'this client offers no methods' } });
        }
      });
      try {
        await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        const session = await call('session/new', { cwd, mcpServers: [] });
        await call('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: options.model });
        if (options.thinking) await call('session/set_config_option', { sessionId: session.sessionId, configId: 'thought_level', value: options.thinking });
        const schemaRule = request.schema
          ? `\n\nReply with exactly one JSON object matching this JSON Schema and nothing else, no code fences: ${JSON.stringify(request.schema)}`
          : '';
        const done = await call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: `${request.system}\n\n${request.prompt}${schemaRule}` }] });
        if (done.stopReason !== 'end_turn') throw new Error(`stopped: ${done.stopReason}`);
        const text = chunks.join('');
        const u = done.usage;
        const reply: ModelReply = {
          text, costIsNotional: true,
          usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cachedReadTokens, cacheWriteTokens: u.cachedWriteTokens } : undefined,
        };
        if (request.schema) reply.json = JSON.parse(text.trim());
        return reply;
      } catch (error) {
        throw new Error(`antigravity ACP call failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      } finally {
        clearTimeout(timer);
        child.kill();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
