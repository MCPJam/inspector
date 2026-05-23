import type { ModelMessage } from "ai";
import { z } from "zod";
import type { PromptTurnToolCall } from "./prompt-turns";

/** Persisted eval trace span categories (Convex: use the same literals in traceSpanValidator). */
export type EvalTraceSpanCategory = "step" | "llm" | "tool" | "error";
export type EvalTraceSpanStatus = "ok" | "error";

export type EvalTraceSpan = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
  promptIndex?: number;
  stepIndex?: number;
  status?: EvalTraceSpanStatus;
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Inclusive index of the first related trace message in the stored blob. */
  messageStartIndex?: number;
  /** Inclusive index of the last related trace message in the stored blob. */
  messageEndIndex?: number;
};

export type PromptTraceSummary = {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
  actualToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
  passed: boolean;
  missing: PromptTurnToolCall[];
  unexpected: PromptTurnToolCall[];
  argumentMismatches: Array<{
    expected: PromptTurnToolCall;
    actual: PromptTurnToolCall;
    mismatchedArguments: string[];
  }>;
};

export type EvalTraceWidgetSnapshot = {
  toolCallId: string;
  toolName: string;
  protocol: "mcp-apps" | "openai-apps";
  serverId: string;
  resourceUri?: string;
  toolMetadata: Record<string, unknown>;
  widgetCsp?: Record<string, unknown> | null;
  widgetPermissions?: Record<string, unknown> | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  widgetHtmlBlobId?: string;
  widgetHtmlUrl?: string | null;
  /**
   * Whether the OpenAI Apps SDK `window.openai` shim was injected into
   * `widgetHtml` at capture time. Persisted so replay can render the
   * blob faithfully under a different host config without rewriting
   * the bytes — see `MCPAppsRenderer.injectedOpenAiCompat`.
   */
  injectedOpenAiCompat?: boolean;
  /**
   * Per-method `window.openai.*` capability surface the runtime was
   * configured with at capture time. Stored as the full resolved
   * record (not a hash) so debug/replay summaries can render the diff
   * vs. preset and answer "which surface was injected", not just
   * "shim was injected: yes/no". See plan §6.5 +
   * feedback_capability_in_render_recipe memory.
   *
   * Optional / absent for snapshots captured before the matrix
   * shipped — replay treats those as the full ChatGPT surface (the
   * runtime's pre-matrix default).
   */
  injectedOpenAiCompatCapabilities?: {
    callTool?: boolean;
    sendFollowUpMessage?: boolean;
    setWidgetState?: boolean;
    requestDisplayMode?: "all" | "fullscreen-only" | "none";
    notifyIntrinsicHeight?: boolean;
    openExternal?: boolean;
    setOpenInAppUrl?: boolean;
    requestModal?: boolean;
    uploadFile?: boolean;
    selectFiles?: boolean;
    getFileDownloadUrl?: boolean;
    requestCheckout?: boolean;
    requestClose?: boolean;
  };
};

/** Versioned blob written by `testSuites:updateTestIteration` when messages are stored. */
export type EvalTraceBlobV1 = {
  traceVersion: 1;
  messages: ModelMessage[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
};

/** Zod mirror of Convex `traceSpanValidator` for client/server tests and optional runtime checks. */
export const evalTraceSpanZ = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  category: z.enum(["step", "llm", "tool", "error"]),
  startMs: z.number(),
  endMs: z.number(),
  promptIndex: z.number().optional(),
  stepIndex: z.number().optional(),
  status: z.enum(["ok", "error"]).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  serverId: z.string().optional(),
  modelId: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  messageStartIndex: z.number().optional(),
  messageEndIndex: z.number().optional(),
});

const traceToolCallZ = z.object({
  toolName: z.string(),
  arguments: z.record(z.string(), z.any()),
});

const promptTraceSummaryZ = z.object({
  promptIndex: z.number(),
  prompt: z.string(),
  expectedToolCalls: z.array(traceToolCallZ),
  actualToolCalls: z.array(traceToolCallZ),
  expectedOutput: z.string().optional(),
  passed: z.boolean(),
  missing: z.array(traceToolCallZ),
  unexpected: z.array(traceToolCallZ),
  argumentMismatches: z.array(
    z.object({
      expected: traceToolCallZ,
      actual: traceToolCallZ,
      mismatchedArguments: z.array(z.string()),
    }),
  ),
});

