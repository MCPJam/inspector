import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  disconnectAllRuntimeServers,
  reconnectServer,
  testConnection,
} from "../mcp-api";
import { serverCheckQueue } from "@/lib/server-check-queue";
import { useStdioCommandApprovalStore } from "@/lib/stdio-command-approval";
import { STDIO_COMMAND_APPROVAL_REQUIRED_REASON } from "@/shared/stdio-command-approval";

function readBody(): Record<string, unknown> {
  expect(authFetchMock).toHaveBeenCalledTimes(1);
  const init = authFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("mcp-api local-mode resolver-only path", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  it("testConnection always sends the resolver body in local mode", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await testConnection(config, "convex_id_abc123", {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("reconnectServer always sends the resolver body in local mode", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await reconnectServer("convex_id_abc123", config, {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("testConnection without projectId throws — legacy fallback is gone", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await expect(
      testConnection(config, "mcpjam local"),
    ).rejects.toThrow(/projectId is required/);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("reconnectServer without projectId throws — legacy fallback is gone", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await expect(
      reconnectServer("mcpjam local", config),
    ).rejects.toThrow(/projectId is required/);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("disconnectAllRuntimeServers removes every listed local runtime server", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            servers: [{ id: "server-1" }, { name: "server-2" }],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        ),
      );

    const result = await disconnectAllRuntimeServers();

    expect(result.success).toBe(true);
    expect(authFetchMock).toHaveBeenNthCalledWith(1, "/api/mcp/servers");
    expect(authFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/mcp/servers/server-1",
      { method: "DELETE" },
    );
    expect(authFetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/mcp/servers/server-2",
      { method: "DELETE" },
    );
  });
  it("reports failed connection status without sending server configuration", async () => {
    const record = vi.fn();
    window.electronAPI = { diagnostics: { record } } as any;
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: "private-details" }),
        { status: 403 },
      ),
    );
    try {
      const result = await testConnection(
        { url: "https://private.test/mcp" } as unknown as MCPServerConfig,
        "private-id",
        { projectId: "private-project" },
      );
      expect(result.success).toBe(false);
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "connect",
          phase: "failure",
          status: 403,
          error: "access_denied",
        }),
      );
      expect(JSON.stringify(record.mock.calls)).not.toContain("private");
    } finally {
      delete window.electronAPI;
    }
  });

});

