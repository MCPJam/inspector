/**
 * `runUnifiedAssistantTurn` — the single front door for executing one assistant
 * turn. Chat, playground, and the eval runners call this; it dispatches to one
 * of two existing engines and returns a normalized result.
 *
 * Design: ONE public turn API, TWO engine adapters, MULTIPLE sinks. It does NOT
 * merge the engine internals.
 *   - `runtime.kind === "hosted"` → `runAssistantTurn` (Convex `/stream`,
 *     `/stream/org`, harness). The routing endpoint is an EXPLICIT field of the
 *     runtime discriminator so it can't be hidden behind a bare string.
 *   - `runtime.kind === "direct"` → `runDirectChatTurn` (in-process AI SDK).
 *
 * Boundary (load-bearing): this facade owns ONLY engine dispatch + the
 * normalized turn result/events. It does NOT own provider/model resolution,
 * persistence policy, org usage writeback, or cleanup/disconnect lifecycle —
 * those stay at the route / eval layers that call this.
 */

import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";
import type { createLlmModel } from "./chat-helpers";
import {
  runAssistantTurn,
  type RunAssistantTurnOptions,
  type RunAssistantTurnResult,
  type RunAssistantTurnStreamSink,
} from "./assistant-turn";
import {
  runDirectChatTurn,
  consumeDirectChatTurnHeadless,
  type RunDirectChatTurnOptions,
} from "./direct-chat-turn";

/** Hosted engine: where/how to execute + auth-adjacent routing, made explicit. */
export type HostedRuntime = {
  kind: "hosted";
  /** "/stream" (MCPJam) | "/stream/org" (org BYOK). Explicit so routing isn't hidden. */
  endpointPath: string;
  extraBodyFields?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  harness?: RunAssistantTurnOptions["harness"];
};

/** Direct engine: the resolved local model handle. */
export type DirectRuntime = {
  kind: "direct";
  llmModel: ReturnType<typeof createLlmModel>;
  modelId: string;
  provider?: string;
};

export type TurnRuntime = HostedRuntime | DirectRuntime;

/**
 * Normalized turn result. Superset of `RunAssistantTurnResult` plus an explicit
 * `newMessages` — THIS turn's response slice — so eval tool-extraction and
 * per-turn checks never have to re-derive it (and can't get it wrong).
 */
export type UnifiedTurnResult = RunAssistantTurnResult & {
  newMessages: ModelMessage[];
};

/** Hosted options = `runAssistantTurn`'s, with routing lifted into `runtime`. */
export type HostedTurnOptions = {
  runtime: HostedRuntime;
} & Omit<
  RunAssistantTurnOptions,
  "endpointPath" | "extraHeaders" | "extraBodyFields" | "harness"
>;

/** Direct options = the shared turn inputs the direct engine needs. */
export type DirectTurnOptions = {
  runtime: DirectRuntime;
  streamSink: RunAssistantTurnStreamSink;
  /** Input history; `newMessages` are appended onto this for `messages`. */
  messages: ModelMessage[];
  onLiveTextDelta?: RunDirectChatTurnOptions["onLiveTextDelta"];
} & Pick<
  RunDirectChatTurnOptions,
  | "systemPrompt"
  | "temperature"
  | "tools"
  | "toolChoice"
  | "abortSignal"
  | "maxSteps"
  | "traceStartedAt"
  | "progressivePlan"
  | "discoveryState"
  | "prepareAdvertisedTools"
>;

export type RunUnifiedAssistantTurnOptions = HostedTurnOptions | DirectTurnOptions;

function isHostedTurn(
  opts: RunUnifiedAssistantTurnOptions
): opts is HostedTurnOptions {
  return opts.runtime.kind === "hosted";
}

export async function runUnifiedAssistantTurn(
  opts: RunUnifiedAssistantTurnOptions
): Promise<UnifiedTurnResult> {
  if (isHostedTurn(opts)) {
    const { runtime, ...rest } = opts;
    const result = await runAssistantTurn({
      ...rest,
      endpointPath: runtime.endpointPath,
      extraHeaders: runtime.extraHeaders,
      extraBodyFields: runtime.extraBodyFields,
      harness: runtime.harness,
    });
    // Hosted returns the FULL rolled-forward transcript; slice off the input.
    const newMessages = result.messages.slice(opts.messages.length);
    return { ...result, newMessages };
  }

  // runtime.kind === "direct"
  if (opts.streamSink === "ui") {
    // The direct UI terminal (buildDirectChatTraceCallbacks + toUIMessageStream)
    // needs the route's SSE writer; it is wired when chat/playground migrate
    // (PR 5). Eval + hosted use the paths above / streamSink "none".
    throw new Error(
      "runUnifiedAssistantTurn: direct runtime with streamSink 'ui' is not " +
        "wired yet (chat/playground migration, PR 5). Use streamSink 'none'."
    );
  }

  const { runtime } = opts;
  const handle = runDirectChatTurn({
    llmModel: runtime.llmModel,
    modelId: runtime.modelId,
    provider: runtime.provider,
    messageHistory: opts.messages,
    systemPrompt: opts.systemPrompt,
    temperature: opts.temperature,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
    abortSignal: opts.abortSignal,
    maxSteps: opts.maxSteps,
    traceStartedAt: opts.traceStartedAt,
    progressivePlan: opts.progressivePlan,
    discoveryState: opts.discoveryState,
    prepareAdvertisedTools: opts.prepareAdvertisedTools,
    onLiveTextDelta: opts.onLiveTextDelta,
  });
  const headless = await consumeDirectChatTurnHeadless(handle);
  // Direct's `response.messages` IS this turn's response slice.
  const newMessages = headless.messages;
  const messages = [...opts.messages, ...newMessages];
  return {
    messages,
    newMessages,
    assistantMessages: extractAssistantMessages(newMessages),
    toolCalls: extractToolCalls(newMessages),
    toolResults: extractToolResults(newMessages),
    turnTrace: headless.turnTrace,
    usage: headless.turnTrace.usage,
    finishReason: headless.finishReason ?? undefined,
  };
}

// Small local extractors mirroring assistant-turn.ts's convenience views (which
// are module-private there). Operate over THIS turn's new messages.
function extractAssistantMessages(
  messages: ModelMessage[]
): AssistantModelMessage[] {
  return messages.filter(
    (m): m is AssistantModelMessage => m?.role === "assistant"
  );
}

function extractToolCalls(
  messages: ModelMessage[]
): RunAssistantTurnResult["toolCalls"] {
  const out: RunAssistantTurnResult["toolCalls"] = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const content = (msg as AssistantModelMessage).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool-call") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }
    }
  }
  return out;
}

function extractToolResults(
  messages: ModelMessage[]
): RunAssistantTurnResult["toolResults"] {
  const out: RunAssistantTurnResult["toolResults"] = [];
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    for (const part of (msg as ToolModelMessage).content) {
      if (part.type === "tool-result") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
        });
      }
    }
  }
  return out;
}
