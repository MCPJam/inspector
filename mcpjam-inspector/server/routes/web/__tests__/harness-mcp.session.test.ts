/**
 * Session envelopes on the hosted harness MCP proxy.
 *
 * A runtime that fingerprints its MCP config (Cursor) keeps one envelope for
 * the whole lane, so the envelope proves identity only. These pin that every
 * request also needs the lane's live turn, that the turn's bound policy must be
 * the one the envelope carries, and that a turn's result never reaches a later
 * turn.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const { mockManager } = vi.hoisted(() => ({
  mockManager: {
    listTools: vi.fn(),
    executeTool: vi.fn(),
    hasServer: vi.fn(() => true),
    getInitializationInfo: () => ({
      protocolVersion: "2025-11-25",
      serverCapabilities: { tools: {} },
      serverVersion: { name: "real-server", version: "1.0.0" },
      clientCapabilities: {},
    }),
    disconnectAllServers: vi.fn(),
  },
}));

vi.mock("../auth", () => ({
  createAuthorizedManager: vi.fn().mockResolvedValue({ manager: mockManager }),
  withManager: async (
    mp: Promise<{ manager: typeof mockManager }>,
    fn: (m: typeof mockManager) => Promise<unknown>,
  ): Promise<unknown> => fn((await mp).manager),
}));

import { harnessMcp } from "../harness-mcp.js";
import { createAuthorizedManager } from "../auth";
import { sealHarnessSessionEnvelope } from "../../../utils/harness/harness-proxy-policy-seal.js";
import { sessionPolicyDigest } from "../../../utils/harness/session-mcp-config.js";
import { SESSION_GRANT_HEADER } from "../../../utils/harness/session-grant.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";
import {
  __resetHarnessPolicyBlockChannelForTests,
  subscribeHarnessPolicyBlocks,
  type HarnessPolicyBlockEvent,
} from "../../../utils/harness/harness-policy-block-channel.js";

const SECRET = "test-harness-proxy-secret-32-chars";
beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

/** A lane's session handle, exactly as the backend's `bind-turn` mints it. */
function sessionHandle(serverId: string, claims: Record<string, string> = {}) {
  const payload = {
    iss: "https://api.mcpjam.com/harness-mcp-proxy",
    purpose: "harness-mcp-session",
    sub: "user_convex_1",
    ext: "user_ext_1",
    org: "org_1",
    projectId: "p1",
    serverId,
    lane: "lane-1",
    iat: 1_700_000_000,
    ...claims,
  };
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", SECRET).update(input).digest("base64url")}`;
}

const profile = { clientCapabilities: {}, timeout: 60_000 };
const policy = (denied: ToolPolicySnapshot["denied"] = {}): ToolPolicySnapshot => ({
  mode: "default",
  denied,
  known: ["read_file", "delete_repo"],
  unknownTool: "allow",
});
const envelope = (serverId = "srv-a", sealedPolicy = policy()) =>
  sealHarnessSessionEnvelope({
    handle: sessionHandle(serverId),
    serverId,
    policy: sealedPolicy,
    profile,
  });

