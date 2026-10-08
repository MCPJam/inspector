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
  /** The backend calls that started while no other backend call was in
   * flight: the request's one-after-another round trips. */
  serial: [] as string[],
  flight: 0,
  latency: undefined as Record<string, number> | undefined,
  /** The deployment predates the Inspector-service functions. */
  fastMissing: false,
  /** The deployment predates the combined claim and dispatch. */
  combinedMissing: false,
  /** Holds every completion record until released (it must never gate the
   * answer). */
  holdCompleted: undefined as Promise<void> | undefined,
  fastRequests: [] as { headers: Headers; args: Record<string, unknown> }[],
}));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const latency = (name: keyof typeof LATENCY) =>
  wait((f.latency ?? LATENCY)[name]);
const count = (name: string) => {
  f.counts[name] = (f.counts[name] ?? 0) + 1;
};
/** One backend round trip: logged when it starts, overlapping or not. */
async function trip<T>(
  entry: string,
  name: keyof typeof LATENCY,
  answer: () => T,
) {
  f.log.push(entry);
  if (f.flight === 0) f.serial.push(entry);
  f.flight++;
  try {
    await latency(name);
    return answer();
  } finally {
    f.flight--;
  }
}
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
    "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] },
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
      return trip("admission", "convex", () => ({
        // users:getCurrentUser (cleanup identity) reads `_id`.
        _id: "actor",
        actorId: "actor",
        projectId: "project",
        ...(args.hostId ? { hostConfig } : {}),
        serverBindings: ((args.serverIds as string[]) ?? []).map(
          (serverId) => ({ kind: "standalone", serverId }),
        ),
      }));
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
  `${kind}.${body.action}${body.dispatch ? "+dispatch" : ""}${
    body.state ? `:${body.state}` : ""
  }`;
/** An older store refuses the combined claim's unknown field before its
 * handler runs, with the route's default refusal. */
const refusesCombined = (kind: string, command: Record<string, unknown>) =>
  f.combinedMissing && kind === "receipt" && command.dispatch === true;
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
  if (command.state === "completed") await f.holdCompleted;
  const refused = refusesCombined(kind, command);
  return trip(
    `${storeLabel(kind, command)}${refused ? ":refused" : ""}`,
    url.endsWith("/api/query") ? "storeQuery" : "storeMutation",
    () =>
      refused
        ? reply({
            status: "error",
            errorMessage: "Server Error",
            errorData: { code: "INVALID_RECEIPT_REQUEST" },
          })
        : reply({
            status: "success",
            value: answer(kind, command),
            logLines: [],
          }),
  );
}

