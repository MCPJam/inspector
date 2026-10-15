import { describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import { createFileResourceBridge } from "../file-resource-bridge";

function fixture(caps = { write: true, subscribe: true }) {
  const handlers = new Map<
    string,
    (request: unknown, extra: unknown) => Promise<unknown>
  >();
  const notification = vi.fn(async () => {});
  const bridge = {
    setRequestHandler: (
      schema: {
        shape: { method: { value: string } };
        parse: (value: unknown) => unknown;
      },
      handler: (request: unknown, extra: unknown) => Promise<unknown>,
    ) =>
      handlers.set(schema.shape.method.value, async (request, extra) =>
        handler(schema.parse(request), extra),
      ),
    notification,
  };
  const send = vi.fn(async () => ({ outcome: "saved", etag: "opaque" }));
  let live = true;
  const adapter = createFileResourceBridge({
    uri: "host-resource://owned",
    capabilities: caps,
    send,
    requireLive: () => {
      if (!live) throw new Error("closed");
    },
  });
  return {
    handlers,
    send,
    notification,
    adapter,
    configure: (
      hostCaps: Parameters<
        NonNullable<WidgetHost["services"]["configureAppBridge"]>
      >[1] = { serverResources: {}, experimental: { "openai/resource": {} } },
    ) => adapter.configureAppBridge(bridge as never, hostCaps),
    closeOwner: () => {
      live = false;
    },
    extra: { signal: new AbortController().signal },
  };
}

describe("owned resource extension bridge", () => {
  it("withholds handlers without negotiated resources or a live operation port", () => {
    const a = fixture();
    a.configure({});
    expect(a.handlers.size).toBe(0);
    const b = fixture();
    b.configure({ serverResources: {} });
    expect(b.handlers.size).toBe(0);
    const c = fixture({ write: false, subscribe: false });
    c.configure();
    expect(c.handlers.size).toBe(0);
  });
  it("validates complete writes and forwards cancellation without treating metadata as authority", async () => {
    const f = fixture();
    f.configure();
    const write = f.handlers.get("openai/resources/write")!;
    await expect(
      write(
        {
          method: "openai/resources/write",
          params: {
            uri: "host-resource://owned",
            text: "save",
            ifMatch: "version",
            _meta: { opaque: [1] },
          },
        },
        f.extra,
      ),
    ).resolves.toEqual({ outcome: "saved", etag: "opaque" });
    expect(f.send).toHaveBeenCalledWith(
      "write-resource",
      { uri: "host-resource://owned", text: "save", ifMatch: "version" },
      f.extra.signal,
    );
    await expect(
      write(
        {
          method: "openai/resources/write",
          params: { uri: "host-resource://owned", text: "save", blob: "" },
        },
        f.extra,
      ),
    ).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("ignores foreign notification handles and stops delivery synchronously on cleanup", async () => {
    const f = fixture();
    const release = f.configure();
    await f.adapter.resourceUpdated("host-resource://foreign");
    expect(f.notification).not.toHaveBeenCalled();
    await f.adapter.resourceUpdated("host-resource://owned");
    expect(f.notification).toHaveBeenCalledWith({
      method: "notifications/resources/updated",
      params: { uri: "host-resource://owned" },
    });
    release?.();
    await f.adapter.resourceUpdated("host-resource://owned");
    expect(f.notification).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith("unsubscribe-resource", {
      uri: "host-resource://owned",
    });
  });
  it("refuses cancelled or closed requests and withholds late results", async () => {
    const f = fixture();
    f.configure();
    const write = f.handlers.get("openai/resources/write")!;
    const request = {
      method: "openai/resources/write",
      params: { uri: "host-resource://owned", text: "save" },
    };
    await expect(
      write(request, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(async () => {
      f.closeOwner();
      return { outcome: "saved", etag: "opaque" };
    });
    await expect(write(request, f.extra)).rejects.toThrow("closed");
    await expect(write(request, f.extra)).rejects.toThrow("closed");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
