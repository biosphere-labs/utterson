// A model that replies from a script: for tests, and for replaying a recorded trajectory without a model.
import type { Model, ModelReply, ModelRequest } from '../types.ts';

/** Each call takes the next reply. A reply can be an object (returned as structured JSON) or a function of the request. */
export function scripted(replies: Array<unknown | ((request: ModelRequest) => unknown)>, name = 'scripted'): Model & { requests: ModelRequest[] } {
  const queue = [...replies];
  const requests: ModelRequest[] = [];
  return {
    name,
    requests,
    async complete(request: ModelRequest): Promise<ModelReply> {
      requests.push(request);
      if (!queue.length) throw new Error('the script has no more replies');
      const next = queue.shift();
      const value = typeof next === 'function' ? (next as (r: ModelRequest) => unknown)(request) : next;
      if (typeof value === 'string') return { text: value };
      return { text: JSON.stringify(value), json: value, costUsd: 0 };
    },
  };
}
