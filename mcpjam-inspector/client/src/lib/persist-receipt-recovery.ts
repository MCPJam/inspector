import {
  isPersistReceiptDataPart,
  type PersistReceiptData,
} from "@/shared/persist-receipt";

/** A duplicate SSE chunk shares one save request; it never sends a chat turn. */
export function createPersistReceiptRecovery(fetcher: typeof fetch) {
  const pending = new Map<
    string,
    { at: number; promise: Promise<PersistReceiptData> }
  >();
  return (receipt: PersistReceiptData): Promise<PersistReceiptData> => {
    const handle = receipt.retryHandle;
    if (!handle || !receipt.retryProjectId || !receipt.turnId)
      return Promise.resolve(receipt);
    for (const [key, entry] of pending)
      if (Date.now() - entry.at > 60_000) pending.delete(key);
    const prior = pending.get(handle);
    if (prior) return prior.promise;
    if (pending.size >= 32) return Promise.resolve(receipt);
    const promise = (async () => {
      try {
        const response = await fetcher("/api/web/chat-persistence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            retryHandle: handle,
            projectId: receipt.retryProjectId,
            chatSessionId: receipt.chatSessionId,
            turnId: receipt.turnId,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return receipt;
        const data: unknown = await response.json();
        const part = { type: "data-persist-receipt", data };
        return isPersistReceiptDataPart(part) &&
          part.data.chatSessionId === receipt.chatSessionId &&
          part.data.turnId === receipt.turnId
          ? part.data
          : receipt;
      } catch {
        // The original failed receipt remains authoritative; the server's wait expires.
        return receipt;
      }
    })();
    pending.set(handle, { at: Date.now(), promise });
    return promise;
  };
}
