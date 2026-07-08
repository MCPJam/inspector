import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getComputersRemoteDataPlaneUrl,
  execViaRemoteDataPlane,
} from "../computers/remote-data-plane";
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

  it("keeps explicit ports and allows plain http", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "http://localhost:3500");
    expect(getComputersRemoteDataPlaneUrl()).toBe("http://localhost:3500");
  });

  it("rejects invalid values and non-http(s) schemes", () => {
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "not a url");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
    vi.stubEnv("COMPUTERS_REMOTE_DATA_PLANE_URL", "ftp://dp.example.test");
    expect(getComputersRemoteDataPlaneUrl()).toBeNull();
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
    vi.stubEnv("COMPUTERS_DATA_PLANE_SECRET", "secret");
    vi.stubEnv("E2B_API_KEY", "e2b_test");
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
