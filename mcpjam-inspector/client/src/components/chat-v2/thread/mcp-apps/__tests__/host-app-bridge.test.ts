import { describe, it, expect, vi } from "vitest";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  registerHostBridgeHandlers,
  resolveIframeSandboxPolicy,
  buildOuterSandboxAttribute,
  buildOuterAllowAttribute,
  getToolVisibility,
  isVisibleToModelOnly,
  type HostBridgeCallbacks,
  type RegisterHostBridgeHandlersOptions,
} from "../host-app-bridge";

/* ------------------------------------------------------------------ *
 * Stub bridge
 *
 * `registerHostBridgeHandlers` only assigns the `on*` handler slots and calls
 * `sendToolCancelled` / `teardownResource` / `getAppCapabilities`. A plain
 * object satisfies that surface; cast to AppBridge for the call site.
 * ------------------------------------------------------------------ */
type StubBridge = {
  oninitialized?: (...args: unknown[]) => unknown;
  onmessage?: (...args: unknown[]) => unknown;
  onopenlink?: (...args: unknown[]) => unknown;
  oncalltool?: (...args: unknown[]) => unknown;
  onreadresource?: (...args: unknown[]) => unknown;
  onlistresources?: (...args: unknown[]) => unknown;
  onlistresourcetemplates?: (...args: unknown[]) => unknown;
  onlistprompts?: (...args: unknown[]) => unknown;
  onloggingmessage?: (...args: unknown[]) => unknown;
  onsizechange?: (...args: unknown[]) => unknown;
  onrequestdisplaymode?: (...args: unknown[]) => unknown;
  onupdatemodelcontext?: (...args: unknown[]) => unknown;
  ondownloadfile?: (...args: unknown[]) => unknown;
  onrequestteardown?: (...args: unknown[]) => unknown;
  sendToolCancelled: ReturnType<typeof vi.fn>;
  teardownResource: ReturnType<typeof vi.fn>;
  getAppCapabilities: ReturnType<typeof vi.fn>;
};

function makeStubBridge(
  appCaps: Record<string, unknown> | undefined = undefined,
): StubBridge {
  return {
    sendToolCancelled: vi.fn().mockResolvedValue(undefined),
    teardownResource: vi.fn().mockResolvedValue({}),
    getAppCapabilities: vi.fn().mockReturnValue(appCaps),
  };
}

const ALL_CAPS = {
  message: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  downloadFile: true,
} as RegisterHostBridgeHandlersOptions["effectiveHostCapabilities"];

const NO_CAPS = {
  message: false,
  openLinks: false,
  serverTools: false,
  serverResources: false,
  logging: false,
  updateModelContext: false,
  downloadFile: false,
} as RegisterHostBridgeHandlersOptions["effectiveHostCapabilities"];

function register(
  bridge: StubBridge,
  opts: Partial<RegisterHostBridgeHandlersOptions> & {
    callbacks?: HostBridgeCallbacks;
  } = {},
) {
  registerHostBridgeHandlers(bridge as unknown as AppBridge, {
    effectiveHostCapabilities: opts.effectiveHostCapabilities ?? ALL_CAPS,
    getMatrix: opts.getMatrix,
    getToolMetadata: opts.getToolMetadata,
    getToolCallId: opts.getToolCallId ?? (() => "tc-1"),
    nextInvocationSequence: opts.nextInvocationSequence,
    onWidgetDebug: opts.onWidgetDebug,
    callbacks: opts.callbacks ?? {},
  });
}

describe("registerHostBridgeHandlers — capability gating (advertise = enforce)", () => {
  it("installs no capability-gated handlers when all caps are off", () => {
    const bridge = makeStubBridge();
    register(bridge, { effectiveHostCapabilities: NO_CAPS });

    expect(bridge.onmessage).toBeUndefined();
    expect(bridge.onopenlink).toBeUndefined();
    expect(bridge.oncalltool).toBeUndefined();
    expect(bridge.onreadresource).toBeUndefined();
    expect(bridge.onlistresources).toBeUndefined();
    expect(bridge.onlistresourcetemplates).toBeUndefined();
    expect(bridge.onloggingmessage).toBeUndefined();
    expect(bridge.onupdatemodelcontext).toBeUndefined();
    expect(bridge.ondownloadfile).toBeUndefined();
  });

  it("keeps the unconditional handlers installed even with all caps off", () => {
    const bridge = makeStubBridge();
    register(bridge, { effectiveHostCapabilities: NO_CAPS });

    expect(bridge.oninitialized).toBeTypeOf("function");
    expect(bridge.onlistprompts).toBeTypeOf("function");
    expect(bridge.onsizechange).toBeTypeOf("function");
    expect(bridge.onrequestdisplaymode).toBeTypeOf("function");
  });

  it("serverTools=false leaves oncalltool unassigned", () => {
    const bridge = makeStubBridge();
    register(bridge, {
      effectiveHostCapabilities: { ...ALL_CAPS, serverTools: false },
    });
    expect(bridge.oncalltool).toBeUndefined();
  });

  it("installs every handler when all caps are on", () => {
    const bridge = makeStubBridge();
    register(bridge, { effectiveHostCapabilities: ALL_CAPS });

    for (const slot of [
      "oninitialized",
      "onmessage",
      "onopenlink",
      "oncalltool",
      "onreadresource",
      "onlistresources",
      "onlistresourcetemplates",
      "onlistprompts",
      "onloggingmessage",
      "onsizechange",
      "onrequestdisplaymode",
      "onupdatemodelcontext",
      "ondownloadfile",
      "onrequestteardown",
    ] as const) {
      expect(bridge[slot], slot).toBeTypeOf("function");
    }
  });
});

