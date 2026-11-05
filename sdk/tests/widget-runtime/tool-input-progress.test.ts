import { afterEach, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createHostAppBridge,
  registerHostBridgeHandlers,
  type AppToolRequestContext,
} from "../../src/widget-runtime/host-app-bridge.js";

afterEach(() => vi.useRealTimers());
async function fixture(waiting: boolean, fakeTime = true) {
  let context!: AppToolRequestContext;
  let finish!: () => void;
  const call = vi.fn(async (_name, _args, current?: AppToolRequestContext) => {
    if (!current) throw new Error("Missing request context");
    context = current;
    current.onInputPending(waiting);
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      current.signal.addEventListener(
        "abort",
        () => reject(current.signal.reason),
        { once: true }
      );
    });
    current.onInputPending(false);
    return { content: [{ type: "text" as const, text: "done" }] };
  });
  const debug = vi.fn();
  const bridge = createHostAppBridge({
    hostInfo: { name: "host", version: "1" },
    hostCapabilities: { serverTools: {} },
  });
  registerHostBridgeHandlers(bridge, {
    effectiveHostCapabilities: { serverTools: {} },
    callbacks: { onCallTool: call },
    onWidgetDebug: debug,
  });
  const app = new App(
    { name: "review", version: "1" },
    {},
    { autoResize: false }
  );
  const [host, guest] = InMemoryTransport.createLinkedPair();
  const hostSend = vi.spyOn(host, "send"),
    guestSend = vi.spyOn(guest, "send");
  await bridge.connect(host);
  await app.connect(guest);
  if (fakeTime)
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
  const progress = () =>
    hostSend.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          "method" in message && message.method === "notifications/progress"
      );
  return {
    app,
    debug,
    call,
    finish: () => finish(),
    context: () => context,
    progress,
    guestSend,
    guest,
    bridge,
    host,
    hostSend,
    close: async () => {
      await app.close();
      await bridge.close();
    },
  };
}

