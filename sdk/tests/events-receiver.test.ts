import { describe, expect, it } from "vitest";
import { checkCallbackUrl } from "../src/events/receiver.js";
import { MemoryEventInbox } from "../src/events/memory-inbox.js";

describe("webhook callback URLs", () => {
  it.each([
    ["https://name:secret@proxy.example/hooks", "Remove the credentials from the callback URL."],
    ["https://proxy.example/hooks?", "Remove the query string or fragment from the callback URL."],
    ["https://proxy.example/hooks#x", "Remove the query string or fragment from the callback URL."],
    ["ftp://proxy.example/hooks", "Use https:// or http:// for the callback URL."],
  ])("refuses %s", (url, reason) => {
    expect(checkCallbackUrl(url)).toEqual({ ok: false, reason });
  });

  it.each([
    ["https://proxy.example/hooks", false],
    ["http://host.docker.internal:6274/api/mcp/events/hooks", true],
  ])("recognizes %s", (url, insecure) => {
    expect(checkCallbackUrl(url)).toEqual({ ok: true, url: new URL(url), insecure });
  });

  it("pins the URL on allocation, including when the same allocation is retried", async () => {
    let base = "https://proxy.example/hooks/server";
    const inbox = new MemoryEventInbox({
      inboxId: "inbox",
      publicOrigin: "http://localhost:6274",
      resolveCallbackBase: () => base,
    });
    const args = {
      logicalSubscriptionId: "subscription",
      projectId: "project",
      environmentId: null,
      bindingKey: "binding",
      dispatch: true,
      idempotencyKey: "first",
    };
    const slot = await inbox.allocateSlot(args);
    expect(slot.callbackUrl).toBe(`${base}/i/inbox/s/${slot.slotId}`);
    base = "https://other.example/hooks/server";
    expect(await inbox.allocateSlot(args)).toEqual(slot);
    expect(inbox.callbackUrlFor(slot.slotId)).toBe(slot.callbackUrl);
  });
});
