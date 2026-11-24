import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (caller: { authMethod?: string }, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
    "x-test-method": caller.authMethod ?? "",
  }),
}));

import { resetMockBackendCachesForTests, resolveMock } from "../backend.js";
import { MockRefusal } from "../refusal.js";

const caller = { authMethod: "authkit_jwt", workosUserId: "u1" };
const answer = {
  mockId: "m1",
  projectId: "p1",
  name: "Mock",
  version: 3,
  headVersion: 4,
  contentHash: "h".repeat(64),
  definition: { tools: { echo: { description: "x" } } },
  baseServerId: "real1",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function grantExpiring(atMs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ purpose: "mock-grant", exp: Math.floor(atMs / 1000) })}.sig`;
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  resetMockBackendCachesForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("resolveMock", () => {
  it("asks the backend with the caller's own bearer and returns its answer", async () => {
    const fetchMock = vi.fn(async () => json(200, answer));
    const resolved = await resolveMock(
      { mockId: "m1", caller, bearerToken: "key-1" },
      { fetch: fetchMock as never },
    );
    expect(resolved).toMatchObject({ version: 3, baseServerId: "real1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://backend.test/web/mock/resolve");
    expect(JSON.parse(String(init.body))).toEqual({ mockId: "m1" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
  });

  it("sends the grant, not a mock id, at the in-process door", async () => {
    const fetchMock = vi.fn(async () => json(200, answer));
    await resolveMock(
      { mockId: "m1", caller, bearerToken: "t", grant: "g.r.a" },
      { fetch: fetchMock as never },
    );
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ grant: "g.r.a" });
  });

  it("caches an answer for 60 seconds, per caller and per mock", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fetchMock = vi.fn(async () => json(200, answer));
    const ask = (bearerToken: string) =>
      resolveMock({ mockId: "m1", caller, bearerToken }, { fetch: fetchMock as never });
    await ask("a");
    await ask("a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ask("b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_000_000 + 60_000);
    await ask("a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never serves an answer past the grant it was given for", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fetchMock = vi.fn(async () => json(200, answer));
    const grant = grantExpiring(1_000_000 + 20_000);
    const ask = () =>
      resolveMock({ mockId: "m1", caller, bearerToken: "t", grant }, { fetch: fetchMock as never });
    await ask();
    vi.setSystemTime(1_000_000 + 19_000);
    await ask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + 20_000);
    await ask();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("remembers a refused caller for 30 seconds and then asks again", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const fetchMock = vi.fn(async () => json(403, { code: "MOCK_FORBIDDEN", message: "no" }));
    const ask = () =>
      resolveMock({ mockId: "m1", caller, bearerToken: "key" }, { fetch: fetchMock as never });
    await expect(ask()).rejects.toMatchObject({ kind: "forbidden" });
    await expect(ask()).rejects.toMatchObject({ kind: "forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5_000_000 + 30_000);
    await expect(ask()).rejects.toBeInstanceOf(MockRefusal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "MOCK_UNAUTHORIZED", "unauthorized"],
    [401, "MOCK_GRANT_INVALID", "unauthorized"],
    [401, "MOCK_GRANT_EXPIRED", "grant_expired"],
    [403, "MOCK_GUEST_REFUSED", "guest"],
    [403, "MOCK_GRANT_CALLER_MISMATCH", "forbidden"],
    [404, "MOCK_NOT_FOUND", "not_found"],
    [404, "MOCK_VERSION_NOT_FOUND", "not_found"],
  ])("maps the backend's %s %s to %s", async (status, code, kind) => {
    const fetchMock = vi.fn(async () => json(status, { code, message: "see 10.0.0.9" }));
    const failure = await resolveMock(
      { mockId: "m1", caller, bearerToken: `k-${code}` },
      { fetch: fetchMock as never },
    ).catch((error: MockRefusal) => error);
    expect(failure).toMatchObject({ kind });
    // The backend's own sentence is never passed on.
    expect((failure as Error).message).not.toContain("10.0.0.9");
  });

  it("does not remember a failure that says nothing about the caller", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, answer));
    const ask = () =>
      resolveMock({ mockId: "m1", caller, bearerToken: "k" }, { fetch: fetchMock as never });
    await expect(ask()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(ask()).resolves.toMatchObject({ version: 3 });
  });

  it("refuses an answer whose definition this build cannot read", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { ...answer, definition: { tools: { echo: { nonsense: true } } } }),
    );
    await expect(
      resolveMock({ mockId: "m1", caller, bearerToken: "k" }, { fetch: fetchMock as never }),
    ).rejects.toMatchObject({ kind: "invalid_definition" });
  });

  it("answers unavailable when the backend cannot be reached", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND convex.internal.example");
    });
    const failure = await resolveMock(
      { mockId: "m1", caller, bearerToken: "k" },
      { fetch: fetchMock as never },
    ).catch((error: MockRefusal) => error);
    expect(failure).toMatchObject({ kind: "unavailable" });
    expect((failure as Error).message).not.toContain("convex.internal");
  });
});
