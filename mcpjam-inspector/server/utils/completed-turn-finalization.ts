import { COMPLETED_TURN_RETRY_TTL_MS, HOSTED_PERSIST_RETRY_PREFIX } from "../../shared/persist-receipt.js";
import type { UIMessageChunk } from "ai";
import { completedTurnPersistence } from "../services/completed-turn-persistence.js";
import {
  writePersistReceipt,
  type PersistChatOutcome,
} from "./chat-ingestion.js";

/** Keep the original finalizer and its lease alive while fresh auth saves only these bytes. */
export async function finishPendingPersist(
  outcome: PersistChatOutcome | void,
  writer: { write: (chunk: UIMessageChunk) => void } | undefined,
  context: { chatSessionId: string; turnId?: string },
  signal?: AbortSignal,
): Promise<PersistChatOutcome | void> {
  if (outcome?.outcome !== "failed" || !outcome.retryHandle) return outcome;
  // A hosted retry can land on another replica; its receipt completes on the client.
  if (outcome.retryHandle.startsWith(HOSTED_PERSIST_RETRY_PREFIX)) return outcome;
  if (!writer) {
    completedTurnPersistence.cancel(outcome.retryHandle);
    return outcome;
  }
  const cancel = () => completedTurnPersistence.cancel(outcome.retryHandle!);
  if (signal?.aborted) {
    cancel();
    return { outcome: "failed", failureKind: "exception" };
  }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    writePersistReceipt(writer, outcome, context);
    return await completedTurnPersistence.wait(outcome.retryHandle);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** Keep the original sidecar lease until a cross-replica retry has had its bounded window. */
export function deferCompletedTurnLeaseRelease(
  outcome: PersistChatOutcome | void,
  release: () => Promise<void>,
  onError: (error: unknown) => void,
): boolean {
  if (outcome?.outcome !== "failed" || !outcome.retryHandle?.startsWith(HOSTED_PERSIST_RETRY_PREFIX)) return false;
  const timer = setTimeout(() => { void release().catch(onError); }, COMPLETED_TURN_RETRY_TTL_MS);
  timer.unref?.();
  return true;
}
