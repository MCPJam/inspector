import { describe, expect, it, vi } from "vitest";
import { readWebConversationState } from "../web-conversation-state.js";

describe("authoritative conversation policy", () => {
  it("returns stored requirements without caller hints", async () => {
    const state = { writable: true, requireNativeToolDiscovery: true };
    expect(
      await readWebConversationState(
        async () => state,
        new AbortController().signal,
      ),
    ).toEqual(state);
  });
  it("does not allow execution when the policy read fails", async () => {
    await expect(
      readWebConversationState(async () => {
        throw new Error("offline");
      }, new AbortController().signal),
    ).rejects.toThrow("offline");
  });
  it.each([false, true])("bounds a stalled read and refuses execution (abort-aware: %s)", async (abortAware) => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const result = readWebConversationState((value) => {
        signal = value;
        return new Promise((_, reject) => {
          if (abortAware) {
            value.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          }
        });
      }, new AbortController().signal);
      const refused = expect(result).rejects.toMatchObject({
        status: 503,
        code: "TIMEOUT",
        details: { retryable: true },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
