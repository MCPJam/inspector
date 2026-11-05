import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import {
  McpAppBrowserHarness,
  type McpAppBrowserHarnessOptions,
} from "../mcp-app-browser-harness";

const harnesses: McpAppBrowserHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

async function fixture(options: Partial<McpAppBrowserHarnessOptions> = {}) {
  const bindings = new Map<string, Parameters<Page["exposeBinding"]>[1]>();
  const frame = {} as Frame;
  const page = {
    on: vi.fn(),
    exposeBinding: vi.fn(async (name, callback) => bindings.set(name, callback)),
    goto: vi.fn(async () => null),
    setContent: vi.fn(async () => {}),
    addScriptTag: vi.fn(),
    mainFrame: () => frame,
  } as Pick<Page, "on" | "exposeBinding" | "goto" | "setContent" | "addScriptTag" | "mainFrame">;
  const context = {
    route: vi.fn(),
    newPage: vi.fn(async () => page as Page),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  } as Pick<BrowserContext, "route" | "newPage" | "on" | "close">;
  const browser = {
    newContext: vi.fn(async () => context as BrowserContext),
    close: vi.fn(async () => {}),
  } as Pick<Browser, "newContext" | "close">;
  class TestHarness extends McpAppBrowserHarness {
    protected async loadChromium() {
      return {
        executablePath: () => process.execPath,
        launch: vi.fn(async () => browser as Browser),
      };
    }
  }
  const callTool = vi.fn(async () => ({ content: [] }));
  const harness = new TestHarness({ callTool, readResource: vi.fn(), ...options });
  harnesses.push(harness);
  // Empty HTML installs the real Node bindings without a browser document.
  await harness.renderWidget({
    toolCallId: "view",
    serverId: "saved",
    toolName: "show",
    html: "",
  });
  harness["mounted"].set("view", { serverId: "saved", actionCount: 0 });
  const call = bindings.get("__mcpjamHostRpc")!;
  const source = { page: page as Page, frame, context: context as BrowserContext };
  return {
    harness,
    callTool,
    bindings,
    source,
    invoke: (name = "refresh") => call(source, {
      widgetId: "view", name, args: { value: 1 },
    }),
  };
}

describe("headless App server-tool admission", () => {
  it.each([{}, { serverTools: false }])(
    "does not dispatch without the host serverTools capability: %j",
    async (hostCapabilities) => {
      const f = await fixture({ hostCapabilities });
      expect(await f.invoke()).toHaveProperty("error");
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([{ visibility: ["model"] }, { visibility: ["model", "model"] }] as const)(
    "refuses explicit model-only visibility $visibility",
    async ({ visibility }) => {
      const f = await fixture({ resolveToolVisibility: () => [...visibility] });
      expect(await f.invoke()).toHaveProperty("error");
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { visibility: undefined },
    { visibility: ["app"] },
    { visibility: ["model", "app"] },
  ] as const)(
    "allows default or app-visible tools: $visibility",
    async ({ visibility }) => {
      const f = await fixture({
        resolveToolVisibility: () => visibility ? [...visibility] : undefined,
      });
      expect(await f.invoke()).toEqual({ result: { content: [] } });
      expect(f.callTool).toHaveBeenCalledWith("saved", "refresh", { value: 1 });
    },
  );

  it("checks current metadata on every call", async () => {
    let visibility: Array<"model" | "app"> = ["app"];
    const f = await fixture({ resolveToolVisibility: () => visibility });
    await f.invoke();
    visibility = ["model"];
    expect(await f.invoke()).toHaveProperty("error");
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses calls after the mounted owner closes", async () => {
    const f = await fixture();
    f.harness["mounted"].delete("view");
    expect(await f.invoke()).toHaveProperty("error");
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("refuses a replaced owner while metadata is being read", async () => {
    let release!: (visibility: Array<"model" | "app">) => void;
    const pending = new Promise<Array<"model" | "app">>((resolve) => { release = resolve; });
    const f = await fixture({ resolveToolVisibility: () => pending });
    const request = f.invoke();
    expect(f.harness["pendingRpcCount"]).toBe(1);
    f.harness["mounted"].set("view", { serverId: "other", actionCount: 0 });
    release(["app"]);
    expect(await request).toHaveProperty("error");
    expect(f.harness["pendingRpcCount"]).toBe(0);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("refuses dispatch when current metadata cannot be read", async () => {
    const f = await fixture({ resolveToolVisibility: async () => { throw new Error("unavailable"); } });
    expect(await f.invoke()).toHaveProperty("error");
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("rechecks host permissions after metadata lookup", async () => {
    const hostCapabilities = { serverTools: {} as object };
    let release!: (visibility: Array<"model" | "app">) => void;
    const pending = new Promise<Array<"model" | "app">>((resolve) => { release = resolve; });
    const f = await fixture({ hostCapabilities, resolveToolVisibility: () => pending });
    const request = f.invoke();
    f.harness["opts"].hostCapabilities = {};
    release(["app"]);
    expect(await request).toHaveProperty("error");
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.harness["pendingRpcCount"]).toBe(0);
  });

  it("does not retain messages when the host disables them", async () => {
    const f = await fixture({ hostCapabilities: { serverTools: {} } });
    await f.bindings.get("__mcpjamHostFollowUp")!(f.source, { widgetId: "view", text: "hello" });
    expect(f.harness["followUpBuffer"]).toEqual([]);
  });

  it.each(["frame", "page"] as const)("refuses calls from a different %s", async (field) => {
    const f = await fixture();
    const source = { ...f.source, [field]: {} };
    expect(await f.bindings.get("__mcpjamHostRpc")!(source, {
      widgetId: "view", name: "refresh", args: {},
    })).toHaveProperty("error");
    expect(f.callTool).not.toHaveBeenCalled();
    expect(await f.bindings.get("__mcpjamHostReadResource")!(source, {
      widgetId: "view", params: { uri: "resource://file" },
    })).toHaveProperty("error");
    await expect(f.bindings.get("__mcpjamHostContext")!(source, {
      widgetId: "view", params: {},
    })).rejects.toThrow("Host binding unavailable");
    await f.bindings.get("__mcpjamHostFollowUp")!(source, {
      widgetId: "view", text: "hello",
    });
    expect(f.harness["followUpBuffer"]).toEqual([]);
  });
});
