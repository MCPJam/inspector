import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrubDeliveredSecrets } from "../../../shared/delivered-secret-registry.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { withMockAnswerSink } from "../../services/mock/answer-marks.js";
import { registerMockInProcessHandler } from "../../services/mock/registry.js";

import {
  dialMockOr,
  dispatchMockInProcess,
  pointAtMockRoute,
  type MockAuthorized,
  type MockDial,
} from "../mock-servers.js";

beforeEach(() => {
  process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "http://127.0.0.1:6274";
});
afterEach(() => {
  delete process.env.MCPJAM_INSPECTOR_PUBLIC_URL;
});

describe("pointAtMockRoute", () => {
  const mock = { url: "https://mock.mcpjam.invalid/mock%201", requestInit: { headers: { "x-keep": "1" } } };

  it("swaps a mock's placeholder for the route's address and presents the caller's bearer", () => {
    const config = pointAtMockRoute(mock, "sk_ann");
    expect(config.url).toBe("http://127.0.0.1:6274/api/web/mock-mcp/mock%201");
    expect(config.requestInit?.headers).toEqual({ "x-keep": "1", authorization: "Bearer sk_ann" });
    expect(config).toMatchObject({ preferSSE: false, disableSseFallback: true });
  });

  it("uses the configured public address when there is one", () => {
    process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "https://inspector.example/";
    expect(pointAtMockRoute(mock, "t").url).toBe("https://inspector.example/api/web/mock-mcp/mock%201");
  });

  it("leaves any other server as it is", () => {
    const other = { url: "https://real.example/mcp" };
    expect(pointAtMockRoute(other, "t")).toBe(other);
    const stdio = { command: "node", args: [] };
    expect(pointAtMockRoute(stdio, "t")).toBe(stdio);
  });
});

