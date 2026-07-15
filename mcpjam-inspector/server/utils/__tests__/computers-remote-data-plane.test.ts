import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getComputersRemoteDataPlaneUrl,
  execViaRemoteDataPlane,
  initComputersRemoteDataPlaneDiscovery,
  initComputersStartup,
  resolveComputersRemoteDataPlaneUrl,
  resetComputersRemoteDataPlaneDiscoveryForTests,
} from "../computers/remote-data-plane";
import { resetComputersRuntimeConfigBootstrapForTests } from "../computers/runtime-config";
import { buildBashTool } from "../built-in-tools/bash";

// The remote data plane is reached through global fetch; stub it and assert
// both the standalone exec client and the bash tool's delegation branch.

const REMOTE_URL = "https://dp.example.test";

type FetchCall = { url: string; headers: Record<string, string>; body: any };

let fetchCalls: FetchCall[];
let fetchResponse: () => Response | Promise<Response>;

function installFetchStub() {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return fetchResponse();
    })
  );
}

function jsonResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const execArgs = {
  authHeader: "Bearer user-token",
  projectId: "proj_1",
  command: "echo hi",
  commandId: "call_1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetComputersRemoteDataPlaneDiscoveryForTests();
});

describe("getComputersRemoteDataPlaneUrl", () => {
  it("returns null when unset or blank", () => {
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "   ");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });

  it("normalizes to the origin (path and trailing slash dropped)", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", `${REMOTE_URL}/some/path/`);
    expect(getComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });

  it("keeps explicit ports and allows plain http for loopback hosts", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://localhost:3500");
    expect(getComputersRemoteDataPlaneUrl()).toBe("http://localhost:3500");
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://127.0.0.1:3500");
    expect(getComputersRemoteDataPlaneUrl()).toBe("http://127.0.0.1:3500");
  });

  it("allows plain http for the IPv6 loopback (bracketed by URL parsing)", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://[::1]:3500");
    expect(getComputersRemoteDataPlaneUrl()).toBe("http://[::1]:3500");
  });

  it("rejects plain http for a non-loopback host", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://staging.mcpjam.com");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });

  it("rejects invalid values and non-http(s) schemes", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "not a url");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "ftp://dp.example.test");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });
});

describe("initComputersRemoteDataPlaneDiscovery", () => {
  it("fetches the canonical URL from Convex and caches it", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: REMOTE_URL });

    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://convex.example/computers/data-plane-url"
    );
    expect(getComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });

  it("skips the network call when an explicit override is set", async () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", REMOTE_URL);
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();

    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(0);
    expect(getComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });

  it("skips the network call when this server already holds real secrets", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-svc-token");
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "terminal-secret-16+");
    installFetchStub();

    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(0);
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });

  it("stays unconfigured (does not throw) when CONVEX_HTTP_URL is unset", async () => {
    installFetchStub();
    await expect(initComputersRemoteDataPlaneDiscovery()).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });

  it("initComputersStartup: a bootstrap-configured server never discovers/delegates", async () => {
    // Only the service token — the boot bootstrap supplies the rest. The
    // startup wrapper must resolve the bootstrap BEFORE discovery runs, so
    // this soon-to-be data plane skips discovery instead of racing into a
    // remote URL while also being locally configured.
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-tok");
    resetComputersRuntimeConfigBootstrapForTests();
    installFetchStub();
    fetchResponse = () =>
      jsonResponse(200, {
        enabled: true,
        e2bApiKey: "boot-key",
        e2bApiUrl: null,
        e2bDomain: null,
        e2bTemplateId: null,
        terminalTokenSecret: "boot-terminal-secret",
      });

    try {
      await initComputersStartup();

      // Exactly one fetch: the runtime-config bootstrap. No discovery call.
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]!.url).toContain(
        "/internal/v1/computers/runtime-config"
      );
      expect(getComputersRemoteDataPlaneUrl()).toBeNull();
    } finally {
      resetComputersRuntimeConfigBootstrapForTests();
      delete process.env.E2B_API_KEY;
      delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    }
  });

  it("stays unconfigured (does not throw) on a network failure", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => {
      throw new TypeError("fetch failed");
    };

    await expect(initComputersRemoteDataPlaneDiscovery()).resolves.toBeUndefined();
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });

  it("does NOT skip discovery for an invalid override (a typo isn't a real override)", async () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "not a url");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: REMOTE_URL });

    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(1);
    expect(getComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });

  it("does NOT skip discovery for a non-loopback http override (rejected, not a real override)", async () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://staging.mcpjam.com");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: REMOTE_URL });

    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(1);
    expect(getComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });

  it("memoizes: a second call does not re-fetch", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: REMOTE_URL });

    await Promise.all([
      initComputersRemoteDataPlaneDiscovery(),
      initComputersRemoteDataPlaneDiscovery(),
    ]);
    await initComputersRemoteDataPlaneDiscovery();

    expect(fetchCalls).toHaveLength(1);
  });

  it("stays unconfigured when Convex has no canonical URL set", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: null });

    await initComputersRemoteDataPlaneDiscovery();
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
  });
});

