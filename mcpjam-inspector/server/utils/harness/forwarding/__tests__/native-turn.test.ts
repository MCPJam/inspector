import { setManagerOrganization } from "../../../mcp-connections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { unsealHarnessProxyToken } from "../../harness-proxy-policy-seal";
import { nativeRpcLogScope } from "../native-rpc-logs";
import {
  hasForwardingOrganization,
  nativeForwardingSelection,
  prepareNativeForwarding,
  readNativeForwardingResult,
} from "../native-turn";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  present: vi.fn(),
  url: "https://forward.example/api/web/harness-mcp/server",
}));
vi.mock("../approval", () => ({
  startForwardingApprovalPresentation: () => {
    mocks.present();
    return mocks.stop;
  },
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
    expect(prepared.logScopeIds).toEqual({ server: nativeRpcLogScope(owner, "turn") });
    expect(new URL(entry.url).searchParams.get("native")).toBe("1");
    expect(JSON.stringify(prepared.mcpJson)).not.toContain(
      "private-user-bearer",
    );
    expect(Object.keys(entry.headers!)).toEqual([
      "X-MCPJam-Forwarding-Context",
    ]);
    const opened = unsealHarnessProxyToken(
      entry.headers!["X-MCPJam-Forwarding-Context"],
      "server",
    );
    expect(JSON.parse(opened!.token)).toEqual({ owner, turnId: "turn" });
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
