import { describe, it, expect, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  // Per the ext-apps App.openLink contract, a host policy block resolves
  // { isError: true } (NOT a throw — throws are reserved for transport/timeout),
  // so the widget's documented `const { isError } = await app.openLink()` path
  // runs its fallback instead of hitting an unhandled rejection.
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "about:blank",
  ])(
    "resolves { isError: true } for the dangerous scheme %s without calling the host",
    async (url) => {
      const onOpenLink = vi.fn();
      const bridge = makeBridge({ onOpenLink });

      await expect(bridge.onopenlink!({ url }, {} as never)).resolves.toEqual({
        isError: true,
      });
      expect(onOpenLink).not.toHaveBeenCalled();
    }
  );

  it("resolves { isError: true } for a malformed URL", async () => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(
      bridge.onopenlink!({ url: "not a url" }, {} as never)
    ).resolves.toEqual({ isError: true });
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("resolves { isError: true } on an empty url", async () => {
    const onOpenLink = vi.fn();
    const bridge = makeBridge({ onOpenLink });

    await expect(bridge.onopenlink!({ url: "" }, {} as never)).resolves.toEqual(
      { isError: true }
    );
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});

describe("owned App navigation", () => {
  it.each([
    "codex://plugins/p/app",
    "chatgpt://plugins/p/app",
    "https://chatgpt.com/plugins/p/app",
  ])("awaits admitted navigation for %s", async (url) => {
    const onOpenLink = vi.fn();
    let done!: () => void;
    const onOpenAppLink = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    const bridge = makeBridge({ onOpenLink, onOpenAppLink });
    let settled = false;
    const result = bridge.onopenlink!({ url }, {} as never).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await expect(result).resolves.toEqual({});
    expect(onOpenAppLink).toHaveBeenCalledWith(url);
    expect(onOpenLink).not.toHaveBeenCalled();
  });
  it("refuses missing or rejected ownership without external fallback", async () => {
    const onOpenLink = vi.fn();
    for (const onOpenAppLink of [
      undefined,
      vi.fn().mockRejectedValue(new Error("denied")),
    ]) {
      const bridge = makeBridge({ onOpenLink, onOpenAppLink });
      await expect(
        bridge.onopenlink!({ url: "codex://plugins/p/app" }, {} as never)
      ).resolves.toEqual({ isError: true });
    }
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});

describe("owned resource request callback", () => {
  it("preserves full request parameters and cancellation context", async () => {
    const bridge = createHostAppBridge({
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: { serverResources: {} },
    });
    const result = {
      contents: [
        {
          uri: "host-resource://file",
          text: "owned",
          _meta: { "openai/resource": { etag: "v1", writable: true } },
        },
      ],
    };
    const read = vi.fn(async () => result);
    const legacy = vi.fn();
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: { serverResources: {} },
      callbacks: { onReadResourceV2: read, onReadResource: legacy },
    });
    const params = {
      uri: "host-resource://file",
      _meta: { representation: "text" },
    };
    const extra = { signal: new AbortController().signal } as never;
    await expect(bridge.onreadresource!(params, extra)).resolves.toEqual(
      result
    );
    expect(read).toHaveBeenCalledWith(params, extra);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("keeps the callback unavailable without server resource capability", () => {
    const bridge = createHostAppBridge({
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: {},
    });
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: {},
      callbacks: { onReadResourceV2: vi.fn() },
    });
    expect(bridge.onreadresource).toBeUndefined();
  });
});

describe("owned model context acknowledgement", () => {
  it("returns the persisted acknowledgement without copying through the legacy callback", async () => {
    const legacy = vi.fn();
    const acknowledgement = {
      _meta: { "openai/modelContext": { updateId: "persisted" } },
    };
    const update = vi.fn().mockResolvedValue(acknowledgement);
    const bridge = createHostAppBridge({
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: { updateModelContext: {} },
    });
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: { updateModelContext: {} },
      callbacks: {
        onUpdateModelContext: legacy,
        onUpdateModelContextV2: update,
      },
    });
    await expect(
      bridge.onupdatemodelcontext!(
        { content: [{ type: "text", text: "state" }] },
        {} as never
      )
    ).resolves.toEqual(acknowledgement);
    expect(update).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("owned complete message", () => {
  it("awaits all content and metadata without truncating to first text", async () => {
    const legacy = vi.fn();
    const send = vi.fn().mockResolvedValue({});
    const bridge = createHostAppBridge({
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: { message: {} },
    });
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: { message: {} },
      callbacks: { onSendFollowUp: legacy, onSendMessage: send },
    });
    const params = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "first" },
        {
          type: "text" as const,
          text: "second",
          _meta: { "openai/title": "Selection" },
        },
      ],
      _meta: { "openai/message": { target: "new" } },
    };
    await expect(bridge.onmessage!(params, {} as never)).resolves.toEqual({});
    expect(send).toHaveBeenCalledWith(params);
    expect(legacy).not.toHaveBeenCalled();
  });
});

it.each(["factory", "retained-official"])(
  "preserves message extensions through the actual %s bridge transport",
  async (kind) => {
    const dispatched = vi.fn();
    const received = vi.fn(async (params: unknown) => {
      const message = params as {
        _meta?: { "openai/message"?: { send?: unknown } };
      };
      if (message._meta?.["openai/message"]?.send === false)
        throw new Error("Unsupported send option");
      dispatched(params);
      return {};
    });
    const bridge =
      kind === "factory"
        ? createHostAppBridge({
            hostInfo: { name: "host", version: "1" },
            hostCapabilities: { message: {} },
          })
        : new AppBridge(null, { name: "host", version: "1" }, { message: {} });
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: { message: {} },
      callbacks: { onSendMessage: received },
    });
    const app = new App(
      { name: "app", version: "1" },
      {},
      { autoResize: false }
    );
    const [hostTransport, guestTransport] =
      InMemoryTransport.createLinkedPair();
    await bridge.connect(hostTransport);
    await app.connect(guestTransport);
    const content = [
      {
        type: "text" as const,
        text: "Exact title",
        _meta: { "openai/title": "Selected" },
      },
    ];
    try {
      await expect(
        app.sendMessage({
          role: "user",
          content,
          _meta: { "openai/message": { target: "active", send: false } },
        } as never)
      ).rejects.toThrow("Unsupported send option");
      expect(dispatched).not.toHaveBeenCalled();
      const params = {
        role: "user" as const,
        content,
        _meta: { "openai/message": { target: "new", send: true } },
      };
      await app.sendMessage(params);
      expect(received).toHaveBeenCalledTimes(2);
      expect(dispatched).toHaveBeenCalledExactlyOnceWith(params);
    } finally {
      await app.close();
      await bridge.close();
    }
  }
);
