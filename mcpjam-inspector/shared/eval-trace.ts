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

/** Versioned blob written by `testSuites:updateTestIteration` when messages are stored. */
export type EvalTraceBlobV1 = {
  traceVersion: 1;
  messages: ModelMessage[];
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

export const evalTraceBlobV1Z = z.object({
  traceVersion: z.literal(1),
  messages: z.array(z.any()),
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
