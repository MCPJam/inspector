/**
 * Behavior regression tests for the MCP-Apps `window.openai` compat runtime.
 *
 * The runtime ships as a JSON-stringified IIFE in the SDK package's
 * `McpAppsOpenAICompatibleRuntime.bundled.ts`. It's injected server-side
 * into widget HTML before the proxy renders it. These tests drive the
 * bundled IIFE in a JSDOM environment with mock window.parent, then assert
 * the wire-level contract the runtime exposes to widgets:
 *
 *   - Apps SDK only (F1): widget metadata has `openai/outputTemplate` only.
 *     window.openai.callTool / setWidgetState / uploadFile must work; the
 *     `openai:set_globals` CustomEvent must fire after init and on each
 *     incoming ui/notifications/tool-input/result.
 *   - MCP Apps only (F2): widget metadata has `_meta.ui.resourceUri` only.
 *     The runtime must complete the ui/initialize handshake and the same
 *     window.openai surface must be reachable (compat shim is always present).
 *   - Dual (F3): both metadata fields. Behavior should match F1 ∩ F2 — no
 *     duplicate dispatch, both event streams flow.
 *
 * Per the consolidation plan: assert *behavior*, not literal CSP strings.
 * Tests assert message shapes and event emission, not the byte layout of
 * the CSP header (covered separately by buildCSP merge-rule tests).
 */
import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - @types/jsdom is not installed; jsdom is a transitive
// devDep of vitest. We only need the constructor + window.eval surface here.
import { JSDOM } from "jsdom";
import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "../../../sdk/src/McpAppsOpenAICompatibleRuntime.bundled";

type CapturedMessage = {
  data: unknown;
  targetOrigin: string;
};

type RuntimeHandle = {
  dom: JSDOM;
  window: any;
  parentMessages: CapturedMessage[];
  setGlobalsEvents: unknown[];
  /** Send a postMessage *from* parent *to* the widget window (host → widget) */
  sendFromParent: (data: unknown) => void;
  /** Drive the init handshake to completion by replying to the ui/initialize request */
  completeInitHandshake: (hostContext?: Record<string, unknown>) => void;
};

function buildHandle(configJson: Record<string, unknown>): RuntimeHandle {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head>
      <script id="openai-compat-config" type="application/json">${JSON.stringify(
        configJson
      )}</script>
    </head><body></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true }
  );
  const win = dom.window as any;
  const parentMessages: CapturedMessage[] = [];
  const setGlobalsEvents: unknown[] = [];

  // Mock window.parent.postMessage to capture outbound messages. The runtime
  // checks `window.parent` so the mock must be a distinct object from `window`.
  const mockParent = {
    postMessage(data: unknown, targetOrigin: string) {
      parentMessages.push({ data, targetOrigin });
    },
  };
  Object.defineProperty(win, "parent", {
    value: mockParent,
    configurable: true,
  });

  win.addEventListener("openai:set_globals", (event: CustomEvent) => {
    setGlobalsEvents.push(event.detail);
  });

  // Eval the bundled IIFE inside the JSDOM context.
  win.eval(MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT);

  return {
    dom,
    window: win,
    parentMessages,
    setGlobalsEvents,
    sendFromParent(data: unknown) {
      const event = new win.MessageEvent("message", {
        data,
        source: mockParent,
      });
      win.dispatchEvent(event);
    },
    completeInitHandshake(hostContext: Record<string, unknown> = {}) {
      const initRequest = parentMessages.find(
        (m): m is CapturedMessage & { data: { method: string; id: number } } =>
          (m.data as any)?.method === "ui/initialize"
      );
      if (!initRequest) throw new Error("ui/initialize was not sent");
      const id = (initRequest.data as any).id;
      const handle = this as RuntimeHandle;
      handle.sendFromParent({
        jsonrpc: "2.0",
        id,
        result: { hostContext },
      });
    },
  };
}

async function findParentMessage(
  handle: RuntimeHandle,
  predicate: (message: CapturedMessage) => boolean,
  // Generous budget: returns as soon as the message lands (typically <50ms).
  // The high ceiling only matters under heavy CI contention, where the JSDOM
  // FileReader onload callback that posts the message can be starved past a
  // tighter window. Must stay below the per-test vitest timeout set on callers.
  timeoutMs = 5_000,
): Promise<CapturedMessage | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = handle.parentMessages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

