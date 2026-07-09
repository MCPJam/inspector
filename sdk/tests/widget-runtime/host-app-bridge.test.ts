import { describe, it, expect, vi } from "vitest";
import {
  createHostAppBridge,
  registerHostBridgeHandlers,
  type HostBridgeCallbacks,
} from "../../src/widget-runtime/host-app-bridge.js";

function makeBridge(callbacks: HostBridgeCallbacks) {
  const bridge = createHostAppBridge({
    hostInfo: { name: "test-host", version: "0.0.0" },
    hostCapabilities: { openLinks: {} },
  });
  registerHostBridgeHandlers(bridge, {
    effectiveHostCapabilities: { openLinks: {} },
    callbacks,
  });
  return bridge;
}

describe("ui/open-link scheme gate", () => {
  it("forwards http(s) URLs to the host", async () => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(
      bridge.onopenlink!({ url: "https://example.com/x" }, {} as never)
    ).resolves.toEqual({});
    await expect(
      bridge.onopenlink!({ url: "http://example.com/y" }, {} as never)
    ).resolves.toEqual({});

    expect(onOpenLink).toHaveBeenCalledTimes(2);
    expect(onOpenLink).toHaveBeenNthCalledWith(1, "https://example.com/x");
    expect(onOpenLink).toHaveBeenNthCalledWith(2, "http://example.com/y");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "about:blank",
  ])("rejects the dangerous scheme %s without calling the host", async (url) => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(bridge.onopenlink!({ url }, {} as never)).rejects.toThrow(
      /Policy violation/
    );
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL", async () => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(
      bridge.onopenlink!({ url: "not a url" }, {} as never)
    ).rejects.toThrow(/Policy violation/);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("no-ops on an empty url", async () => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(
      bridge.onopenlink!({ url: "" }, {} as never)
    ).resolves.toEqual({});
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});