describe("registerHostBridgeHandlers — handshake", () => {
  it("oninitialized forwards the bridge to onAppInitialized", () => {
    const bridge = makeStubBridge({ tools: false });
    const onAppInitialized = vi.fn();
    register(bridge, { callbacks: { onAppInitialized } });

    bridge.oninitialized?.();
    expect(onAppInitialized).toHaveBeenCalledTimes(1);
    expect(onAppInitialized).toHaveBeenCalledWith(bridge);
  });
});

describe("registerHostBridgeHandlers — model-only visibility (SEP-1865)", () => {
  it("rejects an app-initiated call to a model-only tool and never dispatches", async () => {
    const bridge = makeStubBridge();
    const onCallTool = vi.fn().mockResolvedValue({ content: [] });
    register(bridge, {
      getToolMetadata: (name) =>
        name === "secret" ? { ui: { visibility: ["model"] } } : undefined,
      callbacks: { onCallTool },
    });

    await expect(
      (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
        { name: "secret", arguments: {} },
        {},
      ),
    ).rejects.toThrow(/not callable by apps/);
    expect(onCallTool).not.toHaveBeenCalled();
    // matrix permits the side-channel notification by default
    expect(bridge.sendToolCancelled).toHaveBeenCalledTimes(1);
  });

  it("dispatches a normally-visible tool and returns its result", async () => {
    const bridge = makeStubBridge();
    const result = { content: [{ type: "text", text: "ok" }] };
    const onCallTool = vi.fn().mockResolvedValue(result);
    register(bridge, {
      getToolMetadata: () => ({}), // default visibility => model + app
      callbacks: { onCallTool },
    });

    const out = await (
      bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>
    )({ name: "search", arguments: { q: 1 } }, {});
    expect(onCallTool).toHaveBeenCalledWith("search", { q: 1 });
    expect(out).toBe(result);
  });
});

describe("registerHostBridgeHandlers — sendToolCancelled matrix gating", () => {
  it("suppresses sendToolCancelled when matrix.toolCancelled === false", async () => {
    const bridge = makeStubBridge();
    register(bridge, {
      getMatrix: () => ({ toolCancelled: false }),
      getToolMetadata: () => ({ ui: { visibility: ["model"] } }),
      callbacks: { onCallTool: vi.fn() },
    });

    await expect(
      (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
        { name: "x", arguments: {} },
        {},
      ),
    ).rejects.toThrow();
    expect(bridge.sendToolCancelled).not.toHaveBeenCalled();
  });
});

describe("registerHostBridgeHandlers — app-tool invocation lifecycle", () => {
  it("emits running → success around a dispatched call", async () => {
    const bridge = makeStubBridge();
    const updates: Array<{ status: string }> = [];
    register(bridge, {
      getToolCallId: () => "parent-1",
      nextInvocationSequence: () => 7,
      callbacks: {
        onCallTool: vi.fn().mockResolvedValue({ content: [] }),
        onAppToolInvocation: (u) => updates.push(u),
      },
    });

    await (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
      { name: "go", arguments: {} },
      {},
    );
    expect(updates.map((u) => u.status)).toEqual(["running", "success"]);
    expect((updates[0] as { id: string }).id).toBe("parent-1:app-tool:7");
  });

  it("emits running → error and cancels when the dispatch throws", async () => {
    const bridge = makeStubBridge();
    const updates: Array<{ status: string; errorText?: string }> = [];
    register(bridge, {
      callbacks: {
        onCallTool: vi.fn().mockRejectedValue(new Error("boom")),
        onAppToolInvocation: (u) => updates.push(u),
      },
    });

    await expect(
      (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
        { name: "go", arguments: {} },
        {},
      ),
    ).rejects.toThrow("boom");
    expect(updates.map((u) => u.status)).toEqual(["running", "error"]);
    expect(updates[1].errorText).toBe("boom");
    expect(bridge.sendToolCancelled).toHaveBeenCalledWith({ reason: "boom" });
  });

  it("treats a missing onCallTool as 'Tool calls not supported'", async () => {
    const bridge = makeStubBridge();
    const updates: Array<{ status: string; errorText?: string }> = [];
    register(bridge, {
      callbacks: { onAppToolInvocation: (u) => updates.push(u) },
    });

    await expect(
      (bridge.oncalltool as (p: unknown, e: unknown) => Promise<unknown>)(
        { name: "go", arguments: {} },
        {},
      ),
    ).rejects.toThrow("Tool calls not supported");
    expect(updates.map((u) => u.status)).toEqual(["running", "error"]);
    expect(updates[1].errorText).toBe("Tool calls not supported");
  });
});

