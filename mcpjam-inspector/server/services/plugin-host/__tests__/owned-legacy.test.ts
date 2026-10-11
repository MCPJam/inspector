import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  callback: vi.fn(),
  dispose: vi.fn(),
  options: undefined as any,
}));
vi.mock("../../../routes/web/hosted-elicitation.js", () => ({
  HostedElicitationBridge: class {
    constructor(options: unknown) {
      state.options = options;
    }
    callback = state.callback;
    dispose = state.dispose;
    attachStreamWriter() {}
  },
}));
import {
  installedFormClientCapabilities,
  createOwnedPluginLegacyForms,
  ownedLegacyFormCapabilities,
} from "../owned-legacy.js";
import type { ResolvedInvocationContext } from "../invocation.js";

const request = {
  params: {
    mode: "form",
    message: "Choose a part",
    requestedSchema: {
      type: "object",
      required: ["count", "flag"],
      properties: { count: { type: "integer" }, flag: { type: "boolean" } },
    },
  },
};
function fixture(version = "2025-11-25") {
  const controller = new AbortController();
  const assertCurrent = vi.fn(async () => {});
  const forms = createOwnedPluginLegacyForms({
    bearer: "fixture",
    projectId: "project",
    workspaceId: "workspace",
    hostId: "host",
    hostRevision: "revision",
    serverId: "server",
    serverName: () => "Bits & Bolts",
    signal: controller.signal,
    manager: () =>
      ({ getInitializationInfo: () => ({ protocolVersion: version }) } as any),
    assertCurrent,
    profile: {
      fileResources: false,
      origin: "server",
      userResources: false,
      previews: false,
    },
  });
  const authorization = { origin: "quick-action" } as ResolvedInvocationContext;
  return {
    forms,
    assertCurrent,
    controller,
    run: (value = request) =>
      forms.run(authorization, "operation", controller.signal, () =>
        forms.binding.handler(value),
      ),
  };
}
beforeEach(() =>
  state.callback.mockReset().mockResolvedValue({
    action: "accept",
    content: { count: 0, flag: false },
  }),
);
describe("owned legacy extension form dispatch", () => {
  it("uses the freshly admitted server name rather than its opaque ID", async () => {
    const f = fixture();
    state.callback.mockImplementation(async () => {
      expect(state.options.serverNamesById.server).toBe("Bits & Bolts");
      return { action: "decline" };
    });
    await expect(f.run()).resolves.toEqual({ action: "decline" });
    expect(state.options.serverNamesById).toEqual({ server: "Bits & Bolts" });
  });
  it("refuses an unsolicited request before creating a form", async () => {
    const f = fixture();
    await expect(f.forms.binding.handler(request)).rejects.toThrow();
    expect(state.callback).not.toHaveBeenCalled();
  });
  it("preserves typed false and zero through the owned operation", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({
      action: "accept",
      content: { count: 0, flag: false },
    });
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("refuses the legacy handler on a modern connection", async () => {
    await expect(fixture("2026-07-28").run()).rejects.toThrow(
      "Legacy extension forms",
    );
    expect(state.callback).not.toHaveBeenCalled();
  });
  it("rejects a stale owner before and after the human wait", async () => {
    const f = fixture();
    f.assertCurrent.mockRejectedValueOnce(new Error("Owner changed"));
    await expect(f.run()).rejects.toThrow("Owner changed");
    expect(state.callback).not.toHaveBeenCalled();
    const second = fixture();
    second.assertCurrent
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Owner closed"));
    await expect(second.run()).rejects.toThrow("Owner closed");
  });
  it("rejects invalid typed answers rather than coercing them", async () => {
    state.callback.mockResolvedValue({
      action: "accept",
      content: { count: "0", flag: false },
    });
    await expect(fixture().run()).rejects.toThrow("does not satisfy");
  });
  it("delivers a mixed form with an unsupported input whole and unchanged, never partially", async () => {
    const value = {
      params: {
        ...request.params,
        requestedSchema: {
          ...request.params.requestedSchema,
          properties: {
            ...request.params.requestedSchema.properties,
            secret: { type: "object" },
          },
        },
      },
    } as any;
    // The user sees the whole form refused (card + Logs) and can only
    // decline or cancel; no field is dropped to make it fit.
    state.callback.mockResolvedValueOnce({ action: "decline" });
    await expect(fixture().run(value)).resolves.toEqual({ action: "decline" });
    expect(state.callback).toHaveBeenCalledWith(
      expect.objectContaining({ schema: value.params.requestedSchema }),
    );
    state.callback.mockResolvedValueOnce({
      action: "accept",
      content: { count: 1, flag: true },
    });
    await expect(fixture().run(value)).rejects.toThrow("does not satisfy");
  });
  it("receives the requested schema exactly as sent, through the protocol's own params parse", async () => {
    const f = fixture();
    // What the MCP client does before calling a custom-method handler:
    // validate params with the binding's schema and pass its output on.
    const wire = async (params: unknown) => {
      const parsed = await f.forms.binding.schemas.params["~standard"].validate(
        params,
      );
      if ("issues" in parsed && parsed.issues) throw new Error("InvalidParams");
      return f.run({ params: parsed.value } as any);
    };
    const requestedSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        tint: { type: "string", "x-openai-color": { palette: "warm" } },
        span: { type: "string", "x-openai-input": { type: "date-range" } },
      },
    };
    state.callback.mockResolvedValueOnce({ action: "cancel" });
    // An unknown input is not an InvalidParams error the user never sees,
    // and an unknown keyword is not stripped into a partial form.
    await expect(
      wire({ message: "Choose", requestedSchema }),
    ).resolves.toEqual({ action: "cancel" });
    expect(state.callback).toHaveBeenCalledWith(
      expect.objectContaining({ schema: requestedSchema }),
    );
    await expect(
      wire({ mode: "url", message: "Open", requestedSchema }),
    ).rejects.toThrow("InvalidParams");
  });
  it("refuses a schema too large to hold on the wire", async () => {
    const value = {
      params: {
        ...request.params,
        requestedSchema: {
          type: "object",
          properties: {
            note: { type: "string", description: "x".repeat(300 * 1024) },
          },
        },
      },
    } as any;
    await expect(fixture().run(value)).rejects.toThrow("too large");
    expect(state.callback).not.toHaveBeenCalled();
  });
  it("delivers a valid unsupported form whole and refuses a forged acceptance", async () => {
    const value = {
      params: {
        ...request.params,
        requestedSchema: {
          type: "object",
          properties: {
            file: {
              type: "array",
              items: { type: "string", format: "uri" },
              "x-openai-input": {
                type: "resource",
                selection: "implicit",
                options: [],
              },
            },
          },
        },
      },
    } as any;
    state.callback.mockResolvedValueOnce({ action: "cancel" });
    await expect(fixture().run(value)).resolves.toEqual({ action: "cancel" });
    expect(state.callback).toHaveBeenCalledWith(
      expect.objectContaining({ schema: value.params.requestedSchema }),
    );
    state.callback.mockResolvedValueOnce({
      action: "accept",
      content: { file: "file:///forged" },
    });
    await expect(fixture().run(value)).rejects.toThrow("does not satisfy");
  });
});

