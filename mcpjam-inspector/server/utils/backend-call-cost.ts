import type { UIMessageChunk } from "ai";
import {
  parseModelCallCostEvidence,
  type ModelCallCostEvidence,
} from "@mcpjam/sdk";

function metadataOf(
  chunk: UIMessageChunk | null,
): Record<string, unknown> | undefined {
  if (chunk?.type !== "finish") return undefined;
  const metadata: unknown = chunk.messageMetadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined;
}

/**
 * The backend prices every `/stream` and `/stream/org` request and sends the
 * result as `messageMetadata.cost` on that request's finish chunk. The
 * Inspector makes one request per step, so this is the cost of that step's
 * one provider call. Anything that does not parse as evidence reads as no
 * cost, never as a guessed amount.
 */
export function readCallCostFromFinishChunk(
  finishChunk: UIMessageChunk | null,
): ModelCallCostEvidence | undefined {
  return parseModelCallCostEvidence(metadataOf(finishChunk)?.cost);
}

/**
 * The finish chunk the browser receives sums usage over every call in the
 * turn. A cost copied from the last call's metadata would read as the turn's
 * cost, so it is left out; the per-call costs travel on the llm spans.
 */
export function omitCallCost(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }
  if (!("cost" in metadata)) return metadata;
  const rest: Record<string, unknown> = { ...metadata };
  delete rest.cost;
  return rest;
}
