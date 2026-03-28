import type { ModelMessage } from "ai";
import { z } from "zod";

/** Persisted eval trace span categories (Convex: use the same literals in traceSpanValidator). */
export type EvalTraceSpanCategory = "step" | "llm" | "tool" | "error";

export type EvalTraceSpan = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
};

/** Versioned blob written by `testSuites:updateTestIteration` when messages are stored. */
export type EvalTraceBlobV1 = {
  traceVersion: 1;
  messages: ModelMessage[];
  spans?: EvalTraceSpan[];
};

/** Zod mirror of Convex `traceSpanValidator` for client/server tests and optional runtime checks. */
export const evalTraceSpanZ = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  category: z.enum(["step", "llm", "tool", "error"]),
  startMs: z.number(),
  endMs: z.number(),
});

export const evalTraceBlobV1Z = z.object({
  traceVersion: z.literal(1),
  messages: z.array(z.any()),
  spans: z.array(evalTraceSpanZ).optional(),
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
