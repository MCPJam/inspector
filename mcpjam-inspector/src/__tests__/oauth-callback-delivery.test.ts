import { describe, expect, it, vi } from "vitest";
import { OAuthCallbackDelivery } from "../oauth-callback-delivery";
describe("MCP callback delivery", () => {
  it("queues and deduplicates cold-launch callbacks until the listener is installed", () => {
    const send = vi.fn();
    const delivery = new OAuthCallbackDelivery(send);
    delivery.enqueue("first");
    delivery.enqueue("first");
    expect(send).not.toHaveBeenCalled();
    delivery.setReady(true);
    delivery.setReady(true);
    expect(send.mock.calls).toEqual([["first"]]);
  });
  it("delivers warm callbacks and waits again after a document unload", () => {
    const send = vi.fn();
    const delivery = new OAuthCallbackDelivery(send);
    delivery.setReady(true);
    delivery.enqueue("first");
    delivery.setReady(false);
    delivery.enqueue("second");
    expect(send.mock.calls).toEqual([["first"]]);
    delivery.setReady(true);
    expect(send.mock.calls).toEqual([["first"], ["second"]]);
  });
});
