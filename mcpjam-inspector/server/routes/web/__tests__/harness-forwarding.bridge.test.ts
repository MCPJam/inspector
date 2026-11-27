/**
 * The profiled bridge on the native forwarding route (`?native=1`): MCPJam's
 * client carries the request with the client's sealed profile instead of
 * forwarding the runtime's bytes.
 *
 * These pin that MCPJam's own correlation key never reaches the server on the
 * bridge, as on pass-through, and that a session envelope sealed for the
 * bridge takes it (Cursor CLI's lane), while the same lane's pass-through
 * envelope still forwards.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const SECRET = "test-harness-proxy-secret-32-chars";
const state = vi.hoisted(() => ({
  policyDigest: "",
  operations: [] as Array<Record<string, unknown>>,
  bridged: [] as unknown[],
  upstream: [] as Array<Record<string, unknown>>,
  initializePins: [] as unknown[],
}));

vi.mock("../../../utils/harness/forwarding/execution-control.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/forwarding/execution-control.js")
  >()),
  createExecutionControl: () => ({
    authorize: async () => ({
      userId: "user_convex_1",
      externalId: "user_ext_1",
      organizationId: "org_1",
      projectId: "p1",
      expiresAt: Date.now() + 30 * 60_000,
      turnId: "grant-turn",
      policyDigest: state.policyDigest,
    }),
  }),
}));
vi.mock("../../../utils/harness/forwarding/execution-gate.js", () => ({
  executeForwardedOperation: async (args: {
    operation: Record<string, unknown>;
    dispatch: (settle: () => Promise<void>) => Promise<Response>;
  }) => {
    state.operations.push(args.operation);
    return args.dispatch(async () => {});
  },
}));
vi.mock("../../../utils/harness/forwarding/owned-input.js", () => ({
  forwardingInputHost: async () => undefined,
}));
vi.mock("../../../utils/harness/forwarding/enhanced-mcp.js", () => ({
  enhancedToolPolicy: async (
    _manager: unknown,
    _serverId: string,
    _message: unknown,
    policy: ToolPolicySnapshot,
  ) => policy,
  enhancedMcpResponse: async (args: { message?: { id?: unknown } }) => {
    state.bridged.push(args.message);
    return Response.json({ jsonrpc: "2.0", id: args.message?.id, result: { content: [] } });
  },
}));
vi.mock("../auth.js", () => ({
  createAuthorizedManager: async (...args: unknown[]) => {
    state.initializePins.push(
      (args[7] as { initializePins?: unknown } | undefined)?.initializePins,
    );
    return {
      authenticatedUserId: "user_convex_1",
      authorizedServerConfigs: {
        "srv-a": {
          url: "https://upstream.test/mcp",
          baseFetch: async (_url: string | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            state.upstream.push(body);
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
          },
        },
      },
      manager: {
        connectToServer: async () => {},
        setMrtrInputCollector: () => {},
        disconnectAllServers: async () => {},
      },
    };
  },
}));

import { handleNativeForwarding } from "../harness-forwarding.js";
import {
  sealHarnessProxyToken,
  sealHarnessSessionEnvelope,
} from "../../../utils/harness/harness-proxy-policy-seal.js";
import { sessionPolicyDigest } from "../../../utils/harness/session-mcp-config.js";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

const policy: ToolPolicySnapshot = {
  mode: "default",
  denied: {},
  known: [],
  unknownTool: "allow",
};
const profile = {
  clientCapabilities: {
    extensions: {
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    },
  },
  mcpProtocolVersion: "2026-07-28" as const,
  respectToolVisibility: true,
};
const owner = {
  kind: "chat" as const,
  userId: "user_convex_1",
  serverId: "srv-a",
  harnessSessionId: "lane-1",
};

/** A lane's session handle, exactly as the backend's `bind-turn` mints it. */
function sessionHandle() {
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
  })}`;
  return `${input}.${createHmac("sha256", SECRET).update(input).digest("base64url")}`;
}

/** The header the egress proxy injects the turn's grant under. */
const GRANT_HEADER = `x-mcpjam-forwarding-${createHash("sha256")
  .update(JSON.stringify(["srv-a", "server:srv-a"]))
  .digest("hex")
  .slice(0, 40)}`;
const app = new Hono();
app.post("/:serverId", handleNativeForwarding);
const post = (context: string, message: Record<string, unknown>) =>
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
const call = (meta: Record<string, unknown>) => ({
  id: 1,
  method: "tools/call",
  params: { name: "write", arguments: { text: "a" }, _meta: meta },
});

beforeEach(() => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "org_1");
  state.operations.length = 0;
  state.bridged.length = 0;
  state.upstream.length = 0;
  state.initializePins.length = 0;
});

describe("the profiled bridge on the native forwarding route", () => {
  it("drops MCPJam's correlation key before the server sees the call, and still correlates it", async () => {
    state.policyDigest = "a".repeat(64);
    const context = sealHarnessProxyToken({
      token: JSON.stringify({
        owner,
        turnId: "turn-1",
        policyDigest: state.policyDigest,
        delivery: "bridge",
        correlationKey: "mcpjam/toolCallId",
      }),
      serverId: "srv-a",
      policy,
      expiresAtMs: Date.now() + 60_000,
      profile,
    });
    const response = await post(
      context,
      call({ "mcpjam/toolCallId": "call_1", progressToken: 7 }),
    );
    expect(response.status).toBe(200);
    expect(state.upstream).toHaveLength(0);
    expect(state.bridged).toEqual([
      expect.objectContaining({
        method: "tools/call",
        params: { name: "write", arguments: { text: "a" }, _meta: { progressToken: 7 } },
      }),
    ]);
    expect(state.operations[0]).toMatchObject({ nativeToolCallId: "call_1" });
  });

  it("takes the bridge for a lane's session envelope sealed with a profile", async () => {
    state.policyDigest = sessionPolicyDigest("srv-a", policy, profile);
    const bridged = sealHarnessSessionEnvelope({
      handle: sessionHandle(),
      serverId: "srv-a",
      policy,
      profile,
      delivery: "bridge",
    });
    expect((await post(bridged, call({}))).status).toBe(200);
    expect(state.bridged).toHaveLength(1);
    expect(state.upstream).toHaveLength(0);
    // MCPJam's client connects as the sealed profile describes.
    expect(state.initializePins[0]).toMatchObject({
      clientCapabilities: profile.clientCapabilities,
    });
    // A session runtime's requests name no tool call.
    expect(state.operations[0]).not.toHaveProperty("nativeToolCallId");
  });

  it("refuses a session envelope that carries a profile without bridge delivery", async () => {
    // The policy digest ignores the envelope version, so a version 4 envelope
    // with a profile matches a bridged turn's digest; it must not forward
    // natively past the bridge's filtering.
    state.policyDigest = sessionPolicyDigest("srv-a", policy, profile);
    const profiledNative = sealHarnessSessionEnvelope({
      handle: sessionHandle(),
      serverId: "srv-a",
      policy,
      profile,
    });
    expect((await post(profiledNative, call({}))).status).toBe(401);
    expect(state.bridged).toHaveLength(0);
    expect(state.upstream).toHaveLength(0);
  });

  it("still forwards the runtime's own bytes for the lane's pass-through envelope", async () => {
    state.policyDigest = sessionPolicyDigest("srv-a", policy);
    const passThrough = sealHarnessSessionEnvelope({
      handle: sessionHandle(),
      serverId: "srv-a",
      policy,
    });
    expect((await post(passThrough, call({}))).status).toBe(200);
    expect(state.bridged).toHaveLength(0);
    expect(state.upstream).toEqual([expect.objectContaining({ method: "tools/call" })]);
  });
});
