import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Cold App activation cost through the real route and runtime, with every
 * network boundary replaced by a counting double that waits a fixed simulated
 * latency. The counts are exact; the durations reflect only the simulated
 * latencies below, never a real deployment.
 */
const LATENCY = {
  convex: 20,
  authorize: 60,
  initialize: 100,
  toolsList: 20,
  resourcesRead: 20,
  store: 30,
  toolCall: 50,
};
const f = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  toolCalls: [] as string[],
  controls: new Map<string, { snapshotJson: string; expiresAt: number }>(),
  anchors: new Map<string, string>(),
}));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const count = (name: string) => {
  f.counts[name] = (f.counts[name] ?? 0) + 1;
};
const hostConfig = {
  hostId: "host",
  modelId: "model",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  hostStyle: "chatgpt",
  executionScope: { kind: "project", projectId: "project" },
};
const tool = {
  name: "thread-app",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    ui: { resourceUri: "ui://fixture/app" },
    "openai/ui": { entrypoints: [{ type: "thread" }] },
  },
};
/** A tool the App itself calls once it loads (Bits & Bolts: cad.listParts). */
const appTool = {
  name: "list-parts",
  inputSchema: { type: "object", properties: {} },
};
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({
    query: async (_ref: unknown, args: Record<string, unknown>) => {
      count("convex-admission-read");
      await wait(LATENCY.convex);
      return {
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig } : {}),
        serverBindings: ((args.serverIds as string[]) ?? []).map(
          (serverId) => ({ kind: "standalone", serverId }),
        ),
      };
    },
  }),
}));
vi.mock("../auth.js", async () => ({
  projectServerSchema: (await import("zod")).z.object({
    projectId: (await import("zod")).z.string(),
    serverId: (await import("zod")).z.string(),
  }),
  handleRoute: async (_c: unknown, run: () => Promise<Response>) => run(),
  createManualHostedConnection: async () => {
    count("target-authorization");
    await wait(LATENCY.authorize);
    let connected = false;
    const target = { url: "https://fixture.invalid/mcp" };
    return {
      authorizedServerConfigs: { server: target },
      authorizedServerIdentities: {
        server: {
          serverId: "server",
          credentialId: null,
          credentialAuthorizedAt: null,
          config: {
            transportType: "http",
            url: target.url,
            credentialConfigurationId: "a".repeat(64),
          },
        },
      },
      manager: {
        connectToServer: async () => {
          count("mcp-initialize");
          await wait(LATENCY.initialize);
          connected = true;
        },
        disconnectAllServers: async () => {
          connected = false;
        },
        getConnectionStatus: () => (connected ? "connected" : "disconnected"),
        getServerConfig: () => (connected ? target : undefined),
        getInitializationInfo: () => ({ protocolVersion: "2025-06-18" }),
        // An unpinned client prepares an MRTR collector before connect.
        setMrtrInputCollector: () => {},
        getServerCapabilities: () => ({}),
        listTools: async () => {
          count("mcp-tools-list");
          await wait(LATENCY.toolsList);
          return { tools: [tool, appTool] };
        },
        readResource: async () => {
          count("mcp-resources-read");
          await wait(LATENCY.resourcesRead);
          return {
            contents: [
              {
                uri: "ui://fixture/app",
                mimeType: "text/html;profile=mcp-app",
                text: "<p>App</p>",
                _meta: { ui: {} },
              },
            ],
          };
        },
        executeTool: async (_serverId: string, name: string) => {
          count("mcp-tool-call");
          f.toolCalls.push(name);
          await wait(LATENCY.toolCall);
          return { content: [] };
        },
      },
    };
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/tool-approval-token.js")
  >()),
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: () => {},
  captureServerEventForActor: () => {},
}));

