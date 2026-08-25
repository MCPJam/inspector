/**
 * D4b: `toolPolicy` enforcement at the hosted harness MCP proxy.
 *
 * The harness calls MCP itself from its sandbox, so the in-process D4 gate is
 * never on the path — this route is. Same mocking shape as `harness-mcp.test.ts`
 * (real signed token, real bridge, mock authorized manager), plus a real sealed
 * envelope carrying the launch-time decision snapshot.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const { mockManager } = vi.hoisted(() => ({
  mockManager: {
    listTools: vi.fn(),
    executeTool: vi.fn(),
    hasServer: vi.fn(),
    getInitializationInfo: () => ({
      protocolVersion: "2025-06-18",
      serverCapabilities: { tools: { listChanged: true } },
      serverVersion: { name: "real-server", version: "1.0.0" },
      clientCapabilities: {},
    }),
    disconnectAllServers: vi.fn(),
  },
}));

vi.mock("../auth", () => ({
  createAuthorizedManager: vi.fn().mockResolvedValue({ manager: mockManager }),
  withManager: async (
    mp: Promise<any>,
    fn: (m: any) => Promise<any>
  ): Promise<any> => {
    const r = await mp;
    return fn(r.manager ?? r);
  },
}));

import { harnessMcp } from "../harness-mcp.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";
import { sealHarnessProxyToken } from "../../../utils/harness/harness-proxy-policy-seal.js";
import { HARNESS_POLICY_BLOCK_META_KEY } from "../../../utils/harness/harness-proxy-policy-enforcement.js";
import {
  __resetHarnessPolicyBlockChannelForTests,
  subscribeHarnessPolicyBlocks,
  type HarnessPolicyBlockEvent,
} from "../../../utils/harness/harness-policy-block-channel.js";
import { HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER } from "../../../utils/harness/harness-scope-step-up.js";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
    "test-harness-proxy-secret-32-chars";
});

const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

const innerToken = (serverId: string) =>
  signTestProxyToken({
    serverId,
    projectId: "p1",
    externalId: "user_ext_1",
    orgId: "org_1",
  });

const snapshot = (overrides: Partial<ToolPolicySnapshot> = {}) =>
  ({
    mode: "default",
    denied: {
      delete_repo: { reason: "denyList", classification: "destructive" },
    },
    known: ["delete_repo", "read_file"],
    unknownTool: "deny",
    ...overrides,
  } satisfies ToolPolicySnapshot);

const sealedToken = (serverId: string, policy = snapshot()) =>
  sealHarnessProxyToken({
    token: innerToken(serverId),
    serverId,
    policy,
    expiresAtMs: Date.now() + 60_000,
  });

const rpc = async (
  token: string,
  body: Record<string, unknown>,
  serverId = "srv-a"
): Promise<Response> =>
  await app.request(`/api/web/harness-mcp/${serverId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });

const call = (
  token: string,
  name: string,
  serverId = "srv-a",
  correlationId?: string
): Promise<Response> =>
  app.request(`/api/web/harness-mcp/${serverId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": token,
      // The same correlation header every generated `.mcp.json` entry carries.
      ...(correlationId
        ? { [HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER]: correlationId }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockManager.listTools.mockResolvedValue({
    tools: [{ name: "delete_repo" }, { name: "read_file" }],
  });
  mockManager.executeTool.mockResolvedValue({
    content: [{ type: "text", text: "executed" }],
  });
  mockManager.hasServer.mockImplementation((id: string) => id === "srv-b");
});

describe("harness MCP proxy tool policy", () => {
  it("blocks a denied tools/call before it reaches the manager", async () => {
    const res = await call(sealedToken("srv-a"), "delete_repo");
    expect(res.status).toBe(200);
    const data = await res.json();
    // A success envelope, NOT a -32000: a -32000 would be accounted as a tool
    // error against the customer's server and derive `failed`.
    expect(data.error).toBeUndefined();
    expect(data.id).toBe(1);
    expect(data.result._meta[HARNESS_POLICY_BLOCK_META_KEY]).toEqual({
      toolName: "delete_repo",
      reason: "denyList",
      classification: "destructive",
    });
    expect(data.result.content[0].text).toContain("blocked by tool policy");
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("reports the block to the turn that generated the .mcp.json entry", async () => {
    // The result payload cannot be the accounting mechanism: the real Claude
    // Code adapter flattens it to a bare string and the `_meta` marker is lost.
    // The proxy therefore reports what it refused on the turn's own correlation
    // id, exactly as a cross-instance scope step-up does.
    __resetHarnessPolicyBlockChannelForTests();
    const turnId = "33333333-3333-4333-8333-333333333333";
    const seen: HarnessPolicyBlockEvent[] = [];
    const stop = subscribeHarnessPolicyBlocks(turnId, (e) => seen.push(e), [
      "srv-a",
    ]);
    try {
      await call(sealedToken("srv-a"), "delete_repo", "srv-a", turnId);
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      serverId: "srv-a",
      toolName: "delete_repo",
      reason: "denyList",
      classification: "destructive",
    });
  });

  it("still executes an allowed tool", async () => {
    const res = await call(sealedToken("srv-a"), "read_file");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result._meta?.[HARNESS_POLICY_BLOCK_META_KEY]).toBeUndefined();
    expect(mockManager.executeTool).toHaveBeenCalledWith(
      "srv-a",
      "read_file",
      {}
    );
  });

  it("blocks a tool that was not known at launch", async () => {
    const res = await call(sealedToken("srv-a"), "appeared_later");
    const data = await res.json();
    expect(data.result._meta[HARNESS_POLICY_BLOCK_META_KEY]).toEqual({
      toolName: "appeared_later",
      reason: "unknownAtLaunch",
      classification: "unknown",
    });
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("decides on the RESOLVED (server, tool) a prefixed name would execute", async () => {
    // `srv-a:delete_repo` resolves back to this server's denied tool.
    const sameServer = await call(
      sealedToken("srv-a"),
      "srv-a:delete_repo"
    ).then((r) => r.json());
    expect(mockManager.hasServer).toHaveBeenCalledWith("srv-a");
    expect(
      sameServer.result._meta[HARNESS_POLICY_BLOCK_META_KEY]
    ).toMatchObject({ toolName: "delete_repo", reason: "denyList" });

    // `srv-b:read_file` would reroute to a server this envelope carries no
    // decision for — blocked, not permitted.
    const otherServer = await call(
      sealedToken("srv-a"),
      "srv-b:read_file"
    ).then((r) => r.json());
    expect(
      otherServer.result._meta[HARNESS_POLICY_BLOCK_META_KEY]
    ).toMatchObject({ toolName: "read_file", reason: "unknownAtLaunch" });
    expect(mockManager.executeTool).not.toHaveBeenCalled();
  });

  it("does NOT filter tools/list — denied tools stay visible but blocked", async () => {
    const res = await rpc(sealedToken("srv-a"), {
      method: "tools/list",
      params: {},
    });
    const data = await res.json();
    expect(data.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "delete_repo",
      "read_file",
    ]);
  });

  it("401s a sealed envelope whose inner identity token is for another server", async () => {
    const mismatched = sealHarnessProxyToken({
      token: innerToken("srv-b"),
      serverId: "srv-a",
      policy: snapshot(),
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await call(mismatched, "read_file")).status).toBe(401);
  });

  it("401s a sealed envelope presented to a different server", async () => {
    // Unseal fails (wrong `s`), and the sealed blob is not a valid bare token.
    expect(
      (await call(sealedToken("srv-b"), "read_file", "srv-a")).status
    ).toBe(401);
  });

  it("leaves a BARE token unpoliced (unchanged path for other consumers)", async () => {
    const res = await call(innerToken("srv-a"), "delete_repo");
    expect(res.status).toBe(200);
    expect(mockManager.executeTool).toHaveBeenCalledWith(
      "srv-a",
      "delete_repo",
      {}
    );
  });
});
