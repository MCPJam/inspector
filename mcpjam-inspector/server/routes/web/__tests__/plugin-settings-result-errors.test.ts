import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginInstanceRegistry } from "../../../services/plugin-host/instances";
import type { PluginInvocationReceiptPort } from "../../../services/plugin-host/receipt-store";
import {
  RequestOwnedToolInvoker,
} from "../../../services/plugin-host/request-invoker";
import type { DurableInvocationReceipt } from "../../../services/plugin-host/receipt-store";
import { PluginInvocationError } from "../../../services/plugin-host/invocation";

const f = vi.hoisted(() => ({
  report: vi.fn(),
  catalog: vi.fn(),
  get: vi.fn(),
  execute: vi.fn(),
  invoke: vi.fn<PluginInstanceRegistry["invoke"]>(),
  receipts: undefined as PluginInvocationReceiptPort | undefined,
}));
vi.mock("../../../utils/route-error-report.js", () => ({ reportRouteFailure: f.report }));
vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/admission.js")>()),
  admitPluginWorkspace: async () => ({
    actorId: "actor", projectId: "project", workspaceId: "workspace",
    revalidate: async () => {},
  }),
}));
vi.mock("../../../services/plugin-host/receipt-store.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/receipt-store.js")>()),
  createPluginInvocationReceiptPort: () => f.receipts,
}));
vi.mock("../../../services/plugin-host/settings-state.js", async () =>
  (await import("./settings-state-memory.js")).memorySettingsState((token) =>
    f.get(token),
  ),
);
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: { getPersistent: f.get, get: f.get, invoke: f.invoke },
}));
vi.mock("../../../services/plugin-host/request-runtime.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/request-runtime.js")>()),
  createPluginRequestRuntime: () => ({
    catalog: f.catalog,
    manager: () => ({ executeTool: f.execute }),
    release: async () => {},
  }),
}));
import routes from "../plugin-settings";
import { resolvePluginSettingsCatalog } from "../../../services/plugin-host/settings-catalog";
import { settingsFixture } from "../../../../shared/__tests__/plugin-settings-fixture";

const owner = {
  actorId: "actor", projectId: "project", workspaceId: "workspace",
  instanceId: "settings-instance", generation: 1, serverId: "server",
  bindingId: "binding", placement: "interactive" as const,
};
const catalog = {
  runtime: "chatgpt", hostRevision: "host", bindingId: "binding",
  serverIdentity: { kind: "standalone" as const, serverId: "server" },
  transport: "legacy" as const, protocolVersion: "2025-11-25",
  requiresApproval: false,
  serverCapabilities: {
    experimental: { "openai/settings": { readTool: "read", updateTool: "save" } },
  },
  tools: ["read", "save"].map(name => ({
    name, inputSchema: { type: "object" as const },
    outputSchema: { type: "object" as const },
  })),
};
const app = new Hono().route("/settings", routes);
const invokers: RequestOwnedToolInvoker[] = [];
afterEach(() => {
  for (const invoker of invokers.splice(0)) invoker.close();
  vi.clearAllMocks();
});

