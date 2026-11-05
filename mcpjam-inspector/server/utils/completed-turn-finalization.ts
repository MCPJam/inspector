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
