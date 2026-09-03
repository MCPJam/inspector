import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// Controllable HOSTED_MODE / kill switch: both are import-time consts in the
// real config module, so env stubs can't reach them.
const configState = vi.hoisted(() => ({
  hosted: false,
  localEnabled: true,
  harnessEnabled: false,
}));
vi.mock("../../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../../config.js")>(
    "../../../config.js"
  );
  return {
    ...actual,
    get HOSTED_MODE() {
      return configState.hosted;
    },
    get LOCAL_COMPUTER_ENABLED() {
      return configState.localEnabled;
    },
    get LOCAL_HARNESS_ENABLED() {
      return configState.harnessEnabled;
    },
  };
});

// The kill switch the route reads for `engines.local.browserAvailable`.
// Imported through the SAME specifier the mock above registers, so the test
// and the route see one value rather than a hard-coded `true`.
import { LOCAL_BROWSER_ENABLED } from "../../../config.js";
import { createComputersRoutes } from "../computers";
import { isLocalComputerEngineAvailable } from "../../../utils/computers/local-machine";
import { getLocalTerminalAvailability } from "../../../utils/computers/local-pty";
import type { BashRunner } from "../../../utils/computers/run-command";

// Route-level tests: GET /config (data-plane discovery) and POST /exec (the
// endpoint a credential-less local inspector forwards bash calls to). The
// Convex control plane is a fetch stub; E2B is an injected runner.

const CONVEX_URL = "https://convex.example";

type FetchCall = { path: string; headers: Record<string, string>; body: any };

let fetchCalls: FetchCall[];
let fetchHandler: (path: string, body: any) => { status: number; json: any };

function installFetchStub() {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      fetchCalls.push({
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
      });
      const { status, json } = fetchHandler(path, body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    })
  );
}

function happyControlPlane() {
  fetchHandler = (path) => {
    if (path === "/computers/reserve") {
      return {
        status: 200,
        json: { computerId: "comp_1", status: "ready", provider: "e2b" },
      };
    }
    if (path === "/computers/sandbox-info") {
      return {
        status: 200,
        json: {
          computerId: "comp_1",
          providerComputerId: "sbx_42",
          provider: "e2b",
          status: "ready",
          projectId: "proj_1",
          ownerUserId: "user_1",
        },
      };
    }
    if (path === "/computers/commands") {
      return { status: 200, json: { ok: "recorded" } };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

function createApp(runner?: BashRunner) {
  const app = new Hono();
  app.route("/api/web/computers", createComputersRoutes(runner));
  return app;
}

function postExec(
  app: Hono,
  body: Record<string, unknown>,
  headers: Record<string, string> = { authorization: "Bearer user-token" }
) {
  return app.request("/api/web/computers/exec", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function stubLocalDataPlaneEnv() {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-svc-token");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "terminal-secret-16+");
}

beforeEach(() => {
  installFetchStub();
  configState.hosted = false;
  configState.localEnabled = true;
  configState.harnessEnabled = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/web/computers/config", () => {
  // The local-engine block depends on the host running the tests (bash on
  // PATH); compose the expectation from the same probe the route consults so
  // the suite is honest on a bash-less machine instead of failing on it.
  async function expectedLocalEngineBlock() {
    const availability = isLocalComputerEngineAvailable();
    // node-pty is an OPTIONAL native dep, so `terminalAvailable` depends on the
    // host running the tests just like `available` does — compose it from the
    // same probe the route consults rather than hard-coding either answer.
    const terminal = await getLocalTerminalAvailability();
    // `browserAvailable` is a SERVER capability bit, independent of whether
    // bash is on this machine's PATH — the agent browser does not need a
    // shell. Composed from the same switch the route reads so the suite stays
    // honest on a server where it is turned off.
    return availability.available
      ? {
          available: true,
          terminalAvailable: terminal.available,
          workspaceDisplayRoot: "~/.mcpjam/computer",
          browserAvailable: LOCAL_BROWSER_ENABLED,
        }
      : {
          available: false,
          // A machine whose local ENGINE is off never offers a terminal.
          terminalAvailable: false,
          workspaceDisplayRoot: null,
          browserAvailable: LOCAL_BROWSER_ENABLED,
          reason: availability.reason,
        };
  }

  it("reports an unconfigured server — legacy fields intact, engines added", async () => {
    const localBlock = await expectedLocalEngineBlock();
    const response = await createApp().request("/api/web/computers/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      localConfigured: false,
      remoteDataPlaneUrl: null,
      engines: {
        // Terminal stays off until the node-pty PR wires its probe.
        local: localBlock,
        cloud: { available: false },
      },
      capabilities: {
        personalCloudAvailable: false,
        ephemeralCloudAvailable: false,
      },
      // A different axis from the engines: an engine decides where a bash call
      // runs, a harness target decides where the whole vendor agent runs. Off
      // by default, and on this OPEN endpoint the answer is deliberately
      // coarse — a server capability, nothing about this machine.
      harnessTargets: { localNative: { serverEnabled: false } },
      // No cloud anywhere ⇒ local when the machine can serve it, else the
      // honest "no engine exists" null.
      defaultEngine: localBlock.available ? "local" : null,
    });
  });

  it("reports a locally configured data plane — BOTH cloud capabilities", async () => {
    stubLocalDataPlaneEnv();
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.localConfigured).toBe(true);
    expect(body.remoteDataPlaneUrl).toBeNull();
    expect(body.engines.cloud).toEqual({ available: true });
    expect(body.capabilities).toEqual({
      personalCloudAvailable: true,
      ephemeralCloudAvailable: true,
    });
  });

  it("remote-only: personal cloud works, ephemeral does NOT — the capability split", async () => {
    // `remoteDataPlaneUrl` delegates only personal-computer exec/terminal;
    // eval/swarm/scenario sandboxes need THIS process to hold the creds. A
    // single "cloud available" bit would lie to exactly those surfaces.
    vi.stubEnv(
      "COMPUTERS_REMOTE_DATA_PLANE_URL",
      "https://dp.example.test/ignored-path"
    );
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.localConfigured).toBe(false);
    expect(body.remoteDataPlaneUrl).toBe("https://dp.example.test");
    expect(body.capabilities).toEqual({
      personalCloudAvailable: true,
      ephemeralCloudAvailable: false,
    });
  });

  it("hosted: no local engine, cloud default — and no reason leaks paths", async () => {
    configState.hosted = true;
    stubLocalDataPlaneEnv();
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.engines.local.available).toBe(false);
    expect(body.engines.local.workspaceDisplayRoot).toBeNull();
    expect(body.defaultEngine).toBe("cloud");
  });

  it("kill switch off + no cloud: NO contradictory default — defaultEngine is null", async () => {
    // Telling the client "the default engine is cloud" while every
    // availability flag says cloud doesn't exist would send the engine UI
    // chasing a phantom; null lets it fall through to its empty state.
    configState.localEnabled = false;
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.engines.local.available).toBe(false);
    expect(body.engines.local.reason).toMatch(/disabled/);
    expect(body.defaultEngine).toBeNull();
  });

  it("kill switch off with a cloud data plane: default falls back to cloud", async () => {
    configState.localEnabled = false;
    stubLocalDataPlaneEnv();
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.defaultEngine).toBe("cloud");
  });

  it("reports the harness kill switch, and only the kill switch", async () => {
    configState.harnessEnabled = true;
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.harnessTargets).toEqual({
      localNative: { serverEnabled: true },
    });
    // Everything that would identify THIS MACHINE stays behind the
    // authenticated route: this endpoint takes no bearer.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/runtimeId|machineId|digest|fingerprint/i);
  });

  it("hosted forces the harness target off, whatever the kill switch says", async () => {
    // The structural rule: a hosted replica must never offer to run an agent
    // on ITS machine. `LOCAL_HARNESS_ENABLED` is already false under
    // `HOSTED_MODE` in the real config; the route re-checks anyway, and this
    // pins the route's own answer rather than the constant's.
    configState.harnessEnabled = true;
    configState.hosted = true;
    const response = await createApp().request("/api/web/computers/config");
    const body = (await response.json()) as Record<string, any>;
    expect(body.harnessTargets.localNative.serverEnabled).toBe(false);
  });

  it("never leaks an absolute home path — the display root is a tilde literal", async () => {
    const response = await createApp().request("/api/web/computers/config");
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(process.env.HOME ?? "::never::");
    if (isLocalComputerEngineAvailable().available) {
      expect(raw).toContain("~/.mcpjam/computer");
    }
  });
});