function fixture(reply: unknown, updateReply?: unknown) {
  const saved = new Map<string, DurableInvocationReceipt>();
  f.receipts = {
    read: async (id) => {
      const receipt = saved.get(id);
      return receipt ? structuredClone(receipt) : null;
    },
    claim: async (id, input) => {
      const previous = saved.get(id);
      if (previous) return { claimed: false, receipt: structuredClone(previous) };
      const receipt: DurableInvocationReceipt = {
        fingerprint: input.fingerprint, revision: input.revision,
        expiresAt: Date.now() + 60_000,
        legs: [{ round: 0, fingerprint: input.legFingerprint,
          state: input.dispatch ? "dispatched" : "reserved" }],
      };
      saved.set(id, receipt);
      return { claimed: true, receipt: structuredClone(receipt) };
    },
    write: async (id, input) => {
      if (input.state === "refused") { saved.delete(id); return; }
      const receipt = saved.get(id);
      if (!receipt) throw Error("Fixture receipt missing");
      Object.assign(receipt.legs[0]!, input);
    },
  };
  const invoker = () => {
    const value = new RequestOwnedToolInvoker(owner, () => {});
    invokers.push(value);
    return value;
  };
  let current = invoker();
  f.invoke.mockImplementation((_token, _actor, ports, id, params, signal, origin = "app") =>
    current.invoke(ports, origin, id, params, signal),
  );
  f.catalog.mockResolvedValue(catalog);
  f.get.mockReturnValue({
    hostId: "host", owner,
    activation: { selector: { kind: "settings" }, settings: {
      ...resolvePluginSettingsCatalog(catalog)!.settings,
      revision: resolvePluginSettingsCatalog(catalog)!.revision,
    } },
  });
  f.execute.mockImplementation(async (_server, name) => name === "save" ? updateReply : reply);
  const operationIds = { read: crypto.randomUUID(), update: crypto.randomUUID() };
  const instanceToken = crypto.randomUUID();
  const post = (method: "read" | "update") => app.request(`/settings/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", pluginWorkspace: { version: 1, workspaceId: "workspace" }, instanceToken, operationId: operationIds[method], ...(method === "update" ? { set: { count: 3 } } : {}) }),
  });
  return { read: () => post("read"), update: () => post("update"), saved: (method: "read" | "update" = "read") => saved.get(operationIds[method]), cold: () => { current.close(); current = invoker(); } };
}

it.each(["unsupported", "malformed"])(
  "preserves the %s settings refusal through real dispatch and cold receipt recovery",
  async (variant) => {
    const document = settingsFixture();
    if (variant === "unsupported")
      Reflect.set(document.schema.properties, "label", { type: "object", title: "Nested" });
    else Reflect.set(document.values, "enabled", "false");
    const code = variant === "unsupported" ? "PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA" : "PLUGIN_SETTINGS_INVALID_RESULT";
    const fxt = fixture({ content: [], structuredContent: document });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) fxt.cold();
      const response = await fxt.read();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code, outcomeUnknown: true });
      expect(f.execute).toHaveBeenCalledOnce();
    }
    expect(fxt.saved()?.legs[0]).toMatchObject({ state: "unknown", errorCode: code });
  },
);

it("keeps an unrelated post-dispatch exception uncertain and never replays it", async () => {
  const fxt = fixture({ content: [], structuredContent: settingsFixture() });
  f.execute.mockRejectedValue(new Error("untrusted failure"));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fxt.read();
    expect(await response.json()).toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
    expect(f.execute).toHaveBeenCalledOnce();
  }
});

it("does not mark a proven pre-dispatch refusal as an uncertain effect", async () => {
  const fxt = fixture({ content: [], structuredContent: settingsFixture() });
  f.catalog.mockRejectedValueOnce(new PluginInvocationError("PLUGIN_EXTENSION_DISABLED"));
  const response = await fxt.read();
  expect(response.status).toBe(403);
  const failure = await response.json();
  expect(failure).toMatchObject({ code: "PLUGIN_EXTENSION_DISABLED" });
  expect(failure).not.toHaveProperty("outcomeUnknown");
  expect(f.execute).not.toHaveBeenCalled();
});

it("preserves an invalid dispatched update as uncertain through retries and cold recovery", async () => {
  const fxt = fixture(
    { content: [], structuredContent: settingsFixture() },
    { content: [], structuredContent: { values: { count: 3 } } },
  );
  expect((await fxt.read()).status).toBe(200);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 2) fxt.cold();
    const response = await fxt.update();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "PLUGIN_SETTINGS_INVALID_RESULT", outcomeUnknown: true,
    });
    expect(f.execute.mock.calls.filter(([, name]) => name === "save")).toHaveLength(1);
  }
  expect(fxt.saved("update")?.legs[0]).toMatchObject({
    state: "unknown", errorCode: "PLUGIN_SETTINGS_INVALID_RESULT",
  });
});

it("reports an unexpected pre-dispatch failure once without exposing its details", async () => {
  const fxt = fixture({ content: [], structuredContent: settingsFixture() });
  const error = new Error("private infrastructure failure");
  f.catalog.mockRejectedValueOnce(error);
  const response = await fxt.read();
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(error.message);
  expect(f.report).toHaveBeenCalledExactlyOnceWith(
    "Plugin Settings request failed", error, { source: "web.pluginSettings", hop: "mcpjam_internal" },
  );
  expect(f.execute).not.toHaveBeenCalled();
});
