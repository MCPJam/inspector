import { setManagerOrganization, setManagerResourceHostConfig, setManagerResourceSnapshots } from "../../../mcp-connections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { unsealHarnessProxyToken } from "../../harness-proxy-policy-seal";
import { nativeRpcLogScope } from "../native-rpc-logs";
import { attributeCursorToolCall, toAcpMcpServers } from "../../mcp-config";
import { sessionPolicyDigest } from "../../session-mcp-config";
import { sessionForwardingContext } from "../session-forwarding";
import {
  hasForwardingOrganization,
  nativeForwardingSelection,
  prepareNativeForwarding,
  readNativeForwardingResult,
} from "../native-turn";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  present: vi.fn(),
  bind: vi.fn(async () => ({ bound: true })),
  url: "https://forward.example/api/web/harness-mcp/server",
}));
vi.mock("../approval", () => ({
  startForwardingApprovalPresentation: () => {
    mocks.present();
    return mocks.stop;
  },
}));
vi.mock("../execution-control", async (original) => ({
  ...(await original<typeof import("../execution-control")>()),
  createExecutionControl: () => ({ bindPolicy: mocks.bind }),
}));
vi.mock("../../harness-proxy-strategy", () => ({
  resolveHarnessProxyUrl: async () => mocks.url,
}));
beforeEach(() => {
  vi.stubEnv(
    "COMPUTERS_TERMINAL_TOKEN_SECRET",
    "test-seal-secret-at-least-32-bytes-long",
  );
  vi.stubEnv(
    "INSPECTOR_SERVICE_TOKEN",
    "native-forwarding-test-secret-long-enough",
  );
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  mocks.present.mockClear();
  mocks.stop.mockClear();
  mocks.bind.mockClear();
});
afterEach(() => vi.unstubAllEnvs());
const owner = {
  kind: "chat" as const,
  userId: "user",
  serverId: "server",
  harnessSessionId: "lane",
};
describe("native turn configuration", () => {
  it("delivers a sealed context without a model, user or upstream credential", async () => {
    const prepared = await prepareNativeForwarding({
      owners: [owner],
      origin: "https://forward.example",
      expiresAt: Date.now() + 60000,
      turnId: "turn",
      strategy: { plane: "web-authorized", mode: "relay" },
      authHeader: "private-user-bearer",
      writer: { write: vi.fn() },
    });
    const entry = prepared.mcpJson.mcpServers.server;
    expect(entry.timeout).toBeGreaterThan(59_000);
    expect(entry.timeout).toBeLessThanOrEqual(60_000);
    expect(prepared.logScopeIds).toEqual({
      server: nativeRpcLogScope(owner, "turn"),
    });
    expect(new URL(entry.url).searchParams.get("native")).toBe("1");
    expect(JSON.stringify(prepared.mcpJson)).not.toContain(
      "private-user-bearer",
    );
    expect(Object.keys(entry.headers!)).toEqual([
      "Connection",
      "X-MCPJam-Forwarding-Context",
    ]);
    expect(entry.headers!.Connection).toBe("close");
    const opened = unsealHarnessProxyToken(
      entry.headers!["X-MCPJam-Forwarding-Context"],
      "server",
    );
    expect(JSON.parse(opened!.token)).toEqual({
      owner,
      turnId: "turn",
      policyDigest: prepared.policyDigest,
    });
    expect(mocks.bind).toHaveBeenCalledWith("turn", prepared.policyDigest);
    expect(prepared.isForwardedTool("mcp__server__read")).toBe(true);
    expect(prepared.isForwardedTool("Bash")).toBe(false);
    await prepared.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it("refuses an origin that lacks the installed credential binding", async () => {
    await expect(
      prepareNativeForwarding({
        owners: [owner],
        origin: "https://other.example",
        expiresAt: Date.now() + 60000,
        turnId: "turn",
        strategy: { plane: "web-authorized", mode: "relay" },
        authHeader: "private",
        writer: { write: vi.fn() },
      }),
    ).rejects.toThrow("origin differs");
    expect(mocks.present).not.toHaveBeenCalled();
  });
  it("selects only the existing lane and one explicit account", () => {
    const connection = {
      serverId: "server",
      connectionId: "account",
      key: "server",
      label: "Account",
    };
    expect(
      nativeForwardingSelection({
        manager: new MCPClientManager({}),
        laneId: "lane",
        hostId: "host",
        serverIds: ["server"],
        connections: { server: [connection] },
      }),
    ).toEqual({
      harnessSessionId: "lane",
      hostId: "host",
      servers: [{ serverId: "server", connectionId: "account" }],
    });
    expect(() =>
      nativeForwardingSelection({
        manager: new MCPClientManager({}),
        laneId: "lane",
        hostId: "host",
        serverIds: ["server"],
        connections: {
          server: [connection, { ...connection, connectionId: "other" }],
        },
      }),
    ).toThrow("one account");
  });
  it("does not enroll another organization when the server flag is enabled", () => {
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
    vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "internal");
    const internal = new MCPClientManager({});
    const other = new MCPClientManager({});
    setManagerOrganization(internal, "internal");
    setManagerOrganization(other, "customer");
    expect(hasForwardingOrganization(internal)).toBe(true);
    expect(hasForwardingOrganization(other)).toBe(false);
  });
});

it("rejects incomplete, substituted or mismatched broker ownership", () => {
  const selected = {
    harnessSessionId: "lane",
    hostId: "host",
    servers: [{ serverId: "server", connectionId: "account" }],
  };
  const payload = {
    forwardingOwners: [{ ...owner, connectionId: "account" }],
    forwardingOrigin: "https://forward.example",
  };
  expect(readNativeForwardingResult(payload, selected)).toEqual({
    owners: payload.forwardingOwners,
    origin: payload.forwardingOrigin,
  });
  expect(readNativeForwardingResult({}, selected)).toBeNull();
  expect(
    readNativeForwardingResult(payload, {
      ...selected,
      harnessSessionId: "other-lane",
    }),
  ).toBeNull();
  expect(
    readNativeForwardingResult(payload, {
      ...selected,
      servers: [{ serverId: "server", connectionId: "other-account" }],
    }),
  ).toBeNull();
  expect(readNativeForwardingResult(payload)).toBeUndefined();
});

it("seals the adapter correlation key and refuses to reuse its policy digest for a different key", async () => {
  const prepare = (correlationKey: string) => prepareNativeForwarding({
    owners: [owner], origin: "https://forward.example", expiresAt: Date.now() + 60000,
    turnId: "turn", strategy: {plane: "web-authorized", mode: "relay"},
    authHeader: "private-user-bearer", writer: {write: vi.fn()}, correlationKey,
  });
  const codex = await prepare("callId");
  const other = await prepare("otherRuntime/callId");
  const opened = unsealHarnessProxyToken(codex.mcpJson.mcpServers.server.headers!["X-MCPJam-Forwarding-Context"], "server");
  expect(JSON.parse(opened!.token).correlationKey).toBe("callId");
  expect(codex.policyDigest).not.toBe(other.policyDigest);
  await codex.stop();
  await other.stop();
});

it("pins the authorized default OAuth account when there is no multi-account group", () => {
  const manager = new MCPClientManager({});
  setManagerResourceHostConfig(manager, "host-config", "host");
  setManagerResourceSnapshots(manager, new Map([["server", {serverUpdatedAt: 1, credentialAuthorizedAt: 2, credentialId: "captured-account"}]]));
  expect(nativeForwardingSelection({manager, laneId: "lane", hostId: "host", serverIds: ["server"], connections: {}}).servers)
    .toEqual([{serverId: "server", connectionId: "captured-account"}]);
});

describe("session-stable forwarding", () => {
  const account = { ...owner, connectionId: "account" };
  const binds: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    binds.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        binds.push(JSON.parse(String(init?.body)));
        return Response.json({
          ok: true,
          bound: true,
          laneId: "lane",
          handles: { server: "lane-session-handle" },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const prepare = (turnId: string, expiresIn: number) =>
    prepareNativeForwarding({
      owners: [account],
      origin: "https://forward.example",
      expiresAt: Date.now() + expiresIn,
      turnId,
      strategy: { plane: "web-authorized", mode: "relay" },
      authHeader: "private-user-bearer",
      writer: { write: vi.fn() },
      session: {
        owner: { ownerType: "direct-chat", chatSessionId: "chat" } as never,
        leaseId: `lease-${turnId}`,
        turnId: `lane-turn-${turnId}`,
      },
      attributeToolCall: attributeCursorToolCall,
    });

  it("gives every turn of the lane the same MCP config, with no turn, expiry or timeout in it", async () => {
    const first = await prepare("grant-turn-1", 60_000);
    const second = await prepare("grant-turn-2", 1_800_000);
    expect(JSON.stringify(toAcpMcpServers(second.mcpJson))).toBe(
      JSON.stringify(toAcpMcpServers(first.mcpJson)),
    );
    expect(JSON.stringify(second.mcpJson)).toBe(JSON.stringify(first.mcpJson));
    const entry = first.mcpJson.mcpServers.server;
    expect(entry).not.toHaveProperty("timeout");
    expect(new URL(entry.url).searchParams.get("native")).toBe("1");
    expect(Object.keys(entry.headers!)).toEqual([
      "Connection",
      "X-MCPJam-Forwarding-Context",
    ]);
    const config = JSON.stringify(first.mcpJson);
    for (const value of ["grant-turn-1", "lane-turn-grant-turn-1", "private-user-bearer"])
      expect(config).not.toContain(value);
    const sealed = unsealHarnessProxyToken(
      entry.headers!["X-MCPJam-Forwarding-Context"],
      "server",
    );
    expect(sealed).toMatchObject({ session: true, token: "lane-session-handle" });
    expect(sealed).not.toHaveProperty("profile");
    await first.stop();
    await second.stop();
  });

  it("binds each turn on the lane and on the owner's grant with the server's own digest", async () => {
    const prepared = await prepare("grant-turn-1", 60_000);
    const digest = sessionPolicyDigest("server", {
      mode: "default",
      denied: {},
      known: [],
      unknownTool: "allow",
    });
    expect(binds).toEqual([
      expect.objectContaining({
        leaseId: "lease-grant-turn-1",
        turnId: "lane-turn-grant-turn-1",
        servers: [{ serverId: "server", connectionId: "account", policyDigest: digest }],
      }),
    ]);
    // The grant was installed for the runner's turn, not the lane's.
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith("grant-turn-1", digest);
    await prepared.stop();
  });

  it("matches Cursor's calls by the server its input names, and hydrates no result", async () => {
    const prepared = await prepare("grant-turn-1", 60_000);
    const input = { providerIdentifier: "server", toolName: "read", args: {} };
    expect(prepared.isForwardedTool("acp_tool_1", input)).toBe(true);
    expect(prepared.isForwardedTool("acp_tool_2", { command: "ls" })).toBe(false);
    // Host-executed tools carry the registered server in their names.
    expect(prepared.isForwardedTool("mcp__server__read", {})).toBe(true);
    expect(prepared.isForwardedTool("mcp__unknown__read", {})).toBe(false);
    await expect(prepared.readToolResult("server", "acp_tool_1")).resolves.toBeUndefined();
    await prepared.stop();
  });

  it("refuses the turn before the runtime starts when the lane cannot be bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, bound: false, reason: "lease_unavailable" })),
    );
    await expect(prepare("grant-turn-1", 60_000)).rejects.toThrow(
      "Couldn't connect this turn to its chat session. Send your message again.",
    );
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("reads the owner back from the envelope's handle, never from the request", () => {
    const sealed = {
      token: "not-a-handle",
      serverId: "server",
      policy: { mode: "default" as const, denied: {}, known: [], unknownTool: "allow" as const },
      session: true as const,
    };
    expect(sessionForwardingContext(sealed, "server")).toBeUndefined();
  });
});