describe("POST /api/web/computers/exec", () => {
  it("runs the command with the caller's bearer and returns the output", async () => {
    stubLocalDataPlaneEnv();
    happyControlPlane();
    const runner = vi.fn(async () => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    }));

    const response = await postExec(createApp(runner), {
      projectId: "proj_1",
      command: "echo hello",
      commandId: "call_7",
      workdir: "/home/user/workspace",
      timeoutSeconds: 30,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_42",
        command: "echo hello",
        workdir: "/home/user/workspace",
        timeoutMs: 30_000,
      })
    );
    // The caller's bearer reaches Convex reserve (authz); the caller's
    // commandId is the idempotency key on the durable log.
    expect(fetchCalls[0].path).toBe("/computers/reserve");
    expect(fetchCalls[0].headers.authorization).toBe("Bearer user-token");
    expect(
      fetchCalls.find((call) => call.path === "/computers/commands")?.body
    ).toMatchObject({ commandId: "call_7", source: "chat" });
  });

  it("rejects requests without a bearer token", async () => {
    stubLocalDataPlaneEnv();
    const runner = vi.fn();
    const response = await postExec(
      createApp(runner),
      { projectId: "proj_1", command: "ls", commandId: "c1" },
      {}
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies", async () => {
    stubLocalDataPlaneEnv();
    const response = await postExec(createApp(vi.fn()), {
      projectId: "proj_1",
      // command missing
      commandId: "c1",
    });
    expect(response.status).toBe(400);
  });

  it("reports soft failure when this server is not a data plane — and never forwards", async () => {
    // A remote URL is set, but /exec must not delegate: that would let a
    // misconfigured pair of servers forward to each other in a loop.
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "https://dp.example.test");
    const response = await postExec(createApp(vi.fn()), {
      projectId: "proj_1",
      command: "ls",
      commandId: "c1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      error: "Computers are not configured on this server.",
    });
    expect(fetchCalls).toHaveLength(0);
  });
});
