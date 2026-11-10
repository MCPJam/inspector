/**
 * Session envelopes on the native forwarding route (`?native=1`).
 *
 * A runtime that fingerprints its MCP config (Cursor) sends the lane's session
 * envelope on every turn. These pin that the owner comes from the handle, the
 * turn and its policy come from the egress-injected grant, and that Cursor's
 * own 60-second cancel holds: the cancel reaches the server, a cancelled
 * request never runs, and MCPJam's 300-second outer timeout never fires first.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const SECRET = "test-harness-proxy-secret-32-chars";
const control = vi.hoisted(() => ({
  owners: [] as unknown[],
  tokens: [] as unknown[],
  boundDigest: "",
  cancelled: new Set<string | number>(),
  cancels: [] as Array<[string, string | number]>,
  prepared: [] as Array<Record<string, unknown>>,
}));
const upstream = vi.hoisted(() => ({
  bodies: [] as Array<Record<string, unknown>>,
  signals: [] as AbortSignal[],
  timeouts: [] as number[],
}));

vi.mock("../../../utils/harness/forwarding/execution-control.js", async (original) => {
  const actual = await original<
    typeof import("../../../utils/harness/forwarding/execution-control.js")
  >();
  return {
    ...actual,
    createExecutionControl: (args: { owner: unknown; token?: string }) => {
      control.owners.push(args.owner);
      control.tokens.push(args.token);
      return {
        authorize: async () => ({
          userId: "user_convex_1",
          externalId: "user_ext_1",
          organizationId: "org_1",
          projectId: "p1",
          expiresAt: Date.now() + 30 * 60_000,
          turnId: "grant-turn",
          policyDigest: control.boundDigest,
        }),
        cancel: async (turnId: string, rpcId: string | number) => {
          control.cancels.push([turnId, rpcId]);
          control.cancelled.add(rpcId);
          return { cancelled: 0 };
        },
        // The backend's tombstone: a cancelled rpc id never prepares again.
        prepare: async (intent: Record<string, unknown>) => {
          control.prepared.push(intent);
          if (control.cancelled.has(intent.rpcId as string | number))
            throw new actual.ExecutionControlError("control_409");
          return {
            executionId: `execution-${control.prepared.length}`,
            state: "prepared" as const,
            replayed: false,
            requireToolApproval: false,
          };
        },
        claim: async () => ({ dispatch: true, state: "dispatched" as const }),
        settle: async () => ({ replayed: false, adopted: false }),
      };
    },
  };
});

/** A fixture server: `slow_write` answers after 70 s, like the qualification fixture. */
async function upstreamFetch(_url: string | URL, init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}"));
  upstream.bodies.push(body);
  if (init?.signal) upstream.signals.push(init.signal);
  if (body.method !== "tools/call") return new Response(null, { status: 202 });
  if (body.params?.name === "slow_write")
    await new Promise((resolve) => setTimeout(resolve, 70_000));
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result: { content: [{ type: "text", text: "written" }] },
  });
}

vi.mock("../auth.js", () => ({
  createAuthorizedManager: vi.fn(
    async (_caller: unknown, _bearer: string, _project: string, _servers: string[], timeout: number) => {
      upstream.timeouts.push(timeout);
      return {
        authenticatedUserId: "user_convex_1",
        authorizedServerConfigs: {
          "srv-a": { url: "https://upstream.test/mcp", baseFetch: upstreamFetch },
        },
        manager: { disconnectAllServers: vi.fn(async () => {}) },
      };
    },
  ),
}));

import { handleNativeForwarding } from "../harness-forwarding.js";
import { sealHarnessSessionEnvelope } from "../../../utils/harness/harness-proxy-policy-seal.js";
import { sessionPolicyDigest } from "../../../utils/harness/session-mcp-config.js";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

