import { describe, expect, it, vi } from "vitest";
import { streamListedFileUpdates } from "../listed-file-subscription.js";
describe("request-owned listed resource subscription", () => {
  it("maps exact notifications to opaque URIs and unsubscribes on close", async () => {
    const controller = new AbortController();
    let notify!: (value: { params: { uri: string } }) => void;
    const manager = {
      onResourceUpdated: vi.fn((_id, handler) => {
        notify = handler;
      }),
      subscribeResource: vi.fn(async () => ({})),
      unsubscribeResource: vi.fn(async () => ({})),
    };
    const authorize = vi.fn(async () => {});
    const emit = vi.fn(async () => {
      controller.abort();
    });
    const running = streamListedFileUpdates({
      manager,
      serverId: "saved",
      sourceUri: "private://a",
      publicUri: "host-resource://a",
      signal: controller.signal,
      authorize,
      emit,
    });
    await vi.waitFor(() =>
      expect(manager.subscribeResource).toHaveBeenCalledOnce(),
    );
    notify({ params: { uri: "private://other" } });
    notify({ params: { uri: "private://a" } });
    await running;
    expect(emit).toHaveBeenCalledExactlyOnceWith("host-resource://a");
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(manager.unsubscribeResource).toHaveBeenCalledOnce();
    notify({ params: { uri: "private://a" } });
    expect(emit).toHaveBeenCalledOnce();
  });
  it("refuses delivery after fresh authority is withdrawn", async () => {
    const controller = new AbortController();
    let notify!: (value: { params: { uri: string } }) => void;
    const manager = {
      onResourceUpdated: vi.fn((_id, handler) => {
        notify = handler;
      }),
      subscribeResource: vi.fn(async () => ({})),
      unsubscribeResource: vi.fn(async () => ({})),
    };
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("denied"));
    const emit = vi.fn();
    const running = streamListedFileUpdates({
      manager,
      serverId: "saved",
      sourceUri: "private://a",
      publicUri: "host-resource://a",
      signal: controller.signal,
      authorize,
      emit,
    });
    const settled = expect(running).rejects.toThrow("denied");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    notify({ params: { uri: "private://a" } });
    await settled;
    expect(emit).not.toHaveBeenCalled();
    expect(manager.unsubscribeResource).toHaveBeenCalledOnce();
  });
});
