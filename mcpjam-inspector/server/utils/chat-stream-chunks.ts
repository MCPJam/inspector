/**
 * Canonical builders + emitters for the AI-SDK `UIMessageChunk`s that the two
 * chat engines CONSTRUCT and stream to the client:
 *   - the emulated engine (`mcpjam-stream-handler.ts runChatEngineLoop`), and
 *   - the harness engine (`harness/run-harness-turn.ts runHarnessTurn`).
 *
 * The same client renders both, so the client-facing wire shape of each chunk
 * must stay identical across engines. Before this module each engine hand-built
 * the literals inline and they had already drifted. Centralising the envelope
 * here makes the field names/order one typed surface, makes the *legitimate*
 * differences explicit parameters (e.g. `providerExecuted`, which only the
 * harness sets because its tools run in-sandbox), and lets one unit test freeze
 * every shape.
 *
 * SCOPE: this only owns chunks an engine CONSTRUCTS. The emulated engine also
 * FORWARDS Convex-origin chunks (`text-*`, `reasoning-*`, `tool-input-*`, …)
 * verbatim — those carry origin fields not modelled here and must NOT be routed
 * through these builders.
 *
 * ai@6 ONLY — no `@ai-sdk/harness`/v7 types cross this boundary. The harness
 * reads its v7 `fullStream` loosely and passes plain values into the builders.
 *
 * Field order in each builder MATCHES the previous inline literals (the
 * full-chunk snapshot tests are order-sensitive); the conditional spread for
 * optional keys is LAST, and optional keys are OMITTED (never `false`/`null`).
 */
import type { UIMessageChunk } from "ai";
import { logger } from "./logger.js";

export type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export type UsageTokens = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

// `UIMessageChunk` is a discriminated union; the extra fields we attach
// (`providerExecuted`, `messageMetadata`, hydrated `output`) aren't on every
// member, so each builder constructs the literal and casts ONCE here — callers
// stay clean (mirrors the pre-existing `as UIMessageChunk` in the engines).
const asChunk = (value: Record<string, unknown>): UIMessageChunk =>
  value as unknown as UIMessageChunk;

// ── text ─────────────────────────────────────────────────────────────────────
export const textStartChunk = (id: string): UIMessageChunk =>
  asChunk({ type: "text-start", id });

export const textDeltaChunk = (id: string, delta: string): UIMessageChunk =>
  asChunk({ type: "text-delta", id, delta });

export const textEndChunk = (id: string): UIMessageChunk =>
  asChunk({ type: "text-end", id });

// ── reasoning ────────────────────────────────────────────────────────────────
// The emulated engine FORWARDS these from Convex; the harness builds them from
// its translated `reasoning-*` fullStream parts. Same client renderer, so the
// shapes must match (id + delta, like text).
export const reasoningStartChunk = (id: string): UIMessageChunk =>
  asChunk({ type: "reasoning-start", id });

export const reasoningDeltaChunk = (id: string, delta: string): UIMessageChunk =>
  asChunk({ type: "reasoning-delta", id, delta });

export const reasoningEndChunk = (id: string): UIMessageChunk =>
  asChunk({ type: "reasoning-end", id });

// ── tools ────────────────────────────────────────────────────────────────────
export const toolInputChunk = (a: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerExecuted?: boolean;
}): UIMessageChunk =>
  asChunk({
    type: "tool-input-available",
    toolCallId: a.toolCallId,
    toolName: a.toolName,
    input: a.input,
    ...(a.providerExecuted ? { providerExecuted: true } : {}),
  });

export const toolOutputChunk = (a: {
  toolCallId: string;
  output: unknown;
  providerExecuted?: boolean;
}): UIMessageChunk =>
  asChunk({
    type: "tool-output-available",
    toolCallId: a.toolCallId,
    output: a.output,
    ...(a.providerExecuted ? { providerExecuted: true } : {}),
  });

export const toolApprovalRequestChunk = (a: {
  approvalId: string;
  toolCallId: string;
}): UIMessageChunk =>
  asChunk({
    type: "tool-approval-request",
    approvalId: a.approvalId,
    toolCallId: a.toolCallId,
  });