describe("dispatchMockInProcess", () => {
  const NOW = 1_800_000_000_000;
  const profile = { timeoutMs: 12_000, clientCapabilities: { roots: {} } };
  const base = {
    url: "https://mock.mcpjam.invalid/mock1",
    timeout: 12_000,
    requestInit: { headers: { "X-Kept": "yes" } },
  };
  const entry = (grant: string, grantExpiresAt: number): MockAuthorized => ({
    ok: true,
    oauthAccessToken: grant,
    serverConfig: { mock: { mockId: "mock1", version: 4, contentHash: "h".repeat(64), grantExpiresAt } },
  });

  function setup(reauthorize: MockDial["reauthorize"], grantLifeMs = 3_600_000) {
    const handler = vi.fn(async () => new Response("{}", { status: 200 }));
    registerMockInProcessHandler(handler);
    const dial: MockDial = {
      caller: { authMethod: "workos_api_key", workosUserId: "ann", mcpjamOrganizationId: "org1" },
      bearerToken: "ann-bearer",
      projectId: "proj1",
      xaaIssuer: "https://issuer.test",
      reauthorize: vi.fn(reauthorize),
    };
    const config = dispatchMockInProcess(base, entry("grant-token-1", NOW + grantLifeMs), profile, dial);
    const call = () => config.baseFetch!("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" });
    return { config, dial, handler, call };
  }
  const grantsSeen = (handler: ReturnType<typeof vi.fn>) =>
    handler.mock.calls.map((c) => (c as unknown as [string, Request, { grant: string }])[2].grant);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    registerMockInProcessHandler(undefined);
  });

  it("calls the route in process with the grant and the context the dialer authorized with", async () => {
    const { config, handler, call } = setup(async () => entry("unused", NOW));
    await call();
    const [mockId, , door] = handler.mock.calls[0] as unknown as [string, Request, Record<string, unknown>];
    expect(mockId).toBe("mock1");
    expect(door).toMatchObject({
      grant: "grant-token-1",
      bearerToken: "ann-bearer",
      caller: { authMethod: "workos_api_key", workosUserId: "ann", mcpjamOrganizationId: "org1" },
      projectId: "proj1",
      profile: { timeoutMs: 12_000, clientCapabilities: { roots: {} }, xaaIssuer: "https://issuer.test" },
    });
    expect(config).toMatchObject({ credentialSource: "mcpjam-backend", preferSSE: false, disableSseFallback: true });
    expect(new Headers(config.requestInit?.headers).get("x-kept")).toBe("yes");
  });

  it("hands the running tool call each mark as the route reports it", async () => {
    const { handler, call } = setup(async () => entry("unused", NOW));
    handler.mockImplementationOnce(async (_id: string, _r: Request, door: { onCall?: (m: object) => void }) => {
      door.onCall?.({ mockId: "mock1", version: 4, tool: "echo", source: "saved" });
      return new Response("{}");
    });
    const seen: unknown[] = [];
    await withMockAnswerSink((marks) => seen.push(...marks), call);
    await call();
    expect(seen).toEqual([{ mockId: "mock1", version: 4, tool: "echo", source: "saved" }]);
  });

  it("registers the grant with the scrubber, so no error body carries it", () => {
    setup(async () => entry("unused", NOW));
    expect(scrubDeliveredSecrets("failed with grant-token-1 in the body")).not.toContain("grant-token-1");
  });

  it("never reaches a network when no route is registered", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { call } = setup(async () => entry("unused", NOW));
    registerMockInProcessHandler(undefined);
    expect((await call()).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is refused for a dialer that cannot say who it is, rather than dialed", () => {
    expect(() => dispatchMockInProcess(base, entry("g", NOW + 1000), profile, undefined)).toThrowError(WebRouteError);
  });

  it("is not asked for again while the grant has more than 30 seconds left", async () => {
    const { dial, call } = setup(async () => entry("grant-token-2", NOW + 7_200_000));
    await call();
    vi.setSystemTime(NOW + 3_600_000 - 31_000);
    await call();
    expect(dial.reauthorize).not.toHaveBeenCalled();
  });

  it("is minted again 30 seconds before it expires, once for calls that arrive together", async () => {
    const { dial, handler, call } = setup(async () => entry("grant-token-2", NOW + 240_000), 120_000);
    vi.setSystemTime(NOW + 90_001);
    await Promise.all([call(), call(), call()]);
    expect(dial.reauthorize).toHaveBeenCalledTimes(1);
    expect(grantsSeen(handler)).toEqual(["grant-token-2", "grant-token-2", "grant-token-2"]);
  });

  it("is minted again on a 401, whatever its expiry says", async () => {
    const { config, dial } = setup(async () => entry("grant-token-9", NOW + 3_600_000));
    expect(await config.onUnauthorized!({ serverId: "mock", error: new Error("401") })).toEqual({
      accessToken: "grant-token-9",
    });
    expect(dial.reauthorize).toHaveBeenCalledTimes(1);
  });

  it("answers in JSON-RPC when it cannot be renewed, and says nothing of why", async () => {
    const { call, handler } = setup(async () => {
      throw new WebRouteError(403, ErrorCode.FORBIDDEN, "Not a member of project proj1 on https://secret.example");
    }, 10_000);
    const response = await call();
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ jsonrpc: "2.0", error: { data: { mockCode: "mock_forbidden" } } });
    expect(text).not.toMatch(/secret\.example|proj1/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("is refused when the backend answers for the mock with no grant", async () => {
    const { call } = setup(async () => ({ ok: true, serverConfig: {} }), 10_000);
    expect((await call()).status).toBe(401);
  });
});

describe("dialMockOr", () => {
  it("takes the in-process door only on the marker, never on the address", () => {
    const config = { url: "https://mock.mcpjam.invalid/mock1" };
    process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "https://inspector.example";
    const viaAddress = dialMockOr(config, { ok: true, serverConfig: {} }, { timeoutMs: 1 }, undefined);
    expect(viaAddress.url).toBe("https://inspector.example/api/web/mock-mcp/mock1");
    expect(viaAddress.baseFetch).toBeUndefined();
  });
});
