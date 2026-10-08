import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  // The backend's Inspector-service functions through the Convex client.
  storeQuery: 30,
  storeMutation: 30,
};
const f = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  toolCalls: [] as string[],
  controls: new Map<string, { snapshotJson: string; expiresAt: number }>(),
  anchors: new Map<string, string>(),
  /** Every backend and MCP boundary crossed, in the order it started. */
  log: [] as string[],
  latency: undefined as Record<string, number> | undefined,
  /** The deployment predates the Inspector-service functions. */
  fastMissing: false,
  fastRequests: [] as { headers: Headers; args: Record<string, unknown> }[],
}));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const latency = (name: keyof typeof LATENCY) =>
  wait((f.latency ?? LATENCY)[name]);
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
      f.log.push("admission");
      await latency("convex");
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
    f.log.push("authorize-target");
    await latency("authorize");
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
          f.log.push("initialize");
          await latency("initialize");
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
          f.log.push("tools/list");
          await latency("toolsList");
          return { tools: [tool, appTool] };
        },
        readResource: async () => {
          count("mcp-resources-read");
          f.log.push("resources/read");
          await latency("resourcesRead");
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
          f.log.push("tools/call");
          f.toolCalls.push(name);
          await latency("toolCall");
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

const CONVEX_CLOUD = "https://fixture.convex.cloud";
const storeLabel = (kind: string, body: Record<string, unknown>) =>
  `${kind}.${body.action}${body.state ? `:${body.state}` : ""}`;
/** The same store behind the backend's Inspector-service query and mutation,
 * in Convex's wire format (as the Convex client sends and reads it). */
async function convexApi(url: string, init: RequestInit) {
  const { path, args } = JSON.parse(String(init.body)) as {
    path: string;
    args: [Record<string, unknown>];
  };
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  if (f.fastMissing) {
    count("fast-missing");
    f.log.push(`missing ${path}`);
    await latency("storeQuery");
    return reply({
      status: "error",
      errorMessage: `[Request ID: fixture] Server Error\nCould not find public function for '${path}'.\n`,
    });
  }
  f.fastRequests.push({ headers: new Headers(init.headers), args: args[0] });
  const command = args[0].command as Record<string, unknown>;
  const kind = path.startsWith("pluginInvocationReceipts")
    ? "receipt"
    : "control";
  count(`${kind}-fast:${command.action}`);
  f.log.push(storeLabel(kind, command));
  await latency(url.endsWith("/api/query") ? "storeQuery" : "storeMutation");
  return reply({
    status: "success",
    value: answer(kind, command),
    logLines: [],
  });
}

/** Minimal durable control and receipt service. */
async function service(url: string, init: RequestInit) {
  const body = JSON.parse(String(init.body));
  const kind = url.includes("plugin-invocations") ? "receipt" : "control";
  count(`${kind}-store:${body.action}`);
  f.log.push(storeLabel(kind, body));
  await latency("store");
  return new Response(JSON.stringify(answer(kind, body)), { status: 200 });
}
function answer(kind: string, body: Record<string, any>): unknown {
  const json = (value: unknown) => value;
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
  // The Convex client fast path stays off unless a test sets CONVEX_URL.
  delete process.env.CONVEX_URL;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    String(url).startsWith(CONVEX_CLOUD)
      ? convexApi(String(url), init)
      : service(String(url), init),
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

describe("App call backend trips", () => {
  const scope = {
    projectId: "project",
    pluginWorkspace: { version: 1, workspaceId: "workspace" },
  };
  const post = async (path: string, data: unknown) => {
    const { default: routes } = await import("../plugin-instances");
    return new Hono()
      .route("/instances", routes)
      .request(`/instances/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture",
        },
        body: JSON.stringify(data),
      });
  };
  const open = async (threadId: string) => {
    f.controls.clear();
    f.anchors.clear();
    const opened = await post("activation/open", {
      ...scope,
      hostId: "host",
      serverId: "server",
      toolName: tool.name,
      threadId,
      kind: "thread",
    });
    expect(opened.status).toBe(200);
    return ((await opened.json()) as { instanceToken: string }).instanceToken;
  };
  const call = (instanceToken: string) =>
    post("call", {
      ...scope,
      instanceToken,
      invocationId: crypto.randomUUID(),
      params: { name: appTool.name, arguments: {} },
    });
  const execute = (instanceToken: string) =>
    post("activation/execute", { ...scope, instanceToken });
  const reset = () => {
    f.log = [];
    f.counts = {};
    f.fastRequests = [];
  };
  beforeEach(async () => {
    const { resetPluginFastStoreDetection } =
      await import("../../../services/plugin-host/service-store");
    resetPluginFastStoreDetection();
    f.fastMissing = false;
    f.latency = undefined;
    process.env.CONVEX_URL = CONVEX_CLOUD;
  });
  afterEach(() => {
    delete process.env.CONVEX_URL;
    f.latency = undefined;
  });

  // One authorization: the App's durable control beside the member's
  // admission, before and after the catalog wait.
  const FENCE = ["control.read", "admission"];
  const AUTHORIZE = [...FENCE, "tools/list", ...FENCE];
  // An App tools/call, in order. Every effect (claim, dispatch, the call, the
  // result) is bracketed by its own authorization; the route's first
  // resolution is also the invoker's first authorization.
  const APP_CALL = [
    "admission",
    "control.read",
    ...AUTHORIZE,
    "receipt.claim",
    ...AUTHORIZE,
    "receipt.write:dispatched",
    ...AUTHORIZE,
    "tools/call",
    ...AUTHORIZE,
    "receipt.write:completed",
    // Delivery: admission and catalog again before the result leaves.
    "admission",
    "tools/list",
    "admission",
  ];
  const backendTrips = (log: string[]) =>
    log.filter((entry) => !entry.startsWith("tools/")).length;
  /** Backend round trips one after another: a fence's two reads overlap. */
  const sequentialTrips = (log: string[]) =>
    log.filter(
      (entry, index) =>
        !entry.startsWith("tools/") &&
        !(entry === "admission" && log[index - 1] === "control.read"),
    ).length;

  it("an App tools/call makes its backend trips in this order, all through the Convex client", async () => {
    const instanceToken = await open("thread-trips");
    reset();
    const response = await call(instanceToken);
    expect(response.status).toBe(200);
    expect(f.log).toEqual(APP_CALL);
    // 23 backend calls, 15 one after another (was 25 and 17, with 12 of the
    // 17 on HTTP actions).
    expect(backendTrips(f.log)).toBe(23);
    expect(sequentialTrips(f.log)).toBe(15);
    // No durable trip went to an HTTP action.
    expect(Object.keys(f.counts).filter((k) => k.includes("-store:"))).toEqual(
      [],
    );
    // The service credential is the only authority presented; never a user
    // bearer, and every read is a fresh one.
    expect(f.fastRequests.length).toBeGreaterThan(0);
    const requestIds = new Set<unknown>();
    for (const request of f.fastRequests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.args.serviceToken).toBe("fixture-service-token");
      if (request.args.requestId) requestIds.add(request.args.requestId);
    }
    expect(requestIds.size).toBe(
      f.fastRequests.filter((request) => request.args.requestId).length,
    );
  });

  it("activation/execute makes the same trips", async () => {
    const instanceToken = await open("thread-execute");
    reset();
    const response = await execute(instanceToken);
    expect(response.status).toBe(200);
    expect(f.log).toEqual(APP_CALL);
  });

  it("falls back to the HTTP routes, unseen, on a backend without the fast functions", async () => {
    f.fastMissing = true;
    const instanceToken = await open("thread-fallback");
    reset();
    const first = await call(instanceToken);
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("completed");
    // Each missing function is asked once, then remembered.
    expect(f.log.filter((entry) => entry.startsWith("missing "))).toEqual([
      "missing pluginInstanceControls:serviceRead",
      "missing pluginInvocationReceipts:serviceApply",
    ]);
    expect(f.log.filter((entry) => !entry.startsWith("missing "))).toEqual(
      APP_CALL,
    );
    reset();
    const second = await call(instanceToken);
    expect(second.status).toBe(200);
    expect(f.log).toEqual(APP_CALL);
    expect(f.counts["fast-missing"]).toBeUndefined();
    expect(f.counts["control-store:read"]).toBe(9);
    expect(f.counts["receipt-store:claim"]).toBe(1);
    expect(f.counts["receipt-store:write"]).toBe(2);
  });

  it("stays under 2 s of server time at realistic backend latencies", async () => {
    // Measured from a laptop against the dev deployment: an HTTP action is
    // about 500 ms (even a 404), a Convex query or mutation about 80-90 ms.
    // Run at a fifth of real time; reported in real milliseconds.
    const SCALE = 5;
    const real = {
      convex: 80,
      authorize: 60,
      initialize: 100,
      toolsList: 20,
      resourcesRead: 20,
      store: 500,
      toolCall: 5,
      storeQuery: 80,
      storeMutation: 90,
    };
    f.latency = Object.fromEntries(
      Object.entries(real).map(([name, ms]) => [name, ms / SCALE]),
    );
    const timed = async (run: () => Promise<Response>) => {
      const started = performance.now();
      const response = await run();
      expect(response.status).toBe(200);
      return Math.round((performance.now() - started) * SCALE);
    };
    const fast = await open("thread-latency-fast");
    const fastCall = await timed(() => call(fast));
    const fastExecute = await timed(() => execute(fast));
    const raced = await open("thread-latency-race");
    const race = await Promise.all([
      timed(() => execute(raced)),
      (async () => {
        // The App asks right after it loads, while its entrypoint call runs.
        await wait(real.convex / SCALE);
        return timed(() => call(raced));
      })(),
    ]);
    f.fastMissing = true;
    const http = await open("thread-latency-http");
    await call(http);
    const httpCall = await timed(() => call(http));
    const httpExecute = await timed(() => execute(http));
    console.info(
      "[app-call-latency]",
      JSON.stringify({
        trips: {
          backend: backendTrips(APP_CALL),
          sequential: sequentialTrips(APP_CALL),
        },
        fast: { call: fastCall, execute: fastExecute },
        fastRaced: { execute: race[0], call: race[1] },
        httpRoutes: { call: httpCall, execute: httpExecute },
      }),
    );
    expect(fastCall).toBeLessThan(2_000);
    expect(fastExecute).toBeLessThan(2_000);
    expect(race[1]).toBeLessThan(2_000);
    expect(httpCall).toBeGreaterThan(fastCall * 2);
  });
});
