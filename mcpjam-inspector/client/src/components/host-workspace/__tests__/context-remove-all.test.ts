import { describe, expect, it, vi } from "vitest";
import { removeAllAppContext } from "../context-remove-all";
import { PluginContextUpdateRejected } from "../model-context-controller";
import { ThreadAppError } from "../thread-app-api";

const signal = () => new AbortController().signal;

describe("re-sending an unconfirmed remove-all", () => {
  it("returns the first outcome the server gives", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce("in-effect");
    expect(await removeAllAppContext(send, signal(), [0, 0])).toEqual({
      outcome: "in-effect",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries a concurrent context write but stops at a refusal", async () => {
    const conflict = new ThreadAppError("INSTANCE_CONTEXT_CONFLICT");
    const refusal = new ThreadAppError("PLUGIN_EXTENSION_DISABLED");
    const send = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(refusal);
    expect(await removeAllAppContext(send, signal(), [0, 0, 0])).toEqual({
      error: refusal,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("re-sends after a failure that may have applied", async () => {
    const send = vi.fn().mockResolvedValue("applied");
    for (const code of [
      "INSTANCE_STORE_UNAVAILABLE",
      "PLUGIN_INSTANCE_CANCELLED",
      "PLUGIN_WORKSPACE_UNREACHABLE",
      "INSTANCE_RESPONSE_INVALID",
      "INSTANCE_UNAVAILABLE",
    ])
      send.mockRejectedValueOnce(new ThreadAppError(code));
    expect(await removeAllAppContext(send, signal(), [0, 0, 0, 0, 0])).toEqual({
      outcome: "applied",
    });
    expect(send).toHaveBeenCalledTimes(6);
  });

  it.each([
    new ThreadAppError("INSTANCE_CONTEXT_DUPLICATE_MISMATCH"),
    new ThreadAppError("INSTANCE_CONTEXT_UNAVAILABLE"),
    new ThreadAppError("INVALID_PLUGIN_INSTANCE_REQUEST"),
    new PluginContextUpdateRejected("App context could not be removed"),
  ])("stops at a refusal of this exact request: %s", async (refusal) => {
    const send = vi.fn().mockRejectedValue(refusal);
    expect(await removeAllAppContext(send, signal(), [0, 0])).toEqual({
      error: refusal,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("gives up with no outcome after the last wait", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn().mockRejectedValue(new Error("unavailable"));
      const pending = removeAllAppContext(send, signal(), [1_000, 2_000]);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.outcome).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when its owner goes away", async () => {
    const owner = new AbortController();
    const send = vi.fn().mockRejectedValue(new Error("unavailable"));
    const pending = removeAllAppContext(send, owner.signal, [60_000]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    owner.abort();
    expect((await pending).outcome).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});
