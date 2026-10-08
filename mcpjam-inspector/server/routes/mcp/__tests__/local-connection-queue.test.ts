import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localServerCheckQueue,
  LocalCheckError,
} from "../../../utils/local-server-check-queue.js";
import { randomUUID } from "node:crypto";
import { createMockMcpClientManager, createTestApp } from "./helpers/index.js";
import { generateSessionToken } from "../../../services/session-token.js";
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const authorization = {
  ok: true,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig: {
    transportType: "http",
    url: "https://example.test/mcp",
    authMethod: "none",
  },
};
beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          results: Object.fromEntries(
            (body.serverIds ?? []).map((id: string) => [id, authorization]),
          ),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("local connection route coordination", () => {
  it("shares connect/reconnect admission across tabs and waits for interrupted cleanup", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, ["connect", "servers"]);
    const signals = new Map<string, AbortSignal>();
    const release = new Map<string, () => void>();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    manager.connectToServer.mockImplementation(
      (key: string, _config: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          signals.set(key, options.signal);
          release.set(key, () => resolve({}));
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    manager.disconnectServer.mockImplementation(async (key: string) => {
      if (signals.get(key)?.aborted) await cleanup;
    });
    const post = (key: string, automatic: boolean, reconnect = false) =>
      app.request(
        reconnect ? "/api/mcp/servers/reconnect" : "/api/mcp/connect",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer verified-by-resolver",
          },
          body: JSON.stringify({
            projectId: reconnect ? "project-b" : "project-a",
            serverId: key,
            serverName: key,
            _serverCheck: {
              requestId: randomUUID(),
              intent: automatic ? "automatic" : "manual",
            },
          }),
        },
      );
    const autos = Array.from({ length: 10 }, (_, i) =>
      post(`auto-${i}`, true, i % 2 === 0),
    );
    await vi.waitFor(() => expect(signals.size).toBe(10));
    const manual = post("manual", false);
    await tick();
    expect([...signals.values()].filter((s) => s.aborted)).toHaveLength(1);
    expect(signals.has("manual")).toBe(false);
    finishCleanup();
    await vi.waitFor(() => expect(signals.has("manual")).toBe(true));
    for (const done of release.values()) done();
    const responses = await Promise.all([...autos, manual]);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await responses.find((r) => r.status === 409)!.json()).toMatchObject(
      {
        details: { reason: "SERVER_CHECK_PREEMPTED" },
      },
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(10);
    // Success retains its runtime connection; only its initial disconnect ran.
    expect(
      manager.disconnectServer.mock.calls.filter(([key]) => key === "manual"),
    ).toHaveLength(1);
  });
  it("keeps an existing connection while a same-key reconnect waits", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, ["connect", "servers"]);
    const releases: (() => void)[] = [];
    manager.connectToServer.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve({}))),
    );
    const post = () =>
      app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: JSON.stringify({
          projectId: "project",
          serverId: "same",
          serverName: "same",
        }),
      });
    const first = post();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = post();
    await tick();
    expect(releases).toHaveLength(1);
    expect(manager.disconnectServer).toHaveBeenCalledTimes(1);
    releases[0]();
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    expect((await second).status).toBe(200);
  });
  it("deduplicates matching request IDs without sharing a consumed response body", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, "connect");
    let release!: () => void;
    manager.connectToServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    const requestId = randomUUID();
    const post = (serverId = "same") =>
      app.request("/api/mcp/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: JSON.stringify({
          projectId: "project",
          serverId,
          serverName: "same",
          _serverCheck: { requestId },
        }),
      });
    const first = post();
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = post();
    await tick();
    const conflict = await post("different-authorized-target");
    expect(conflict.status).toBe(409);
    expect(manager.connectToServer).toHaveBeenCalledTimes(1);
    release();
    const responses = await Promise.all([first, second]);
    for (const response of responses)
      expect(await response.json()).toMatchObject({ success: true });
  });

  it("does not disconnect or connect when authorization is cancelled", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, "connect");
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const request = app.request("/api/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      },
      body: JSON.stringify({
        projectId: "project",
        serverId: "cancel",
        serverName: "cancel",
      }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    expect((await request).status).toBe(499);
    expect(manager.disconnectServer).not.toHaveBeenCalled();
    expect(manager.connectToServer).not.toHaveBeenCalled();
  });
  it.each(["SERVER_CHECK_QUEUE_FULL", "SERVER_CHECK_QUEUE_TIMEOUT"])(
    "returns retryable queue metadata for %s",
    async (reason) => {
      const manager = createMockMcpClientManager();
      const app = createTestApp(manager, "connect");
      const admission = vi
        .spyOn(localServerCheckQueue, "run")
        .mockRejectedValueOnce(new LocalCheckError(429, reason));
      try {
        const response = await app.request("/api/mcp/connect", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token",
          },
          body: JSON.stringify({
            projectId: "project",
            serverId: "busy",
            serverName: "busy",
          }),
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("2");
        expect(await response.json()).toMatchObject({
          success: false,
          details: { reason },
        });
        expect(manager.connectToServer).not.toHaveBeenCalled();
      } finally {
        admission.mockRestore();
      }
    },
  );

  it("protects promotion with the existing local session authentication", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, "servers", { withSecurity: true });
    const token = generateSessionToken();
    const post = (session?: string) =>
      app.request("/api/mcp/servers/checks/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { "x-mcp-session-auth": `Bearer ${session}` } : {}),
        },
        body: JSON.stringify({ requestId: randomUUID() }),
      });
    expect((await post()).status).toBe(401);
    const authorized = await post(token);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ state: "expired" });
  });
});
