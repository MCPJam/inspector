/**
 * What a failed stage says when no model has explained it.
 *
 * The chain already names the REASON a stage failed ("the server reported a
 * tool error") and lists the span ids that prove it. Neither is the thing a
 * reader wants first, which is what the server actually said. That sentence is
 * already in the trace the drawer has downloaded, one lookup away from the
 * span the chain points at.
 *
 * Deterministic and free: no model, no request, no spend. An AI narrative for
 * the same stage supersedes it; until one exists — and on a run nobody ever
 * analyzes — this is what the stage says.
 *
 * Scope is deliberately one reason, `toolError`, whose evidence is a quotable
 * sentence the server itself wrote. A floor for the rest would have to
 * interpret, and interpretation is the model's half of this page.
 */
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import type { EvalTraceSpan } from "@/shared/eval-trace";

/**
 * The subset of the trace envelope this reads.
 *
 * Both fields are `unknown` and narrowed here: a stored trace is whatever an
 * older build wrote, and a floor that threw on an unexpected shape would take
 * the whole scorecard with it.
 */
export type StageFloorTrace = {
  messages?: unknown;
  spans?: unknown;
};

export type StageFloor = { actual: string; toolName?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The message a failed tool call actually carried.
 *
 * Hand-mirrored from `extractToolErrorMessage` in the backend's
 * `convex/lib/evalTraceLedger.ts`, which reads the same recorded shapes to
 * build the model's ledger. The two must agree: a reader who runs Analyze
 * should see the model quoting the same sentence this showed them for free.
 */
export function toolErrorMessage(output: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 6 || value === null || value === undefined) return undefined;
    if (typeof value === "string") return value.trim() || undefined;
    if (typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;
    if (obj.type === "error-text" && typeof obj.value === "string")
      return obj.value;
    if (Array.isArray(obj.content)) {
      const texts = obj.content
        .filter(record)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text).trim())
        .filter(Boolean);
      if (texts.length) return texts.join(" ");
    }
    for (const key of [
      "message",
      "error",
      "errorText",
      "value",
      "result",
      "output",
      "data",
    ])
      if (key in obj) {
        const found = visit(obj[key], depth + 1);
        if (found) return found;
      }
    return undefined;
  };
  const found = visit(output, 0);
  return found ? found.replace(/\s+/g, " ").trim().slice(0, 400) : undefined;
}

type ErroredCall = { toolCallId?: string; toolName?: string; text: string };

/** Every recorded tool result that carried an error, in transcript order. */
function erroredCalls(trace: StageFloorTrace | null): ErroredCall[] {
  const messages = Array.isArray(trace?.messages) ? trace.messages : [];
  const found: ErroredCall[] = [];
  for (const message of messages) {
    if (!record(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!record(part) || part.type !== "tool-result") continue;
      // `isError: true` is a domain error the model was meant to read; an
      // `error-text` output is a call that never returned one. Both are
      // failures a reader is owed, and neither is a verdict.
      const raw = record(part.result) ? part.result : undefined;
      const isError =
        raw?.isError === true ||
        (record(part.output) && part.output.type === "error-text");
      if (!isError) continue;
      const text = toolErrorMessage(raw ?? part.output);
      if (!text) continue;
      found.push({
        toolCallId:
          typeof part.toolCallId === "string" ? part.toolCallId : undefined,
        toolName: typeof part.toolName === "string" ? part.toolName : undefined,
        text,
      });
    }
  }
  return found;
}

/** The stage row whose evidence names the spans the chain blamed. */
function stageRow(
  chain: EvalRunDecisionChain | null | undefined,
  stage: UserValueStage,
) {
  return chain?.status === "verified"
    ? chain.stages.find((row) => row.stage === stage)
    : undefined;
}

/**
 * The recorded sentence for one stage, or null when this build cannot produce
 * one honestly.
 *
 * Returning null is the common case and is correct: `STAGE_REASON_LABELS`
 * already says what the chain decided, and saying it twice in different words
 * would imply a second source.
 */
export function stageFloor(
  stage: UserValueStage,
  chain: EvalRunDecisionChain | null | undefined,
  trace: StageFloorTrace | null | undefined,
): StageFloor | null {
  const row = stageRow(chain, stage);
  if (!row || row.state !== "failed") return null;
  if (row.reason !== "toolError") return null;
  const calls = erroredCalls(trace ?? null);
  if (!calls.length) return null;
  // The span the chain blamed, when its evidence names one; otherwise the
  // first recorded failure, which is the one the rest followed from.
  const spans: readonly EvalTraceSpan[] = Array.isArray(trace?.spans)
    ? (trace.spans as EvalTraceSpan[])
    : [];
  const blamed = new Set(
    spans
      .filter((span) => span?.status === "error" && span?.toolCallId)
      .map((span) => String(span.toolCallId)),
  );
  const call =
    calls.find((entry) => entry.toolCallId && blamed.has(entry.toolCallId)) ??
    calls[0];
  const others = calls.length - 1;
  return {
    toolName: call.toolName,
    actual: [
      call.toolName
        ? `\`${call.toolName}\` returned an error: ${call.text}`
        : `A tool returned an error: ${call.text}`,
      others > 0
        ? `${others} other tool ${others === 1 ? "call" : "calls"} also returned an error.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