export const toolOutputDeniedChunk = (a: {
  toolCallId: string;
}): UIMessageChunk =>
  asChunk({ type: "tool-output-denied", toolCallId: a.toolCallId });

// ── finish / error ───────────────────────────────────────────────────────────
// Takes a READY messageMetadata (no aggregation here). The emulated engine's
// `createClientFinishChunk` keeps its turn-level usage aggregation and delegates
// only its final literal to this builder; the harness passes its `usage`.
export const buildFinishChunk = (a: {
  finishReason: string;
  messageMetadata?: unknown;
}): UIMessageChunk =>
  asChunk({
    type: "finish",
    finishReason: a.finishReason,
    ...(a.messageMetadata != null
      ? { messageMetadata: a.messageMetadata }
      : {}),
  });

export const errorChunk = (errorText: string): UIMessageChunk =>
  asChunk({ type: "error", errorText });

// ── emit wrappers (build + write, return the chunk) ──────────────────────────
export const emitTextStart = (w: ChunkWriter, id: string): UIMessageChunk => {
  const c = textStartChunk(id);
  w.write(c);
  return c;
};
export const emitTextDelta = (
  w: ChunkWriter,
  id: string,
  delta: string,
): UIMessageChunk => {
  const c = textDeltaChunk(id, delta);
  w.write(c);
  return c;
};
export const emitTextEnd = (w: ChunkWriter, id: string): UIMessageChunk => {
  const c = textEndChunk(id);
  w.write(c);
  return c;
};
export const emitReasoningStart = (w: ChunkWriter, id: string): UIMessageChunk => {
  const c = reasoningStartChunk(id);
  w.write(c);
  return c;
};
export const emitReasoningDelta = (
  w: ChunkWriter,
  id: string,
  delta: string,
): UIMessageChunk => {
  const c = reasoningDeltaChunk(id, delta);
  w.write(c);
  return c;
};
export const emitReasoningEnd = (w: ChunkWriter, id: string): UIMessageChunk => {
  const c = reasoningEndChunk(id);
  w.write(c);
  return c;
};
export const emitToolInput = (
  w: ChunkWriter,
  a: Parameters<typeof toolInputChunk>[0],
): UIMessageChunk => {
  const c = toolInputChunk(a);
  w.write(c);
  return c;
};
export const emitToolOutput = (
  w: ChunkWriter,
  a: Parameters<typeof toolOutputChunk>[0],
): UIMessageChunk => {
  const c = toolOutputChunk(a);
  w.write(c);
  return c;
};
export const emitToolApprovalRequest = (
  w: ChunkWriter,
  a: Parameters<typeof toolApprovalRequestChunk>[0],
): UIMessageChunk => {
  const c = toolApprovalRequestChunk(a);
  w.write(c);
  return c;
};
export const emitToolOutputDenied = (
  w: ChunkWriter,
  a: Parameters<typeof toolOutputDeniedChunk>[0],
): UIMessageChunk => {
  const c = toolOutputDeniedChunk(a);
  w.write(c);
  return c;
};
export const emitFinish = (
  w: ChunkWriter,
  a: Parameters<typeof buildFinishChunk>[0],
): UIMessageChunk => {
  const c = buildFinishChunk(a);
  w.write(c);
  return c;
};
export const emitError = (w: ChunkWriter, errorText: string): UIMessageChunk => {
  const c = errorChunk(errorText);
  w.write(c);
  return c;
};

/**
 * Shared fire-and-forget callback guard. Catches both a synchronous throw and a
 * rejected promise, logging `${label} callback failed` (pass the full label so
 * the existing log messages are preserved). FIRE-AND-FORGET ONLY — never use at
 * an awaited callback site (it would reorder the stream).
 */
export function safelyInvoke(label: string, fn: () => unknown): void {
  const warn = (error: unknown) =>
    logger.warn(`${label} callback failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  try {
    void Promise.resolve(fn()).catch(warn);
  } catch (error) {
    warn(error);
  }
}