describe("installed form protocol capability", () => {
  it("withholds the capability when no owned handler is installed", () => {
    expect(ownedLegacyFormCapabilities({}, undefined)).toEqual({});
  });
  // A Codex-style capture claims the OpenAI form extensions itself.
  const capture = {
    elicitation: { form: {} },
    extensions: { "openai/elicitation": { form: {} }, "openai/form": {} },
  };
  it("claims openai/elicitation on a chat connection only with a handler and forms on", () => {
    const binding = { binding: {} };
    expect(
      installedFormClientCapabilities({}, { legacy: binding, mrtr: false }, true),
    ).toEqual({ extensions: { "openai/elicitation": { form: {} } } });
    expect(installedFormClientCapabilities(capture, { mrtr: true }, true)).toBe(
      capture,
    );
    for (const [installed, forms] of [
      [{ mrtr: false }, true],
      [{ mrtr: false }, undefined],
      [{ mrtr: true }, false],
    ] as const)
      expect(installedFormClientCapabilities(capture, installed, forms)).toEqual({
        elicitation: { form: {} },
      });
  });
});

it("advertises the protocol only with its installed owned handler", async () => {
  const f = fixture();
  expect(ownedLegacyFormCapabilities({}, f.forms)).toEqual({
    extensions: { "openai/elicitation": { form: {} } },
  });
  await f.forms.dispose();
});