const evalTraceWidgetSnapshotZ = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  protocol: z.union([z.literal("mcp-apps"), z.literal("openai-apps")]),
  serverId: z.string(),
  resourceUri: z.string().optional(),
  toolMetadata: z.record(z.string(), z.unknown()),
  widgetCsp: z.record(z.string(), z.unknown()).nullable().optional(),
  widgetPermissions: z.record(z.string(), z.unknown()).nullable().optional(),
  widgetPermissive: z.boolean().optional(),
  prefersBorder: z.boolean().optional(),
  widgetHtmlBlobId: z.string().optional(),
  widgetHtmlUrl: z.string().nullable().optional(),
  injectedOpenAiCompat: z.boolean().optional(),
  // Mirror of `EvalTraceWidgetSnapshot.injectedOpenAiCompatCapabilities`.
  // Sparse object — every field optional — matching what the SDK
  // runtime actually consumed. Strict per-field validation keeps
  // hand-edited eval blobs from injecting unknown method flags.
  injectedOpenAiCompatCapabilities: z
    .object({
      callTool: z.boolean().optional(),
      sendFollowUpMessage: z.boolean().optional(),
      setWidgetState: z.boolean().optional(),
      requestDisplayMode: z.enum(["all", "fullscreen-only", "none"]).optional(),
      notifyIntrinsicHeight: z.boolean().optional(),
      openExternal: z.boolean().optional(),
      setOpenInAppUrl: z.boolean().optional(),
      requestModal: z.boolean().optional(),
      uploadFile: z.boolean().optional(),
      selectFiles: z.boolean().optional(),
      getFileDownloadUrl: z.boolean().optional(),
      requestCheckout: z.boolean().optional(),
      requestClose: z.boolean().optional(),
    })
    .optional(),
});

export const evalTraceBlobV1Z = z.object({
  traceVersion: z.literal(1),
  messages: z.array(z.any()),
  widgetSnapshots: z.array(evalTraceWidgetSnapshotZ).optional(),
  spans: z.array(evalTraceSpanZ).optional(),
  prompts: z.array(promptTraceSummaryZ).optional(),
});

export function msOffsetFromRunStart(
  runStartedAt: number,
  absoluteMs: number,
): number {
  return absoluteMs - runStartedAt;
}

export function normalizeSpanInterval(
  startMs: number,
  endMs: number,
): { startMs: number; endMs: number } {
  if (endMs <= startMs) return { startMs, endMs: startMs + 1 };
  return { startMs, endMs };
}

export function createOffsetInterval(
  runStartedAt: number,
  startAbs: number,
  endAbs: number,
): { startMs: number; endMs: number } {
  return normalizeSpanInterval(
    msOffsetFromRunStart(runStartedAt, startAbs),
    msOffsetFromRunStart(runStartedAt, endAbs),
  );
}

function messageDedupeKey(message: ModelMessage): string {
  const id = (message as { id?: string }).id;
  if (typeof id === "string" && id) return `id:${id}`;
  try {
    return `json:${JSON.stringify(message)}`;
  } catch {
    return `fallthrough:${String((message as { role?: string }).role)}`;
  }
}

/** Append `incoming` to `acc`, skipping duplicates (by `id` or JSON identity). */
export function appendDedupedModelMessages(
  acc: ModelMessage[],
  incoming: ModelMessage[],
): void {
  const seen = new Set(acc.map(messageDedupeKey));
  for (const m of incoming) {
    const key = messageDedupeKey(m);
    if (!seen.has(key)) {
      seen.add(key);
      acc.push(m);
    }
  }
}

export function stepResultHasToolActivity(step: {
  toolCalls?: unknown[] | null;
  dynamicToolCalls?: unknown[] | null;
  staticToolCalls?: unknown[] | null;
  toolResults?: unknown[] | null;
  staticToolResults?: unknown[] | null;
  dynamicToolResults?: unknown[] | null;
}): boolean {
  const arrays = [
    step.toolCalls,
    step.dynamicToolCalls,
    step.staticToolCalls,
    step.toolResults,
    step.staticToolResults,
    step.dynamicToolResults,
  ];
  return arrays.some((a) => Array.isArray(a) && a.length > 0);
}
