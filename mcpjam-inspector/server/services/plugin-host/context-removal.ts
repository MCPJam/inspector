import { z } from "zod";
import type { PluginContextRemoveAllResult } from "../../../shared/plugin-model-context.js";
import { PluginInvocationError } from "./invocation.js";

/**
 * Per-instance removal cursor, saved with the context next to `held`. All
 * three only grow, and a restart restores them, so a late retry is judged
 * against what actually happened rather than against a receipt that may have
 * been compacted away.
 */
export type PluginContextRemovalCursor = {
  /** Counts applied remove-alls and user attaches. */
  cursor: number;
  /** `cursor` at the last applied remove-all, or 0. */
  removedAt: number;
  /** `cursor` at the last update the person attached, or 0. */
  attachedAt: number;
};
export const NO_CONTEXT_REMOVALS: PluginContextRemovalCursor = {
  cursor: 0,
  removedAt: 0,
  attachedAt: 0,
};

export type PluginContextRemoveAll = {
  operationId: string;
  /** The snapshot `cursor` the person saw when they removed the context. */
  basis: number;
};

/** Removal receipts kept for idempotent retries. Older receipts are compacted
 * away; a retry whose receipt is gone is decided by its basis, so the window
 * bounds storage without ever letting an old retry erase newer context. */
export const PLUGIN_CONTEXT_REMOVAL_WINDOW = 256;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const persistedRemovalCursorSchema = z
  .object({ cursor: count, removedAt: count, attachedAt: count })
  .strict()
  .refine(
    (value) =>
      value.removedAt <= value.cursor && value.attachedAt <= value.cursor,
  );

const receiptFingerprint = (basis: number) => JSON.stringify(["all", basis]);

/**
 * Decide a remove-all atomically. Only `"apply"` lets the caller write; every
 * other answer leaves the context exactly as it is.
 */
export function decideContextRemoveAll(input: {
  request: PluginContextRemoveAll;
  receipt: string | undefined;
  held: boolean;
  removal: PluginContextRemovalCursor;
}): PluginContextRemoveAllResult["outcome"] | "apply" {
  const { request, receipt, held, removal } = input;
  if (!request.operationId || request.operationId.length > 128)
    throw new PluginInvocationError("INSTANCE_CONTEXT_REMOVAL_INVALID");
  if (receipt !== undefined) {
    if (receipt !== receiptFingerprint(request.basis))
      throw new PluginInvocationError("INSTANCE_CONTEXT_DUPLICATE_MISMATCH");
    return "applied";
  }
  // A basis the server never issued cannot describe what the person saw.
  if (!Number.isSafeInteger(request.basis) || request.basis < 0)
    throw new PluginInvocationError("INSTANCE_CONTEXT_REMOVAL_INVALID");
  if (request.basis > removal.cursor)
    throw new PluginInvocationError("INSTANCE_CONTEXT_REMOVAL_INVALID");
  if (removal.removedAt > request.basis)
    return held ? "in-effect" : "superseded";
  if (removal.attachedAt > request.basis) return "stale";
  return "apply";
}

/** Record an applied remove-all: its receipt (compacted) and the new cursor. */
export function recordContextRemoveAll(
  receipts: Map<string, string>,
  request: PluginContextRemoveAll,
  removal: PluginContextRemovalCursor,
): PluginContextRemovalCursor {
  receipts.set(request.operationId, receiptFingerprint(request.basis));
  // Keep the most recent window in insertion order.
  for (const key of receipts.keys()) {
    if (receipts.size <= PLUGIN_CONTEXT_REMOVAL_WINDOW) break;
    receipts.delete(key);
  }
  return {
    ...removal,
    cursor: removal.cursor + 1,
    removedAt: removal.cursor + 1,
  };
}

/** Record an update the person attached by using the App. */
export function recordContextUserAttach(
  removal: PluginContextRemovalCursor,
): PluginContextRemovalCursor {
  return {
    ...removal,
    cursor: removal.cursor + 1,
    attachedAt: removal.cursor + 1,
  };
}

/** Snapshot fields, omitted while they are the default. */
export function contextRemovalSnapshot(
  held: boolean,
  removal: PluginContextRemovalCursor,
) {
  return {
    ...(held ? { held: true as const } : {}),
    ...(removal.cursor ? { ...removal } : {}),
  };
}
