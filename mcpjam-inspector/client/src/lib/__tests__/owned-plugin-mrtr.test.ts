import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
const upload = vi.hoisted(() => vi.fn());
const ack = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../apis/web/base", () => ({
  webPost: upload,
  WebApiError: class extends Error {},
}));
vi.mock("../apis/web/mrtr-api", async (original) => ({
  ...(await original<typeof import("../apis/web/mrtr-api")>()),
  acknowledgeHostedMrtrContinuation: ack,
}));
import { driveOwnedPluginMrtr } from "../apis/owned-plugin-mrtr";
const pending = (round = 1) => ({
  status: "input_required",
  continuationId: "disposable-continuation",
  version: 1,
  serverId: "server",
  method: "tools/call",
  round,
  inputRequests: [
    {
      key: "constructor",
      mode: "form",
      message: "Disposable input",
      requestedSchema: { type: "object", properties: {} },
    },
  ],
  expiresAt: Date.now() + 10000,
  negotiatedEra: "2026-07-28",
  pluginFormProfile: {
    fileResources: false,
    origin: "server",
    userResources: false,
    previews: false,
  },
});
beforeEach(() => {
  useHostedMrtrStore.getState().__reset();
  upload.mockReset();
  ack.mockClear();
});
describe("owned private MRTR browser driver", () => {
  it("retains the dialog and private receipt after a failed ACK, then disposes each round", async () => {
    upload.mockResolvedValue({ ok: true, storageId: "receipt-one" });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost ACK"))
      .mockResolvedValueOnce(pending(2))
      .mockResolvedValueOnce({ status: "completed", result: { content: [] } });
    const controller = new AbortController(),
      cancel = vi.fn(async () => {});
    const result = driveOwnedPluginMrtr(pending(), {
      signal: controller.signal,
      submit,
      cancel,
    });
    const answer = Object.fromEntries([
      ["constructor", { action: "accept", content: { typed: [false, 0] } }],
    ]);
    await expect(
      useHostedMrtrStore
        .getState()
        .submit("disposable-continuation:1", answer as never),
    ).rejects.toThrow("lost ACK");
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);
    await useHostedMrtrStore
      .getState()
      .submit("disposable-continuation:1", answer as never);
    await vi.waitFor(() =>
      expect(useHostedMrtrStore.getState().rounds[0]?.round).toBe(2),
    );
    expect(upload).toHaveBeenCalledTimes(1);
    await useHostedMrtrStore.getState().submit("disposable-continuation:2", {
      constructor: { action: "cancel" },
    } as never);
    expect(await result).toEqual({
      status: "completed",
      result: { content: [] },
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith("disposable-continuation");
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });
  it("aborts uploads and refuses a late actor-owned delivery", async () => {
    let done!: (value: unknown) => void;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const controller = new AbortController(),
      submit = vi.fn(),
      cancel = vi.fn(async () => {});
    const result = driveOwnedPluginMrtr(pending(), {
      signal: controller.signal,
      submit,
      cancel,
    });
    const sending = useHostedMrtrStore
      .getState()
      .submit("disposable-continuation:1", {
        constructor: { action: "decline" },
      } as never);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toThrow("owner closed");
    done({ ok: true, storageId: "late" });
    await expect(sending).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect(upload.mock.calls[0][2].signal.aborted).toBe(true);
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });
  it("rejects unqualified profiles and changed continuation identity", async () => {
    const controller = new AbortController(),
      cancel = vi.fn(async () => {});
    await expect(
      driveOwnedPluginMrtr(
        {
          ...pending(),
          pluginFormProfile: { ...pending().pluginFormProfile, previews: true },
        },
        { signal: controller.signal, submit: vi.fn(), cancel },
      ),
    ).rejects.toThrow("Unsupported");
    // The server always states the client's File resources toggle.
    const { fileResources: _toggle, ...unstated } = pending().pluginFormProfile;
    await expect(
      driveOwnedPluginMrtr(
        { ...pending(), pluginFormProfile: unstated },
        { signal: controller.signal, submit: vi.fn(), cancel },
      ),
    ).rejects.toThrow("Unsupported");
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    upload.mockResolvedValue({ ok: true, storageId: "receipt" });
    const result = driveOwnedPluginMrtr(pending(), {
      signal: controller.signal,
      submit: vi.fn(async () => ({ ...pending(2), continuationId: "foreign" })),
      cancel,
    });
    await useHostedMrtrStore.getState().submit("disposable-continuation:1", {
      constructor: { action: "decline" },
    } as never);
    await expect(result).rejects.toThrow("Invalid owned");
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });
  it("expires a pending round without opening a worker or uploading an answer", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {}),
        submit = vi.fn();
      const result = driveOwnedPluginMrtr(
        { ...pending(), expiresAt: Date.now() + 10 },
        { signal: new AbortController().signal, submit, cancel },
      );
      const rejected = expect(result).rejects.toThrow("expired");
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(upload).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