/** Minimal durable control and receipt service. */
async function service(url: string, init: RequestInit) {
  const body = JSON.parse(String(init.body));
  const kind = url.includes("plugin-invocations") ? "receipt" : "control";
  count(`${kind}-store:${body.action}`);
  await wait(LATENCY.store);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  if (kind === "receipt") {
    if (body.action === "claim")
      return json({
        claimed: true,
        receipt: {
          fingerprint: body.fingerprint,
          revision: body.revision,
          expiresAt: Date.now() + 60_000,
          legs: [],
        },
      });
    if (body.action === "read") return json({ receipt: null });
    return json({});
  }
  if (body.action === "read-activation") {
    const token = f.anchors.get(body.activationAnchorHash);
    return json({
      activation: token ? { token, control: f.controls.get(token) } : null,
    });
  }
  if (body.action === "issue") {
    const original = f.anchors.get(body.activation.anchorHash);
    if (original)
      return json({ token: original, control: f.controls.get(original) });
    const control = {
      snapshotJson: body.snapshotJson,
      expiresAt: body.expiresAt,
    };
    f.controls.set(body.activation.token, control);
    f.anchors.set(body.activation.anchorHash, body.activation.token);
    return json({ token: body.activation.token, control });
  }
  if (body.action === "read") {
    const token = [...f.controls.keys()][0];
    return json({ control: f.controls.get(token) ?? null });
  }
  return json({});
}

const env = { ...process.env };
beforeAll(() => {
  process.env.INSPECTOR_SERVICE_TOKEN = "fixture-service-token";
  process.env.CONVEX_HTTP_URL = "https://fixture.invalid";
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    service(String(url), init),
  );
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("cold App activation cost", () => {
  it("records the work for one cold open and its entrypoint call", async () => {
    const { default: routes } = await import("../plugin-instances");
    const app = new Hono().route("/instances", routes);
    const post = async (path: string, data: unknown) =>
      app.request(`/instances/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture",
        },
        body: JSON.stringify(data),
      });
    const scope = {
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
    };
    const measure = async (run: () => Promise<Response>) => {
      f.counts = {};
      const started = performance.now();
      const response = await run();
      const value = await response.json();
      return {
        status: response.status,
        value,
        ms: Math.round(performance.now() - started),
        counts: { ...f.counts },
        serverTiming: response.headers.get("Server-Timing"),
      };
    };
    const open = await measure(() =>
      post("activation/open", {
        ...scope,
        hostId: "host",
        serverId: "server",
        toolName: tool.name,
        threadId: "thread",
        kind: "thread",
      }),
    );
    expect(open.status).toBe(200);
    const execute = await measure(() =>
      post("activation/execute", {
        ...scope,
        instanceToken: open.value.instanceToken,
      }),
    );
    expect(execute.status).toBe(200);
    // Printed for the change report; the assertions below guard regressions.
    console.info(
      "[activation-cost]",
      JSON.stringify({ latency: LATENCY, open, execute }, null, 1),
    );
    expect(open.counts["target-authorization"]).toBe(1);
    expect(open.counts["mcp-initialize"]).toBe(1);
    expect(open.counts["mcp-tools-list"]).toBe(1);
    expect(open.counts["control-store:issue"]).toBe(1);
    expect(open.counts["control-store:read-activation"]).toBeUndefined();
    // The entrypoint call right after open reuses the authorized connection.
    expect(execute.counts["target-authorization"]).toBeUndefined();
    expect(execute.counts["mcp-initialize"]).toBeUndefined();
    expect(execute.counts["mcp-tool-call"]).toBe(1);
    expect(open.serverTiming).toContain("tools-list;dur=");
  });

  it("runs the App's first call ahead of the entrypoint call it races", async () => {
    // Opening an App draws it and runs its entrypoint at once; the App's own
    // first call (with a 15 s deadline in the App) must not share every
    // round trip with that entrypoint call.
    f.controls.clear();
    f.anchors.clear();
    f.toolCalls = [];
    const { default: routes } = await import("../plugin-instances");
    const app = new Hono().route("/instances", routes);
    const post = (path: string, data: unknown) =>
      app.request(`/instances/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture",
        },
        body: JSON.stringify(data),
      });
    const scope = {
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
    };
    const open = await post("activation/open", {
      ...scope,
      hostId: "host",
      serverId: "server",
      toolName: tool.name,
      threadId: "thread-race",
      kind: "thread",
    });
    expect(open.status).toBe(200);
    const { instanceToken } = (await open.json()) as { instanceToken: string };
    const execute = post("activation/execute", { ...scope, instanceToken });
    // The entrypoint call is already under way when the App asks.
    await wait(LATENCY.convex + LATENCY.store);
    const call = post("call", {
      ...scope,
      instanceToken,
      invocationId: crypto.randomUUID(),
      params: { name: appTool.name, arguments: {} },
    });
    const [executed, called] = await Promise.all([execute, call]);
    expect(called.status).toBe(200);
    expect(executed.status).toBe(200);
    expect(f.toolCalls).toEqual([appTool.name, tool.name]);
  });
});