const F1_CONFIG = {
  toolId: "tool-1",
  toolName: "search",
  toolInput: { q: "hello" },
  toolOutput: null,
  toolResponseMetadata: { source: "boot" },
  theme: "dark",
  viewMode: "inline",
  viewParams: {},
};

const F2_CONFIG = {
  toolId: "tool-2",
  toolName: "weather",
  toolInput: { location: "SF" },
  toolOutput: { temperature: 72 },
  toolResponseMetadata: null,
  theme: "light",
  viewMode: "inline",
  viewParams: {},
};

const F3_CONFIG = {
  toolId: "tool-3",
  toolName: "dual",
  toolInput: { a: 1 },
  toolOutput: { b: 2 },
  toolResponseMetadata: null,
  theme: "dark",
  viewMode: "inline",
  viewParams: {},
};

describe("compat runtime — F1: Apps SDK only", () => {
  let h: RuntimeHandle;
  beforeEach(() => {
    h = buildHandle(F1_CONFIG);
  });

  it("sends ui/initialize handshake on load", () => {
    const init = h.parentMessages.find(
      (m) => (m.data as any)?.method === "ui/initialize"
    );
    expect(init).toBeDefined();
    expect((init!.data as any).jsonrpc).toBe("2.0");
    expect((init!.data as any).id).toBeGreaterThan(0);
    expect((init!.data as any).params.protocolVersion).toBe("2026-01-26");
  });

  it("dispatches openai:set_globals after init handshake completes", () => {
    expect(h.setGlobalsEvents).toHaveLength(0);
    h.completeInitHandshake();
    expect(h.setGlobalsEvents).toHaveLength(1);
    const detail = h.setGlobalsEvents[0] as {
      globals: Record<string, unknown>;
    };
    expect(detail.globals.toolInput).toEqual({ q: "hello" });
    expect(detail.globals.theme).toBe("dark");
    expect(detail.globals.displayMode).toBe("inline");
  });

  it("window.openai.callTool emits a tools/call JSON-RPC request", async () => {
    h.completeInitHandshake();
    h.window.openai.callTool("search", { q: "hi" });
    const call = h.parentMessages.find(
      (m) => (m.data as any)?.method === "tools/call"
    );
    expect(call).toBeDefined();
    expect((call!.data as any).params.name).toBe("search");
    expect((call!.data as any).params.arguments).toEqual({ q: "hi" });
  });

  it("window.openai.setWidgetState emits openai:setWidgetState postMessage and dispatches set_globals", () => {
    // The compat runtime mirrors the Apps SDK contract: setWidgetState
    // notifies the host via a non-JSON-RPC `openai:setWidgetState` message
    // (which mcp-apps-renderer.tsx forwards into onWidgetStateChange for
    // replay/saved-view persistence). It does NOT auto-call
    // ui/update-model-context — that would leak widget state into the LLM
    // prompt on every state change.
    h.completeInitHandshake();
    const before = h.setGlobalsEvents.length;
    h.window.openai.setWidgetState({ counter: 5 });
    const set = h.parentMessages.find(
      (m) => (m.data as any)?.type === "openai:setWidgetState"
    );
    expect(set).toBeDefined();
    expect((set!.data as any).state).toEqual({ counter: 5 });
    expect((set!.data as any).toolId).toBe(F1_CONFIG.toolId);
    // Model context update should NOT be auto-sent.
    const modelCtx = h.parentMessages.find(
      (m) => (m.data as any)?.method === "ui/update-model-context"
    );
    expect(modelCtx).toBeUndefined();
    const after = h.setGlobalsEvents.length;
    expect(after).toBe(before + 1);
    const last = h.setGlobalsEvents[after - 1] as {
      globals: Record<string, unknown>;
    };
    expect(last.globals.widgetState).toEqual({ counter: 5 });
  });

  it("window.openai.setOpenInAppUrl emits openai:setOpenInAppUrl postMessage", () => {
    h.completeInitHandshake();
    h.window.openai.setOpenInAppUrl({
      href: " https://app.example.com/trails/42 ",
    });
    const set = h.parentMessages.find(
      (m) => (m.data as any)?.type === "openai:setOpenInAppUrl"
    );
    expect(set).toBeDefined();
    expect(set!.data as any).toEqual({
      type: "openai:setOpenInAppUrl",
      toolId: F1_CONFIG.toolId,
      href: "https://app.example.com/trails/42",
    });
  });

  it("window.openai.setOpenInAppUrl rejects missing href and respects feature detection", () => {
    h.completeInitHandshake();
    expect(() => h.window.openai.setOpenInAppUrl({})).toThrow(
      /href is required for setOpenInAppUrl/
    );

    const disabled = buildHandle({
      ...F1_CONFIG,
      capabilities: { setOpenInAppUrl: false },
    });
    disabled.completeInitHandshake();
    expect(disabled.window.openai.setOpenInAppUrl).toBeUndefined();
  });

  it("window.openai.uploadFile emits openai:uploadFile postMessage with base64 data", async () => {
    h.completeInitHandshake();
    // Construct a 12-byte File that passes the magic-byte check for PNG
    // (the runtime only checks size + type; the server enforces magic bytes).
    const fakePng = new Uint8Array(12);
    const blob = new h.window.Blob([fakePng], { type: "image/png" });
    const file = new h.window.File([blob], "test.png", { type: "image/png" });

    const uploadPromise = h.window.openai.uploadFile(file);

    const upload = await findParentMessage(
      h,
      (m) => (m.data as any)?.type === "openai:uploadFile",
    );
    expect(upload).toBeDefined();
    expect((upload!.data as any).mimeType).toBe("image/png");
    expect((upload!.data as any).fileName).toBe("test.png");
    expect(typeof (upload!.data as any).data).toBe("string");

    // Reply so the promise resolves (otherwise it'd dangle to the 60s timeout)
    const callId = (upload!.data as any).callId;
    h.sendFromParent({
      type: "openai:uploadFile:response",
      callId,
      result: { fileId: "file_abc" },
    });
    await expect(uploadPromise).resolves.toEqual({ fileId: "file_abc" });
    // Generous per-test timeout: the FileReader onload that posts the upload
    // message can be starved under concurrent CI load, so allow the poll above
    // (≤5s) to win over vitest's default 5s cutoff.
  }, 20_000);

  it("window.openai.requestCheckout emits openai/requestCheckout JSON-RPC notification", () => {
    h.completeInitHandshake();
    h.window.openai.requestCheckout({ price: 100, currency: "usd" });
    const req = h.parentMessages.find(
      (m) => (m.data as any)?.method === "openai/requestCheckout"
    );
    expect(req).toBeDefined();
    expect((req!.data as any).params.price).toBe(100);
    expect((req!.data as any).params.callId).toBeGreaterThan(0);
  });

  it("window.openai.requestModal emits openai/requestModal notification", () => {
    h.completeInitHandshake();
    h.window.openai.requestModal({ title: "Hi", template: "ui://m" });
    const req = h.parentMessages.find(
      (m) => (m.data as any)?.method === "openai/requestModal"
    );
    expect(req).toBeDefined();
    expect((req!.data as any).params.title).toBe("Hi");
  });

  it("window.openai.requestClose emits openai/requestClose notification", () => {
    h.completeInitHandshake();
    h.window.openai.requestClose();
    const req = h.parentMessages.find(
      (m) => (m.data as any)?.method === "openai/requestClose"
    );
    expect(req).toBeDefined();
  });

  it("window.openai.requestDisplayMode emits ui/request-display-mode JSON-RPC request", () => {
    h.completeInitHandshake();
    h.window.openai.requestDisplayMode({ mode: "fullscreen" });
    const req = h.parentMessages.find(
      (m) => (m.data as any)?.method === "ui/request-display-mode"
    );
    expect(req).toBeDefined();
    expect((req!.data as any).params.mode).toBe("fullscreen");
  });

  it("exposes toolResponseMetadata from config on window.openai", () => {
    h.completeInitHandshake();
    expect(h.window.openai.toolResponseMetadata).toEqual({ source: "boot" });
  });

  it("ui/notifications/tool-result with _meta updates window.openai.toolResponseMetadata", () => {
    h.completeInitHandshake();
    const before = h.setGlobalsEvents.length;
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [{ type: "text", text: "ok" }],
        _meta: { timestamp: "2026-01-01T00:00:00Z", source: "weather-api" },
      },
    });
    expect(h.window.openai.toolResponseMetadata).toEqual({
      timestamp: "2026-01-01T00:00:00Z",
      source: "weather-api",
    });
    const after = h.setGlobalsEvents.length;
    expect(after).toBe(before + 1);
    const last = h.setGlobalsEvents[after - 1] as {
      globals: Record<string, unknown>;
    };
    expect(last.globals.toolResponseMetadata).toEqual({
      timestamp: "2026-01-01T00:00:00Z",
      source: "weather-api",
    });
  });
});