// Exercise the actual local request boundary, not only the scheduler in isolation.
describe.each(["native", "fallback"])("local browser connection scheduling (%s)", (support) => {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  beforeEach(() => {
    if (support === "fallback")
      Object.defineProperty(AbortSignal, "any", { ...anyDescriptor, value: undefined });
  });
  afterEach(() => {
    Object.defineProperty(AbortSignal, "any", anyDescriptor);
    vi.restoreAllMocks();
  });
  const config = {
    url: "http://localhost:8787/mcp",
  } as unknown as MCPServerConfig;
  const tick = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  it.each(["success", "failure", "cancel", "timeout"])(
    "cleans up local forwarding listeners and deadlines after %s",
    async (outcome) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const failure = new Error("Connection failed");
      authFetchMock.mockImplementation((_url, init) => {
        if (outcome === "success")
          return Promise.resolve(new Response(JSON.stringify({ success: true })));
        if (outcome === "failure") return Promise.reject(failure);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true }
          );
        });
      });
      const result = reconnectServer("one", config, {
        projectId: "local-cleanup",
        queueSignal: caller.signal,
      });
      const settled = Promise.allSettled([result]);
      if (outcome === "cancel") caller.abort(failure);
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(50_000);
      const [value] = await settled;
      if (outcome === "success")
        expect(value).toMatchObject({ status: "fulfilled" });
      else {
        expect(value.status).toBe("rejected");
        if (value.status === "rejected") {
          if (outcome === "timeout")
            expect(value.reason.name).toBe("TimeoutError");
          else expect(value.reason).toBe(failure);
        }
      }
      expect(vi.getTimerCount()).toBe(0);
      if (support === "fallback") {
        expect(add).toHaveBeenCalledTimes(2);
        expect(remove).toHaveBeenCalledTimes(2);
        for (const [type, listener] of add.mock.calls)
          expect(remove).toHaveBeenCalledWith(type, listener);
      }
    }
  );

  it("runs 120 local cards in saved order, deduplicates mounts and reorders waiting work", async () => {
    const { serverCheckQueue: queue } =
      await import("@/lib/server-check-queue");
    const projectId = "local-120";
    const names = Array.from({ length: 120 }, (_, i) => `card-${i}`);
    queue.markAutomatic(projectId, names);
    queue.setOrder(projectId, [...names].reverse());
    const starts: string[] = [];
    const release = new Map<string, () => void>();
    authFetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve) => {
          const body = JSON.parse(init.body);
          starts.push(body.serverName);
          expect(body._serverCheck.intent).toBe("automatic");
          release.set(body.serverName, () =>
            resolve(new Response(JSON.stringify({ success: true }))),
          );
        }),
    );
    const connect = (name: string) =>
      testConnection(config, name, { projectId, serverName: name });
    const jobs = names.map(connect);
    const duplicate = connect("card-119");
    await tick();
    expect(starts).toEqual([...names].reverse().slice(0, 10));
    expect(queue.state(projectId, "card-0")).toBe("queued");
    queue.setOrder(projectId, names);
    release.get("card-119")!();
    await tick();
    expect(starts.at(-1)).toBe("card-0");
    for (let i = 0; i < 120; i++) {
      for (const done of release.values()) done();
      await tick();
    }
    await Promise.all([...jobs, duplicate]);
    expect(new Set(starts).size).toBe(120);
    expect(starts).toHaveLength(120);
  });
  it("returns a preempted automatic attempt to Queued and keeps the original promise", async () => {
    vi.useFakeTimers();
    const { serverCheckQueue: queue } =
      await import("@/lib/server-check-queue");
    const projectId = "local-recovery";
    queue.markAutomatic(projectId, ["auto"]);
    const ids: string[] = [];
    authFetchMock.mockImplementation((_url, init) => {
      ids.push(JSON.parse(init.body)._serverCheck.requestId);
      return Promise.resolve(
        ids.length === 1
          ? new Response(
              JSON.stringify({
                success: false,
                details: { reason: "SERVER_CHECK_PREEMPTED" },
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ success: true })),
      );
    });
    try {
      let completed = false;
      const job = reconnectServer("auto", config, {
        projectId,
        serverName: "auto",
      }).then((value) => {
        completed = true;
        return value;
      });
      await tick();
      expect(completed).toBe(false);
      expect(queue.state(projectId, "auto")).toBe("queued");
      await vi.advanceTimersByTimeAsync(500);
      await expect(job).resolves.toEqual({ success: true });
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("respects Retry-After for queue refusals", async () => {
    vi.useFakeTimers();
    const projectId = "local-congestion";
    let count = 0;
    authFetchMock.mockImplementation(() =>
      Promise.resolve(
        ++count === 1
          ? new Response(
              JSON.stringify({
                details: { reason: "SERVER_CHECK_QUEUE_FULL" },
              }),
              { status: 429, headers: { "Retry-After": "2" } },
            )
          : new Response(JSON.stringify({ success: true })),
      ),
    );
    try {
      const job = testConnection(config, "busy", { projectId });
      await tick();
      await vi.advanceTimersByTimeAsync(1999);
      expect(count).toBe(1);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(job).resolves.toEqual({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });
  it("forwards cancellation without turning it into a timeout", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    authFetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          received = init.signal;
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    const job = testConnection(config, "cancel", {
      projectId: "local-cancel",
      queueSignal: controller.signal,
    });
    const rejection = expect(job).rejects.toHaveProperty("name", "AbortError");
    await tick();
    controller.abort();
    await rejection;
    expect(received?.aborted).toBe(true);
  });
  it("distinguishes a dispatched request deadline from caller cancellation", async () => {
    vi.useFakeTimers();
    authFetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    try {
      const job = testConnection(config, "timeout", {
        projectId: "local-timeout",
      });
      const rejection = expect(job).rejects.toHaveProperty(
        "name",
        "TimeoutError",
      );
      await tick();
      await vi.advanceTimersByTimeAsync(50_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
  it("releases the slot when OAuth needs input so waiting connections can proceed", async () => {
    const { serverCheckQueue: queue } =
      await import("@/lib/server-check-queue");
    const projectId = "local-oauth";
    const releases: (() => void)[] = [];
    authFetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() =>
            resolve(
              new Response(
                JSON.stringify({ success: false, oauthRequired: true }),
                { status: 401 },
              ),
            ),
          );
        }),
    );
    const jobs = Array.from({ length: 11 }, (_, i) =>
      testConnection(config, `oauth-${i}`, { projectId }),
    );
    await tick();
    expect(releases).toHaveLength(10);
    expect(queue.state(projectId, "oauth-10")).toBe("queued");
    releases[0]();
    await tick();
    expect(releases).toHaveLength(11);
    for (const release of releases) release();
    await Promise.all(jobs);
    expect(queue.state(projectId, "oauth-0")).toBeUndefined();
  });
});

describe("mcp-api local-mode stdio command approval handshake", () => {
  const config = { command: "node", args: ["server.js"] } as unknown as MCPServerConfig;
  const options = { projectId: "project_xyz", serverName: "Files" };
  const TERMS = {
    serverId: "srv-1",
    fingerprint: "ab".repeat(32),
    command: "node",
    args: ["server.js"],
    envNames: ["FOO"],
    previouslyApproved: false,
  };
  const REFUSAL = {
    success: false,
    error: '"Files" runs a command this device has not approved yet.',
    reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
    serverId: "srv-1",
    approval: TERMS,
  };
  const refusal = () =>
    new Response(JSON.stringify(REFUSAL), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  const ok = () =>
    new Response(JSON.stringify({ success: true }), { status: 200 });

  function answerNextPrompt(allowed: boolean) {
    return new Promise<void>((resolve) => {
      const unsubscribe = useStdioCommandApprovalStore.subscribe((state) => {
        if (state.queue.length === 0) return;
        unsubscribe();
        state.settle(allowed);
        resolve();
      });
    });
  }

  beforeEach(() => {
    authFetchMock.mockReset();
    useStdioCommandApprovalStore.setState({ queue: [] });
  });

  it("asks the user, records the approval and retries the connect", async () => {
    authFetchMock
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const answered = answerNextPrompt(true);

    const result = await testConnection(config, "srv-1", options);
    await answered;

    expect(result).toEqual({ success: true });
    expect(authFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/mcp/connect",
      "/api/mcp/servers/approve-command",
      "/api/mcp/connect",
    ]);
    const approveBody = JSON.parse(
      String((authFetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(approveBody).toEqual({
      projectId: "project_xyz",
      serverId: "srv-1",
      serverName: "Files",
      fingerprint: TERMS.fingerprint,
    });
  });

  it("returns the refusal untouched when the user declines", async () => {
    authFetchMock.mockResolvedValue(refusal());
    const answered = answerNextPrompt(false);

    const result = await reconnectServer("srv-1", config, options);
    await answered;

    expect(result).toMatchObject({
      success: false,
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("never prompts for an automatic connect", async () => {
    serverCheckQueue.markAutomatic("project_xyz", ["Files"]);
    authFetchMock.mockResolvedValue(refusal());
    let prompted = false;
    const unsubscribe = useStdioCommandApprovalStore.subscribe((state) => {
      if (state.queue.length > 0) prompted = true;
    });

    const result = await reconnectServer("srv-1", config, options);
    unsubscribe();

    expect(prompted).toBe(false);
    expect(result).toMatchObject({
      success: false,
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