describe("registerHostBridgeHandlers — teardown gating", () => {
  it("does not install onrequestteardown when matrix.requestTeardown === false", () => {
    const bridge = makeStubBridge();
    register(bridge, { getMatrix: () => ({ requestTeardown: false }) });
    expect(bridge.onrequestteardown).toBeUndefined();
  });

  it("installs onrequestteardown by default and runs teardownResource + callback", async () => {
    const bridge = makeStubBridge();
    const onRequestTeardown = vi.fn();
    register(bridge, {
      getToolCallId: () => "tc-9",
      callbacks: { onRequestTeardown },
    });
    expect(bridge.onrequestteardown).toBeTypeOf("function");
    await (bridge.onrequestteardown as () => Promise<unknown>)();
    expect(bridge.teardownResource).toHaveBeenCalledTimes(1);
    expect(onRequestTeardown).toHaveBeenCalledWith("tc-9");
  });
});

describe("tool visibility helpers", () => {
  it("defaults to model + app when unspecified", () => {
    expect(getToolVisibility(undefined)).toEqual(["model", "app"]);
    expect(getToolVisibility({})).toEqual(["model", "app"]);
    expect(isVisibleToModelOnly({})).toBe(false);
  });
  it("detects model-only", () => {
    expect(isVisibleToModelOnly({ ui: { visibility: ["model"] } })).toBe(true);
    expect(isVisibleToModelOnly({ ui: { visibility: ["model", "app"] } })).toBe(
      false,
    );
  });
  it("dedupes repeated scopes so model-only stays enforced", () => {
    expect(getToolVisibility({ ui: { visibility: ["model", "model"] } })).toEqual(
      ["model"],
    );
    expect(
      isVisibleToModelOnly({ ui: { visibility: ["model", "model"] } }),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Iframe sandbox attribute construction
 *
 * Asserts the extracted builders produce exactly the strings SandboxedIframe
 * produced pre-refactor for matching inputs (plan verification step 1).
 * ------------------------------------------------------------------ */
describe("resolveIframeSandboxPolicy — outer attribute construction", () => {
  it("falls back to the permissive baseline when sandboxAttrs is undefined", () => {
    expect(buildOuterSandboxAttribute({})).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
  });

  it("treats [] as spec-minimum (allow-scripts + allow-same-origin only)", () => {
    expect(buildOuterSandboxAttribute({ sandboxAttrs: [] })).toBe(
      "allow-same-origin allow-scripts",
    );
  });

  it("unions profile tokens with the spec minimum, sorted", () => {
    expect(
      buildOuterSandboxAttribute({ sandboxAttrs: ["allow-forms"] }),
    ).toBe("allow-forms allow-same-origin allow-scripts");
  });

  it("rejects sandbox tokens with internal whitespace", () => {
    expect(
      buildOuterSandboxAttribute({
        sandboxAttrs: ["allow-forms", "allow-popups allow-modals"],
      }),
    ).toBe("allow-forms allow-same-origin allow-scripts");
  });

  it("emits legacy allow defaults when allowFeatures is undefined", () => {
    expect(buildOuterAllowAttribute({})).toBe(
      "local-network-access *; midi *",
    );
  });

  it("flows the 4 spec permissions through regardless of allowFeatures", () => {
    expect(
      buildOuterAllowAttribute({
        permissions: { camera: {}, clipboardWrite: {} } as never,
        allowFeatures: {},
      }),
    ).toBe("camera *; clipboard-write *");
  });

  it("drops the legacy defaults when allowFeatures is authoritative ({})", () => {
    expect(buildOuterAllowAttribute({ allowFeatures: {} })).toBe("");
  });

  it("appends non-spec permissions-policy features from allowFeatures", () => {
    expect(
      buildOuterAllowAttribute({ allowFeatures: { fullscreen: "*" } }),
    ).toBe("fullscreen *");
  });

  it("ignores spec features and injection attempts in allowFeatures", () => {
    expect(
      buildOuterAllowAttribute({
        allowFeatures: {
          camera: "*", // spec feature: must come from permissions, not here
          "bad key": "*", // whitespace in key
          evil: "*; camera *", // separator injection in value
          fullscreen: "*",
        },
      }),
    ).toBe("fullscreen *");
  });

  it("resolveIframeSandboxPolicy composes both attributes", () => {
    expect(
      resolveIframeSandboxPolicy({
        sandboxAttrs: ["allow-forms"],
        permissions: { camera: {} } as never,
        allowFeatures: { fullscreen: "*" },
      }),
    ).toEqual({
      sandbox: "allow-forms allow-same-origin allow-scripts",
      allow: "camera *; fullscreen *",
    });
  });
});