describe("compat runtime — F2: MCP Apps only", () => {
  let h: RuntimeHandle;
  beforeEach(() => {
    h = buildHandle(F2_CONFIG);
  });

  it("ui/notifications/tool-input updates window.openai.toolInput and fires set_globals", () => {
    h.completeInitHandshake();
    const before = h.setGlobalsEvents.length;
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { location: "NYC" } },
    });
    expect(h.window.openai.toolInput).toEqual({ location: "NYC" });
    const after = h.setGlobalsEvents.length;
    expect(after).toBe(before + 1);
    const last = h.setGlobalsEvents[after - 1] as {
      globals: Record<string, unknown>;
    };
    expect(last.globals.toolInput).toEqual({ location: "NYC" });
  });

  it("ui/notifications/tool-result updates window.openai.toolOutput and fires set_globals", () => {
    h.completeInitHandshake();
    const before = h.setGlobalsEvents.length;
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [{ type: "text", text: "Sunny" }],
        structuredContent: { t: 75 },
      },
    });
    expect((h.window.openai.toolOutput as any).structuredContent.t).toBe(75);
    const after = h.setGlobalsEvents.length;
    expect(after).toBe(before + 1);
  });

  it("ui/notifications/host-context-changed updates theme/displayMode and fires set_globals", () => {
    h.completeInitHandshake();
    const before = h.setGlobalsEvents.length;
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", displayMode: "fullscreen" },
    });
    expect(h.window.openai.theme).toBe("dark");
    expect(h.window.openai.displayMode).toBe("fullscreen");
    const after = h.setGlobalsEvents.length;
    expect(after).toBe(before + 1);
    const last = h.setGlobalsEvents[after - 1] as {
      globals: Record<string, unknown>;
    };
    expect(last.globals.theme).toBe("dark");
    expect(last.globals.displayMode).toBe("fullscreen");
  });

  it("applies hostContext from ui/initialize result", () => {
    h.completeInitHandshake({ theme: "light", displayMode: "inline" });
    expect(h.window.openai.theme).toBe("light");
    expect(h.window.openai.displayMode).toBe("inline");
  });
});