it("keeps the actual App.callServerTool alive past 60 seconds only while human input is pending", async () => {
  const f = await fixture(true);
  try {
    let settled = false;
    const result = f.app.callServerTool({ name: "review" }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled).toBe(false);
    expect(f.call).toHaveBeenCalledOnce();
    const request = f.guestSend.mock.calls
      .map(([message]) => message)
      .find(
        (message) => "method" in message && message.method === "tools/call"
      );
    const token =
      request && "params" in request
        ? request.params?._meta?.progressToken
        : undefined;
    expect(typeof token).toBe("number");
    expect(f.progress()).toHaveLength(4);
    for (const message of f.progress())
      expect(message).toMatchObject({ params: { progressToken: token } });
    f.finish();
    await expect(result).resolves.toMatchObject({
      content: [{ text: "done" }],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.progress()).toHaveLength(4);
  } finally {
    await f.close();
  }
});

it("does not keep an ordinary stalled tool alive", async () => {
  const f = await fixture(false);
  try {
    const result = f.app.callServerTool({ name: "stalled" });
    const failure = expect(result).rejects.toMatchObject({ code: -32001 });
    await vi.advanceTimersByTimeAsync(61_000);
    await failure;
    expect(f.progress()).toEqual([]);
  } finally {
    await f.close();
  }
});

it("stops pending-input progress when the caller cancels", async () => {
  const f = await fixture(true);
  try {
    const controller = new AbortController();
    const result = f.app.callServerTool(
      { name: "review" },
      { signal: controller.signal }
    );
    const failure = expect(result).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(20_000);
    controller.abort();
    await failure;
    await vi.advanceTimersByTimeAsync(0);
    const count = f.progress().length;
    expect(f.context().signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.progress()).toHaveLength(count);
  } finally {
    await f.close();
  }
});

it.each(["stop", "dispose", "abort"])(
  "never sends queued progress after %s",
  async (action) => {
    const { createToolInputProgress } =
      await import("../../src/widget-runtime/tool-input-progress.js");
    const controller = new AbortController();
    const notify = vi.fn(async () => {});
    const progress = createToolInputProgress(controller.signal, notify);
    progress.setPending(true);
    if (action === "stop") progress.setPending(false);
    else if (action === "dispose") progress.dispose();
    else controller.abort();
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    progress.dispose();
    progress.setPending(true);
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  }
);

it("does not invent progress tokens for callers opting out", async () => {
  const f = await fixture(true);
  try {
    const result = f.app.callServerTool(
      { name: "review" },
      { onprogress: undefined }
    );
    const failure = expect(result).rejects.toMatchObject({ code: -32001 });
    await vi.advanceTimersByTimeAsync(61_000);
    await failure;
    expect(f.progress()).toEqual([]);
  } finally {
    await f.close();
  }
});

it.runIf(process.env.RUN_SLOW_PLUGIN_PROGRESS === "1")(
  "keeps an actual App request open across 61 seconds of wall time",
  async () => {
    const f = await fixture(true, false);
    const started = Date.now();
    try {
      let settled = false;
      const result = f.app.callServerTool({ name: "review" }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      expect(settled).toBe(false);
      expect(f.progress()).toHaveLength(4);
      f.finish();
      await expect(result).resolves.toMatchObject({
        content: [{ text: "done" }],
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(61_000);
    } finally {
      await f.close();
    }
  },
  70_000
);

it("stops and reports a failed progress send", async () => {
  const { createToolInputProgress } =
    await import("../../src/widget-runtime/tool-input-progress.js");
  vi.useFakeTimers();
  const error = new Error("Closed transport");
  const notify = vi.fn(async () => {
    throw error;
  });
  const report = vi.fn();
  const progress = createToolInputProgress(
    new AbortController().signal,
    notify,
    report
  );
  progress.setPending(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(notify).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(error);
  progress.dispose();
});

it("preserves a caller's total timeout during human input", async () => {
  const f = await fixture(true);
  try {
    const result = f.app.callServerTool(
      { name: "review" },
      { maxTotalTimeout: 30_000 }
    );
    const failure = expect(result).rejects.toMatchObject({ code: -32001 });
    await vi.advanceTimersByTimeAsync(40_000);
    await failure;
    expect(f.progress().length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});


it("ties progress to request id zero and a string token on the original transport", async () => {
  const f = await fixture(true);
  try {
    let finish!: (message: unknown) => void;
    const result = new Promise((resolve) => { finish = resolve; });
    f.guest.onmessage = (message) => { if ("id" in message && message.id === 0) finish(message); };
    await f.guest.send({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "review", arguments: {}, _meta: { progressToken: "form-token" } } });
    await vi.advanceTimersByTimeAsync(20_000);
    const sent = f.hostSend.mock.calls.filter(([message]) => "method" in message && message.method === "notifications/progress");
    expect(sent.length).toBeGreaterThan(0);
    for (const [message, options] of sent) {
      expect(message).toMatchObject({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "form-token" } });
      expect(options).toEqual({ relatedRequestId: 0 });
    }
    f.finish();
    await expect(result).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
  } finally { await f.close(); }
});

it("stops the old request before a different bridge transport can receive progress", async () => {
  const f = await fixture(true);
  const result = f.app.callServerTool({ name: "review" });
  const failure = expect(result).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(20_000);
  await f.bridge.close();
  await failure;
  const [nextHost, nextGuest] = InMemoryTransport.createLinkedPair();
  const nextSend = vi.spyOn(nextHost, "send");
  try {
    await f.bridge.connect(nextHost);
    await nextGuest.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(nextSend).not.toHaveBeenCalled();
    expect(f.context().signal.aborted).toBe(true);
    expect(f.call).toHaveBeenCalledOnce();
  } finally { await nextGuest.close(); await f.close(); }
});


it("refuses progress through a different transport while the original call can finish", async () => {
  const f = await fixture(true);
  const [other] = InMemoryTransport.createLinkedPair();
  const otherSend = vi.spyOn(other, "send");
  const result = f.app.callServerTool({ name: "review" });
  await vi.advanceTimersByTimeAsync(0);
  const count = f.progress().length;
  const transport = vi.spyOn(f.bridge, "transport", "get").mockReturnValue(other);
  try {
    await vi.advanceTimersByTimeAsync(40_000);
    expect(otherSend).not.toHaveBeenCalled();
    expect(f.progress()).toHaveLength(count);
    expect(f.debug).toHaveBeenCalledWith("host-to-ui", "notifications/progress", { error: "App request transport is no longer connected" });
    transport.mockRestore();
    f.finish();
    await expect(result).resolves.toMatchObject({ content: [{ text: "done" }] });
    expect(f.call).toHaveBeenCalledOnce();
  } finally { transport.mockRestore(); await other.close(); await f.close(); }
});

it("reports one rejected transport progress send without replaying the tool", async () => {
  const f = await fixture(true);
  f.hostSend.mockRejectedValueOnce(new Error("Transport closed"));
  try {
    const result = f.app.callServerTool({ name: "review" });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.debug).toHaveBeenCalledWith("host-to-ui", "notifications/progress", { error: "Transport closed" });
    expect(f.progress()).toHaveLength(1);
    f.finish();
    await expect(result).resolves.toMatchObject({ content: [{ text: "done" }] });
    expect(f.call).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