/** Minimal durable control and receipt service (the HTTP actions). */
async function service(url: string, init: RequestInit) {
  const body = JSON.parse(String(init.body));
  const kind = url.includes("plugin-invocations") ? "receipt" : "control";
  count(`${kind}-store:${body.action}`);
  if (body.state === "completed") await f.holdCompleted;
  const refused = refusesCombined(kind, body);
  return trip(
    `${storeLabel(kind, body)}${refused ? ":refused" : ""}`,
    "store",
    () =>
      refused
        ? new Response(JSON.stringify({ code: "INVALID_RECEIPT_REQUEST" }), {
            status: 409,
          })
        : new Response(JSON.stringify(answer(kind, body)), { status: 200 }),
  );
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
          legs: [
            {
              round: 0,
              fingerprint: body.legFingerprint,
              state: body.dispatch ? "dispatched" : "reserved",
            },
          ],
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
  if (body.action === "close") {
    f.controls.clear();
    return json({ closed: true });
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
  const open = async (
    threadId: string,
    kind: "thread" | "global" = "thread",
  ) => {
    f.controls.clear();
    f.anchors.clear();
    const opened = await post("activation/open", {
      ...scope,
      hostId: "host",
      serverId: "server",
      toolName: tool.name,
      threadId,
      kind,
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
    f.serial = [];
    f.counts = {};
    f.fastRequests = [];
    f.toolCalls = [];
  };
  /** The completion record is written after the answer; wait for it. */
  const settled = () =>
    vi.waitFor(() => expect(f.log).toContain("receipt.write:completed"));
  beforeEach(async () => {
    const { resetPluginFastStoreDetection } =
      await import("../../../services/plugin-host/service-store");
    const { resetPluginCombinedClaimDetection } =
      await import("../../../services/plugin-host/receipt-store");
    const { pluginConnectionPool } =
      await import("../../../services/plugin-host/connection-pool");
    resetPluginFastStoreDetection();
    resetPluginCombinedClaimDetection();
    await pluginConnectionPool.clear();
    f.fastMissing = false;
    f.combinedMissing = false;
    f.holdCompleted = undefined;
    f.latency = undefined;
    process.env.CONVEX_URL = CONVEX_CLOUD;
  });
  afterEach(() => {
    delete process.env.CONVEX_URL;
    f.latency = undefined;
    vi.restoreAllMocks();
  });

  /** One authorization's read: the App's durable control beside the
   * member's admission and current host, side by side. */
  const FENCE = ["control.read", "admission"];
  /**
   * An App tools/call (and the entrypoint call), in order, as each guarantee
   * needs it and no more:
   * - admit: the member's admission names the actor; the App's durable
   *   control is read once;
   * - resolve: the admission and host read beside that control read (the
   *   capability and launcher toggles and the master switch, current), then
   *   the catalog; the route's resolution is the invoker's first
   *   authorization;
   * - claim: claimed and marked dispatched in one write, which the store
   *   refuses for a closed, expired or revoked App;
   * - before the effect: control and admission read again (a write ran);
   * - after the effect: control and admission read again; delivery stands on
   *   it (nothing runs in between).
   * The completion record follows the answer (AFTER_ANSWER).
   */
  const APP_CALL = [
    "admission",
    "control.read",
    "admission",
    "tools/list",
    "receipt.claim+dispatch",
    ...FENCE,
    "tools/call",
    ...FENCE,
  ];
  const AFTER_ANSWER = ["receipt.write:completed"];
  const backendTrips = (log: string[]) =>
    log.filter((entry) => !entry.startsWith("tools/")).length;
  /** Before this change, for the report: 23 backend calls, 15 one after
   * another, all before the answer (5 tools/list). */
  const BEFORE = { backend: 23, sequential: 15, toolsList: 5 };

  it("an App tools/call makes its backend trips in this order, all through the Convex client", async () => {
    const instanceToken = await open("thread-trips");
    reset();
    const response = await call(instanceToken);
    expect(response.status).toBe(200);
    await settled();
    expect(f.log).toEqual([...APP_CALL, ...AFTER_ANSWER]);
    // 9 backend calls (was 23): 8 before the answer, 6 of them one after
    // another (was 15), and one tools/list (was 5).
    expect(backendTrips(APP_CALL)).toBe(8);
    expect(f.serial).toEqual([
      "admission",
      "control.read",
      "admission",
      "receipt.claim+dispatch",
      "control.read",
      "control.read",
      "receipt.write:completed",
    ]);
    expect(f.counts["mcp-tools-list"]).toBe(1);
    expect(f.toolCalls).toEqual([appTool.name]);
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

  it.each(["thread", "global"] as const)(
    "a %s activation/execute makes the same trips",
    async (kind) => {
      const instanceToken = await open(`${kind}-execute`, kind);
      reset();
      const response = await execute(instanceToken);
      expect(response.status).toBe(200);
      await settled();
      expect(f.log).toEqual([...APP_CALL, ...AFTER_ANSWER]);
      expect(f.toolCalls).toEqual([tool.name]);
    },
  );

  it("answers without waiting for the completion record", async () => {
    const instanceToken = await open("thread-hold");
    let release!: () => void;
    f.holdCompleted = new Promise((done) => {
      release = done;
    });
    reset();
    const response = await call(instanceToken);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe(
      "completed",
    );
    expect(f.log).toEqual(APP_CALL);
    release();
    await settled();
  });

  it("claims, then marks dispatched, on a backend without the combined claim", async () => {
    f.combinedMissing = true;
    const instanceToken = await open("thread-old-claim");
    reset();
    const first = await call(instanceToken);
    expect(first.status).toBe(200);
    await settled();
    const OLDER = [
      "admission",
      "control.read",
      "admission",
      "tools/list",
      "receipt.claim+dispatch:refused",
      "receipt.claim",
      ...FENCE,
      "receipt.write:dispatched",
      ...FENCE,
      "tools/call",
      ...FENCE,
    ];
    expect(f.log).toEqual([...OLDER, ...AFTER_ANSWER]);
    // Asked once, then remembered: the next call claims the plain way.
    reset();
    expect((await call(instanceToken)).status).toBe(200);
    await settled();
    expect(f.log).toEqual([
      ...OLDER.filter((entry) => !entry.endsWith(":refused")),
      ...AFTER_ANSWER,
    ]);
  });

  it("falls back to the HTTP routes, unseen, on a backend without the fast functions", async () => {
    f.fastMissing = true;
    const instanceToken = await open("thread-fallback");
    reset();
    const first = await call(instanceToken);
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("completed");
    await settled();
    // Each missing function is asked once, then remembered.
    expect(f.log.filter((entry) => entry.startsWith("missing "))).toEqual([
      "missing pluginInstanceControls:serviceRead",
      "missing pluginInvocationReceipts:serviceApply",
    ]);
    expect(f.log.filter((entry) => !entry.startsWith("missing "))).toEqual([
      ...APP_CALL,
      ...AFTER_ANSWER,
    ]);
    reset();
    const second = await call(instanceToken);
    expect(second.status).toBe(200);
    await settled();
    expect(f.log).toEqual([...APP_CALL, ...AFTER_ANSWER]);
    expect(f.counts["fast-missing"]).toBeUndefined();
    expect(f.counts["control-store:read"]).toBe(3);
    expect(f.counts["receipt-store:claim"]).toBe(1);
    expect(f.counts["receipt-store:write"]).toBe(1);
  });

  it.each(["here", "in another process"])(
    "refuses an App closed %s before its call, before any claim or effect",
    async (where) => {
      const instanceToken = await open(`thread-closed-${where}`);
      if (where === "here")
        expect((await post("close", { ...scope, instanceToken })).status).toBe(
          200,
        );
      // Another process closed it: only the durable control knows.
      else f.controls.clear();
      reset();
      const response = await call(instanceToken);
      expect([
        response.status,
        ((await response.json()) as { code: string }).code,
      ]).toEqual([403, "INSTANCE_UNAVAILABLE"]);
      expect(f.log.filter((entry) => entry.startsWith("receipt."))).toEqual([]);
      expect(f.toolCalls).toEqual([]);
    },
  );

  /**
   * Measured from a laptop against the dev deployment: a Convex query about
   * 90 ms, a mutation about 100 ms, an HTTP action about 500 ms, and a full
   * target authorization 500-900 ms. Run at a fifth of real time; reported in
   * real milliseconds.
   */
  const SCALE = 5;
  const REAL = {
    convex: 90,
    authorize: 500,
    initialize: 100,
    toolsList: 6,
    resourcesRead: 20,
    store: 500,
    toolCall: 5,
    storeQuery: 90,
    storeMutation: 100,
  };
  const realistic = () => {
    f.latency = Object.fromEntries(
      Object.entries(REAL).map(([name, ms]) => [name, ms / SCALE]),
    );
  };
  const timed = async (run: () => Promise<Response>) => {
    const started = performance.now();
    const response = await run();
    const body = await response.json();
    expect([response.status, body]).toEqual([200, expect.anything()]);
    return Math.round((performance.now() - started) * SCALE);
  };

  it("an App call and an activation each answer in about 600 ms at realistic latencies, racing or not", async () => {
    realistic();
    // Each step settles (its completion record lands) before the next.
    const measure = async (run: () => Promise<Response>) => {
      reset();
      const ms = await timed(run);
      await settled();
      return ms;
    };
    const thread = await open("thread-latency");
    const threadExecute = await measure(() => execute(thread));
    await measure(() => call(thread));
    const steady = await measure(() => call(thread));
    const global = await open("global-latency", "global");
    const globalExecute = await measure(() => execute(global));
    // The App's first call while its entrypoint call runs: the App asks
    // right after it loads. Each request leases its own connection, so the
    // second pays one connection authorization.
    const raced = await open("thread-latency-race");
    f.toolCalls = [];
    const race = await Promise.all([
      timed(() => execute(raced)),
      (async () => {
        await wait(REAL.convex / SCALE);
        return timed(() => call(raced));
      })(),
    ]);
    // Each tool ran once, and the App's first call is nowhere near the
    // 15 s an OpenAI SDK App waits for an answer.
    expect(f.toolCalls.sort()).toEqual([appTool.name, tool.name].sort());
    expect(Math.max(...race)).toBeLessThan(3_000);
    console.info(
      "[app-call-latency]",
      JSON.stringify({
        latency: REAL,
        trips: {
          before: BEFORE,
          after: {
            backend: backendTrips(APP_CALL) + AFTER_ANSWER.length,
            beforeAnswer: backendTrips(APP_CALL),
            sequential: 6,
            toolsList: 1,
          },
        },
        threadExecute,
        globalExecute,
        steadyCall: steady,
        race: { execute: race[0], firstCall: race[1] },
      }),
    );
    // Six round trips (90-100 ms) and the catalog: about 600 ms.
    for (const ms of [threadExecute, globalExecute, steady, race[0]])
      expect(ms).toBeLessThan(750);
  });

  it("re-authorizes an App's connection ahead of its window, so a call past 60 s stays fast", async () => {
    realistic();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const app = await open("thread-latency-window");
    await timed(() => call(app));
    // 35 s later the App calls again: this call answers on the current
    // authorization while a full one runs beside it.
    clock.mockReturnValue(start + 35_000);
    reset();
    const refreshing = await timed(() => call(app));
    await vi.waitFor(() => expect(f.counts["target-authorization"]).toBe(1));
    await wait((REAL.authorize * 2) / SCALE);
    // 64 s after the connection was first authorized.
    clock.mockReturnValue(start + 64_000);
    reset();
    const pastWindow = await timed(() => call(app));
    expect(f.counts["target-authorization"]).toBeUndefined();
    console.info(
      "[app-call-window]",
      JSON.stringify({ refreshing, pastWindow }),
    );
    expect(refreshing).toBeLessThan(750);
    expect(pastWindow).toBeLessThan(750);
  });
});