/** The session grant this turn's box egress injects into every request. */
const GRANT = `grant-1.${"a".repeat(64)}`;
const call = (
  token: string,
  name = "read_file",
  serverId = "srv-a",
  grant: string | null = GRANT,
) =>
  app.request(`/api/web/harness-mcp/${serverId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": token,
      ...(grant ? { [SESSION_GRANT_HEADER]: grant } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });

let liveTurn: { turnId: string; policyDigest: string } | undefined;
const turnRequests: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  turnRequests.length = 0;
  liveTurn = {
    turnId: "turn-1",
    policyDigest: sessionPolicyDigest("srv-a", policy(), profile),
  };
  mockManager.executeTool.mockResolvedValue({
    content: [{ type: "text", text: "executed" }],
  });
  vi.stubEnv("CONVEX_HTTP_URL", "https://authority.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-server-only");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.pathname).toBe("/internal/harness/session-turn");
      expect(init.redirect).toBe("error");
      const request = JSON.parse(String(init.body));
      turnRequests.push(request);
      // The backend answers only for the grant installed for the live turn.
      return liveTurn && request.boxGrant === GRANT
        ? Response.json(liveTurn)
        : new Response(null, { status: 403 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetHarnessPolicyBlockChannelForTests();
});

describe("session envelopes on the signed MCP proxy", () => {
  it("is the same value on every turn of the lane", () => {
    expect(envelope()).toBe(envelope());
    expect(envelope()).not.toBe(envelope("srv-a", policy({
      delete_repo: { reason: "denyList", classification: "destructive" },
    })));
  });

  it("runs a call under the lane's live turn, as the lane's user", async () => {
    const response = await call(envelope());
    expect(response.status).toBe(200);
    expect(mockManager.executeTool).toHaveBeenCalledTimes(1);
    expect(turnRequests[0]).toEqual({
      laneId: "lane-1",
      userId: "user_convex_1",
      projectId: "p1",
      serverId: "srv-a",
      boxGrant: GRANT,
    });
  });

  it("reaches nothing from outside the box, without the grant its egress injects", async () => {
    // The envelope is readable in the box (its MCP config, the bridge's start
    // config), so a copy is sent from anywhere with the envelope alone.
    const outside = await call(envelope(), "read_file", "srv-a", null);
    expect(outside.status).toBe(401);
    expect(turnRequests).toHaveLength(0);
    // Another turn's, or a guessed, grant is refused by the backend.
    const guessed = await call(envelope(), "read_file", "srv-a", `grant-2.${"b".repeat(64)}`);
    expect(guessed.status).toBe(401);
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("reaches nothing once the lane has no live turn", async () => {
    liveTurn = undefined;
    const response = await call(envelope());
    expect(response.status).toBe(401);
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("refuses an envelope whose policy is not the one the live turn bound", async () => {
    liveTurn = {
      turnId: "turn-2",
      policyDigest: sessionPolicyDigest(
        "srv-a",
        policy({ read_file: { reason: "denyList", classification: "write" } }),
        profile,
      ),
    };
    expect((await call(envelope())).status).toBe(401);
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("never hands a result to a later turn", async () => {
    mockManager.executeTool.mockImplementationOnce(async () => {
      liveTurn = { ...liveTurn!, turnId: "turn-2" };
      return { content: [{ type: "text", text: "turn-1-only" }] };
    });
    const response = await call(envelope());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("turn-1-only");
  });

  it("refuses a per-turn proxy token sealed as a session envelope", async () => {
    const forged = sealHarnessSessionEnvelope({
      handle: signTestProxyToken({ serverId: "srv-a", projectId: "p1" }),
      serverId: "srv-a",
      policy: policy(),
      profile,
    });
    expect((await call(forged)).status).toBe(401);
    expect(turnRequests).toHaveLength(0);
  });

  it("refuses a handle minted for another server", async () => {
    const crossed = sealHarnessSessionEnvelope({
      handle: sessionHandle("srv-b"),
      serverId: "srv-a",
      policy: policy(),
      profile,
    });
    expect((await call(crossed)).status).toBe(401);
  });

  it("files a policy block under the live turn, with no correlation in the config", async () => {
    const denied = policy({
      delete_repo: { reason: "denyList", classification: "destructive" },
    });
    const turnId = "7c1b4b6e-8a43-4f53-9f0e-6a3f8b4f2a10";
    liveTurn = {
      turnId,
      policyDigest: sessionPolicyDigest("srv-a", denied, profile),
    };
    const seen: HarnessPolicyBlockEvent[] = [];
    const stop = subscribeHarnessPolicyBlocks(
      turnId,
      (event) => {
        seen.push(event);
      },
      ["srv-a"],
    );
    const response = await call(envelope("srv-a", denied), "delete_repo");
    stop();
    expect(response.status).toBe(200);
    expect(seen.map((event) => event.toolName)).toEqual(["delete_repo"]);
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("lets Cursor's 60-second cancel stop a slow call before MCPJam's 300-second timeout", async () => {
    vi.useFakeTimers();
    // The built-in Cursor CLI profile's outer timeout, so Cursor's own governs.
    const outer = { clientCapabilities: {}, timeout: 300_000 };
    liveTurn = {
      turnId: "turn-1",
      policyDigest: sessionPolicyDigest("srv-a", policy(), outer),
    };
    const token = sealHarnessSessionEnvelope({
      handle: sessionHandle("srv-a"),
      serverId: "srv-a",
      policy: policy(),
      profile: outer,
    });
    let signal: AbortSignal | undefined;
    mockManager.executeTool.mockImplementationOnce(
      (_server: string, _tool: string, _args: unknown, options: { request: { signal?: AbortSignal } }) =>
        new Promise((resolve, reject) => {
          signal = options.request.signal;
          const timer = setTimeout(
            () => resolve({ content: [{ type: "text", text: "slow" }] }),
            70_000,
          );
          // MCPJam's MCP client sends the server its own cancel on abort.
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal!.reason);
          });
        }),
    );
    const send = (body: Record<string, unknown>) =>
      app.request("/api/web/harness-mcp/srv-a", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-MCPJam-Proxy-Token": token,
          [SESSION_GRANT_HEADER]: GRANT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      });
    const pending = send({
      id: 3,
      method: "tools/call",
      params: { name: "slow_write", arguments: {} },
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.mocked(createAuthorizedManager).mock.calls.at(-1)?.[4]).toBe(300_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const cancelled = await send({
      method: "notifications/cancelled",
      params: { requestId: 3, reason: "McpError: MCP error -32001: Request timed out" },
    });
    expect(cancelled.status).toBe(202);
    expect(signal?.aborted).toBe(true);
    const answered = await pending;
    expect(await answered.text()).not.toContain("slow");
    expect(mockManager.executeTool).toHaveBeenCalledTimes(1);
  });

  it("leaves another lane's call running when a cancel names its request id", async () => {
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    mockManager.executeTool.mockImplementationOnce(
      (_server: string, _tool: string, _args: unknown, options: { request: { signal?: AbortSignal } }) =>
        new Promise((resolve) => {
          signal = options.request.signal;
          finish = () => resolve({ content: [{ type: "text", text: "done" }] });
        }),
    );
    const otherLane = sealHarnessSessionEnvelope({
      handle: sessionHandle("srv-a", { lane: "lane-2" }),
      serverId: "srv-a",
      policy: policy(),
      profile,
    });
    const pending = call(envelope());
    await vi.waitFor(() => expect(signal).toBeDefined());
    const response = await app.request("/api/web/harness-mcp/srv-a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-MCPJam-Proxy-Token": otherLane,
        [SESSION_GRANT_HEADER]: GRANT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    });
    expect(response.status).toBe(202);
    expect(signal?.aborted).toBe(false);
    finish();
    expect(await (await pending).text()).toContain("done");
  });
});
