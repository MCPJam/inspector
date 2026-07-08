import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildBashTool, BASH_TOOL_NAME } from "../built-in-tools/bash";
import { detectAuthUrls } from "../computers/auth-urls";

// The bash tool's Convex control-plane calls go through global fetch
// (CONVEX_HTTP_URL); the E2B exec goes through an injectable runner. Stub
// both and exercise the tool exactly as the AI SDK would call it.

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

const toolOpts = {
  authHeader: "Bearer user-token",
  projectId: "proj_1",
  workdir: "/workspace",
};

function execTool(
  tool: ReturnType<typeof buildBashTool>,
  input: Record<string, unknown>
) {
  return (tool as any).execute(input, {
    toolCallId: "call_1",
    abortSignal: undefined,
    messages: [],
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  vi.stubEnv("COMPUTERS_DATA_PLANE_SECRET", "test-data-plane-secret-000000");
  vi.stubEnv("E2B_API_KEY", "e2b_test");
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe(`${BASH_TOOL_NAME} tool`, () => {
  it("reserves, resolves the sandbox, runs, records, and returns output", async () => {
    happyControlPlane();
    const runner = vi.fn(async () => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = buildBashTool(toolOpts, runner);

    const result = await execTool(tool, { command: "echo hello" });
    expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_42",
        command: "echo hello",
        workdir: "/workspace",
        timeoutMs: 120_000,
      })
    );

    const paths = fetchCalls.map((call) => call.path);
    expect(paths).toEqual([
      "/computers/reserve",
      "/computers/sandbox-info",
      "/computers/commands",
    ]);
    // Reserve uses the user's bearer; the secret routes use the shared secret.
    expect(fetchCalls[0].headers.authorization).toBe("Bearer user-token");
    expect(fetchCalls[1].headers["x-computers-data-plane-secret"]).toBeTruthy();
    expect(fetchCalls[2].body).toMatchObject({
      computerId: "comp_1",
      commandId: "call_1",
      source: "chat",
      status: "completed",
      exitCode: 0,
    });
  });

  it("polls reserve until ready and surfaces waking → ready", async () => {
    let reserveCalls = 0;
    fetchHandler = (path) => {
      if (path === "/computers/reserve") {
        reserveCalls += 1;
        return {
          status: 200,
          json: {
            computerId: "comp_1",
            status: reserveCalls < 3 ? "waking" : "ready",
            provider: "e2b",
          },
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
      return { status: 200, json: { ok: "recorded" } };
    };
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const tool = buildBashTool({ ...toolOpts }, runner);

    // Real-time poll loop (two 1.5s intervals) — fake timers would deadlock
    // the awaited fetch chain, and 3s is within this test's raised timeout.
    const result = await execTool(tool, { command: "true" });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(reserveCalls).toBe(3);
  }, 15_000);

  it("reports non-zero exits as results, not errors, and lifts auth URLs", async () => {
    happyControlPlane();
    const runner = vi.fn(async () => ({
      stdout: "Open https://github.com/login/device and enter code ABCD-1234\n",
      stderr: "exited",
      exitCode: 1,
    }));
    const tool = buildBashTool(toolOpts, runner);

    const result = await execTool(tool, { command: "gh auth login" });
    expect(result.exitCode).toBe(1);
    expect(result.authUrls).toEqual(["https://github.com/login/device"]);

    expect(
      fetchCalls.find((call) => call.path === "/computers/commands")?.body
    ).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("returns a clean error when computers are unconfigured", async () => {
    vi.stubEnv("COMPUTERS_DATA_PLANE_SECRET", "");
    const runner = vi.fn();
    const tool = buildBashTool(toolOpts, runner);
    const result = await execTool(tool, { command: "ls" });
    expect(result).toEqual({
      error: "Computers are not configured on this server.",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces reserve denials (e.g. non-member) as tool errors", async () => {
    fetchHandler = (path) => {
      if (path === "/computers/reserve") {
        return { status: 403, json: { error: "Not authorized" } };
      }
      throw new Error("should not get further");
    };
    const tool = buildBashTool(toolOpts, vi.fn());
    const result = await execTool(tool, { command: "ls" });
    expect(result.error).toMatch(/Not authorized/);
  });

  it("errors when the sandbox id is not yet assigned", async () => {
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
            providerComputerId: null,
            provider: "e2b",
            status: "ready",
            projectId: "proj_1",
            ownerUserId: "user_1",
          },
        };
      }
      throw new Error("should not record");
    };
    const tool = buildBashTool(toolOpts, vi.fn());
    const result = await execTool(tool, { command: "ls" });
    expect(result.error).toMatch(/still provisioning/);
  });
});

describe("detectAuthUrls", () => {
  it("detects device-flow and login URLs, deduped, punctuation-trimmed", () => {
    const output = [
      "First open https://github.com/login/device.",
      "then https://github.com/login/device",
      "or https://accounts.google.com/o/oauth2/v2/auth?x=1",
      "also https://microsoft.com/devicelogin,",
    ].join("\n");
    expect(detectAuthUrls(output)).toEqual([
      "https://github.com/login/device",
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      "https://microsoft.com/devicelogin",
    ]);
  });

  it("ignores ordinary URLs", () => {
    expect(
      detectAuthUrls("see https://example.com/docs and https://npmjs.com/x")
    ).toEqual([]);
  });
});
