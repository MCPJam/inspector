import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpServerConfig } from "@mcpjam/sdk";
import { scrubDeliveredSecrets } from "../../../shared/delivered-secret-registry.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { registerMockInProcessHandler } from "../../services/mock/registry.js";
import {
  dispatchMockInProcess,
  mockVersionsOf,
  readMockPins,
  type MockAuthorized,
  type MockDial,
} from "../mock-servers.js";

const NOW = 1_800_000_000_000;
const profile = { timeoutMs: 12_000, clientCapabilities: { roots: {} } };
const base: HttpServerConfig = {
  url: "https://mock.mcpjam.invalid/mock1",
  timeout: 12_000,
  requestInit: { headers: { "X-Kept": "yes" } },
};

function entry(grant: string, grantExpiresAt: number): MockAuthorized {
  return {
    ok: true,
    oauthAccessToken: grant,
    serverConfig: { mock: { mockId: "mock1", version: 4, contentHash: "h".repeat(64), grantExpiresAt } },
  };
}

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

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchMockInProcess", () => {
  it("calls the route in process with the grant and the context the dialer authorized with", async () => {
    const { config, handler, call } = setup(async () => entry("unused", NOW));
    await call();
    expect(handler).toHaveBeenCalledTimes(1);
    const [mockId, request, door] = handler.mock.calls[0] as unknown as [string, Request, Record<string, unknown>];
    expect(mockId).toBe("mock1");
    expect(request.method).toBe("POST");
    expect(door).toMatchObject({
      grant: "grant-token-1",
      bearerToken: "ann-bearer",
      caller: { authMethod: "workos_api_key", workosUserId: "ann", mcpjamOrganizationId: "org1" },
      projectId: "proj1",
      profile: { timeoutMs: 12_000, clientCapabilities: { roots: {} }, xaaIssuer: "https://issuer.test" },
    });
    // What the dialer built for any HTTP server is kept; the mock's dispatch is laid over it.
    expect(config).toMatchObject({
      url: base.url,
      timeout: 12_000,
      credentialSource: "mcpjam-backend",
      preferSSE: false,
      disableSseFallback: true,
    });
    expect(new Headers(config.requestInit?.headers).get("x-kept")).toBe("yes");
  });

  it("registers the grant with the scrubber, so no error body carries it", () => {
    setup(async () => entry("unused", NOW));
    expect(scrubDeliveredSecrets("failed with grant-token-1 in the body")).not.toContain("grant-token-1");
  });

  it("never reaches a network when no route is registered", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { call } = setup(async () => entry("unused", NOW));
    registerMockInProcessHandler(undefined as never);
    const response = await call();
    expect(response.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is refused for a dialer that cannot say who it is, rather than dialed", () => {
    expect(() => dispatchMockInProcess(base, entry("g", NOW + 1000), profile, undefined)).toThrowError(
      WebRouteError,
    );
  });

  describe("the grant", () => {
    it("is not asked for again while it has more than 30 seconds left", async () => {
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
      const grants = handler.mock.calls.map((c) => (c as unknown as [string, Request, { grant: string }])[2].grant);
      expect(grants).toEqual(["grant-token-2", "grant-token-2", "grant-token-2"]);
    });

    it("is minted again at each expiry for as long as the connection lasts (a 2 minute life, 5 minutes)", async () => {
      let n = 1;
      const { dial, handler, call } = setup(async () => {
        n += 1;
        return entry(`grant-token-${n}`, Date.now() + 120_000);
      }, 120_000);
      const seen: string[] = [];
      for (let elapsed = 0; elapsed <= 300_000; elapsed += 20_000) {
        vi.setSystemTime(NOW + elapsed);
        await call();
        seen.push((handler.mock.calls.at(-1) as unknown as [string, Request, { grant: string }])[2].grant);
      }
      expect(dial.reauthorize).toHaveBeenCalledTimes(3);
      expect([...new Set(seen)]).toEqual(["grant-token-1", "grant-token-2", "grant-token-3", "grant-token-4"]);
    });

    it("registers each new grant with the scrubber", async () => {
      const { call } = setup(async () => entry("grant-token-2", NOW + 240_000), 100_000);
      vi.setSystemTime(NOW + 80_000);
      await call();
      expect(scrubDeliveredSecrets("grant-token-2 and grant-token-1")).not.toMatch(/grant-token-[12]/);
    });

    it("is minted again on a 401, whatever its expiry says", async () => {
      const { config, dial } = setup(async () => entry("grant-token-9", NOW + 3_600_000));
      const refreshed = await config.onUnauthorized!({ serverId: "mock", error: new Error("401") });
      expect(refreshed).toEqual({ accessToken: "grant-token-9" });
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
});

describe("a run's pins", () => {
  it("become the versions to authorize, keeping only well-formed ones", () => {
    const pins = readMockPins([
      { serverId: "a", version: 3, contentHash: "h" },
      { serverId: "b", version: 0, contentHash: "h" },
      { serverId: "c", version: 1.5, contentHash: "h" },
      { serverId: "d", version: 2 },
      null,
      "x",
    ]);
    expect(pins).toEqual([{ serverId: "a", version: 3, contentHash: "h" }]);
    expect(mockVersionsOf(pins)).toEqual({ a: 3 });
    expect(mockVersionsOf([])).toBeUndefined();
    expect(readMockPins(undefined)).toEqual([]);
  });
});
