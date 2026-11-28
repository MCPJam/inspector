/**
 * Who the hosted harness proxy says it is to the backend.
 *
 * An RS256 proxy token or session handle is sent as the bearer itself, with a
 * handle's box grant beside it, and the turn checks read their ids from it. An
 * HS256 one comes from a backend that may not take it as a bearer, so it keeps
 * the synthesized acting-as caller and the service credential with body ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const { mockManager } = vi.hoisted(() => ({
  mockManager: {
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "echo" }] }),
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
import {
  sealHarnessProxyToken,
  sealHarnessSessionEnvelope,
} from "../../../utils/harness/harness-proxy-policy-seal.js";
import { resetHarnessProxyJwksCacheForTests } from "../../../utils/harness/harness-proxy-token.js";
import { sessionPolicyDigest } from "../../../utils/harness/session-mcp-config.js";
import { SESSION_GRANT_HEADER } from "../../../utils/harness/session-grant.js";
import {
  signTestProxyToken,
  signTestRs256Credential,
  testHarnessKey,
  testProxyTokenPayload,
} from "../../../utils/harness/__tests__/sign-test-token.js";

const SECRET = "test-harness-proxy-secret-32-chars";
const key = testHarnessKey();
const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

const GRANT = `grant-1.${"a".repeat(64)}`;
const profile = { clientCapabilities: {}, timeout: 60_000 };
const policy: ToolPolicySnapshot = {
  mode: "default",
  denied: {},
  known: ["echo"],
  unknownTool: "allow",
};
const HANDLE = {
  iss: "https://api.mcpjam.com/harness-mcp-proxy",
  purpose: "harness-mcp-session",
  sub: "user_convex_1",
  ext: "user_ext_1",
  org: "org_1",
  projectId: "p1",
  serverId: "srv-a",
  lane: "lane-1",
  iat: 1_700_000_000,
};

function hs256(payload: Record<string, unknown>) {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", SECRET).update(input).digest("base64url")}`;
}

const rs256Token = () =>
  signTestRs256Credential(
    testProxyTokenPayload({ serverId: "srv-a", projectId: "p1" }),
    key,
  );

const post = (token: string, grant?: string) =>
  app.request("/api/web/harness-mcp/srv-a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCPJam-Proxy-Token": token,
      ...(grant ? { [SESSION_GRANT_HEADER]: grant } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

const turnChecks: { path: string; headers: Headers; body: unknown }[] = [];
// A turn of its own per test: a turn's requests share one cached manager.
let turns = 0;
let turnId = "";
beforeEach(() => {
  vi.clearAllMocks();
  turnChecks.length = 0;
  turnId = `turn-${++turns}`;
  resetHarnessProxyJwksCacheForTests();
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", SECRET);
  vi.stubEnv(
    "HARNESS_PROXY_SEAL_SECRET",
    "test-seal-secret-at-least-32-characters",
  );
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-service-credential");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/harness/mcp-proxy-jwks") return Response.json(key.jwks);
      turnChecks.push({
        path,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return path === "/internal/harness/session-turn"
        ? Response.json({
            turnId,
            policyDigest: sessionPolicyDigest("srv-a", policy, profile),
          })
        : new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("per-turn proxy tokens", () => {
  it("send an RS256 token as the caller's bearer", async () => {
    const token = rs256Token();
    expect((await post(token)).status).toBe(200);
    expect(createAuthorizedManager).toHaveBeenLastCalledWith(
      {},
      token,
      "p1",
      ["srv-a"],
      expect.any(Number),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("keep the synthesized acting-as caller for an HS256 token", async () => {
    vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", SECRET);
    const token = signTestProxyToken({ serverId: "srv-a", projectId: "p1" });
    expect((await post(token)).status).toBe(200);
    expect(createAuthorizedManager).toHaveBeenLastCalledWith(
      {
        authMethod: "workos_api_key",
        workosUserId: "user_ext_1",
        mcpjamOrganizationId: "org_1",
      },
      "",
      "p1",
      ["srv-a"],
      expect.any(Number),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("check a turn with the RS256 token, sending only the lane and lease", async () => {
    const token = rs256Token();
    const sealed = sealHarnessProxyToken({
      turn: { laneId: "lane-1", leaseId: "lease-1" },
      token,
      serverId: "srv-a",
      policy,
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await post(sealed)).status).toBe(200);
    expect(turnChecks[0]!.path).toBe("/internal/harness/proxy-turn");
    expect(turnChecks[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(turnChecks[0]!.headers.get("x-inspector-service-token")).toBeNull();
    expect(turnChecks[0]!.body).toEqual({
      laneId: "lane-1",
      leaseId: "lease-1",
    });
  });

  it("check an HS256 token's turn with the service credential and body ids", async () => {
    const sealed = sealHarnessProxyToken({
      turn: { laneId: "lane-1", leaseId: "lease-1" },
      token: signTestProxyToken({ serverId: "srv-a", projectId: "p1" }),
      serverId: "srv-a",
      policy,
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await post(sealed)).status).toBe(200);
    expect(turnChecks[0]!.headers.get("authorization")).toBeNull();
    expect(turnChecks[0]!.body).toEqual({
      laneId: "lane-1",
      leaseId: "lease-1",
      userId: "user_convex_1",
      projectId: "p1",
    });
  });
});

describe("session handles", () => {
  const envelope = (handle: string) =>
    sealHarnessSessionEnvelope({ handle, serverId: "srv-a", policy, profile });

  it("send an RS256 handle as the bearer, with the box's grant, for the turn check and the backend", async () => {
    const handle = signTestRs256Credential(HANDLE, key);
    expect((await post(envelope(handle), GRANT)).status).toBe(200);
    expect(turnChecks[0]!.path).toBe("/internal/harness/session-turn");
    expect(turnChecks[0]!.headers.get("authorization")).toBe(
      `Bearer ${handle}`,
    );
    expect(turnChecks[0]!.body).toEqual({ boxGrant: GRANT });
    expect(createAuthorizedManager).toHaveBeenLastCalledWith(
      { harnessSessionGrant: GRANT },
      handle,
      "p1",
      ["srv-a"],
      60_000,
      undefined,
      {},
      expect.anything(),
    );
  });

  it("keep the acting-as caller and body ids for an HS256 handle", async () => {
    expect((await post(envelope(hs256(HANDLE)), GRANT)).status).toBe(200);
    expect(turnChecks[0]!.headers.get("x-inspector-service-token")).toBe(
      "test-service-credential",
    );
    expect(turnChecks[0]!.body).toEqual({
      laneId: "lane-1",
      userId: "user_convex_1",
      projectId: "p1",
      serverId: "srv-a",
      boxGrant: GRANT,
    });
    expect(vi.mocked(createAuthorizedManager).mock.lastCall?.[0]).toMatchObject(
      {
        authMethod: "workos_api_key",
      },
    );
  });
});
