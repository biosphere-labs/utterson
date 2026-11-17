// @biosphere-labs/utterson-agent: a recursive language model harness. Compose the parts and run:
//
//   const rlm = createRlm({ model: claudeAgentSdk({ model: 'claude-sonnet-5-5' }), task, tools, limits, log });
//   const result = await rlm.run([text(book), value('question', question)]);
export { createRlm, DEFAULT_SUB_SYSTEM, type RlmConfig } from './rlm.ts';
export { Budget, BudgetExhausted, DEFAULT_LIMITS } from './budget.ts';
export { text, value } from './substrate.ts';
export { DEFAULT_PROMPT, INVESTIGATOR_IDENTITY, COMPLETION_MODEL_IDENTITY, JS_REPL_RULES, RULEBOOK_CONDITIONS, STRATEGIES, rootPrompt } from './prompt.ts';
export { TURN_SCHEMA, readTurn } from './turn.ts';
export { EVENT_SCHEMA_VERSION, consoleLog, eventBus, jsonlLog, memoryLog, silentLog, teeLog, type EventHandler, type EventKind, type Logger, type LoggedEvent, type RlmEvent } from './log.ts';
export { currentRecorder, hashOf, observedComplete, observedDecide, withRecorder, type CallRecord, type CallRecorder, type CallRole } from './observe.ts';
export { Sandbox, type SandboxOptions } from './sandbox/host.ts';
export { scripted } from './models/scripted.ts';
export { claudeAgentSdk, meteredEnvNames } from './models/claudeAgentSdk.ts';
export { WORKER_DEFAULT_ALLOW, claudeWorker, type ClaudeWorkerOptions, type WorkerReport } from './tools/claudeWorker.ts';
export { anthropicApi } from './models/anthropicApi.ts';
export { Ledger, SpendRefused, PRICES, costUsd } from './models/ledger.ts';
export { DECISION_PRICES, OPENROUTER_DECISIONS_ENDPOINT, chunkText, datedEnvKey, decisionTools, judgeChunks, openRouterDecisions, type DecisionAnswer, type DecisionQuestion, type DecisionReply, type Judge } from './decisions.ts';
export { codexSdk } from './models/codexSdk.ts';
export { grokCli } from './models/grokCli.ts';
export { antigravityAcp } from './models/antigravityAcp.ts';
export { ADVISOR_QUESTIONS, COMBINE_SHAPES, chooseStrategy, decisionAdvisor, defaultStrategies, preparedStrategies, surveyPrepare, type Advice, type Prepared, type Advisor, type StrategyParts } from './advisor.ts';
export { OPENAI_COMPATIBLE_PRESETS, openAiCompatible, resolveBaseUrl, type OpenAiCompatibleOptions } from './models/openAiCompatible.ts';
export { CATALOG_PROVIDERS, type CatalogProvider } from './models/providers.generated.ts';
export { SUBSCRIPTION, UttersonConfigError, modelFor, providerOf, utterson, type UttersonOptions } from './utterson.ts';
export type * from './types.ts';