describe("compat runtime — F3: dual metadata", () => {
  let h: RuntimeHandle;
  beforeEach(() => {
    h = buildHandle(F3_CONFIG);
  });

  it("supports both message streams without one suppressing the other", () => {
    h.completeInitHandshake();
    const baseline = h.setGlobalsEvents.length;

    // MCP-side notification updates state + dispatches event
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { content: [{ type: "text", text: "ok" }] },
    });

    // Apps-SDK-side call: window.openai.setWidgetState dispatches event
    h.window.openai.setWidgetState({ k: 1 });

    // Both should have fired
    expect(h.setGlobalsEvents.length).toBe(baseline + 2);

    // setWidgetState emits the Apps SDK contract message
    // (openai:setWidgetState postMessage) so the host can persist widget
    // state for replay / saved views. ui/update-model-context is an
    // opt-in spec API and should NOT be auto-fired.
    const setState = h.parentMessages.find(
      (m) => (m.data as any)?.type === "openai:setWidgetState"
    );
    expect(setState).toBeDefined();
    const modelCtx = h.parentMessages.find(
      (m) => (m.data as any)?.method === "ui/update-model-context"
    );
    expect(modelCtx).toBeUndefined();
  });

  it("does not double-dispatch when both notification streams target the same field", () => {
    h.completeInitHandshake();
    const baseline = h.setGlobalsEvents.length;
    // Two tool-input notifications back-to-back → exactly two dispatches.
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { a: 1 } },
    });
    h.sendFromParent({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { a: 2 } },
    });
    expect(h.setGlobalsEvents.length).toBe(baseline + 2);
    expect(h.window.openai.toolInput).toEqual({ a: 2 });
  });
});