describe("resolveComputersRemoteDataPlaneUrl", () => {
  it("awaits a slow in-flight discovery instead of racing it", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    let resolveFetch: (value: Response) => void;
    fetchResponse = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

    // Simulates server startup firing discovery without awaiting it.
    void initComputersRemoteDataPlaneDiscovery();
    const resolved = resolveComputersRemoteDataPlaneUrl();

    // The lookup hasn't returned yet — resolveComputersRemoteDataPlaneUrl
    // must not settle with a premature null.
    resolveFetch!(jsonResponse(200, { url: REMOTE_URL }));
    expect(await resolved).toBe(REMOTE_URL);
  });

  it("self-triggers discovery when nothing has started it yet", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    installFetchStub();
    fetchResponse = () => jsonResponse(200, { url: REMOTE_URL });

    expect(await resolveComputersRemoteDataPlaneUrl()).toBe(REMOTE_URL);
  });
});

describe("execViaRemoteDataPlane", () => {
  beforeEach(() => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", REMOTE_URL);
    installFetchStub();
  });

  it("POSTs the exec route with the user's bearer and returns the result", async () => {
    fetchResponse = () =>
      jsonResponse(200, { stdout: "hi\n", stderr: "", exitCode: 0 });

    const result = await execViaRemoteDataPlane({
      ...execArgs,
      workdir: "/workspace",
      timeoutSeconds: 30,
    });
    expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${REMOTE_URL}/api/web/computers/exec`);
    expect(fetchCalls[0].headers.authorization).toBe("Bearer user-token");
    expect(fetchCalls[0].body).toEqual({
      projectId: "proj_1",
      command: "echo hi",
      commandId: "call_1",
      workdir: "/workspace",
      timeoutSeconds: 30,
    });
  });

  it("prefixes Bearer when the auth header is a bare token", async () => {
    fetchResponse = () =>
      jsonResponse(200, { stdout: "", stderr: "", exitCode: 0 });
    await execViaRemoteDataPlane({ ...execArgs, authHeader: "raw-token" });
    expect(fetchCalls[0].headers.authorization).toBe("Bearer raw-token");
  });

  it("passes through soft { error } results from the remote", async () => {
    fetchResponse = () =>
      jsonResponse(200, { error: "Computer unavailable: asleep" });
    const result = await execViaRemoteDataPlane(execArgs);
    expect(result).toEqual({ error: "Computer unavailable: asleep" });
  });

  it("maps webError envelopes (e.g. 401) to a tool-shaped error", async () => {
    fetchResponse = () =>
      jsonResponse(401, {
        code: "UNAUTHORIZED",
        message: "Missing or invalid bearer token",
      });
    const result = await execViaRemoteDataPlane(execArgs);
    expect(result).toEqual({
      error: "Computer unavailable: Missing or invalid bearer token",
    });
  });

  it("reports unreachable remotes without throwing", async () => {
    fetchResponse = () => {
      throw new TypeError("fetch failed");
    };
    const result = await execViaRemoteDataPlane(execArgs);
    expect(result).toEqual({
      error: "Could not reach the computers data plane.",
    });
  });

  it("rejects unexpected response shapes", async () => {
    fetchResponse = () => jsonResponse(200, { unexpected: true });
    const result = await execViaRemoteDataPlane(execArgs);
    expect(result).toEqual({
      error: "The computers data plane returned an unexpected response.",
    });
  });

  it("errors cleanly when no remote is configured", async () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "");
    const result = await execViaRemoteDataPlane(execArgs);
    expect(result).toEqual({
      error: "Computers are not configured on this server.",
    });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("bash tool delegation", () => {
  beforeEach(() => {
    // No local data-plane credentials — only the remote URL.
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", REMOTE_URL);
    installFetchStub();
  });

  function execTool(input: Record<string, unknown>) {
    const runner = vi.fn();
    const tool = buildBashTool(
      {
        authHeader: "Bearer user-token",
        projectId: "proj_1",
        workdir: "/workspace",
      },
      runner
    );
    return {
      runner,
      result: (tool as any).execute(input, {
        toolCallId: "call_9",
        abortSignal: undefined,
        messages: [],
      }) as Promise<unknown>,
    };
  }

  it("forwards the exec to the remote data plane when local is unconfigured", async () => {
    fetchResponse = () =>
      jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0 });

    const { runner, result } = execTool({ command: "ls", timeoutSeconds: 5 });
    expect(await result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });

    // The local E2B runner must never be touched on the delegation path.
    expect(runner).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${REMOTE_URL}/api/web/computers/exec`);
    expect(fetchCalls[0].body).toMatchObject({
      projectId: "proj_1",
      command: "ls",
      commandId: "call_9",
      workdir: "/workspace",
      timeoutSeconds: 5,
    });
  });

  it("prefers the local data plane when both are configured", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-svc-token");
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "terminal-secret-16+");
    fetchResponse = () =>
      jsonResponse(200, {
        computerId: "comp_1",
        status: "ready",
        provider: "e2b",
        providerComputerId: "sbx_1",
        projectId: "proj_1",
        ownerUserId: "user_1",
      });

    const runner = vi.fn(async () => ({
      stdout: "local\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = buildBashTool(
      { authHeader: "Bearer user-token", projectId: "proj_1" },
      runner
    );
    const result = await (tool as any).execute(
      { command: "true" },
      { toolCallId: "call_1", abortSignal: undefined, messages: [] }
    );
    expect(result).toMatchObject({ stdout: "local\n", exitCode: 0 });
    expect(runner).toHaveBeenCalled();
    // Every fetch went to the Convex control plane, none to the remote.
    expect(
      fetchCalls.every((call) => call.url.startsWith("https://convex.example"))
    ).toBe(true);
  });
});
