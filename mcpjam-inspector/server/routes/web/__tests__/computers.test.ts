import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createComputersRoutes } from "../computers";
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
  vi.stubEnv("COMPUTERS_DATA_PLANE_SECRET", "test-secret");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
}

beforeEach(() => {
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/web/computers/config", () => {
  it("reports an unconfigured server", async () => {
    const response = await createApp().request("/api/web/computers/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      localConfigured: false,
      remoteDataPlaneUrl: null,
    });
  });

  it("reports a locally configured data plane", async () => {
    stubLocalDataPlaneEnv();
    const response = await createApp().request("/api/web/computers/config");
    expect(await response.json()).toEqual({
      localConfigured: true,
      remoteDataPlaneUrl: null,
    });
  });

  it("advertises the remote data plane origin", async () => {
    vi.stubEnv(
      "COMPUTERS_REMOTE_DATA_PLANE_URL",
      "https://dp.example.test/ignored-path"
    );
    const response = await createApp().request("/api/web/computers/config");
    expect(await response.json()).toEqual({
      localConfigured: false,
      remoteDataPlaneUrl: "https://dp.example.test",
    });
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
      workdir: "/workspace",
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
        workdir: "/workspace",
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
