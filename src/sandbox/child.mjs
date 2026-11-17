// The sandbox child: runs the model's JavaScript in a node:vm context and talks to the host over the IPC channel.
//
// Plain JavaScript (.mjs) on purpose: under `--permission` this process may read only this one file, and a .mjs file
// needs no package.json lookup to decide its module type.
//
// What the model's code can reach: its variables, `memory`, `print`, `SUBMIT` and the host tools (each an async
// function that sends a message to the host and waits for the reply). Nothing else: no require, no process, no fetch.
// The functions placed in the context belong to this process's realm, so `print.constructor.constructor` reaches this
// realm's Function; `--disallow-code-generation-from-strings` makes that throw instead of compiling code with access
// to `process`. File, child-process and worker access are refused by `--permission`; the host adds the network wall.
import vm from 'node:vm';

const SUBMITTED = Symbol('submitted');
let context;
let outputChars = 12000;
let submitted;
let printed = [];
let nextCall = 0;
const pending = new Map();

function send(message) {
  process.send(message);
}

function show(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 0) ?? String(value);
  } catch {
    return String(value);
  }
}

function makeContext(variables, toolNames) {
  const globals = {
    memory: {},
    print: (...values) => { printed.push(values.map(show).join(' ')); },
    SUBMIT: (outputs) => {
      submitted = outputs;
      throw SUBMITTED; // ends the step at once, like DSPy's SUBMIT
    },
  };
  for (const name of toolNames) {
    globals[name] = (...args) => new Promise((resolve, reject) => {
      const callId = ++nextCall;
      pending.set(callId, { resolve, reject });
      send({ type: 'tool_call', callId, name, args });
    });
  }
  for (const [name, value] of Object.entries(variables)) globals[name] = value;
  return vm.createContext(globals, { codeGeneration: { strings: false, wasm: false } });
}

async function run(id, code, stepMs) {
  printed = [];
  submitted = undefined;
  let error;
  try {
    const promise = vm.runInContext(`(async () => {\n${code}\n})()`, context, { timeout: stepMs, filename: 'step.js' });
    await promise;
  } catch (thrown) {
    if (thrown !== SUBMITTED) error = thrown instanceof Error || (thrown && thrown.stack) ? `${thrown.name}: ${thrown.message}` : show(thrown);
  }
  let output = printed.join('\n');
  let cut = false;
  if (output.length > outputChars) {
    output = output.slice(0, outputChars) + `\n[output cut: ${output.length.toLocaleString('en-US')} characters, ${outputChars.toLocaleString('en-US')} shown]`;
    cut = true;
  }
  send({ type: 'done', id, output, cut, error, submitted: submitted === undefined ? undefined : submitted });
}

process.on('message', (message) => {
  if (message.type === 'init') {
    outputChars = message.outputChars;
    context = makeContext(message.variables, message.tools);
    send({ type: 'ready' });
  } else if (message.type === 'run') {
    run(message.id, message.code, message.stepMs);
  } else if (message.type === 'tool_result') {
    const waiter = pending.get(message.callId);
    pending.delete(message.callId);
    if (waiter) message.ok ? waiter.resolve(message.value) : waiter.reject(new Error(message.error));
  }
});
send({ type: 'started' });