/** A lane's session handle, exactly as the backend's `bind-turn` mints it. */
function sessionHandle(claims: Record<string, string> = {}) {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: "https://api.mcpjam.com/harness-mcp-proxy",
    purpose: "harness-mcp-session",
    sub: "user_convex_1",
    ext: "user_ext_1",
    org: "org_1",
    projectId: "p1",
    serverId: "srv-a",
    lane: "lane-1",
    iat: 1_700_000_000,
    ...claims,
  })}`;
  return `${input}.${createHmac("sha256", SECRET).update(input).digest("base64url")}`;
}

const policy: ToolPolicySnapshot = {
  mode: "default",
  denied: {},
  known: [],
  unknownTool: "allow",
};
const envelope = (handle = sessionHandle()) =>
  sealHarnessSessionEnvelope({ handle, serverId: "srv-a", policy });
/** The header the egress proxy injects the turn's grant under. */
const GRANT_HEADER = `x-mcpjam-forwarding-${createHash("sha256")
  .update(JSON.stringify(["srv-a", "server:srv-a"]))
  .digest("hex")
  .slice(0, 40)}`;

const app = new Hono();
app.post("/:serverId", handleNativeForwarding);
const post = (message: Record<string, unknown>, context = envelope()) =>
  app.request("/srv-a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mcpjam-forwarding-context": context,
      [GRANT_HEADER]: "turn-grant",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
const call = (id: number, name = "fast_write") =>
  post({ id, method: "tools/call", params: { name, arguments: { text: "a" } } });
const cancel = (requestId: number) =>
  post({
    method: "notifications/cancelled",
    params: { requestId, reason: "McpError: MCP error -32001: Request timed out" },
  });
const toolCalls = () =>
  upstream.bodies.filter((body) => body.method === "tools/call");

beforeEach(() => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "org_1");
  control.owners.length = 0;
  control.tokens.length = 0;
  control.cancels.length = 0;
  control.prepared.length = 0;
  control.cancelled.clear();
  control.boundDigest = sessionPolicyDigest("srv-a", policy);
  upstream.bodies.length = 0;
  upstream.signals.length = 0;
  upstream.timeouts.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("session envelopes on the native forwarding route", () => {
  it("runs a call as the handle's owner, under the turn the grant was installed for", async () => {
    const response = await call(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("written");
    expect(control.owners[0]).toEqual({
      kind: "chat",
      userId: "user_convex_1",
      serverId: "srv-a",
      harnessSessionId: "lane-1",
    });
    expect(control.tokens[0]).toBe("turn-grant");
    expect(control.prepared[0]).toMatchObject({ turnId: "grant-turn", rpcId: 1 });
    // No tool-call id reaches the server from this runtime, so none is read.
    expect(control.prepared[0]).not.toHaveProperty("nativeToolCallId");
    expect(toolCalls()).toHaveLength(1);
  });

  it("refuses an envelope whose policy is not the one this turn bound", async () => {
    control.boundDigest = "b".repeat(64);
    expect((await call(1)).status).toBe(409);
    expect(control.prepared).toHaveLength(0);
    expect(toolCalls()).toHaveLength(0);
  });

  it("refuses a handle the backend did not sign, or one for another server", async () => {
    const forged = `${sessionHandle().split(".").slice(0, 2).join(".")}.forged`;
    expect((await call(1, "fast_write")).status).toBe(200);
    expect((await post({ id: 2, method: "tools/list" }, envelope(forged))).status).toBe(401);
    expect(
      (await post({ id: 3, method: "tools/list" }, envelope(sessionHandle({ serverId: "srv-b" })))).status,
    ).toBe(401);
  });

  it("never runs a request whose cancel arrived first, and still tells the server", async () => {
    expect((await cancel(9)).status).toBe(202);
    expect(control.cancels).toEqual([["grant-turn", 9]]);
    expect(upstream.bodies).toEqual([
      expect.objectContaining({
        method: "notifications/cancelled",
        params: expect.objectContaining({ requestId: 9 }),
      }),
    ]);
    expect((await call(9)).status).toBe(409);
    expect(toolCalls()).toHaveLength(0);
  });

  it("lets Cursor's 60-second cancel govern a slow call: no outer timeout fires first", async () => {
    vi.useFakeTimers();
    const pending = call(3, "slow_write");
    await vi.advanceTimersByTimeAsync(59_999);
    // MCPJam has not cut the call: the server still holds it and nothing answered.
    expect(toolCalls()).toHaveLength(1);
    expect(upstream.signals[0]?.aborted).toBe(false);
    expect(upstream.timeouts).toEqual([300_000]);
    // At 60 s Cursor gives up and sends its cancel as a separate request.
    await vi.advanceTimersByTimeAsync(1);
    expect((await cancel(3)).status).toBe(202);
    expect(control.cancels).toEqual([["grant-turn", 3]]);
    expect(upstream.bodies.at(-1)).toMatchObject({
      method: "notifications/cancelled",
      params: { requestId: 3 },
    });
    // A retry of the same request id after the cancel never runs.
    expect((await call(3, "slow_write")).status).toBe(409);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(200);
    expect(toolCalls()).toHaveLength(1);
  });
});
